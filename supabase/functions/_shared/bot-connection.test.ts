// @vitest-environment node
// Bot connection flows against the local mock Bot API (scripts/lib/telegram-mock.ts, real HTTP, no Telegram) and an
// in-memory stand-in for the bot_* RPCs with the same ownership rules. Only fake BotFather-format tokens.
// The SQL itself (Vault, RLS / grants, uniqueness, ownership change) is covered by tests/integration/security/bot-connection.test.ts.
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTelegramMockServer, type MockBotState, type MockMessage } from '../../../scripts/lib/telegram-mock';
import { connectBot, disconnectBot, getBot, handleWebhookUpdate, saveWelcome, syncBot, type BotDeps, type Rpc } from './bot-connection';
import { DEFAULT_MANAGER_BUTTON_TEXT, DEFAULT_OPEN_BUTTON_TEXT, DEFAULT_WELCOME_TEXT, sha256Hex, UNSUBSCRIBED_TEXT } from './bot-welcome';

let server: Server;
let base = '';
beforeAll(async () => {
  server = createTelegramMockServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP address');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const tokens: string[] = [];
function token(prefix = 'FAKE'): string {
  const id = 100_000_000 + Math.floor(Math.random() * 800_000_000);
  const t = `${id}:${prefix}_${randomBytes(18).toString('hex')}`;
  tokens.push(t);
  return t;
}
const botIdOf = (t: string) => Number(t.split(':')[0]);
const noSecretIn = (value: unknown) => {
  const text = JSON.stringify(value);
  return tokens.every((t) => !text.includes(t.split(':')[1]!));
};
const state = async (botId: number): Promise<MockBotState> => (await fetch(`${base}/__mock/bots/${botId}`)).json() as Promise<MockBotState>;
const setForeignWebhook = (botId: number, url: string) =>
  fetch(`${base}/__mock/bots/${botId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webhook_url: url }) });
const messages = async (chatId: number): Promise<MockMessage[]> => ((await (await fetch(`${base}/__mock/messages?chat_id=${chatId}`)).json()) as { messages: MockMessage[] }).messages;
const failNext = (chatId: number, times: number, status = 500) =>
  fetch(`${base}/__mock/fail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: String(chatId), times, status }) });

// ---- In-memory stand-in for the bot_* RPCs (same rules as 20261107090000 and 20261113090000) --------------------

interface Shop {
  id: string;
  slug: string;
  name: string;
  status: string;
  owner: string;
}
interface Conn {
  connection_id: string;
  bot_id: number;
  bot_username: string;
  secret_id: string;
  token_hint: string;
  webhook_secret_hash: string;
  webhook_url: string;
  menu_button_url: string | null;
  menu_button_text: string | null;
  status: 'connected' | 'error';
  last_error: string | null;
  connected_at: string;
  updated_at: string;
}
interface Welcome {
  welcome_text: string;
  open_button_text: string;
  manager_button_text: string;
  manager_url: string | null;
  open_button_emoji_id: string | null;
  manager_button_emoji_id: string | null;
  updated_at: string;
}
interface Subscriber {
  chat_id: number;
  status: 'active' | 'unsubscribed' | 'blocked';
}

const EMOJI_ID_RE = /^[0-9]{5,25}$/;

class FakeDb {
  shops = new Map<string, Shop>();
  vault = new Map<string, string>();
  conns = new Map<string, Conn>();
  welcome = new Map<string, Welcome>();
  updates = new Set<string>();
  /** private.bot_subscribers: one row per (shop, bot, Telegram user). */
  subscribers = new Map<string, Subscriber>();
  /** true: bot_webhook_track fails (the database is unavailable). */
  trackFails = false;
  attempts: Array<{ shop: string; actor: string }> = [];
  calls: string[] = [];
  /** private.shop_bot_assignments, purpose 'notifications': the Bot ID of each shop's notification bot (20261126090000). */
  notifBots = new Map<string, number>();

  /** The user's row in the audience of the shop's CURRENT bot. */
  subscriber(shopId: string, tgUserId: number): Subscriber | undefined {
    const c = this.conns.get(shopId);
    return c ? this.subscribers.get(`${shopId}/${c.bot_id}/${tgUserId}`) : undefined;
  }

  addShop(slug: string, name: string): Shop & { actor: string } {
    const shop = { id: randomUUID(), slug, name, status: 'active', owner: randomUUID() };
    this.shops.set(shop.id, shop);
    return { ...shop, actor: shop.owner };
  }

  private assert(shopId: unknown, actor: unknown) {
    const shop = this.shops.get(String(shopId));
    if (!shop) throw new Error('shop_not_found');
    if (shop.owner !== actor) throw new Error('forbidden');
    return shop;
  }

  private settings(shopId: string) {
    const shop = this.shops.get(shopId)!;
    const c = this.conns.get(shopId);
    const w = this.welcome.get(shopId);
    return {
      shop: { id: shop.id, slug: shop.slug, name: shop.name },
      connection: c
        ? {
            bot_id: c.bot_id,
            bot_username: c.bot_username,
            token_hint: c.token_hint,
            status: c.status,
            last_error: c.last_error,
            menu_button_url: c.menu_button_url,
            connected_at: c.connected_at,
            updated_at: c.updated_at,
          }
        : null,
      welcome: w
        ? { ...w, customized: true }
        : {
            welcome_text: DEFAULT_WELCOME_TEXT,
            open_button_text: DEFAULT_OPEN_BUTTON_TEXT,
            manager_button_text: DEFAULT_MANAGER_BUTTON_TEXT,
            manager_url: null,
            open_button_emoji_id: null,
            manager_button_emoji_id: null,
            customized: false,
            updated_at: null,
          },
    };
  }

  private creds(shopId: string) {
    const c = this.conns.get(shopId);
    if (!c) return null;
    return {
      bot_token: this.vault.get(c.secret_id)!,
      bot_id: c.bot_id,
      bot_username: c.bot_username,
      connection_id: c.connection_id,
      webhook_url: c.webhook_url,
      menu_button_url: c.menu_button_url,
      menu_button_text: c.menu_button_text,
    };
  }

  rpc: Rpc = async (fn, a) => {
    this.calls.push(fn);
    try {
      return { data: this.exec(fn, a), error: null };
    } catch (err) {
      return { data: null, error: { message: (err as Error).message } };
    }
  };

