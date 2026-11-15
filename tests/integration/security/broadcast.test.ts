// «Рассылка» (20261113090000, bot-connection actions broadcast-*) and the bot audience recorded by telegram-webhook.
// LOCAL ONLY. Every Telegram call goes to the local mock Bot API (global-setup refuses to run otherwise); fake tokens.
// Covers: who is a recipient (only users who started THIS shop's bot), tenant isolation, access control on every
// path, idempotent start, one broadcast at a time, delivery with a Mini App button and Premium emoji (+ fallback),
// photo upload once then file_id, blocked users, transient errors with retry, Telegram 429 / retry_after, the
// owner's retry of failed sends, cancel, and what an ownership change removes.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockBotState, mockFailNext, mockMessages } from '../../../scripts/lib/telegram-mock.ts';
import {
  anon,
  callAdminFunction,
  createMember,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  env,
  fakeBotToken,
  newTelegramUserId,
  type Db,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, PNG, psqlAsync, svcRpc } from './sec-helpers';

const PUBLIC = process.env.PUBLIC_APP_URL ?? 'https://miniapp.local.test';
const botId = (t: string) => Number(t.split(':')[0]);
const sql = async (q: string) => {
  const r = await psqlAsync(q);
  if (r.code !== 0) throw new Error(r.err);
  return r.out;
};
const fn = (client: Db | null, body: Record<string, unknown>) => callAdminFunction('bot-connection', client, body);
const code = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;

interface Overview {
  bot: { bot_username: string } | null;
  audience: { active: number; unsubscribed: number; blocked: number };
  active: Broadcast | null;
  history: Broadcast[];
}
interface Broadcast {
  id: string;
  status: string;
  total: number;
  counts: { pending: number; sent: number; failed: number; blocked: number; cancelled: number };
  resume_at: string | null;
  last_error: string | null;
}
const overviewOf = (r: { body: Record<string, unknown> | null }) => r.body!.overview as Overview;

async function webhookOf(t: string): Promise<{ connectionId: string; secret: string }> {
  const hook = (await mockBotState(botId(t))).webhook;
  if (!hook) throw new Error('no webhook set');
  return { connectionId: new URL(hook.url).searchParams.get('c')!, secret: hook.secret_token! };
}

