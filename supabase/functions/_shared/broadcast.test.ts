// @vitest-environment node
// «Рассылка»: the worker that sends a broadcast (rate, Telegram 429 / retry_after, blocks, retries, Premium emoji
// fallback, photo upload once) and the validation before it starts. Telegram is a scripted fetch — nothing is sent
// anywhere; the broadcast_* RPCs are an in-memory stand-in with the queue rules of 20261113090000 (the SQL itself,
// tenant isolation and access control are covered by tests/integration/security/broadcast.test.ts).
// Time is a fake clock moved by the worker's own sleep(), so the send rate and the time budget are exact.
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Rpc } from './bot-connection';
import {
  BROADCAST_LIMITS,
  buildBroadcastKeyboard,
  cancelBroadcast,
  getBroadcast,
  MIN_SEND_INTERVAL_MS,
  renderBroadcast,
  retryBroadcast,
  runBroadcast,
  RUN_BUDGET_MS,
  startBroadcast,
  type BroadcastDeps,
  type BroadcastJson,
  type StartBroadcastInput,
} from './broadcast';

const PUBLIC = 'https://miniappdemo.pages.dev';
const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-13T09:00:00Z');
let clock = T0;
const iso = (ms: number) => new Date(ms).toISOString();
const asc = (a: number, b: number) => a - b;