  private exec(fn: string, a: Record<string, unknown>): unknown {
    const now = new Date().toISOString();
    switch (fn) {
      case 'bot_get_settings':
        this.assert(a.p_shop_id, a.p_actor);
        return this.settings(String(a.p_shop_id));
      case 'bot_register_connect_attempt': {
        this.assert(a.p_shop_id, a.p_actor);
        if (this.attempts.filter((x) => x.shop === a.p_shop_id).length >= 10) throw new Error('bot_connect_rate_limited');
        this.attempts.push({ shop: String(a.p_shop_id), actor: String(a.p_actor) });
        return null;
      }
      case 'bot_assert_available': {
        this.assert(a.p_shop_id, a.p_actor);
        for (const [shopId, c] of this.conns) if (c.bot_id === a.p_bot_id && shopId !== a.p_shop_id) throw new Error('bot_in_use');
        if (this.notifBots.get(String(a.p_shop_id)) === a.p_bot_id) throw new Error('bot_used_for_notifications');
        return { same_bot: this.conns.get(String(a.p_shop_id))?.bot_id === a.p_bot_id };
      }
      case 'bot_get_credentials':
        this.assert(a.p_shop_id, a.p_actor);
        return this.creds(String(a.p_shop_id));
      case 'bot_save_connection': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const t = String(a.p_bot_token);
        if (Number(t.split(':')[0]) !== a.p_bot_id) throw new Error('invalid_token');
        for (const [shopId, c] of this.conns) if (c.bot_id === a.p_bot_id && shopId !== shop.id) throw new Error('bot_in_use');
        if (this.notifBots.get(shop.id) === a.p_bot_id) throw new Error('bot_used_for_notifications');
        const old = this.conns.get(shop.id);
        const secretId = randomUUID();
        this.vault.set(secretId, t);
        if (old) this.vault.delete(old.secret_id);
        this.conns.set(shop.id, {
          connection_id: String(a.p_connection_id),
          bot_id: Number(a.p_bot_id),
          bot_username: String(a.p_bot_username),
          secret_id: secretId,
          token_hint: `${t.split(':')[0]}:••••${t.slice(-4)}`,
          webhook_secret_hash: String(a.p_webhook_secret_hash),
          webhook_url: String(a.p_webhook_url),
          menu_button_url: (a.p_menu_button_url as string) ?? null,
          menu_button_text: (a.p_menu_button_text as string) ?? null,
          status: 'connected',
          last_error: null,
          connected_at: now,
          updated_at: now,
        });
        return this.settings(shop.id);
      }
      case 'bot_record_sync': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const c = this.conns.get(shop.id);
        if (!c) throw new Error('not_connected');
        c.status = a.p_ok ? 'connected' : 'error';
        c.last_error = a.p_ok ? null : String(a.p_error);
        if (a.p_ok) {
          c.menu_button_url = a.p_menu_button_url as string;
          c.menu_button_text = a.p_menu_button_text as string;
        }
        return this.settings(shop.id);
      }
      case 'bot_delete_connection': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const c = this.conns.get(shop.id);
        if (c && c.connection_id === a.p_connection_id) {
          this.vault.delete(c.secret_id);
          this.conns.delete(shop.id);
        }
        return this.settings(shop.id);
      }
      case 'bot_save_welcome_v2': {
        const shop = this.assert(a.p_shop_id, a.p_actor);
        const emojiId = (v: unknown) => String(v ?? '').trim() || null;
        const openEmoji = emojiId(a.p_open_button_emoji_id);
        const managerEmoji = emojiId(a.p_manager_button_emoji_id);
        // The CHECK constraints of private.shop_bot_welcome.
        if ([openEmoji, managerEmoji].some((id) => id !== null && !EMOJI_ID_RE.test(id))) throw new Error('invalid_welcome');
        this.welcome.set(shop.id, {
          welcome_text: String(a.p_welcome_text),
          open_button_text: String(a.p_open_button_text),
          manager_button_text: String(a.p_manager_button_text),
          manager_url: (a.p_manager_url as string) || null,
          open_button_emoji_id: openEmoji,
          manager_button_emoji_id: managerEmoji,
          updated_at: now,
        });
        return this.settings(shop.id);
      }
      case 'bot_webhook_track': {
        if (this.trackFails) throw new Error('connection refused');
        const entry = [...this.conns.entries()].find(([, c]) => c.connection_id === a.p_connection_id);
        const event = String(a.p_event);
        const userId = Number(a.p_tg_user_id);
        if (!entry || !(userId > 0) || !['start', 'message', 'stop', 'blocked', 'unblocked'].includes(event)) return null;
        const key = `${entry[0]}/${entry[1].bot_id}/${userId}`;
        const row = this.subscribers.get(key);
        if (event === 'start' || event === 'message' || event === 'stop') {
          // A plain message keeps an unsubscribed user unsubscribed; a blocked user who writes again is active.
          const status = event === 'start' ? 'active' : event === 'stop' ? 'unsubscribed' : !row || row.status === 'blocked' ? 'active' : row.status;
          this.subscribers.set(key, { chat_id: Number(a.p_chat_id), status });
          return status;
        }
        // my_chat_member only updates a known user; "unblocked" only lifts a block.
        if (!row || (event === 'unblocked' && row.status !== 'blocked')) return null;
        row.status = event === 'blocked' ? 'blocked' : 'active';
        return row.status;
      }
      case 'bot_webhook_begin': {
        const entry = [...this.conns.entries()].find(([, c]) => c.connection_id === a.p_connection_id);
        if (!entry || entry[1].webhook_secret_hash !== a.p_secret_hash) return null;
        const key = `${a.p_connection_id}/${a.p_update_id}`;
        if (this.updates.has(key)) return { duplicate: true };
        this.updates.add(key);
        const [shopId, c] = entry;
        const shop = this.shops.get(shopId)!;
        return {
          duplicate: false,
          bot_token: this.vault.get(c.secret_id),
          bot_id: c.bot_id,
          bot_username: c.bot_username,
          menu_button_url: c.menu_button_url,
          menu_button_text: c.menu_button_text,
          shop: { id: shop.id, slug: shop.slug, name: shop.name, status: shop.status },
          welcome: this.settings(shopId).welcome,
        };
      }
      case 'bot_webhook_release':
        this.updates.delete(`${a.p_connection_id}/${a.p_update_id}`);
        return null;
      case 'bot_webhook_record_menu': {
        const c = [...this.conns.values()].find((x) => x.connection_id === a.p_connection_id);
        if (c) {
          c.menu_button_url = a.p_menu_button_url as string;
          c.menu_button_text = a.p_menu_button_text as string;
        }
        return null;
      }
      default:
        throw new Error(`unknown rpc ${fn}`);
    }
  }
}