let updateSeq = Math.floor(Math.random() * 1_000_000_000);
/** An update delivered exactly like Telegram does: only the secret header authenticates it. */
async function deliver(t: string, update: Record<string, unknown>) {
  const { connectionId, secret } = await webhookOf(t);
  const res = await fetch(`${env.url}/functions/v1/telegram-webhook?c=${connectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: updateSeq++, ...update }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}
const message = (user: number, text: string) => ({
  message: { message_id: 1, date: Math.floor(Date.now() / 1000), text, chat: { id: user, type: 'private' }, from: { id: user, is_bot: false, first_name: 'Buyer' } },
});
const memberStatus = (user: number, status: 'kicked' | 'member') => ({
  my_chat_member: { chat: { id: user, type: 'private' }, from: { id: user, is_bot: false }, date: 1, old_chat_member: { status: 'member' }, new_chat_member: { status } },
});
/** A new Telegram user who pressed Start in the bot of `t`. */
async function starter(t: string): Promise<number> {
  const user = newTelegramUserId();
  const res = await deliver(t, message(user, '/start'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return user;
}

const draft = (over: Record<string, unknown> = {}) => ({ idempotencyKey: randomUUID(), text: 'Новинки недели', ...over });
const start = (client: Db, shopId: string, broadcast: Record<string, unknown>) => fn(client, { action: 'broadcast-start', shopId, broadcast });
const run = (client: Db, shopId: string) => fn(client, { action: 'broadcast-run', shopId });
/** Runs worker steps until the shop has no running broadcast (or the step limit is hit). */
async function drain(client: Db, shopId: string, steps = 6) {
  let last = await run(client, shopId);
  for (let i = 1; i < steps && overviewOf(last).active; i++) last = await run(client, shopId);
  return last;
}
/** Broadcast messages a chat received (the /start welcome is not one of them). */
const received = async (user: number, text: string) => (await mockMessages(String(user))).filter((m) => m.text === text);
const recipientRow = (broadcastId: string, user: number) =>
  sql(`select status || '|' || attempts || '|' || coalesce(last_error, '') from private.broadcast_recipients where broadcast_id = '${broadcastId}' and tg_user_id = ${user};`);

/** A shop with its owner and a connected bot. */
async function shopWithBot(prefix = 'FAKE') {
  const shop = await createTestShop();
  const owner = await createOwner(shop.id);
  const token = fakeBotToken(prefix);
  const res = await fn(owner.client, { action: 'connect', shopId: shop.id, botToken: token });
  expect(res.status, res.text).toBe(200);
  return { shop, owner, token };
}

let A: { shop: TestShop; owner: Awaited<ReturnType<typeof createOwner>>; token: string };
let B: typeof A;
let a1: number;
let a2: number;
let a3: number;
let b1: number;

beforeAll(async () => {
  A = await shopWithBot();
  B = await shopWithBot();
  a1 = await starter(A.token);
  a2 = await starter(A.token);
  a3 = await starter(A.token);
  b1 = await starter(B.token);
});
afterAll(cleanupSecurity);

describe('audience: only users who started this shop’s bot', () => {
  it('the webhook now asks Telegram for private messages and block / unblock updates', async () => {
    expect((await mockBotState(botId(A.token))).webhook!.allowed_updates).toEqual(['message', 'my_chat_member']);
  });

  it('records Telegram user id → chat id per shop and bot, nothing else; shops never see each other’s users', async () => {
    const rows = await sql(`select tg_user_id || ':' || chat_id || ':' || bot_id || ':' || status from private.bot_subscribers where shop_id = '${A.shop.id}' order by tg_user_id;`);
    expect(rows.split('\n')).toEqual([a1, a2, a3].sort((x, y) => x - y).map((u) => `${u}:${u}:${botId(A.token)}:active`));
    expect(await sql(`select tg_user_id from private.bot_subscribers where shop_id = '${B.shop.id}';`)).toBe(String(b1));
    expect(overviewOf(await fn(A.owner.client, { action: 'broadcast-get', shopId: A.shop.id })).audience).toEqual({ active: 3, unsubscribed: 0, blocked: 0 });
    expect(overviewOf(await fn(B.owner.client, { action: 'broadcast-get', shopId: B.shop.id })).audience).toEqual({ active: 1, unsubscribed: 0, blocked: 0 });
    // No name or username is stored.
    expect(await sql(`select string_agg(column_name, ',' order by column_name) from information_schema.columns where table_schema = 'private' and table_name = 'bot_subscribers';`)).toBe(
      'bot_id,chat_id,first_started_at,last_started_at,shop_id,status,tg_user_id,updated_at',
    );
  });

  it('an update that is not authenticated for the connection records nobody', async () => {
    const stranger = newTelegramUserId();
    const { connectionId } = await webhookOf(A.token);
    const res = await fetch(`${env.url}/functions/v1/telegram-webhook?c=${connectionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret' },
      body: JSON.stringify({ update_id: updateSeq++, ...message(stranger, '/start') }),
    });
    expect(res.status).toBe(401);
    expect(await sql(`select count(*) from private.bot_subscribers where tg_user_id = ${stranger};`)).toBe('0');
    // Groups and other bots are not an audience either.
    const group = await deliver(A.token, { message: { message_id: 1, date: 1, text: '/start', chat: { id: -100123, type: 'supergroup' }, from: { id: stranger, is_bot: false } } });
    expect(group.status).toBe(200);
    expect(await sql(`select count(*) from private.bot_subscribers where tg_user_id = ${stranger};`)).toBe('0');
  });

  it('/stop unsubscribes (with a confirmation), a block is recorded, /start brings the user back', async () => {
    const X = await shopWithBot();
    const u = await starter(X.token);
    const status = () => sql(`select status from private.bot_subscribers where shop_id = '${X.shop.id}' and tg_user_id = ${u};`);
    expect((await deliver(X.token, message(u, '/stop'))).body).toEqual({ ok: true, handled: true });
    expect(await status()).toBe('unsubscribed');
    expect((await mockMessages(String(u))).at(-1)!.text).toContain('Вы отписались от рассылки');
    // A plain message does not re-subscribe.
    await deliver(X.token, message(u, 'привет'));
    expect(await status()).toBe('unsubscribed');
    await deliver(X.token, message(u, '/start'));
    expect(await status()).toBe('active');
    await deliver(X.token, memberStatus(u, 'kicked'));
    expect(await status()).toBe('blocked');
    await deliver(X.token, memberStatus(u, 'member'));
    expect(await status()).toBe('active');
    expect(overviewOf(await fn(X.owner.client, { action: 'broadcast-get', shopId: X.shop.id })).audience).toEqual({ active: 1, unsubscribed: 0, blocked: 0 });
  });
});