// Premium (custom) emoji ids are public numbers; these are made up.
const FIRE = '5368324170671202286';
const HAND = '5368324170671202287';
const tag = (id: string, fallback: string) => `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;

/** Fake token in the BotFather format; never valid in Telegram. */
const fakeToken = () => `${100_000_000 + Math.floor(Math.random() * 800_000_000)}:FAKE_${randomBytes(18).toString('hex')}`;

// ---- In-memory stand-in for the broadcast_* RPCs (same rules as 20261113090000) ---------------------------------

type SubscriberStatus = 'active' | 'unsubscribed' | 'blocked';
type RecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'blocked' | 'cancelled';

interface TestShop {
  id: string;
  slug: string;
  name: string;
  owner: string;
  /** The owner's user id, as the Edge Function passes it. */
  actor: string;
  bot: { bot_id: number; bot_username: string; token: string } | null;
}
interface Recipient {
  tg_user_id: number;
  chat_id: number;
  status: RecipientStatus;
  attempts: number;
  next_attempt_at: number;
  locked_until: number | null;
  message_id: number | null;
  last_error: string | null;
}
interface Broadcast {
  id: string;
  shop_id: string;
  bot_id: number;
  idempotency_key: string;
  message_text: string;
  photo_path: string | null;
  photo_file_id: string | null;
  button_text: string | null;
  button_emoji_id: string | null;
  status: 'sending' | 'completed' | 'cancelled';
  total: number;
  resume_at: number | null;
  worker_id: string | null;
  worker_until: number | null;
  last_error: string | null;
  created_at: number;
  completed_at: number | null;
  recipients: Recipient[];
}

const trimmed = (v: unknown): string | null => String(v ?? '').trim() || null;

class FakeDb {
  shops = new Map<string, TestShop>();
  /** private.bot_subscribers, keyed by shop / bot / Telegram user. */
  subscribers = new Map<string, { chat_id: number; status: SubscriberStatus }>();
  broadcasts: Broadcast[] = [];
  /** Names of the objects in the shop-media bucket. */
  storage = new Set<string>();
  calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  private nextUser = 700_000_001;

  addShop(slug: string, name: string, withBot = true): TestShop {
    const owner = randomUUID();
    const shop: TestShop = { id: randomUUID(), slug, name, owner, actor: owner, bot: null };
    this.shops.set(shop.id, shop);
    if (withBot) this.replaceBot(shop);
    return shop;
  }

  /** Connects another bot to the shop (a new bot id: its audience starts empty). */
  replaceBot(shop: TestShop): void {
    const token = fakeToken();
    const botId = Number(token.split(':')[0]);
    shop.bot = { bot_id: botId, bot_username: `shop_${botId}_bot`, token };
  }

  /** `count` users who started the shop's current bot; their ids, ascending. */
  subscribe(shop: TestShop, count: number, status: SubscriberStatus = 'active'): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      const id = this.nextUser++;
      this.subscribers.set(`${shop.id}/${shop.bot!.bot_id}/${id}`, { chat_id: id, status });
      ids.push(id);
    }
    return ids;
  }

  setStatus(shop: TestShop, user: number, status: SubscriberStatus): void {
    this.subscribers.get(`${shop.id}/${shop.bot!.bot_id}/${user}`)!.status = status;
  }

  /** A broadcast photo the owner uploaded to Storage; its path. */
  upload(shop: TestShop): string {
    const path = `${shop.id}/broadcast/${randomUUID()}.jpg`;
    this.storage.add(path);
    return path;
  }

  /** `count` finished broadcasts from a few days ago; the oldest one has a photo. */
  seedHistory(shop: TestShop, count: number, oldestPhoto: string): void {
    for (let i = 0; i < count; i++) {
      const at = clock - 72 * HOUR - i * HOUR;
      this.broadcasts.push({
        id: randomUUID(),
        shop_id: shop.id,
        bot_id: shop.bot!.bot_id,
        idempotency_key: randomUUID(),
        message_text: `Старая рассылка ${i}`,
        photo_path: i === count - 1 ? oldestPhoto : null,
        photo_file_id: null,
        button_text: null,
        button_emoji_id: null,
        status: 'completed',
        total: 0,
        resume_at: null,
        worker_id: null,
        worker_until: null,
        last_error: null,
        created_at: at,
        completed_at: at,
        recipients: [],
      });
    }
  }

  /** Queue rows of the shop's latest broadcast. */
  recipients(shop: TestShop): Recipient[] {
    const mine = this.broadcasts.filter((b) => b.shop_id === shop.id).sort((x, y) => y.created_at - x.created_at);
    return mine[0]?.recipients ?? [];
  }

  rpc: Rpc = async (fn, args) => {
    this.calls.push({ fn, args });
    try {
      return { data: this.exec(fn, args), error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  };

  private assert(shopId: unknown, actor: unknown): TestShop {
    const shop = this.shops.get(String(shopId));
    if (!shop) throw new Error('shop_not_found');
    if (shop.owner !== actor) throw new Error('forbidden');
    return shop;
  }

  private json(b: Broadcast): BroadcastJson {
    const count = (...statuses: RecipientStatus[]) => b.recipients.filter((r) => statuses.includes(r.status)).length;
    return {
      id: b.id,
      status: b.status,
      message_text: b.message_text,
      photo_path: b.photo_path,
      button_text: b.button_text,
      button_emoji_id: b.button_emoji_id,
      total: b.total,
      counts: { pending: count('pending', 'sending'), sent: count('sent'), failed: count('failed'), blocked: count('blocked'), cancelled: count('cancelled') },
      resume_at: b.status === 'sending' && b.resume_at !== null && b.resume_at > clock ? iso(b.resume_at) : null,
      last_error: b.last_error,
      created_at: iso(b.created_at),
      completed_at: b.completed_at === null ? null : iso(b.completed_at),
    };
  }

  /** private.broadcast_finish: 'cancelled' also drops everything not sent yet. */
  private finish(b: Broadcast, status: 'completed' | 'cancelled', error: string | null): void {
    if (status === 'cancelled') {
      for (const r of b.recipients) {
        if (r.status === 'pending') {
          r.status = 'cancelled';
          r.locked_until = null;
        }
      }
    }
    if (b.status !== 'sending') return;
    b.status = status;
    b.completed_at = clock;
    b.resume_at = null;
    b.worker_id = null;
    b.worker_until = null;
    b.last_error = error === null ? null : error.slice(0, 300);
  }

  private exec(fn: string, a: Record<string, unknown>): unknown {
    switch (fn) {
      case 'broadcast_overview': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const mine = this.broadcasts.filter((b) => b.shop_id === shop.id).sort((x, y) => y.created_at - x.created_at);
        const audience = { active: 0, unsubscribed: 0, blocked: 0 };
        // Users of the CURRENT bot only.
        if (shop.bot) for (const [key, s] of this.subscribers) if (key.startsWith(`${shop.id}/${shop.bot.bot_id}/`)) audience[s.status] += 1;
        const active = mine.find((b) => b.status === 'sending');
        return {
          shop: { id: shop.id, slug: shop.slug, name: shop.name },
          bot: shop.bot ? { bot_username: shop.bot.bot_username, status: 'connected' } : null,
          audience,
          active: active ? this.json(active) : null,
          history: mine.slice(0, 10).map((b) => this.json(b)),
        };
      }
      case 'broadcast_start': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        if (!a.p_idempotency_key) throw new Error('invalid_broadcast');
        const existing = this.broadcasts.find((b) => b.shop_id === shop.id && b.idempotency_key === a.p_idempotency_key);
        if (existing) return { replayed: true, broadcast: this.json(existing), pruned_photos: [] };
        if (!shop.bot) throw new Error('not_connected');
        const text = typeof a.p_message_text === 'string' ? a.p_message_text : '';
        if (!text.trim() || text.length > 4096) throw new Error('invalid_broadcast_text');
        const photo = trimmed(a.p_photo_path);
        const button = trimmed(a.p_button_text);
        const emoji = trimmed(a.p_button_emoji_id);
        // The shop's own uploaded file, nothing else.
        const ownPhoto = new RegExp(`^${shop.id}/broadcast/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\\.(jpg|png|webp)$`);
        if (photo !== null && (!ownPhoto.test(photo) || !this.storage.has(photo))) throw new Error('invalid_broadcast_photo');
        if ((button !== null && button.length > 64) || (emoji !== null && (button === null || !/^[0-9]{5,25}$/.test(emoji)))) {
          throw new Error('invalid_broadcast_button');
        }
        const mine = this.broadcasts.filter((b) => b.shop_id === shop.id);
        if (mine.some((b) => b.status === 'sending')) throw new Error('broadcast_in_progress');
        if (mine.filter((b) => b.created_at > clock - 24 * HOUR).length >= 10) throw new Error('broadcast_rate_limited');

        // The recipients: active users of the shop's current bot. Nothing in the request can add one.
        const prefix = `${shop.id}/${shop.bot.bot_id}/`;
        const recipients: Recipient[] = [...this.subscribers]
          .filter(([key, s]) => key.startsWith(prefix) && s.status === 'active')
          .map(([key, s]) => ({
            tg_user_id: Number(key.slice(prefix.length)),
            chat_id: s.chat_id,
            status: 'pending',
            attempts: 0,
            next_attempt_at: clock,
            locked_until: null,
            message_id: null,
            last_error: null,
          }));
        if (recipients.length === 0) throw new Error('no_recipients');
        const b: Broadcast = {
          id: randomUUID(),
          shop_id: shop.id,
          bot_id: shop.bot.bot_id,
          idempotency_key: String(a.p_idempotency_key),
          message_text: text,
          photo_path: photo,
          photo_file_id: null,
          button_text: button,
          button_emoji_id: emoji,
          status: 'sending',
          total: recipients.length,
          resume_at: null,
          worker_id: null,
          worker_until: null,
          last_error: null,
          created_at: clock,
          completed_at: null,
          recipients,
        };
        this.broadcasts.push(b);
        // History is short: the 30 latest broadcasts of the shop.
        const keep = new Set([...mine, b].sort((x, y) => y.created_at - x.created_at).slice(0, 30));
        const pruned = mine.filter((x) => !keep.has(x));
        this.broadcasts = this.broadcasts.filter((x) => !pruned.includes(x));
        return { replayed: false, broadcast: this.json(b), pruned_photos: pruned.flatMap((x) => (x.photo_path ? [x.photo_path] : [])) };
      }
      case 'broadcast_claim': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const b = this.broadcasts.find((x) => x.id === a.p_broadcast_id && x.shop_id === shop.id);
        if (!b || !a.p_worker_id) throw new Error('broadcast_not_found');
        if (b.status !== 'sending') return { state: 'done' };
        if (!shop.bot || shop.bot.bot_id !== b.bot_id) {
          this.finish(b, 'cancelled', 'bot_changed');
          return { state: 'done' };
        }
        if (b.resume_at !== null && b.resume_at > clock) return { state: 'paused', resume_at: iso(b.resume_at) };
        if (b.worker_until !== null && b.worker_until > clock && b.worker_id !== a.p_worker_id) return { state: 'busy' };

        for (const r of b.recipients) {
          // Claimed and never reported (the worker died): not sent again automatically.
          if (r.status === 'sending' && r.locked_until !== null && r.locked_until < clock) {
            r.status = 'failed';
            r.last_error = 'interrupted';
            r.locked_until = null;
          }
          // Left or blocked the bot since the broadcast started.
          if (r.status === 'pending' && this.subscribers.get(`${shop.id}/${b.bot_id}/${r.tg_user_id}`)?.status !== 'active') {
            r.status = 'cancelled';
            r.last_error = 'unsubscribed';
          }
        }
        const limit = Math.min(Math.max(Number(a.p_limit ?? 20), 1), 30);
        const picked = b.recipients
          .filter((r) => r.status === 'pending' && r.next_attempt_at <= clock)
          .sort((x, y) => x.next_attempt_at - y.next_attempt_at || x.tg_user_id - y.tg_user_id)
          .slice(0, limit);
        if (picked.length === 0) {
          if (!b.recipients.some((r) => r.status === 'pending' || r.status === 'sending')) {
            this.finish(b, 'completed', null);
            return { state: 'done' };
          }
          return { state: 'waiting' };
        }
        for (const r of picked) {
          r.status = 'sending';
          r.attempts += 1;
          r.locked_until = clock + 180_000;
        }
        b.worker_id = String(a.p_worker_id);
        b.worker_until = clock + 90_000;
        return {
          state: 'send',
          bot_token: shop.bot.token,
          shop: { slug: shop.slug, name: shop.name },
          broadcast: {
            id: b.id,
            message_text: b.message_text,
            photo_path: b.photo_path,
            photo_file_id: b.photo_file_id,
            button_text: b.button_text,
            button_emoji_id: b.button_emoji_id,
          },
          recipients: picked.sort((x, y) => x.tg_user_id - y.tg_user_id).map((r) => ({ tg_user_id: r.tg_user_id, chat_id: r.chat_id, attempt: r.attempts })),
        };
      }
      case 'broadcast_report': {
        const b = this.broadcasts.find((x) => x.id === a.p_broadcast_id);
        if (!b) return null;
        for (const item of (a.p_results ?? []) as Array<{ tg_user_id: number; outcome: string; message_id?: number; error?: string }>) {
          // Only a row this batch still holds.
          const r = b.recipients.find((x) => x.tg_user_id === item.tg_user_id && x.status === 'sending');
          if (!r || !['sent', 'blocked', 'failed', 'retry', 'release'].includes(item.outcome)) continue;
          const failure = () => (item.error ?? 'unknown_error').slice(0, 300);
          r.locked_until = null;
          r.next_attempt_at = clock;
          if (item.outcome === 'sent') {
            r.status = 'sent';
            r.message_id = item.message_id ?? null;
            r.last_error = null;
          } else if (item.outcome === 'release') {
            // Not attempted: back to the queue, the attempt is not counted.
            r.status = 'pending';
            r.attempts = Math.max(r.attempts - 1, 0);
            r.last_error = null;
          } else if (item.outcome === 'retry') {
            // Backoff 20 s, 40 s; at most 3 attempts.
            r.status = r.attempts >= 3 ? 'failed' : 'pending';
            r.next_attempt_at = clock + 20_000 * 2 ** Math.max(r.attempts - 1, 0);
            r.last_error = failure();
          } else {
            r.status = item.outcome === 'blocked' ? 'blocked' : 'failed';
            r.last_error = failure();
            const subscriber = this.subscribers.get(`${b.shop_id}/${b.bot_id}/${r.tg_user_id}`);
            if (item.outcome === 'blocked' && subscriber) subscriber.status = 'blocked';
          }
        }
        const retryAfter = Number(a.p_retry_after ?? 0);
        // Telegram's flood control pauses the WHOLE broadcast.
        if (retryAfter > 0) b.resume_at = clock + (Math.min(retryAfter, 3600) + 1) * 1000;
        b.photo_file_id ??= trimmed(a.p_photo_file_id);
        if (b.worker_id === a.p_worker_id) b.worker_until = null;
        if (b.status !== 'sending') {
          for (const r of b.recipients) if (r.status === 'pending') r.status = 'cancelled';
        } else if (!b.recipients.some((r) => r.status === 'pending' || r.status === 'sending')) {
          this.finish(b, 'completed', null);
        }
        return this.json(b);
      }
      case 'broadcast_cancel': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const b = this.broadcasts.find((x) => x.id === a.p_broadcast_id && x.shop_id === shop.id);
        if (!b) throw new Error('broadcast_not_found');
        this.finish(b, 'cancelled', trimmed(a.p_reason));
        return this.json(b);
      }
      case 'broadcast_retry_failed': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const b = this.broadcasts.find((x) => x.id === a.p_broadcast_id && x.shop_id === shop.id);
        if (!b) throw new Error('broadcast_not_found');
        if (b.created_at < clock - 48 * HOUR) throw new Error('broadcast_expired');
        if (b.status !== 'sending' && this.broadcasts.some((x) => x.shop_id === shop.id && x.status === 'sending')) throw new Error('broadcast_in_progress');
        // Failed sends only — a blocked user is never written to again.
        const failed = b.recipients.filter((r) => r.status === 'failed');
        for (const r of failed) {
          r.status = 'pending';
          r.attempts = 0;
          r.next_attempt_at = clock;
          r.last_error = null;
          r.locked_until = null;
        }
        if (failed.length > 0 && b.status !== 'sending') {
          b.status = 'sending';
          b.completed_at = null;
          b.last_error = null;
          b.resume_at = null;
        }
        return { retried: failed.length, broadcast: this.json(b) };
      }
      default:
        throw new Error(`unknown rpc ${fn}`);
    }
  }
}

// ---- Scripted Telegram ------------------------------------------------------------------------------------------

interface TgRequest {
  token: string;
  method: string;
  chat: number;
  /** `text` (sendMessage) or `caption` (sendPhoto). */
  text: string;
  /** `entities` / `caption_entities`; null when absent. */
  entities: unknown;
  reply_markup: unknown;
  parse_mode: unknown;
  /** sendPhoto: an uploaded file (its size) or a file_id. */
  photo: { upload_bytes: number } | { file_id: string } | null;
  /** Clock time of the request. */
  at: number;
  /** true: Telegram accepted it — the user got the message. */
  ok: boolean;
}
/** status 0: the request does not reach Telegram (network error). */
interface TgFailure {
  status: number;
  description?: string;
  retry_after?: number;
}

class FakeTelegram {
  requests: TgRequest[] = [];
  /** The bot's owner has no Telegram Premium: a message with custom emoji is refused (400). */
  noCustomEmoji = false;
  /** The token was revoked in BotFather: every request answers 401. */
  revoked = false;
  /** How long one request takes on the fake clock. */
  latencyMs = 0;
  private failures = new Map<number, TgFailure[]>();
  private nextMessageId = 1;

  /** The next requests to this chat are answered with these failures, in order; after them requests succeed. */
  fail(chat: number, ...failures: TgFailure[]): void {
    this.failures.set(chat, [...(this.failures.get(chat) ?? []), ...failures]);
  }

  /** What users actually received. */
  delivered(): TgRequest[] {
    return this.requests.filter((r) => r.ok);
  }

  fetch: typeof fetch = async (input, init) => {
    const m = /\/bot(\d+:[A-Za-z0-9_-]+)\/(\w+)$/.exec(String(input));
    if (!m) throw new Error(`unexpected request: ${String(input)}`);
    const body: Record<string, unknown> = {};
    if (init?.body instanceof FormData) {
      // An upload: multipart/form-data, objects JSON-serialized, the file as a part.
      for (const [key, value] of init.body.entries()) body[key] = typeof value === 'string' ? value : { upload_bytes: value.size };
      for (const key of ['reply_markup', 'caption_entities']) if (typeof body[key] === 'string') body[key] = JSON.parse(body[key] as string);
    } else {
      Object.assign(body, JSON.parse(String(init?.body ?? '{}')));
    }
    const isPhoto = m[2] === 'sendPhoto';
    const request: TgRequest = {
      token: m[1]!,
      method: m[2]!,
      chat: Number(body.chat_id),
      text: String((isPhoto ? body.caption : body.text) ?? ''),
      entities: (isPhoto ? body.caption_entities : body.entities) ?? null,
      reply_markup: body.reply_markup ?? null,
      parse_mode: body.parse_mode,
      photo: !isPhoto ? null : typeof body.photo === 'string' ? { file_id: body.photo } : (body.photo as { upload_bytes: number }),
      at: clock,
      ok: false,
    };
    this.requests.push(request);
    clock += this.latencyMs;

    const refuse = (status: number, description: string, retryAfter?: number) =>
      new Response(JSON.stringify({ ok: false, error_code: status, description, ...(retryAfter === undefined ? {} : { parameters: { retry_after: retryAfter } }) }), { status });
    if (this.revoked) return refuse(401, 'Unauthorized');
    const failure = this.failures.get(request.chat)?.shift();
    if (failure) {
      if (failure.status === 0) throw new TypeError('fetch failed');
      return refuse(failure.status, failure.description ?? 'Internal Server Error', failure.retry_after);
    }
    // Entity type "custom_emoji" in the text, or icon_custom_emoji_id on a button.
    if (this.noCustomEmoji && JSON.stringify([request.entities, request.reply_markup]).includes('custom_emoji')) {
      return refuse(400, 'Bad Request: custom emoji are not available for this bot');
    }
    request.ok = true;
    const messageId = this.nextMessageId++;
    const result: Record<string, unknown> = { message_id: messageId };
    if (request.photo) {
      // An upload gets a new file_id; a file_id is echoed back. The last size is the largest, like Telegram.
      const fileId = 'file_id' in request.photo ? request.photo.file_id : `file-${messageId}`;
      result.photo = [{ file_id: `${fileId}-s` }, { file_id: fileId }];
    }
    return new Response(JSON.stringify({ ok: true, result }));
  };
}

// ---- Helpers ----------------------------------------------------------------------------------------------------

const PHOTO_BYTES = 4;
let db: FakeDb;
let tg: FakeTelegram;
let deps: BroadcastDeps;
let photoLoads: string[];
let removedPhotos: string[];
let logs: string[];

function makeDeps(over: Partial<BroadcastDeps> = {}): BroadcastDeps {
  return {
    rpc: db.rpc,
    apiBase: 'http://telegram.test',
    fetchImpl: tg.fetch,
    publicAppUrl: PUBLIC,
    functionsBaseUrl: 'https://ref.supabase.co/functions/v1',
    loadPhoto: async (path) => {
      photoLoads.push(path);
      return new Blob([new Uint8Array(PHOTO_BYTES)], { type: 'image/jpeg' });
    },
    removePhotos: async (paths) => {
      removedPhotos.push(...paths);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    newWorkerId: () => randomUUID(),
    log: (message) => logs.push(message),
    ...over,
  };
}

beforeEach(() => {
  clock = T0;
  db = new FakeDb();
  tg = new FakeTelegram();
  photoLoads = [];
  removedPhotos = [];
  logs = [];
  deps = makeDeps();
});

const start = (shop: TestShop, over: Partial<StartBroadcastInput> = {}) =>
  startBroadcast(deps, { shopId: shop.id, actor: shop.actor, idempotencyKey: randomUUID(), text: 'Скидки сегодня!', ...over });
/** One worker step, as the admin page calls it. */
const run = (shop: TestShop, budgetMs?: number) => runBroadcast(deps, shop.id, shop.actor, budgetMs);
const noirVapor = () => db.addShop('noir-vapor', 'Noir Vapor');
const STORE = `${PUBLIC}/s/noir-vapor/`;

async function expectFlowError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

// ---- Tests ------------------------------------------------------------------------------------------------------

describe('content of a broadcast', () => {
  it('the shop name is substituted and <tg-emoji> tags become entities; nothing else is interpreted', () => {
    expect(renderBroadcast(`${tag(FIRE, '🔥')} Скидки в {название_магазина}`, 'Noir Vapor')).toEqual({
      text: '🔥 Скидки в Noir Vapor',
      entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: FIRE }],
    });
    expect(renderBroadcast('<b>{название_магазина}</b> &amp; друзья', 'Noir <i>Vapor</i>')).toEqual({ text: '<b>Noir <i>Vapor</i></b> &amp; друзья', entities: [] });
  });

  it('the keyboard is one web_app button to the storefront, with an optional Premium emoji icon', () => {
    expect(buildBroadcastKeyboard('Каталог', null, STORE)).toEqual({ inline_keyboard: [[{ text: 'Каталог', web_app: { url: STORE } }]] });
    expect(buildBroadcastKeyboard('Каталог', FIRE, STORE)).toEqual({ inline_keyboard: [[{ text: 'Каталог', web_app: { url: STORE }, icon_custom_emoji_id: FIRE }]] });
    // No button text, or no public storefront address: no keyboard at all.
    expect(buildBroadcastKeyboard(null, FIRE, STORE)).toBeNull();
    expect(buildBroadcastKeyboard('Каталог', null, null)).toBeNull();
  });

  it('the limits shown to the owner are Telegram’s', () => {
    expect(BROADCAST_LIMITS).toEqual({ text: 4096, caption: 1024, button: 64 });
  });
});

describe('startBroadcast', () => {
  it("the recipients are the ACTIVE users of the shop's CURRENT bot — chosen by the database, never by the request", async () => {
    const A = noirVapor();
    // Users of the bot the shop had before it connected the current one.
    db.subscribe(A, 2);
    db.replaceBot(A);
    const active = db.subscribe(A, 3);
    db.subscribe(A, 2, 'unsubscribed');
    db.subscribe(A, 1, 'blocked');
    const B = db.addShop('mint-lab', 'Mint Lab');
    db.subscribe(B, 4);

    const res = await start(A, { button: { text: ' Каталог ' } });
    expect(res).toMatchObject({ replayed: false, storefront_url: STORE, limits: BROADCAST_LIMITS });
    expect(res.overview.audience).toEqual({ active: 3, unsubscribed: 2, blocked: 1 });
    expect(res.overview.active).toMatchObject({
      status: 'sending',
      message_text: 'Скидки сегодня!',
      total: 3,
      counts: { pending: 3, sent: 0, failed: 0, blocked: 0, cancelled: 0 },
      button_text: 'Каталог',
      button_emoji_id: null,
      photo_path: null,
    });
    expect(db.recipients(A).map((r) => r.tg_user_id).sort(asc)).toEqual(active);
    // The request carries the content only: there is no parameter a chat id could travel in.
    const args = db.calls.find((c) => c.fn === 'broadcast_start')!.args;
    expect(Object.keys(args).sort()).toEqual(['p_actor', 'p_button_emoji_id', 'p_button_text', 'p_idempotency_key', 'p_message_text', 'p_photo_path', 'p_shop_id']);

    await run(A);
    expect(tg.requests.map((r) => r.chat).sort(asc)).toEqual(active);
    expect(new Set(tg.requests.map((r) => r.token))).toEqual(new Set([A.bot!.token]));
  });

  it('validates the content before anything is queued', async () => {
    const A = noirVapor();
    db.subscribe(A, 2);
    const B = db.addShop('mint-lab', 'Mint Lab');
    const many = (n: number) => Array.from({ length: n }, () => tag('11111', '🔥')).join('');

    await expectFlowError(start(A, { idempotencyKey: 'not-a-uuid' }), 'invalid_broadcast');
    await expectFlowError(start(A, { text: '  \n ' }), 'invalid_broadcast_text');
    await expectFlowError(start(A, { text: 'x'.repeat(4097) }), 'invalid_broadcast_text');
    await expect(start(A, { text: many(101) })).rejects.toMatchObject({ code: 'too_many_custom_emoji', status: 400, details: { max: 100 } });
    await expectFlowError(start(A, { button: { text: '  ' } }), 'invalid_broadcast_button');
    await expectFlowError(start(A, { button: { text: 'x'.repeat(65) } }), 'invalid_broadcast_button');
    await expectFlowError(start(A, { button: { text: 'Каталог', emojiId: 'abc' } }), 'invalid_emoji_id');
    // A photo must be this shop's own uploaded broadcast photo.
    await expectFlowError(start(A, { photoPath: db.upload(B) }), 'invalid_broadcast_photo');
    await expectFlowError(start(A, { photoPath: `${A.id}/broadcast/${randomUUID()}.jpg` }), 'invalid_broadcast_photo');
    await expectFlowError(start(A, { photoPath: `${A.id}/products/${randomUUID()}.jpg` }), 'invalid_broadcast_photo');
    // The button opens the storefront: without a public address it would lead nowhere.
    deps = makeDeps({ publicAppUrl: undefined });
    await expect(start(A, { button: { text: 'Каталог' } })).rejects.toMatchObject({ code: 'public_url_not_configured', status: 503 });
    // A shop without a connected bot has nobody to write to.
    await expect(start(db.addShop('no-bot', 'No Bot', false))).rejects.toMatchObject({ code: 'not_connected', status: 404 });

    expect(db.broadcasts).toEqual([]);
    expect(tg.requests).toEqual([]);
    // A message without a button needs no storefront address.
    const ok = await start(A);
    expect(ok.storefront_url).toBeNull();
    expect(ok.overview.active!.total).toBe(2);
  });

  it('the length limit applies to the message as sent: 4096 characters of text, 1024 of a photo caption', async () => {
    const L = db.addShop('long-name', 'N'.repeat(80));
    db.subscribe(L, 1);
    // The template fits (4069), the message with the shop name substituted (4130) does not: refused, never cut.
    await expect(start(L, { text: `${'x'.repeat(4050)}{название_магазина}` })).rejects.toMatchObject({ code: 'broadcast_too_long', status: 400, details: { max: 4096 } });
    const photo = db.upload(L);
    await expect(start(L, { text: 'x'.repeat(1025), photoPath: photo })).rejects.toMatchObject({ code: 'broadcast_too_long', details: { max: 1024 } });
    expect(db.broadcasts).toEqual([]);

    // A Premium emoji tag (54 characters) counts as the one emoji inside it: 1022 + 2 = 1024.
    const caption = `${'x'.repeat(1022)}${tag(FIRE, '🔥')}`;
    const res = await start(L, { text: caption, photoPath: photo });
    expect(res.overview.active).toMatchObject({ message_text: caption, photo_path: photo, total: 1 });
  });

  it('the same request never starts a second broadcast; another one has to wait for the running one', async () => {
    const A = noirVapor();
    db.subscribe(A, 2);
    const key = randomUUID();
    const first = await start(A, { idempotencyKey: key });
    expect(first.replayed).toBe(false);

    const again = await start(A, { idempotencyKey: key, text: 'Другой текст' });
    expect(again.replayed).toBe(true);
    expect(again.overview.active).toMatchObject({ id: first.overview.active!.id, message_text: 'Скидки сегодня!' });
    expect(db.broadcasts).toHaveLength(1);
    await expect(start(A)).rejects.toMatchObject({ code: 'broadcast_in_progress', status: 409 });

    await run(A);
    // A late retry of the first request after the broadcast is over still does not send it again.
    expect((await start(A, { idempotencyKey: key })).replayed).toBe(true);
    expect((await run(A)).worker).toEqual({ state: 'done', sent: 0 });
    expect(tg.requests).toHaveLength(2);
  });

  it('nobody started the bot, or everybody left: no_recipients — and nothing is left behind', async () => {
    const A = noirVapor();
    db.subscribe(A, 1, 'unsubscribed');
    db.subscribe(A, 1, 'blocked');
    await expect(start(A)).rejects.toMatchObject({ code: 'no_recipients', status: 409 });
    expect(db.broadcasts).toEqual([]);
  });

  it('at most 10 broadcasts of a shop in 24 hours', async () => {
    const A = noirVapor();
    db.subscribe(A, 1);
    for (let i = 0; i < 10; i++) {
      const b = await start(A);
      await cancelBroadcast(deps, A.id, A.actor, b.overview.active!.id);
      clock += 60_000;
    }
    await expect(start(A)).rejects.toMatchObject({ code: 'broadcast_rate_limited', status: 429 });
    clock += 24 * HOUR;
    expect((await start(A)).replayed).toBe(false);
    expect(tg.requests).toEqual([]);
  });

  it('photos of broadcasts that left the history are removed; a failed cleanup never fails the start', async () => {
    const A = noirVapor();
    db.subscribe(A, 1);
    const oldPhoto = db.upload(A);
    db.seedHistory(A, 30, oldPhoto);
    await start(A);
    expect(removedPhotos).toEqual([oldPhoto]);
    expect(db.broadcasts.filter((b) => b.shop_id === A.id)).toHaveLength(30);

    const B = db.addShop('mint-lab', 'Mint Lab');
    db.subscribe(B, 1);
    db.seedHistory(B, 30, db.upload(B));
    deps = makeDeps({
      removePhotos: async () => {
        throw new Error('storage is down');
      },
    });
    expect((await start(B)).overview.active!.total).toBe(1);
    expect(logs).toContain('broadcast: old photos not removed');
  });
});

describe('runBroadcast', () => {
  it('delivers the message once to every recipient: shop name substituted, Premium emoji, the Mini App button of THIS shop, no parse mode', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 3);
    await start(A, { text: `Скидки в {название_магазина} ${tag(FIRE, '🔥')}`, button: { text: 'Открыть каталог', emojiId: HAND } });
    const res = await run(A);

    expect(res.worker).toEqual({ state: 'done', sent: 3 });
    expect(res.overview.active).toBeNull();
    expect(res.overview.history[0]).toMatchObject({ status: 'completed', total: 3, counts: { pending: 0, sent: 3, failed: 0, blocked: 0, cancelled: 0 }, last_error: null });
    expect(res.overview.history[0]!.completed_at).not.toBeNull();

    const text = 'Скидки в Noir Vapor 🔥';
    expect(tg.requests.map((r) => r.chat)).toEqual(users);
    for (const r of tg.requests) {
      expect(r).toMatchObject({ token: A.bot!.token, method: 'sendMessage', text, photo: null, ok: true });
      expect(r.parse_mode).toBeUndefined();
      expect(r.entities).toEqual([{ type: 'custom_emoji', offset: text.indexOf('🔥'), length: 2, custom_emoji_id: FIRE }]);
      expect(r.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Открыть каталог', web_app: { url: STORE }, icon_custom_emoji_id: HAND }]] });
    }
    // Neither the bot's token nor a recipient leaves the worker: the owner sees counts only.
    const out = JSON.stringify(res);
    expect(out).not.toContain(A.bot!.token.split(':')[1]);
    for (const user of users) expect(out).not.toContain(String(user));
    expect(logs.join('\n')).not.toContain(A.bot!.token.split(':')[1]);

    // A further call finds nothing to do.
    expect((await run(A)).worker).toEqual({ state: 'done', sent: 0 });
    expect(tg.requests).toHaveLength(3);
  });

  it('with nothing running it answers "done" without claiming anything', async () => {
    const A = noirVapor();
    db.subscribe(A, 2);
    expect((await run(A)).worker).toEqual({ state: 'done', sent: 0 });
    expect(db.calls.map((c) => c.fn)).not.toContain('broadcast_claim');
    expect(tg.requests).toEqual([]);
  });

  it(`keeps at least ${MIN_SEND_INTERVAL_MS} ms between two sends (at most 20 messages per second) and stops at its time budget; the next call continues`, async () => {
    const A = noirVapor();
    db.subscribe(A, 200);
    await start(A);

    const first = await run(A);
    // 9 batches of 20: the batch that crosses the budget is finished, no new one is claimed.
    expect(first.worker).toEqual({ state: 'send', sent: 180 });
    expect(first.overview.active).toMatchObject({ status: 'sending', counts: { pending: 20, sent: 180 } });
    const times = tg.requests.map((r) => r.at);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(MIN_SEND_INTERVAL_MS);
    for (let i = 20; i < times.length; i++) expect(times[i]! - times[i - 20]!, 'no more than 20 messages in any second').toBeGreaterThanOrEqual(1000);
    expect(times.at(-1)! - times[0]!).toBeLessThan(RUN_BUDGET_MS + 1000);

    const second = await run(A);
    expect(second.worker).toEqual({ state: 'done', sent: 20 });
    expect(second.overview.history[0]).toMatchObject({ status: 'completed', counts: { pending: 0, sent: 200 } });
    // Nobody got it twice.
    expect(tg.requests).toHaveLength(200);
    expect(new Set(tg.requests.map((r) => r.chat)).size).toBe(200);
  });

  it('a claimed batch that ran out of time is given back — not counted as an attempt, and nobody gets the message twice', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 20);
    await start(A);
    // Telegram answers slowly: 2 s per message.
    tg.latencyMs = 2000;
    const first = await run(A);
    expect(first.worker).toEqual({ state: 'send', sent: 13 });
    expect(first.overview.active!.counts).toMatchObject({ pending: 7, sent: 13 });
    expect(db.recipients(A).filter((r) => r.status === 'pending').map((r) => r.attempts)).toEqual([0, 0, 0, 0, 0, 0, 0]);

    tg.latencyMs = 0;
    const second = await run(A);
    expect(second.worker).toEqual({ state: 'done', sent: 7 });
    expect(tg.requests.map((r) => r.chat)).toEqual(users);
  });

  it('Telegram flood control (429) pauses the WHOLE broadcast for retry_after; what was not attempted goes back without an attempt', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 5);
    tg.fail(users[2]!, { status: 429, description: 'Too Many Requests: retry after 7', retry_after: 7 });
    await start(A);

    const res = await run(A);
    expect(res.worker).toEqual({ state: 'paused', sent: 2 });
    // The two recipients after the refused one were not even attempted.
    expect(tg.requests.map((r) => r.chat)).toEqual(users.slice(0, 3));
    expect(res.overview.active).toMatchObject({ status: 'sending', counts: { pending: 3, sent: 2, failed: 0 } });
    // retry_after and one second on top.
    expect(Date.parse(res.overview.active!.resume_at!) - clock).toBe(8000);
    expect(db.recipients(A).filter((r) => r.status === 'pending').map((r) => r.attempts)).toEqual([0, 0, 0]);

    // Called again too early (another tab, an impatient click): still paused, nothing is sent.
    clock += 3000;
    expect((await run(A)).worker).toEqual({ state: 'paused', sent: 0 });
    expect(tg.requests).toHaveLength(3);

    clock += 5001;
    const done = await run(A);
    expect(done.worker).toEqual({ state: 'done', sent: 3 });
    expect(done.overview.history[0]).toMatchObject({ status: 'completed', resume_at: null, counts: { pending: 0, sent: 5, failed: 0 } });
    // Everybody got it exactly once.
    expect(tg.delivered().map((r) => r.chat).sort(asc)).toEqual(users);
  });

  it('a 429 without retry_after waits 5 seconds by default', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 2);
    tg.fail(users[0]!, { status: 429, description: 'Too Many Requests' });
    await start(A);
    const res = await run(A);
    expect(res.worker).toEqual({ state: 'paused', sent: 0 });
    expect(Date.parse(res.overview.active!.resume_at!) - clock).toBe(6000);
  });

  it('a user who blocked the bot, deleted the account or whose chat is gone is marked blocked: never retried, left out of the next broadcast', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 4);
    tg.fail(users[0]!, { status: 403, description: 'Forbidden: bot was blocked by the user' });
    tg.fail(users[1]!, { status: 403, description: 'Forbidden: user is deactivated' });
    tg.fail(users[2]!, { status: 400, description: 'Bad Request: chat not found' });
    await start(A);

    const res = await run(A);
    expect(res.worker).toEqual({ state: 'done', sent: 1 });
    const broadcast = res.overview.history[0]!;
    expect(broadcast).toMatchObject({ status: 'completed', counts: { pending: 0, sent: 1, failed: 0, blocked: 3 } });
    expect(res.overview.audience).toEqual({ active: 1, unsubscribed: 0, blocked: 3 });
    expect(tg.requests).toHaveLength(4);
    // «Повторить неудачные» never brings a blocked user back.
    expect((await retryBroadcast(deps, A.id, A.actor, broadcast.id)).retried).toBe(0);

    clock += 60_000;
    const next = await start(A, { text: 'Вторая рассылка' });
    expect(next.overview.active!.total).toBe(1);
    await run(A);
    expect(tg.requests.slice(4).map((r) => r.chat)).toEqual([users[3]]);
  });

  it('a transient failure (5xx, network) is retried with backoff — at most 3 attempts, then the send is failed', async () => {
    const A = noirVapor();
    const [flaky, down, fine] = db.subscribe(A, 3) as [number, number, number];
    tg.fail(flaky, { status: 502, description: 'Bad Gateway' });
    tg.fail(down, { status: 0 }, { status: 500, description: 'Internal Server Error' }, { status: 503, description: 'Service Unavailable' });
    await start(A);

    const first = await run(A);
    expect(first.worker).toEqual({ state: 'waiting', sent: 1 });
    expect(first.overview.active!.counts).toMatchObject({ pending: 2, sent: 1, failed: 0 });
    expect(tg.delivered().map((r) => r.chat)).toEqual([fine]);

    // The retry is due in 20 s: before that nothing is sent.
    clock += 10_000;
    expect((await run(A)).worker).toEqual({ state: 'waiting', sent: 0 });
    clock += 10_001;
    const second = await run(A);
    expect(second.worker).toEqual({ state: 'waiting', sent: 1 });
    expect(tg.delivered().map((r) => r.chat)).toEqual([fine, flaky]);

    // The third attempt is due 40 s after the second one.
    clock += 30_000;
    expect((await run(A)).worker).toEqual({ state: 'waiting', sent: 0 });
    clock += 11_000;
    const third = await run(A);
    expect(third.worker).toEqual({ state: 'done', sent: 0 });
    expect(third.overview.history[0]).toMatchObject({ status: 'completed', counts: { pending: 0, sent: 2, failed: 1, blocked: 0 } });
    expect(tg.requests.filter((r) => r.chat === down)).toHaveLength(3);
    expect(db.recipients(A).find((r) => r.tg_user_id === down)).toMatchObject({ status: 'failed', attempts: 3, last_error: 'telegram_unavailable' });
    // Not blocked: a failure of Telegram says nothing about the user.
    expect(third.overview.audience).toEqual({ active: 3, unsubscribed: 0, blocked: 0 });
  });

  it('a permanent error fails only that recipient; «Повторить неудачные» puts failed sends back into the queue', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 3);
    tg.fail(users[1]!, { status: 400, description: 'Bad Request: message is too long' });
    await start(A);

    const res = await run(A);
    expect(res.worker).toEqual({ state: 'done', sent: 2 });
    const broadcast = res.overview.history[0]!;
    expect(broadcast).toMatchObject({ status: 'completed', counts: { sent: 2, failed: 1 } });
    // Not retried on its own.
    expect(tg.requests.filter((r) => r.chat === users[1])).toHaveLength(1);
    expect(db.recipients(A).find((r) => r.tg_user_id === users[1])!.last_error).toBe('telegram_bad_request: Bad Request: message is too long');

    const retried = await retryBroadcast(deps, A.id, A.actor, broadcast.id);
    expect(retried.retried).toBe(1);
    expect(retried.overview.active).toMatchObject({ id: broadcast.id, status: 'sending', counts: { pending: 1, sent: 2, failed: 0 } });
    expect((await run(A)).worker).toEqual({ state: 'done', sent: 1 });
    // Only the failed recipient was written to again.
    expect(tg.requests).toHaveLength(4);
    expect(tg.delivered().map((r) => r.chat).sort(asc)).toEqual(users);
    expect((await retryBroadcast(deps, A.id, A.actor, broadcast.id)).retried).toBe(0);

    // An old broadcast can not be woken up.
    clock += 49 * HOUR;
    await expect(retryBroadcast(deps, A.id, A.actor, broadcast.id)).rejects.toMatchObject({ code: 'broadcast_expired', status: 409 });
  });

  it('a bot that may not use Premium emoji: the first refusal switches the rest of the run to the Unicode fallback', async () => {
    const A = noirVapor();
    const [u1, u2, u3] = db.subscribe(A, 3) as [number, number, number];
    tg.noCustomEmoji = true;
    await start(A, { text: `Скидки ${tag(FIRE, '🔥')}`, button: { text: 'Каталог', emojiId: HAND } });

    const res = await run(A);
    expect(res.worker).toEqual({ state: 'done', sent: 3 });
    expect(res.overview.history[0]!.counts).toMatchObject({ sent: 3, failed: 0 });
    // First recipient: the Premium version is refused, the plain one is delivered. Everyone after: plain right away.
    expect(tg.requests.map((r) => [r.chat, r.ok])).toEqual([[u1, false], [u1, true], [u2, true], [u3, true]]);
    expect(tg.requests[0]).toMatchObject({
      entities: [{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: FIRE }],
      reply_markup: { inline_keyboard: [[{ text: 'Каталог', web_app: { url: STORE }, icon_custom_emoji_id: HAND }]] },
    });
    for (const r of tg.delivered()) {
      expect(r.text).toBe('Скидки 🔥');
      expect(r.entities).toBeNull();
      expect(r.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Каталог', web_app: { url: STORE } }]] });
    }
  });

  it('a photo is uploaded once: the first send carries the file, every other one — and the next worker call — its file_id', async () => {
    const A = noirVapor();
    db.subscribe(A, 25);
    const path = db.upload(A);
    await start(A, { text: 'Новинка в {название_магазина}', photoPath: path, button: { text: 'Смотреть' } });

    // A short budget: one batch of 20.
    const first = await run(A, 500);
    expect(first.worker).toEqual({ state: 'send', sent: 20 });
    expect(photoLoads).toEqual([path]);
    expect(tg.requests[0]).toMatchObject({ method: 'sendPhoto', text: 'Новинка в Noir Vapor', photo: { upload_bytes: PHOTO_BYTES } });
    expect(tg.requests[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Смотреть', web_app: { url: STORE } }]] });
    for (const r of tg.requests.slice(1)) expect(r).toMatchObject({ method: 'sendPhoto', text: 'Новинка в Noir Vapor', photo: { file_id: 'file-1' } });

    const second = await run(A);
    expect(second.worker).toEqual({ state: 'done', sent: 5 });
    // Not read from Storage again: the file_id was kept with the broadcast.
    expect(photoLoads).toEqual([path]);
    expect(tg.requests).toHaveLength(25);
    for (const r of tg.requests.slice(20)) expect(r.photo).toEqual({ file_id: 'file-1' });
  });

  it("the bot's token was revoked: the broadcast stops itself and nothing more is attempted", async () => {
    const A = noirVapor();
    db.subscribe(A, 5);
    await start(A);
    tg.revoked = true;

    const res = await run(A);
    expect(res.worker).toEqual({ state: 'done', sent: 0 });
    expect(tg.requests).toHaveLength(1);
    expect(res.overview.active).toBeNull();
    expect(res.overview.history[0]).toMatchObject({ status: 'cancelled', last_error: 'telegram_unauthorized', counts: { pending: 0, sent: 0, failed: 0, cancelled: 5 } });
    // Nobody is marked blocked because of the shop's own token.
    expect(res.overview.audience).toEqual({ active: 5, unsubscribed: 0, blocked: 0 });
  });

  it('one worker at a time; a batch whose worker died is NOT sent again on its own — only the owner can retry it', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 3);
    const id = (await start(A)).overview.active!.id;
    // Another tab claimed two recipients and holds the lease.
    const other = await db.rpc('broadcast_claim', { p_shop_id: A.id, p_actor: A.actor, p_broadcast_id: id, p_worker_id: randomUUID(), p_limit: 2 });
    expect(other.data).toMatchObject({ state: 'send', recipients: [{ tg_user_id: users[0] }, { tg_user_id: users[1] }] });

    expect((await run(A)).worker).toEqual({ state: 'busy', sent: 0 });
    expect(tg.requests).toEqual([]);

    // That tab was closed mid-send. Its lease runs out after 90 s: the rest of the queue goes on…
    clock += 91_000;
    expect((await run(A)).worker).toEqual({ state: 'waiting', sent: 1 });
    expect(tg.requests.map((r) => r.chat)).toEqual([users[2]]);
    // …but whether its two messages were delivered is unknown, so they are never repeated automatically.
    clock += 100_000;
    const res = await run(A);
    expect(res.worker).toEqual({ state: 'done', sent: 0 });
    expect(res.overview.history[0]).toMatchObject({ status: 'completed', counts: { pending: 0, sent: 1, failed: 2 } });
    expect(db.recipients(A).filter((r) => r.status === 'failed').map((r) => r.last_error)).toEqual(['interrupted', 'interrupted']);
    expect(tg.requests).toHaveLength(1);

    expect((await retryBroadcast(deps, A.id, A.actor, id)).retried).toBe(2);
    expect((await run(A)).worker).toEqual({ state: 'done', sent: 2 });
    expect(tg.requests.map((r) => r.chat).sort(asc)).toEqual(users);
  });

  it('«Остановить»: what was not sent yet is dropped, and a later worker call sends nothing', async () => {
    const A = noirVapor();
    db.subscribe(A, 30);
    const id = (await start(A)).overview.active!.id;
    await run(A, 500);
    expect(tg.requests).toHaveLength(20);

    const cancelled = await cancelBroadcast(deps, A.id, A.actor, id);
    expect(cancelled.overview.active).toBeNull();
    expect(cancelled.overview.history[0]).toMatchObject({ id, status: 'cancelled', last_error: null, counts: { pending: 0, sent: 20, cancelled: 10 } });
    expect((await run(A)).worker).toEqual({ state: 'done', sent: 0 });
    expect(tg.requests).toHaveLength(20);

    // The next broadcast may start right away.
    clock += 1000;
    expect((await start(A, { text: 'Новая' })).overview.active!.total).toBe(30);
  });

  it('a user who sent /stop or blocked the bot after the broadcast started is not written to', async () => {
    const A = noirVapor();
    const users = db.subscribe(A, 4);
    await start(A);
    db.setStatus(A, users[1]!, 'unsubscribed');
    db.setStatus(A, users[2]!, 'blocked');

    const res = await run(A);
    expect(res.worker).toEqual({ state: 'done', sent: 2 });
    expect(tg.requests.map((r) => r.chat)).toEqual([users[0], users[3]]);
    expect(res.overview.history[0]).toMatchObject({ status: 'completed', counts: { sent: 2, cancelled: 2, failed: 0 } });
  });

  it('the shop connected another bot meanwhile: the broadcast is cancelled — the new bot never writes to the old audience', async () => {
    const A = noirVapor();
    db.subscribe(A, 3);
    await start(A);
    db.replaceBot(A);

    const res = await run(A);
    expect(res.worker).toEqual({ state: 'done', sent: 0 });
    expect(tg.requests).toEqual([]);
    expect(res.overview.history[0]).toMatchObject({ status: 'cancelled', last_error: 'bot_changed', counts: { sent: 0, cancelled: 3 } });
    expect(res.overview.audience).toEqual({ active: 0, unsubscribed: 0, blocked: 0 });
  });
});

describe('tenant isolation', () => {
  it("the owner of another shop can neither see, start, run, stop nor retry this shop's broadcast", async () => {
    const A = noirVapor();
    db.subscribe(A, 3);
    const B = db.addShop('mint-lab', 'Mint Lab');
    const [buyerOfB] = db.subscribe(B, 1);
    const id = (await start(A)).overview.active!.id;

    const attempts: Array<() => Promise<unknown>> = [
      () => getBroadcast(deps, A.id, B.actor),
      () => startBroadcast(deps, { shopId: A.id, actor: B.actor, idempotencyKey: randomUUID(), text: 'Чужая' }),
      () => runBroadcast(deps, A.id, B.actor),
      () => cancelBroadcast(deps, A.id, B.actor, id),
      () => retryBroadcast(deps, A.id, B.actor, id),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    // Their own shop, but shop A's broadcast id.
    await expect(cancelBroadcast(deps, B.id, B.actor, id)).rejects.toMatchObject({ code: 'broadcast_not_found', status: 404 });
    await expect(retryBroadcast(deps, B.id, B.actor, id)).rejects.toMatchObject({ code: 'broadcast_not_found', status: 404 });

    expect(tg.requests).toEqual([]);
    expect((await getBroadcast(deps, A.id, A.actor)).overview.active).toMatchObject({ id, status: 'sending', counts: { pending: 3, sent: 0 } });

    // Shop B's own broadcast goes to B's audience through B's bot — while A's is still running.
    await start(B, { button: { text: 'Каталог' } });
    expect((await run(B)).worker).toEqual({ state: 'done', sent: 1 });
    expect(tg.requests.map((r) => [r.token, r.chat])).toEqual([[B.bot!.token, buyerOfB]]);
    expect(tg.requests[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Каталог', web_app: { url: `${PUBLIC}/s/mint-lab/` } }]] });
  });
});