// ---- Helpers ----------------------------------------------------------------------------------------------------

const PUBLIC = 'https://miniappdemo.pages.dev';
let db: FakeDb;
let secrets: string[];
let deps: BotDeps;

beforeEach(() => {
  db = new FakeDb();
  secrets = [];
  deps = {
    rpc: db.rpc,
    apiBase: base,
    publicAppUrl: PUBLIC,
    functionsBaseUrl: 'https://ref.supabase.co/functions/v1',
    platformBotId: 999_999_999,
    newWebhookSecret: () => {
      const s = randomBytes(32).toString('base64url');
      secrets.push(s);
      return s;
    },
  };
});

const lastSecret = () => secrets[secrets.length - 1]!;
const connIdOf = (shopId: string) => db.conns.get(shopId)!.connection_id;
let updateSeq = 1;
const startUpdate = (chatId: number, text = '/start', chatType = 'private') => ({
  update_id: updateSeq++,
  message: { message_id: 1, date: 1, text, chat: { id: chatId, type: chatType }, from: { id: chatId, is_bot: false, first_name: 'Buyer' } },
});
const newChat = () => 500_000_000 + Math.floor(Math.random() * 400_000_000);
/** A private message with extra fields (e.g. entities). */
const messageUpdate = (chatId: number, message: Record<string, unknown>) => ({
  update_id: updateSeq++,
  message: { message_id: 1, date: 1, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Buyer' }, ...message },
});
/** my_chat_member: the user blocked ('kicked') or unblocked / restarted ('member') the bot. */
const memberUpdate = (chatId: number, status: 'kicked' | 'member') => ({
  update_id: updateSeq++,
  my_chat_member: {
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, is_bot: false, first_name: 'Buyer' },
    date: 1,
    old_chat_member: { status: status === 'kicked' ? 'member' : 'kicked' },
    new_chat_member: { status },
  },
});