describe('access control', () => {
  it('only the owner (or an aal2 platform admin) reaches any broadcast action; no session → 401', async () => {
    const manager = (await createMember(A.shop.id, 'manager')).client;
    const aal1 = await createPlatformAdmin({ mfa: false });
    const bodies = [
      { action: 'broadcast-get', shopId: A.shop.id },
      { action: 'broadcast-start', shopId: A.shop.id, broadcast: draft() },
      { action: 'broadcast-run', shopId: A.shop.id },
      { action: 'broadcast-cancel', shopId: A.shop.id, broadcastId: randomUUID() },
      { action: 'broadcast-retry', shopId: A.shop.id, broadcastId: randomUUID() },
    ];
    for (const body of bodies) {
      expect((await fn(null, body)).status, body.action).toBe(401);
      for (const [who, client, expected] of [
        ['manager', manager, 'forbidden'],
        ['owner of another shop', B.owner.client, 'forbidden'],
        ['aal1 platform admin', aal1.client, 'mfa_required'],
      ] as const) {
        const res = await fn(client, body);
        expect(res.status, `${who} ${body.action}`).toBe(403);
        expect(code(res), `${who} ${body.action}`).toBe(expected);
      }
    }
    expect(await sql(`select count(*) from private.shop_broadcasts where shop_id = '${A.shop.id}';`)).toBe('0');
    const pa = await createPlatformAdmin();
    expect((await fn(pa.client, { action: 'broadcast-get', shopId: A.shop.id })).status).toBe(200);
  });

  it('browsers can call no broadcast RPC and read no private table; the service role still needs the right actor', async () => {
    for (const client of [anon(), A.owner.client]) {
      for (const [name, args] of [
        ['broadcast_overview', { p_shop_id: A.shop.id, p_actor: A.owner.userId }],
        ['broadcast_start', { p_shop_id: A.shop.id, p_actor: A.owner.userId, p_idempotency_key: randomUUID(), p_message_text: 'x', p_photo_path: null, p_button_text: null, p_button_emoji_id: null }],
        ['broadcast_claim', { p_shop_id: A.shop.id, p_actor: A.owner.userId, p_broadcast_id: randomUUID(), p_worker_id: randomUUID(), p_limit: 5 }],
        ['broadcast_report', { p_broadcast_id: randomUUID(), p_worker_id: randomUUID(), p_results: [], p_retry_after: null, p_photo_file_id: null }],
        ['bot_webhook_track', { p_connection_id: randomUUID(), p_tg_user_id: 1, p_chat_id: 1, p_event: 'start' }],
      ] as const) {
        const r = await client.rpc(name as never, args as never);
        expect(r.error?.message, name).toMatch(/permission denied|Could not find/i);
      }
      for (const table of ['bot_subscribers', 'shop_broadcasts', 'broadcast_recipients']) {
        const t = await (client as unknown as { schema: (s: string) => Db }).schema('private').from(table as never).select('*');
        expect(t.error, table).not.toBeNull();
      }
    }
    // Another shop's owner as the actor: refused in SQL, whatever the caller.
    expect((await svcRpc('broadcast_overview', { p_shop_id: A.shop.id, p_actor: B.owner.userId })).error?.message).toBe('forbidden');
    expect(
      (await svcRpc('broadcast_start', { p_shop_id: A.shop.id, p_actor: B.owner.userId, p_idempotency_key: randomUUID(), p_message_text: 'x', p_photo_path: null, p_button_text: null, p_button_emoji_id: null })).error?.message,
    ).toBe('forbidden');
  });
});