// Premium (custom) emoji ids are public numbers; these are made up.
const FIRE = '5368324170671202286';
const HAND = '5368324170671202287';
const tag = (id: string, fallback: string) => `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;

/** A shop with a connected bot and a manager link. `prefix` picks the mock's behaviour for the bot (e.g. NOEMOJI). */
async function connected(slug = 'noir-vapor', name = 'Noir Vapor', prefix = 'FAKE') {
  const shop = db.addShop(slug, name);
  const t = token(prefix);
  await connectBot(deps, { shopId: shop.id, actor: shop.actor, botToken: t });
  await saveWelcome(deps, shop.id, shop.actor, {
    welcomeText: DEFAULT_WELCOME_TEXT,
    openButtonText: 'Открыть приложение',
    managerButtonText: 'Связаться с менеджером',
    managerUrl: 'https://t.me/noir_manager',
  });
  return { shop, t, connectionId: connIdOf(shop.id), secret: lastSecret() };
}
/** Delivers updates to the webhook of one connection, as Telegram does. */
const sender = (c: { connectionId: string; secret: string }) => (update: unknown) =>
  handleWebhookUpdate(deps, { connectionId: c.connectionId, secretToken: c.secret, update });

async function expectFlowError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}

// ---- Tests -------------------------------------------------------------------------------------------------------

describe('connect', () => {
  it('verifies the token with getMe, sets the web_app Menu Button and a secret webhook, and never returns the token', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t = token();
    const res = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t });

    expect(res.settings.connection).toMatchObject({ bot_id: botIdOf(t), bot_username: `mock_${botIdOf(t)}_bot`, status: 'connected' });
    expect(res.settings.connection!.token_hint).toBe(`${botIdOf(t)}:••••${t.slice(-4)}`);
    expect(res.storefront_url).toBe(`${PUBLIC}/s/noir-vapor/`);
    expect(noSecretIn(res)).toBe(true);
    expect(JSON.stringify(res)).not.toContain(lastSecret());

    const s = await state(botIdOf(t));
    expect(s.menu_button).toEqual({ type: 'web_app', text: 'Открыть приложение', web_app: { url: `${PUBLIC}/s/noir-vapor/` } });
    expect(s.webhook!.url).toBe(`https://ref.supabase.co/functions/v1/telegram-webhook?c=${connIdOf(A.id)}`);
    expect(s.webhook!.url).not.toContain(t.split(':')[1]);
    expect(s.webhook!.secret_token).toBe(lastSecret());
    // Private messages (/start, /stop) and block / unblock of the bot — nothing else is requested.
    expect(s.webhook!.allowed_updates).toEqual(['message', 'my_chat_member']);
    // Only the hash of the webhook secret is stored; the token only in the (fake) Vault.
    expect(db.conns.get(A.id)!.webhook_secret_hash).toBe(await sha256Hex(lastSecret()));
    expect(JSON.stringify([...db.conns.values()])).not.toContain(t.split(':')[1]);
    expect([...db.vault.values()]).toEqual([t]);
  });

  it('a wrong format is refused before any Bot API call; an invalid / revoked token is refused by getMe and nothing is stored', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: 'not-a-token' }), 'invalid_token');
    expect(db.calls).not.toContain('bot_register_connect_attempt');
    const bad = token('UNAUTHORIZED');
    await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: bad }), 'telegram_unauthorized');
    expect(db.conns.size).toBe(0);
    expect(db.vault.size).toBe(0);
    expect((await state(botIdOf(bad))).webhook).toBeNull();
  });

  it('re-connecting the same bot (e.g. a new token after revoke) keeps working without a webhook warning', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t1 = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t1 });
    const firstConn = connIdOf(A.id);
    const t2 = `${botIdOf(t1)}:FAKE_${randomBytes(18).toString('hex')}`;
    tokens.push(t2);
    const res = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t2 });
    expect(res.previous).toBeNull();
    expect(connIdOf(A.id)).not.toBe(firstConn);
    expect([...db.vault.values()]).toEqual([t2]);
    expect((await state(botIdOf(t1))).webhook!.url).toContain(connIdOf(A.id));
  });

  it('one bot can never be connected to two shops of the platform', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const B = db.addShop('mint-lab', 'Mint Lab');
    const t = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t });
    const before = await state(botIdOf(t));
    await expectFlowError(connectBot(deps, { shopId: B.id, actor: B.actor, botToken: t }), 'bot_in_use');
    expect(db.conns.has(B.id)).toBe(false);
    // Shop A's webhook and Menu Button are untouched.
    expect(await state(botIdOf(t))).toEqual(before);
  });

  describe('one bot, one purpose: the storefront bot is never the bot of the order notifications', () => {
    it('refuses the notification bot of the SAME shop (identified by its Bot ID from getMe), changes nothing in Telegram and stores nothing', async () => {
      const A = db.addShop('noir-vapor', 'Noir Vapor');
      const t = token();
      db.notifBots.set(A.id, botIdOf(t));
      const err = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'bot_used_for_notifications', status: 409 });
      expect(noSecretIn(err)).toBe(true);
      expect(String((err as Error).message)).not.toContain(t.split(':')[1]);
      // Refused BEFORE anything is set on the bot: no webhook, no Menu Button; nothing in the database or Vault.
      const s = await state(botIdOf(t));
      expect(s.webhook).toBeNull();
      expect(s.menu_button).toEqual({ type: 'default' });
      expect(db.conns.size).toBe(0);
      expect(db.vault.size).toBe(0);
      expect(db.calls).not.toContain('bot_save_connection');
    });

    it('the decision is made by the Bot ID, not by the text of the token: another token of the same bot is refused too', async () => {
      const A = db.addShop('noir-vapor', 'Noir Vapor');
      const t = token();
      db.notifBots.set(A.id, botIdOf(t));
      const reissued = `${botIdOf(t)}:FAKE_${randomBytes(18).toString('hex')}`;
      tokens.push(reissued);
      await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: reissued }), 'bot_used_for_notifications');
      expect(db.conns.size).toBe(0);
    });

    it('a different bot is connected and works next to the notification bot', async () => {
      const A = db.addShop('noir-vapor', 'Noir Vapor');
      const notifications = token();
      const storefront = token();
      db.notifBots.set(A.id, botIdOf(notifications));
      const res = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: storefront });
      expect(res.settings.connection).toMatchObject({ bot_id: botIdOf(storefront), status: 'connected' });
      expect(db.notifBots.get(A.id)).toBe(botIdOf(notifications));
      expect((await state(botIdOf(storefront))).webhook!.url).toContain(connIdOf(A.id));
      // The notification bot is never touched by the storefront.
      expect((await state(botIdOf(notifications))).webhook).toBeNull();
    });

    it('replacing the storefront bot with the notification bot is refused and the working connection keeps everything', async () => {
      const A = db.addShop('noir-vapor', 'Noir Vapor');
      const storefront = token();
      const notifications = token();
      await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: storefront });
      db.notifBots.set(A.id, botIdOf(notifications));
      const before = { conn: { ...db.conns.get(A.id)! }, vault: [...db.vault.values()], tg: await state(botIdOf(storefront)) };
      await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: notifications }), 'bot_used_for_notifications');
      expect(db.conns.get(A.id)).toEqual(before.conn);
      expect([...db.vault.values()]).toEqual(before.vault);
      expect(await state(botIdOf(storefront))).toEqual(before.tg);
      expect((await state(botIdOf(notifications))).webhook).toBeNull();
    });

    it('re-saving the same storefront bot in the same section is not a conflict', async () => {
      const A = db.addShop('noir-vapor', 'Noir Vapor');
      const storefront = token();
      db.notifBots.set(A.id, botIdOf(token()));
      await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: storefront });
      const again = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: storefront });
      expect(again.settings.connection!.bot_id).toBe(botIdOf(storefront));
    });

    it("another shop's notification bot does not matter (the rule is per shop)", async () => {
      const A = db.addShop('noir-vapor', 'Noir Vapor');
      const B = db.addShop('mint-lab', 'Mint Lab');
      const t = token();
      db.notifBots.set(B.id, botIdOf(t));
      const res = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t });
      expect(res.settings.connection!.bot_id).toBe(botIdOf(t));
    });

    it('a wrong token and an unavailable Telegram are reported with their own codes, never as a duplicate bot', async () => {
      const A = db.addShop('noir-vapor', 'Noir Vapor');
      db.notifBots.set(A.id, botIdOf(token()));
      await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: token('UNAUTHORIZED') }), 'telegram_unauthorized');
      const down = { ...deps, apiBase: 'http://127.0.0.1:1' };
      const err = await connectBot(down, { shopId: A.id, actor: A.actor, botToken: token() }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'network_error', status: 502 });
    });
  });

  it("the platform's own bot cannot be connected to a shop", async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t = `999999999:FAKE_${randomBytes(18).toString('hex')}`;
    tokens.push(t);
    await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t }), 'bot_reserved');
  });

  it('stops on a foreign webhook (only its host is shown) and replaces it only after explicit confirmation', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t = token();
    await setForeignWebhook(botIdOf(t), `https://crm.example/hook/${t}`);
    const err = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'webhook_conflict', status: 409, details: { host: 'crm.example' } });
    expect(noSecretIn(err)).toBe(true);
    expect((await state(botIdOf(t))).webhook!.url).toContain('crm.example');
    expect((await state(botIdOf(t))).menu_button).toEqual({ type: 'default' });
    expect(db.conns.size).toBe(0);

    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t, confirmReplaceWebhook: true });
    expect((await state(botIdOf(t))).webhook!.url).toContain(connIdOf(A.id));
  });

  it('replacing the bot: the old bot keeps working until the new one is verified, then only OUR settings are removed from it', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const oldT = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: oldT });
    const oldState = await state(botIdOf(oldT));

    await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: token('UNAUTHORIZED') }), 'telegram_unauthorized');
    expect(db.conns.get(A.id)!.bot_id).toBe(botIdOf(oldT));
    expect(await state(botIdOf(oldT))).toEqual(oldState);

    const newT = token();
    const res = await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: newT });
    expect(res.previous).toEqual({ bot_username: `mock_${botIdOf(oldT)}_bot`, webhook_removed: true, menu_reset: true, error: null });
    expect(await state(botIdOf(oldT))).toEqual({ webhook: null, menu_button: { type: 'default' } });
    expect(db.conns.get(A.id)!.bot_id).toBe(botIdOf(newT));
  });

  it('is rate limited per shop', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    for (let i = 0; i < 10; i++) await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: token('UNAUTHORIZED') }), 'telegram_unauthorized');
    await expectFlowError(connectBot(deps, { shopId: A.id, actor: A.actor, botToken: token() }), 'bot_connect_rate_limited');
  });

  it('refuses to connect without a public storefront URL (never localhost or a guessed address)', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    for (const publicAppUrl of [undefined, 'http://miniappdemo.pages.dev', 'https://localhost:5173']) {
      await expectFlowError(connectBot({ ...deps, publicAppUrl }, { shopId: A.id, actor: A.actor, botToken: token() }), 'public_url_not_configured');
    }
  });

  it('refuses an http webhook when talking to the real Telegram', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const real = { ...deps, apiBase: 'https://api.telegram.org', functionsBaseUrl: 'http://kong:8000/functions/v1', fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
      fetch(String(url).replace('https://api.telegram.org', base), init)) as typeof fetch };
    await expectFlowError(connectBot(real, { shopId: A.id, actor: A.actor, botToken: token() }), 'webhook_url_insecure');
  });
});

describe('welcome settings and buttons', () => {
  it('defaults: the requested text and button labels', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const view = await getBot(deps, A.id, A.actor);
    expect(view.settings.welcome).toMatchObject({ welcome_text: DEFAULT_WELCOME_TEXT, open_button_text: 'Открыть приложение', manager_button_text: 'Связаться с менеджером', manager_url: null });
  });

  it('validates and normalises: @username → https://t.me/username; unsafe links and empty texts are refused', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const input = { welcomeText: 'Hi', openButtonText: 'Open', managerButtonText: 'Manager', managerUrl: '@noir_manager' };
    const saved = await saveWelcome(deps, A.id, A.actor, input);
    expect(saved.settings.welcome).toMatchObject({ welcome_text: 'Hi', manager_url: 'https://t.me/noir_manager' });
    await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, managerUrl: 'javascript:alert(1)' }), 'invalid_manager_url');
    await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, managerUrl: 'https://evil.example/x' }), 'invalid_manager_url');
    await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, welcomeText: '  ' }), 'invalid_welcome_text');
    await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, welcomeText: 'x'.repeat(4097) }), 'invalid_welcome_text');
    // The template fits, the message after substituting the (long) shop name does not.
    const L = db.addShop('long-name', 'N'.repeat(80));
    await expectFlowError(saveWelcome(deps, L.id, L.actor, { ...input, welcomeText: `${'x'.repeat(4050)}{название_магазина}` }), 'welcome_too_long');
    await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, openButtonText: '' }), 'invalid_open_button_text');
    await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, managerButtonText: 'x'.repeat(65) }), 'invalid_manager_button_text');
    expect(db.welcome.get(A.id)!.manager_url).toBe('https://t.me/noir_manager');
  });

  it('a new text of button 1 is applied to the Menu Button as well', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t });
    const res = await saveWelcome(deps, A.id, A.actor, { welcomeText: 'Hi', openButtonText: 'Каталог', managerButtonText: 'Менеджер', managerUrl: '' });
    expect(res.menu_synced).toBe(true);
    expect((await state(botIdOf(t))).menu_button).toEqual({ type: 'web_app', text: 'Каталог', web_app: { url: `${PUBLIC}/s/noir-vapor/` } });
  });
});

describe('webhook: /start', () => {
  it('answers /start with the welcome (shop name substituted) and exactly two buttons: the Mini App and the manager', async () => {
    const { connectionId, secret, t } = await connected();
    const chat = newChat();
    const res = await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: startUpdate(chat) });
    expect(res).toEqual({ status: 200, body: { ok: true, handled: true } });
    const [msg, ...rest] = await messages(chat);
    expect(rest).toEqual([]);
    expect(msg!.bot_id).toBe(botIdOf(t));
    expect(msg!.parse_mode).toBeNull();
    expect(msg!.text.startsWith('Добро пожаловать в Noir Vapor')).toBe(true);
    expect(msg!.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Открыть приложение', web_app: { url: `${PUBLIC}/s/noir-vapor/` } }],
        [{ text: 'Связаться с менеджером', url: 'https://t.me/noir_manager' }],
      ],
    });
  });

  it('/start with a deep-link parameter and /start@bot work the same way; groups and other messages are ignored', async () => {
    const { connectionId, secret, t } = await connected();
    const chat = newChat();
    expect((await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: startUpdate(chat, '/start promo') })).body).toEqual({ ok: true, handled: true });
    expect((await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: startUpdate(chat, `/start@mock_${botIdOf(t)}_bot`) })).body).toEqual({ ok: true, handled: true });
    expect((await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: startUpdate(chat, 'hello') })).body).toEqual({ ok: true, handled: false });
    expect((await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: startUpdate(-100123, '/start', 'supergroup') })).body).toEqual({ ok: true, handled: false });
    expect(await messages(chat)).toHaveLength(2);
    expect(await messages(-100123)).toEqual([]);
  });

  it('a re-delivered update_id is answered once; a repeated /start (new update) gets the CURRENT welcome', async () => {
    const { shop, connectionId, secret } = await connected();
    const chat = newChat();
    const update = startUpdate(chat);
    await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update });
    expect(await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update })).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(await messages(chat)).toHaveLength(1);

    await saveWelcome(deps, shop.id, shop.actor, { welcomeText: 'Новое приветствие {название_магазина} 🎉', openButtonText: 'В магазин', managerButtonText: 'Менеджер', managerUrl: '@new_manager' });
    await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: startUpdate(chat) });
    const msgs = await messages(chat);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toBe('Новое приветствие Noir Vapor 🎉');
    expect(msgs[1]!.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'В магазин', web_app: { url: `${PUBLIC}/s/noir-vapor/` } }], [{ text: 'Менеджер', url: 'https://t.me/new_manager' }]],
    });
  });

  it('refuses requests without the right secret, for unknown connections or with a malformed id — same 401, nothing sent', async () => {
    const { connectionId, secret } = await connected();
    const other = await connected('mint-lab', 'Mint Lab');
    const chat = newChat();
    for (const req of [
      { connectionId, secretToken: null, update: startUpdate(chat) },
      { connectionId, secretToken: 'wrong_secret', update: startUpdate(chat) },
      { connectionId, secretToken: other.secret, update: startUpdate(chat) },
      { connectionId: randomUUID(), secretToken: secret, update: startUpdate(chat) },
      { connectionId: 'not-a-uuid', secretToken: secret, update: startUpdate(chat) },
      { connectionId: null, secretToken: secret, update: startUpdate(chat) },
      { connectionId, secretToken: 'bad secret!', update: startUpdate(chat) },
    ]) {
      expect((await handleWebhookUpdate(deps, req)).status, JSON.stringify(req.secretToken)).toBe(401);
    }
    expect((await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: { message: {} } })).status).toBe(400);
    expect(await messages(chat)).toEqual([]);
  });

  it("each bot answers with its OWN shop's storefront", async () => {
    const a = await connected('noir-vapor', 'Noir Vapor');
    const b = await connected('mint-lab', 'Mint Lab');
    const chat = newChat();
    await handleWebhookUpdate(deps, { connectionId: a.connectionId, secretToken: a.secret, update: startUpdate(chat) });
    await handleWebhookUpdate(deps, { connectionId: b.connectionId, secretToken: b.secret, update: startUpdate(chat) });
    const [ma, mb] = await messages(chat);
    expect(ma!.bot_id).toBe(botIdOf(a.t));
    expect(JSON.stringify(ma!.reply_markup)).toContain('/s/noir-vapor/');
    expect(mb!.bot_id).toBe(botIdOf(b.t));
    expect(JSON.stringify(mb!.reply_markup)).toContain('/s/mint-lab/');
    expect(mb!.text).toContain('Mint Lab');
  });

  it('a transient Telegram failure releases the update (503) so the re-delivery is answered exactly once', async () => {
    const { connectionId, secret } = await connected();
    const chat = newChat();
    const update = startUpdate(chat);
    await failNext(chat, 1);
    expect((await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update })).status).toBe(503);
    expect(await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update })).toEqual({ status: 200, body: { ok: true, handled: true } });
    expect(await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update })).toMatchObject({ body: { duplicate: true } });
    expect(await messages(chat)).toHaveLength(1);
  });

  it('a permanent failure (user blocked the bot) is acknowledged, not retried', async () => {
    const { connectionId, secret } = await connected();
    const chat = newChat();
    await failNext(chat, 1, 403);
    expect(await handleWebhookUpdate(deps, { connectionId, secretToken: secret, update: startUpdate(chat) })).toEqual({ status: 200, body: { ok: true, handled: false } });
  });

  it('a new storefront address is used by the next /start and re-applied to the Menu Button automatically', async () => {
    const { shop, connectionId, secret, t } = await connected();
    const moved = { ...deps, publicAppUrl: 'https://shop.example.com' };
    const chat = newChat();
    await handleWebhookUpdate(moved, { connectionId, secretToken: secret, update: startUpdate(chat) });
    expect(JSON.stringify((await messages(chat))[0]!.reply_markup)).toContain('https://shop.example.com/s/noir-vapor/');
    expect((await state(botIdOf(t))).menu_button).toMatchObject({ web_app: { url: 'https://shop.example.com/s/noir-vapor/' } });
    expect(db.conns.get(shop.id)!.menu_button_url).toBe('https://shop.example.com/s/noir-vapor/');
  });

  it('without a manager link the welcome still opens the shop (only button 1)', async () => {
    const shop = db.addShop('noir-vapor', 'Noir Vapor');
    await connectBot(deps, { shopId: shop.id, actor: shop.actor, botToken: token() });
    const chat = newChat();
    await handleWebhookUpdate(deps, { connectionId: connIdOf(shop.id), secretToken: lastSecret(), update: startUpdate(chat) });
    expect((await messages(chat))[0]!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: `${PUBLIC}/s/noir-vapor/` } }]] });
  });
});