describe('start: validation, idempotency, one broadcast at a time', () => {
  it('refuses bad content before anything is queued', async () => {
    for (const [broadcast, expected, status] of [
      [draft({ text: '   ' }), 'invalid_broadcast_text', 400],
      [draft({ text: 'x'.repeat(4097) }), 'invalid_broadcast_text', 400],
      [draft({ button: { text: '  ' } }), 'invalid_broadcast_button', 400],
      [draft({ button: { text: 'Открыть', emojiId: 'not-an-id' } }), 'invalid_emoji_id', 400],
      [draft({ photoPath: `${B.shop.id}/broadcast/${randomUUID()}.png` }), 'invalid_broadcast_photo', 400],
      [draft({ photoPath: `${A.shop.id}/broadcast/${randomUUID()}.png` }), 'invalid_broadcast_photo', 400], // no such object
    ] as const) {
      const res = await start(A.owner.client, A.shop.id, broadcast);
      expect(res.status, `${expected}: ${res.text}`).toBe(status);
      expect(code(res)).toBe(expected);
    }
    expect((await fn(A.owner.client, { action: 'broadcast-start', shopId: A.shop.id, broadcast: { ...draft(), idempotencyKey: 'nope' } })).status).toBe(400);
    expect(await sql(`select count(*) from private.shop_broadcasts where shop_id = '${A.shop.id}';`)).toBe('0');
  });

  it('needs a connected bot and at least one user who started it', async () => {
    const noBot = await createTestShop();
    const ownerNoBot = await createOwner(noBot.id);
    const res = await start(ownerNoBot.client, noBot.id, draft());
    expect([res.status, code(res)]).toEqual([404, 'not_connected']);
    const empty = await shopWithBot();
    const none = await start(empty.owner.client, empty.shop.id, draft());
    expect([none.status, code(none)]).toEqual([409, 'no_recipients']);
    expect(await sql(`select count(*) from private.shop_broadcasts where shop_id = '${empty.shop.id}';`)).toBe('0');
  });

  it('a repeated request starts nothing new; a second broadcast waits for the running one', async () => {
    const X = await shopWithBot();
    const u = await starter(X.token);
    const first = draft({ text: 'Первая рассылка' });
    const started = await start(X.owner.client, X.shop.id, first);
    expect(started.status, started.text).toBe(200);
    expect(started.body!.replayed).toBe(false);
    expect(overviewOf(started).active).toMatchObject({ status: 'sending', total: 1, counts: { pending: 1, sent: 0 } });
    const again = await start(X.owner.client, X.shop.id, first);
    expect([again.status, again.body!.replayed]).toEqual([200, true]);
    const other = await start(X.owner.client, X.shop.id, draft({ text: 'Вторая' }));
    expect([other.status, code(other)]).toEqual([409, 'broadcast_in_progress']);
    expect(await sql(`select count(*) from private.shop_broadcasts where shop_id = '${X.shop.id}';`)).toBe('1');

    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).active).toBeNull();
    expect(overviewOf(done).history[0]).toMatchObject({ status: 'completed', counts: { pending: 0, sent: 1, failed: 0 } });
    // Replaying the finished broadcast (or running the worker again) sends nothing more.
    expect((await start(X.owner.client, X.shop.id, first)).body!.replayed).toBe(true);
    await run(X.owner.client, X.shop.id);
    expect(await received(u, 'Первая рассылка')).toHaveLength(1);
  });

  it('at most 10 broadcasts per shop in 24 hours', async () => {
    const X = await shopWithBot();
    await starter(X.token);
    await sql(
      `insert into private.shop_broadcasts (shop_id, bot_id, idempotency_key, message_text, status, created_by, completed_at)
       select '${X.shop.id}', ${botId(X.token)}, gen_random_uuid(), 'old', 'completed', '${X.owner.userId}', now() from generate_series(1, 10);`,
    );
    const res = await start(X.owner.client, X.shop.id, draft());
    expect([res.status, code(res)]).toEqual([429, 'broadcast_rate_limited']);
  });
});