describe('sync and disconnect', () => {
  it('sync re-applies the Menu Button and detects a webhook replaced by another service', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t });
    expect((await syncBot(deps, A.id, A.actor)).webhook_ok).toBe(true);
    await setForeignWebhook(botIdOf(t), 'https://crm.example/hook');
    const res = await syncBot(deps, A.id, A.actor);
    expect(res.webhook_ok).toBe(false);
    expect(res.settings.connection).toMatchObject({ status: 'error', last_error: 'webhook_replaced' });
  });

  it("disconnect removes only the platform's webhook and Menu Button and keeps the welcome settings", async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t });
    await saveWelcome(deps, A.id, A.actor, { welcomeText: 'Hi', openButtonText: 'Open', managerButtonText: 'Manager', managerUrl: '@noir_manager' });
    const res = await disconnectBot(deps, A.id, A.actor);
    expect(res.cleanup).toEqual({ webhook_removed: true, menu_reset: true, telegram: 'ok' });
    expect(res.settings.connection).toBeNull();
    expect(res.settings.welcome.manager_url).toBe('https://t.me/noir_manager');
    expect(await state(botIdOf(t))).toEqual({ webhook: null, menu_button: { type: 'default' } });
    expect(db.vault.size).toBe(0);
  });

  it('disconnect never removes a foreign webhook or a Menu Button set by someone else', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const t = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: t });
    await setForeignWebhook(botIdOf(t), 'https://crm.example/hook');
    await fetch(`${base}/bot${t}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ menu_button: { type: 'web_app', text: 'CRM', web_app: { url: 'https://crm.example/app' } } }),
    });
    const res = await disconnectBot(deps, A.id, A.actor);
    expect(res.cleanup).toEqual({ webhook_removed: false, menu_reset: false, telegram: 'ok' });
    expect(await state(botIdOf(t))).toEqual({
      webhook: { url: 'https://crm.example/hook', secret_token: null, allowed_updates: null },
      menu_button: { type: 'web_app', text: 'CRM', web_app: { url: 'https://crm.example/app' } },
    });
  });

  it('disconnect of one shop does not touch another shop', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const B = db.addShop('mint-lab', 'Mint Lab');
    const ta = token();
    const tb = token();
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: ta });
    await connectBot(deps, { shopId: B.id, actor: B.actor, botToken: tb });
    const before = await state(botIdOf(tb));
    await disconnectBot(deps, A.id, A.actor);
    expect(db.conns.has(B.id)).toBe(true);
    expect(await state(botIdOf(tb))).toEqual(before);
  });

  it('a token revoked in BotFather still lets the owner disconnect', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: token() });
    const c = db.conns.get(A.id)!;
    db.vault.set(c.secret_id, `${c.bot_id}:UNAUTHORIZED_${randomBytes(18).toString('hex')}`);
    const res = await disconnectBot(deps, A.id, A.actor);
    expect(res.cleanup.telegram).toBe('token_revoked');
    expect(db.conns.size).toBe(0);
  });
});

describe('webhook: the audience of the bot', () => {
  it('records who started the bot; /stop unsubscribes and is confirmed; only /start subscribes again', async () => {
    const c = await connected();
    const send = sender(c);
    const chat = newChat();
    expect(db.subscriber(c.shop.id, chat)).toBeUndefined();

    await send(startUpdate(chat));
    expect(db.subscriber(c.shop.id, chat)).toEqual({ chat_id: chat, status: 'active' });

    expect(await send(startUpdate(chat, '/stop'))).toEqual({ status: 200, body: { ok: true, handled: true } });
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('unsubscribed');
    // An ordinary message does not subscribe again.
    expect((await send(startUpdate(chat, 'Здравствуйте'))).body).toEqual({ ok: true, handled: false });
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('unsubscribed');

    await send(startUpdate(chat, '/start'));
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('active');

    const msgs = await messages(chat);
    expect(msgs.map((m) => m.text.split('\n')[0])).toEqual(['Добро пожаловать в Noir Vapor', UNSUBSCRIBED_TEXT, 'Добро пожаловать в Noir Vapor']);
    // The confirmation is plain text without buttons.
    expect(msgs[1]).toMatchObject({ parse_mode: null, reply_markup: null, entities: null });
  });

  it('a user who wrote without /start is known as well; a command addressed to another bot is an ordinary message', async () => {
    const c = await connected();
    const send = sender(c);
    const chat = newChat();
    expect((await send(startUpdate(chat, 'Есть в наличии?'))).body).toEqual({ ok: true, handled: false });
    expect(db.subscriber(c.shop.id, chat)).toEqual({ chat_id: chat, status: 'active' });
    await send(startUpdate(chat, '/stop@some_other_bot'));
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('active');
    expect(await messages(chat)).toEqual([]);
    // Addressed to this bot (in any letter case).
    await send(startUpdate(chat, `/stop@MOCK_${botIdOf(c.t)}_bot`));
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('unsubscribed');
  });

  it('my_chat_member: blocking the bot is recorded, unblocking lifts only a block, and nothing is answered', async () => {
    const c = await connected();
    const send = sender(c);
    const chat = newChat();
    await send(startUpdate(chat));
    expect(await send(memberUpdate(chat, 'kicked'))).toEqual({ status: 200, body: { ok: true, handled: false } });
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('blocked');
    await send(memberUpdate(chat, 'member'));
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('active');

    // Unsubscribed with /stop: "member" does not subscribe again — only /start does.
    await send(startUpdate(chat, '/stop'));
    await send(memberUpdate(chat, 'member'));
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('unsubscribed');

    // A user the bot never saw is not added by a block.
    const stranger = newChat();
    await send(memberUpdate(stranger, 'kicked'));
    expect(db.subscriber(c.shop.id, stranger)).toBeUndefined();
    expect(await messages(stranger)).toEqual([]);
    // The welcome and the /stop confirmation only.
    expect(await messages(chat)).toHaveLength(2);
  });

  it('groups, channels and bots are never recorded', async () => {
    const c = await connected();
    const send = sender(c);
    db.calls.length = 0;
    await send(startUpdate(-100123, '/start', 'supergroup'));
    await send({ update_id: updateSeq++, my_chat_member: { chat: { id: -100123, type: 'supergroup' }, new_chat_member: { status: 'kicked' } } });
    const botChat = newChat();
    await send({ update_id: updateSeq++, message: { text: '/start', chat: { id: botChat, type: 'private' }, from: { id: botChat, is_bot: true } } });
    await send({ update_id: updateSeq++, channel_post: { text: '/start', chat: { id: -100456, type: 'channel' } } });
    expect(db.calls).not.toContain('bot_webhook_track');
    expect(db.subscribers.size).toBe(0);
    expect(await messages(botChat)).toEqual([]);
  });

  it('an update that cannot be recorded is released (503) and handled when Telegram delivers it again', async () => {
    const c = await connected();
    const send = sender(c);
    const chat = newChat();
    const update = startUpdate(chat);
    db.trackFails = true;
    expect((await send(update)).status).toBe(503);
    expect(await messages(chat)).toEqual([]);
    db.trackFails = false;
    expect(await send(update)).toEqual({ status: 200, body: { ok: true, handled: true } });
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('active');
    expect(await messages(chat)).toHaveLength(1);
  });

  it('a shop that is not active: the user is recorded, nothing is answered', async () => {
    const c = await connected();
    db.shops.get(c.shop.id)!.status = 'suspended';
    const chat = newChat();
    expect(await sender(c)(startUpdate(chat))).toEqual({ status: 200, body: { ok: true, handled: false } });
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('active');
    expect(await messages(chat)).toEqual([]);
  });

  it("each bot has its own audience: another shop's bot knows nobody, and a replaced bot starts empty", async () => {
    const a = await connected('noir-vapor', 'Noir Vapor');
    const b = await connected('mint-lab', 'Mint Lab');
    const chat = newChat();
    await sender(a)(startUpdate(chat));
    expect(db.subscriber(a.shop.id, chat)!.status).toBe('active');
    expect(db.subscriber(b.shop.id, chat)).toBeUndefined();

    // Telegram does not let a bot write to the users of another bot.
    await connectBot(deps, { shopId: a.shop.id, actor: a.shop.actor, botToken: token() });
    expect(db.subscriber(a.shop.id, chat)).toBeUndefined();
  });
});

describe('webhook: /emoji (ids of Premium emoji, for the owner)', () => {
  it('answers with the id of every Premium emoji of the message, as plain text', async () => {
    const c = await connected();
    const chat = newChat();
    const update = messageUpdate(chat, {
      text: '/emoji 🔥👍',
      entities: [
        { type: 'bot_command', offset: 0, length: 6 },
        { type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: FIRE },
        { type: 'custom_emoji', offset: 9, length: 2, custom_emoji_id: HAND },
      ],
    });
    expect(await sender(c)(update)).toEqual({ status: 200, body: { ok: true, handled: true } });
    const [msg, ...rest] = await messages(chat);
    expect(rest).toEqual([]);
    expect(msg!.text.split('\n').slice(0, 3)).toEqual(['ID Premium Emoji:', `🔥 — ${FIRE}`, `👍 — ${HAND}`]);
    // No parse mode: the example tag in the answer is shown literally.
    expect(msg).toMatchObject({ parse_mode: null, entities: null, reply_markup: null });
    expect(msg!.text).toContain('<tg-emoji emoji-id="ID">');
    // For the audience it is an ordinary message.
    expect(db.subscriber(c.shop.id, chat)!.status).toBe('active');
  });

  it('without a Premium emoji it explains what to send; an answer that failed is not re-delivered', async () => {
    const c = await connected();
    const send = sender(c);
    const chat = newChat();
    await send(messageUpdate(chat, { text: '/emoji' }));
    expect((await messages(chat))[0]!.text).toContain('Отправьте команду /emoji');
    await failNext(chat, 1);
    expect(await send(messageUpdate(chat, { text: '/emoji 🔥' }))).toEqual({ status: 200, body: { ok: true, handled: true } });
    expect(await messages(chat)).toHaveLength(1);
  });
});

describe('Premium emoji in the welcome', () => {
  const rich = {
    welcomeText: `Привет ${tag(HAND, '👋')} в {название_магазина}`,
    openButtonText: '🛍 Каталог',
    managerButtonText: 'Менеджер',
    managerUrl: '@noir_manager',
    openButtonEmojiId: FIRE,
    managerButtonEmojiId: ` ${HAND} `,
  };
  const store = `${PUBLIC}/s/noir-vapor/`;

  it('the tag in the text becomes a custom_emoji entity and the button ids become icons — sent without a parse mode', async () => {
    const c = await connected();
    const saved = await saveWelcome(deps, c.shop.id, c.shop.actor, rich);
    expect(saved.settings.welcome).toMatchObject({ welcome_text: rich.welcomeText, open_button_emoji_id: FIRE, manager_button_emoji_id: HAND });

    const chat = newChat();
    await sender(c)(startUpdate(chat));
    const [msg, ...rest] = await messages(chat);
    expect(rest).toEqual([]);
    expect(msg!.text).toBe('Привет 👋 в Noir Vapor');
    expect(msg!.parse_mode).toBeNull();
    // "Привет " is 7 UTF-16 code units; 👋 is a surrogate pair.
    expect(msg!.entities).toEqual([{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: HAND }]);
    expect(msg!.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: '🛍 Каталог', web_app: { url: store }, icon_custom_emoji_id: FIRE }],
        [{ text: 'Менеджер', url: 'https://t.me/noir_manager', icon_custom_emoji_id: HAND }],
      ],
    });
    // The Menu Button has no icon: Telegram shows only its text.
    expect((await state(botIdOf(c.t))).menu_button).toEqual({ type: 'web_app', text: '🛍 Каталог', web_app: { url: store } });
  });

  it('a bot that may not use Premium emoji still answers /start once: Unicode emoji, buttons without icons', async () => {
    const c = await connected('noir-vapor', 'Noir Vapor', 'NOEMOJI');
    await saveWelcome(deps, c.shop.id, c.shop.actor, rich);
    const chat = newChat();
    expect(await sender(c)(startUpdate(chat))).toEqual({ status: 200, body: { ok: true, handled: true } });
    const [msg, ...rest] = await messages(chat);
    expect(rest).toEqual([]);
    expect(msg!.text).toBe('Привет 👋 в Noir Vapor');
    expect(msg!.entities).toBeNull();
    expect(msg!.reply_markup).toEqual({
      inline_keyboard: [[{ text: '🛍 Каталог', web_app: { url: store } }], [{ text: 'Менеджер', url: 'https://t.me/noir_manager' }]],
    });
  });

  it('button emoji ids are validated; an empty value removes the icon; an absent one (an older admin page) keeps it', async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const input = { welcomeText: 'Hi', openButtonText: 'Open', managerButtonText: 'Manager', managerUrl: '' };
    for (const bad of ['abc', '1234', '12345x', '<b>']) {
      await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, openButtonEmojiId: bad }), 'invalid_emoji_id');
      await expectFlowError(saveWelcome(deps, A.id, A.actor, { ...input, managerButtonEmojiId: bad }), 'invalid_emoji_id');
    }
    expect(db.welcome.has(A.id)).toBe(false);

    await saveWelcome(deps, A.id, A.actor, { ...input, openButtonEmojiId: FIRE, managerButtonEmojiId: HAND });
    const kept = await saveWelcome(deps, A.id, A.actor, { ...input, welcomeText: 'Hello' });
    expect(kept.settings.welcome).toMatchObject({ welcome_text: 'Hello', open_button_emoji_id: FIRE, manager_button_emoji_id: HAND });
    const removed = await saveWelcome(deps, A.id, A.actor, { ...input, openButtonEmojiId: '', managerButtonEmojiId: HAND });
    expect(removed.settings.welcome).toMatchObject({ open_button_emoji_id: null, manager_button_emoji_id: HAND });
  });

  it('the length limit applies to the message as sent (a tag counts as its emoji); at most 100 Premium emoji', async () => {
    const L = db.addShop('long-name', 'N'.repeat(80));
    const input = { openButtonText: 'Open', managerButtonText: 'Manager', managerUrl: '' };
    // Sent: 3980 + 2 (the emoji) + 80 (the name) = 4062 characters. With the 54-character tag counted it would be 4114.
    const fits = `${'x'.repeat(3980)}${tag(FIRE, '🔥')}{название_магазина}`;
    expect((await saveWelcome(deps, L.id, L.actor, { ...input, welcomeText: fits })).settings.welcome.welcome_text).toBe(fits);
    // Sent: 4015 + 2 + 80 = 4097.
    await expectFlowError(saveWelcome(deps, L.id, L.actor, { ...input, welcomeText: `${'x'.repeat(4015)}${tag(FIRE, '🔥')}{название_магазина}` }), 'welcome_too_long');

    const many = (n: number) => Array.from({ length: n }, () => tag('11111', '🔥')).join('');
    await expectFlowError(saveWelcome(deps, L.id, L.actor, { ...input, welcomeText: many(101) }), 'too_many_custom_emoji');
    expect((await saveWelcome(deps, L.id, L.actor, { ...input, welcomeText: many(100) })).settings.welcome.welcome_text).toBe(many(100));
  });
});

describe('tenant isolation', () => {
  it("the owner of another shop can neither read nor change shop A's bot", async () => {
    const A = db.addShop('noir-vapor', 'Noir Vapor');
    const B = db.addShop('mint-lab', 'Mint Lab');
    await connectBot(deps, { shopId: A.id, actor: A.actor, botToken: token() });
    const snapshot = JSON.stringify([...db.conns.entries()]);
    await expectFlowError(getBot(deps, A.id, B.actor), 'forbidden');
    await expectFlowError(connectBot(deps, { shopId: A.id, actor: B.actor, botToken: token() }), 'forbidden');
    await expectFlowError(syncBot(deps, A.id, B.actor), 'forbidden');
    await expectFlowError(disconnectBot(deps, A.id, B.actor), 'forbidden');
    await expectFlowError(saveWelcome(deps, A.id, B.actor, { welcomeText: 'x', openButtonText: 'x', managerButtonText: 'x', managerUrl: '' }), 'forbidden');
    expect(JSON.stringify([...db.conns.entries()])).toBe(snapshot);
    expect(db.welcome.has(A.id)).toBe(false);
  });
});