describe('delivery', () => {
  it('reaches exactly the users of THIS shop’s bot, through that bot, with the Mini App button and Premium emoji', async () => {
    const text = 'Скидки <tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji> в {название_магазина} <b>не тег</b>';
    const sentText = `Скидки 🔥 в IT ${A.shop.slug} <b>не тег</b>`;
    const started = await start(A.owner.client, A.shop.id, draft({ text, button: { text: '🛍 В магазин', emojiId: '5368324170671202287' } }));
    expect(started.status, started.text).toBe(200);
    expect(overviewOf(started).active).toMatchObject({ total: 3 });
    const done = await drain(A.owner.client, A.shop.id);
    expect(overviewOf(done).active).toBeNull();
    expect(overviewOf(done).history[0]).toMatchObject({ status: 'completed', total: 3, counts: { pending: 0, sent: 3, failed: 0, blocked: 0, cancelled: 0 } });

    for (const u of [a1, a2, a3]) {
      const [msg, ...rest] = await received(u, sentText);
      expect(rest, String(u)).toEqual([]);
      expect(msg!.bot_id).toBe(botId(A.token));
      // Plain text: no parse mode, so "<b>" stays literal; the Premium emoji is an entity over the Unicode fallback.
      expect(msg!.parse_mode).toBeNull();
      expect(msg!.entities).toEqual([{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: '5368324170671202286' }]);
      expect(msg!.reply_markup).toEqual({
        inline_keyboard: [[{ text: '🛍 В магазин', web_app: { url: `${PUBLIC}/s/${A.shop.slug}/` }, icon_custom_emoji_id: '5368324170671202287' }]],
      });
    }
    // Shop B's user started another bot: nothing, and nothing was sent through B's bot.
    expect(await received(b1, sentText)).toEqual([]);
    expect(await sql(`select count(*) from private.broadcast_recipients where shop_id = '${B.shop.id}';`)).toBe('0');
    // A user who never started the bot is unknown to it.
    expect(await mockMessages(String(newTelegramUserId()))).toEqual([]);
  });

  it('a bot that may not use Premium emoji still delivers: Unicode emoji in the text, button without the icon', async () => {
    const X = await shopWithBot('NOEMOJI');
    const u = await starter(X.token);
    const v = await starter(X.token);
    await start(X.owner.client, X.shop.id, draft({ text: 'Привет <tg-emoji emoji-id="5368324170671202286">👋</tg-emoji>', button: { text: 'Открыть', emojiId: '5368324170671202287' } }));
    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).history[0]).toMatchObject({ status: 'completed', counts: { sent: 2, failed: 0 } });
    for (const user of [u, v]) {
      const [msg, ...rest] = await received(user, 'Привет 👋');
      expect(rest).toEqual([]);
      expect(msg!.entities).toBeNull();
      expect(msg!.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Открыть', web_app: { url: `${PUBLIC}/s/${X.shop.slug}/` } }]] });
    }
  });

  it('a photo is uploaded to Telegram once and re-sent by file_id; the caption limit is enforced', async () => {
    const X = await shopWithBot();
    const u = await starter(X.token);
    const v = await starter(X.token);
    const path = `${X.shop.id}/broadcast/${randomUUID()}.png`;
    const up = await X.owner.client.storage.from('shop-media').upload(path, PNG, { contentType: 'image/png' });
    expect(up.error).toBeNull();
    const long = await start(X.owner.client, X.shop.id, draft({ text: 'я'.repeat(1025), photoPath: path }));
    expect([long.status, code(long)]).toEqual([400, 'broadcast_too_long']);

    const started = await start(X.owner.client, X.shop.id, draft({ text: 'Фото дня', photoPath: path }));
    expect(started.status, started.text).toBe(200);
    await drain(X.owner.client, X.shop.id);
    const photos = (await Promise.all([u, v].map((user) => received(user, 'Фото дня')))).flat().map((m) => m.photo);
    expect(photos).toHaveLength(2);
    const uploads = photos.filter((p) => p && 'upload_bytes' in p);
    const byId = photos.filter((p) => p && 'file_id' in p);
    expect(uploads).toEqual([{ upload_bytes: PNG.length }]);
    expect(byId).toHaveLength(1);
    expect(await sql(`select photo_file_id is not null from private.shop_broadcasts where shop_id = '${X.shop.id}';`)).toBe('t');
  });

  it('a user who blocked the bot is not retried and leaves the audience; the others still get the message', async () => {
    const X = await shopWithBot();
    const gone = await starter(X.token);
    const ok = await starter(X.token);
    await mockFailNext(String(gone), 5, 403);
    const started = await start(X.owner.client, X.shop.id, draft({ text: 'Для всех' }));
    const id = overviewOf(started).active!.id;
    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).history[0]).toMatchObject({ status: 'completed', counts: { sent: 1, blocked: 1, failed: 0, pending: 0 } });
    expect(await recipientRow(id, gone)).toMatch(/^blocked\|1\|bot_cannot_post/);
    expect(await received(ok, 'Для всех')).toHaveLength(1);
    expect(overviewOf(done).audience).toEqual({ active: 1, unsubscribed: 0, blocked: 1 });
    // The next broadcast does not even try the blocked user.
    const next = await start(X.owner.client, X.shop.id, draft({ text: 'Ещё раз' }));
    expect(overviewOf(next).active).toMatchObject({ total: 1 });
    await drain(X.owner.client, X.shop.id);
    expect(await received(gone, 'Ещё раз')).toEqual([]);
  });

  it('a transient Telegram error is retried later with backoff — once delivered, never twice', async () => {
    const X = await shopWithBot();
    const u = await starter(X.token);
    await mockFailNext(String(u), 1, 500);
    const id = overviewOf(await start(X.owner.client, X.shop.id, draft({ text: 'С повтором' }))).active!.id;
    const first = await run(X.owner.client, X.shop.id);
    // Not delivered, not failed: waiting for its retry time.
    expect((first.body!.worker as { state: string }).state).toBe('waiting');
    expect(overviewOf(first).active).toMatchObject({ status: 'sending', counts: { pending: 1, sent: 0, failed: 0 } });
    expect(await recipientRow(id, u)).toMatch(/^pending\|1\|telegram_unavailable/);
    expect(await sql(`select next_attempt_at > now() + interval '10 seconds' from private.broadcast_recipients where broadcast_id = '${id}';`)).toBe('t');
    expect(await received(u, 'С повтором')).toEqual([]);
    // The retry time comes.
    await sql(`update private.broadcast_recipients set next_attempt_at = now() where broadcast_id = '${id}';`);
    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).history[0]).toMatchObject({ status: 'completed', counts: { sent: 1, failed: 0 } });
    expect(await recipientRow(id, u)).toBe('sent|2|');
    expect(await received(u, 'С повтором')).toHaveLength(1);
  });

  it('Telegram 429: the whole broadcast waits retry_after, nothing else is sent meanwhile, and no attempt is lost', async () => {
    const X = await shopWithBot();
    const users = [await starter(X.token), await starter(X.token), await starter(X.token)].sort((x, y) => x - y);
    // The first recipient (lowest id) hits the flood limit.
    await mockFailNext(String(users[0]), 1, 429, 30);
    const id = overviewOf(await start(X.owner.client, X.shop.id, draft({ text: 'Под лимитом' }))).active!.id;
    const paused = await run(X.owner.client, X.shop.id);
    expect((paused.body!.worker as { state: string }).state).toBe('paused');
    const active = overviewOf(paused).active!;
    expect(active).toMatchObject({ status: 'sending', counts: { pending: 3, sent: 0, failed: 0 } });
    const waitSec = (Date.parse(active.resume_at!) - Date.now()) / 1000;
    expect(waitSec).toBeGreaterThan(25);
    expect(waitSec).toBeLessThan(35);
    // Nobody got anything, and the attempts were given back.
    for (const u of users) expect(await received(u, 'Под лимитом')).toEqual([]);
    expect(await sql(`select string_agg(status || ':' || attempts, ',' order by tg_user_id) from private.broadcast_recipients where broadcast_id = '${id}';`)).toBe('pending:0,pending:0,pending:0');
    // Calling the worker again while Telegram makes us wait sends nothing.
    const still = await run(X.owner.client, X.shop.id);
    expect((still.body!.worker as { state: string; sent: number })).toEqual({ state: 'paused', sent: 0 });
    for (const u of users) expect(await received(u, 'Под лимитом')).toEqual([]);
    // The pause is over.
    await sql(`update private.shop_broadcasts set resume_at = now() - interval '1 second' where id = '${id}';`);
    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).history[0]).toMatchObject({ status: 'completed', counts: { sent: 3, failed: 0, pending: 0 } });
    for (const u of users) expect(await received(u, 'Под лимитом')).toHaveLength(1);
  });

  it('after three failed attempts the send is "failed"; the owner retries it and it is delivered once', async () => {
    const X = await shopWithBot();
    const u = await starter(X.token);
    await mockFailNext(String(u), 3, 500);
    const id = overviewOf(await start(X.owner.client, X.shop.id, draft({ text: 'Упорная' }))).active!.id;
    for (let i = 0; i < 3; i++) {
      await run(X.owner.client, X.shop.id);
      await sql(`update private.broadcast_recipients set next_attempt_at = now() where broadcast_id = '${id}' and status = 'pending';`);
    }
    const failed = await run(X.owner.client, X.shop.id);
    expect(overviewOf(failed).active).toBeNull();
    expect(overviewOf(failed).history[0]).toMatchObject({ id, status: 'completed', counts: { sent: 0, failed: 1 } });
    expect(await recipientRow(id, u)).toMatch(/^failed\|3\|telegram_unavailable/);

    // Not this shop's broadcast for anyone else.
    const foreign = await fn(B.owner.client, { action: 'broadcast-retry', shopId: B.shop.id, broadcastId: id });
    expect([foreign.status, code(foreign)]).toEqual([404, 'broadcast_not_found']);
    const retried = await fn(X.owner.client, { action: 'broadcast-retry', shopId: X.shop.id, broadcastId: id });
    expect(retried.status, retried.text).toBe(200);
    expect(retried.body!.retried).toBe(1);
    expect(overviewOf(retried).active).toMatchObject({ id, status: 'sending', counts: { pending: 1, failed: 0 } });
    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).history[0]).toMatchObject({ id, status: 'completed', counts: { sent: 1, failed: 0 } });
    expect(await received(u, 'Упорная')).toHaveLength(1);
    // Nothing left to retry.
    expect((await fn(X.owner.client, { action: 'broadcast-retry', shopId: X.shop.id, broadcastId: id })).body!.retried).toBe(0);
  });

  it('a send whose outcome is unknown (worker died) is never repeated automatically', async () => {
    const X = await shopWithBot();
    const u = await starter(X.token);
    const id = overviewOf(await start(X.owner.client, X.shop.id, draft({ text: 'Прерванная' }))).active!.id;
    // A worker claimed the recipient and vanished before reporting; its claim expired.
    const claim = await svcRpc('broadcast_claim', { p_shop_id: X.shop.id, p_actor: X.owner.userId, p_broadcast_id: id, p_worker_id: randomUUID(), p_limit: 5 });
    expect((claim.data as { state: string }).state).toBe('send');
    // While that worker holds the lease, another one sends nothing.
    expect(((await run(X.owner.client, X.shop.id)).body!.worker as { state: string }).state).toBe('busy');
    await sql(`update private.broadcast_recipients set locked_until = now() - interval '1 second' where broadcast_id = '${id}';
               update private.shop_broadcasts set worker_until = now() - interval '1 second' where id = '${id}';`);
    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).history[0]).toMatchObject({ status: 'completed', counts: { sent: 0, failed: 1 } });
    expect(await recipientRow(id, u)).toBe('failed|1|interrupted');
    expect(await received(u, 'Прерванная')).toEqual([]);
  });

  it('«Остановить» drops what was not sent yet; a user who unsubscribed meanwhile is skipped', async () => {
    const X = await shopWithBot();
    const u = await starter(X.token);
    const v = await starter(X.token);
    const id = overviewOf(await start(X.owner.client, X.shop.id, draft({ text: 'Отменённая' }))).active!.id;
    const cancelled = await fn(X.owner.client, { action: 'broadcast-cancel', shopId: X.shop.id, broadcastId: id });
    expect(cancelled.status, cancelled.text).toBe(200);
    expect(overviewOf(cancelled).active).toBeNull();
    expect(overviewOf(cancelled).history[0]).toMatchObject({ id, status: 'cancelled', counts: { cancelled: 2, sent: 0, pending: 0 } });
    await run(X.owner.client, X.shop.id);
    for (const user of [u, v]) expect(await received(user, 'Отменённая')).toEqual([]);

    const next = overviewOf(await start(X.owner.client, X.shop.id, draft({ text: 'После отписки' }))).active!.id;
    await deliver(X.token, message(u, '/stop'));
    const done = await drain(X.owner.client, X.shop.id);
    expect(overviewOf(done).history[0]).toMatchObject({ id: next, status: 'completed', counts: { sent: 1, cancelled: 1 } });
    expect(await received(u, 'После отписки')).toEqual([]);
    expect(await received(v, 'После отписки')).toHaveLength(1);
  });

  it('a replaced bot starts with an empty audience: users of the former bot are never written to', async () => {
    const X = await shopWithBot();
    const old = await starter(X.token);
    const replaced = fakeBotToken();
    expect((await fn(X.owner.client, { action: 'connect', shopId: X.shop.id, botToken: replaced })).status).toBe(200);
    expect(overviewOf(await fn(X.owner.client, { action: 'broadcast-get', shopId: X.shop.id })).audience.active).toBe(0);
    const none = await start(X.owner.client, X.shop.id, draft({ text: 'Новый бот' }));
    expect(code(none)).toBe('no_recipients');
    const fresh = await starter(replaced);
    await start(X.owner.client, X.shop.id, draft({ text: 'Новый бот' }));
    await drain(X.owner.client, X.shop.id);
    expect(await received(old, 'Новый бот')).toEqual([]);
    const [msg] = await received(fresh, 'Новый бот');
    expect(msg!.bot_id).toBe(botId(replaced));
  });
});

describe('ownership change', () => {
  it('removes the audience and the broadcasts of the former owner’s bot', async () => {
    const X = await shopWithBot();
    await starter(X.token);
    await start(X.owner.client, X.shop.id, draft());
    await drain(X.owner.client, X.shop.id);
    const pa = await createPlatformAdmin();
    const next = await createMember(B.shop.id, 'manager');
    const transfer = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: X.shop.id, userId: next.userId });
    expect(transfer.status, transfer.text).toBe(200);
    for (const table of ['bot_subscribers', 'shop_broadcasts', 'broadcast_recipients', 'shop_bot_connections']) {
      expect(await sql(`select count(*) from private.${table} where shop_id = '${X.shop.id}';`), table).toBe('0');
    }
  });
});
