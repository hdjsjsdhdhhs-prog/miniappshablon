// One Telegram bot, one purpose of a shop (20261126090000): the bot of «Уведомления» can never be the bot of «Подключение
// бота» (the storefront) and back. LOCAL ONLY: the real Edge Functions, the real database and the local MOCK Bot API
// (global-setup refuses to run otherwise); only fake tokens, nothing reaches Telegram.
//
// Identity of a bot is its Bot ID from getMe. The mock answers getMe with the id in the token, so a re-issued token of the
// same bot (same id, another secret) is the same bot and two different ids are two different bots.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { localStack } from '../../../scripts/lib/local-stack.ts';
import { mockBotState, mockMessages } from '../../../scripts/lib/telegram-mock.ts';
import {
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  createOwner,
  createTestShop,
  fakeBotToken,
  initDataFor,
  newTelegramUserId,
  waitFor,
  type Db,
  type TestShop,
} from '../helpers';
import { botFn, botIdOf, deliver, errorCode, privateMessage, sql, starter } from './bot-helpers';
import { cleanupSecurity, psqlAsync, sleep, svcRpc } from './sec-helpers';

const startedAt = new Date();
const run = randomBytes(3).toString('hex');
const chat = (kind: string) => `@sep_${kind}_${run}`;
const used: string[] = [];
/** A fake token; `prefix` picks the mock's behaviour (UNAUTHORIZED / UNAVAILABLE). */
function token(prefix?: string): string {
  const t = fakeBotToken(prefix);
  used.push(t.split(':')[1]!);
  return t;
}
/** Another token of the SAME bot: same Bot ID, another secret (what BotFather's /revoke gives). */
function reissued(t: string): string {
  const t2 = `${botIdOf(t)}:FAKE_${randomBytes(18).toString('hex')}`;
  used.push(t2.split(':')[1]!);
  return t2;
}
const noSecret = (text: string) => used.every((s) => !text.includes(s));

interface Ctx {
  shop: TestShop;
  owner: Awaited<ReturnType<typeof createOwner>>;
}
async function fresh(): Promise<Ctx> {
  const shop = await createTestShop({ variants: [{ flavor: 'Mint', stock: 50 }] });
  return { shop, owner: await createOwner(shop.id) };
}

const notif = (c: Ctx, body: Record<string, unknown>) => callAdminFunction('notification-settings', c.owner.client, { shopId: c.shop.id, ...body });
const saveNotif = (c: Ctx, botToken: string | undefined, chatId = chat('main')) => notif(c, { action: 'save', botToken, chatId });
const connect = (c: Ctx, botToken: string, extra: Record<string, unknown> = {}) => botFn(c.owner.client, { action: 'connect', shopId: c.shop.id, botToken, ...extra });
const storefront = (c: Ctx) => botFn(c.owner.client, { action: 'get', shopId: c.shop.id });

type NotifSettings = { configured: boolean; enabled: boolean; token_hint: string | null; bot_username: string | null; chat_id: string | null; status: string };
const notifSettings = async (c: Ctx) => ((await notif(c, { action: 'get' })).body!.settings as NotifSettings);
const botConnection = async (c: Ctx) => ((await storefront(c)).body!.settings as { connection: { bot_id: number; token_hint: string; connected_at: string } | null }).connection;

/** Registry rows of a shop, e.g. [{"purpose":"notifications","bot_id":1},{"purpose":"storefront","bot_id":2}]. */
async function assignments(shopId: string): Promise<Array<{ purpose: string; bot_id: number }>> {
  const out = await sql(
    `select coalesce(json_agg(json_build_object('purpose', purpose, 'bot_id', bot_id) order by purpose), '[]'::json) from private.shop_bot_assignments where shop_id = '${shopId}';`,
  );
  return JSON.parse(out) as Array<{ purpose: string; bot_id: number }>;
}
const registry = (rows: Array<[purpose: 'notifications' | 'storefront', bot: string]>) =>
  rows.map(([purpose, t]) => ({ purpose, bot_id: botIdOf(t) })).sort((a, b) => a.purpose.localeCompare(b.purpose));
const vaultCount = async (shopId: string, kind: 'notify' | 'bot') => Number(await sql(`select count(*) from vault.secrets where name like 'shop_tg_${kind}:${shopId}:%';`));
const storedToken = (shopId: string, table: 'shop_notification_settings' | 'shop_bot_connections') =>
  sql(`select d.decrypted_secret from vault.decrypted_secrets d join private.${table} t on t.bot_token_secret_id = d.id where t.shop_id = '${shopId}';`);

const NOTIF_CONFLICT = 'bot_used_for_storefront';
const BOT_CONFLICT = 'bot_used_for_notifications';

afterAll(cleanupSecurity);

describe('two different bots work side by side', () => {
  it('NotificationBot (notifications) and StoreBot (storefront) are both saved, stored separately and registered', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    const first = await saveNotif(c, N);
    expect(first.status, first.text).toBe(200);
    const second = await connect(c, S);
    expect(second.status, second.text).toBe(200);
    expect(noSecret(first.text + second.text)).toBe(true);

    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));
    // Two Vault secrets, one per purpose; each section reads only its own token.
    expect(await vaultCount(c.shop.id, 'notify')).toBe(1);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(1);
    expect(await storedToken(c.shop.id, 'shop_notification_settings')).toBe(N);
    expect(await storedToken(c.shop.id, 'shop_bot_connections')).toBe(S);
    expect((await notifSettings(c)).bot_username).toBe(`mock_${botIdOf(N)}_bot`);
    expect((await botConnection(c))!.bot_id).toBe(botIdOf(S));
  });

  it('the order notification goes out through NotificationBot, the welcome message through StoreBot — at the same time', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    const channel = chat(`orders_${randomBytes(2).toString('hex')}`);
    expect((await saveNotif(c, N, channel)).status).toBe(200);
    expect((await connect(c, S)).status).toBe(200);

    const user = await starter(S);
    const welcome = await waitFor(() => mockMessages(String(user)), (m) => m.length > 0);
    expect(welcome.map((m) => m.bot_id)).toEqual([botIdOf(S)]);

    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(c.shop, [{ variantId: c.shop.variants[0]!.id, quantity: 1 }]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const sent = await waitFor(() => mockMessages(channel), (m) => m.length > 0);
    expect(sent.map((m) => m.bot_id)).toEqual([botIdOf(N)]);

    // The notification bot has no webhook / Menu Button of the storefront; the storefront bot posts nothing to the channel.
    expect((await mockBotState(botIdOf(N))).webhook).toBeNull();
    expect((await mockBotState(botIdOf(N))).menu_button).toEqual({ type: 'default' });
    expect((await mockMessages(channel)).every((m) => m.bot_id !== botIdOf(S))).toBe(true);
  });
});

describe('scenario A: NotificationBot is connected first, then pasted into «Подключение бота»', () => {
  it('is refused with bot_used_for_notifications; nothing is saved or changed, in the database or in Telegram', async () => {
    const c = await fresh();
    const N = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    const before = await notifSettings(c);

    const res = await connect(c, N);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe(BOT_CONFLICT);
    expect(noSecret(res.text)).toBe(true);
    expect(res.text).not.toContain(N);

    expect(await botConnection(c)).toBeNull();
    expect(await vaultCount(c.shop.id, 'bot')).toBe(0);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N]]));
    // Refused before anything was set on the bot.
    const tg = await mockBotState(botIdOf(N));
    expect(tg.webhook).toBeNull();
    expect(tg.menu_button).toEqual({ type: 'default' });
    // The notifications are exactly as they were.
    expect(await notifSettings(c)).toEqual(before);
    expect(await storedToken(c.shop.id, 'shop_notification_settings')).toBe(N);

    // A different bot is accepted right after the refusal.
    const S = token();
    expect((await connect(c, S)).status).toBe(200);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));
  });

  it('replacing a working StoreBot with NotificationBot is refused and the working connection stays exactly as it was', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await connect(c, S)).status).toBe(200);
    const before = await botConnection(c);
    const hookBefore = (await mockBotState(botIdOf(S))).webhook;

    const res = await connect(c, N);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe(BOT_CONFLICT);
    expect(await botConnection(c)).toEqual(before);
    expect(await storedToken(c.shop.id, 'shop_bot_connections')).toBe(S);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(1);
    expect((await mockBotState(botIdOf(S))).webhook).toEqual(hookBefore);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));
    // The storefront still answers /start.
    const user = await starter(S);
    expect((await waitFor(() => mockMessages(String(user)), (m) => m.length > 0)).length).toBeGreaterThan(0);
  });

  it('is decided by the Bot ID, not by the token text: a re-issued token of NotificationBot is refused too', async () => {
    const c = await fresh();
    const N = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    const N2 = reissued(N);
    expect(N2).not.toBe(N);
    const res = await connect(c, N2);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe(BOT_CONFLICT);
    expect(await botConnection(c)).toBeNull();
    expect(await vaultCount(c.shop.id, 'bot')).toBe(0);
  });
});

describe('scenario B: StoreBot is connected first, then used for «Уведомления»', () => {
  it('is refused with bot_used_for_storefront; the storefront connection is not changed and nothing is stored for notifications', async () => {
    const c = await fresh();
    const S = token();
    expect((await connect(c, S)).status).toBe(200);
    const view = (await storefront(c)).body;
    const hookBefore = (await mockBotState(botIdOf(S))).webhook;
    const menuBefore = (await mockBotState(botIdOf(S))).menu_button;

    const res = await saveNotif(c, S);
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe(NOTIF_CONFLICT);
    expect(noSecret(res.text)).toBe(true);

    expect((await notifSettings(c)).configured).toBe(false);
    expect(await vaultCount(c.shop.id, 'notify')).toBe(0);
    expect(await assignments(c.shop.id)).toEqual(registry([['storefront', S]]));
    // The storefront: the same connection, the same token, the same webhook and Menu Button, still answering /start.
    expect((await storefront(c)).body).toEqual(view);
    expect(await storedToken(c.shop.id, 'shop_bot_connections')).toBe(S);
    expect((await mockBotState(botIdOf(S))).webhook).toEqual(hookBefore);
    expect((await mockBotState(botIdOf(S))).menu_button).toEqual(menuBefore);
    const user = await starter(S);
    expect((await waitFor(() => mockMessages(String(user)), (m) => m.length > 0)).length).toBeGreaterThan(0);

    // A different bot is accepted for the notifications right after the refusal.
    const N = token();
    expect((await saveNotif(c, N)).status).toBe(200);
  });

  it('a working notification bot is not replaced by the storefront bot; the chat, the token and the status stay', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await connect(c, S)).status).toBe(200);
    const before = await notifSettings(c);

    const res = await saveNotif(c, S, chat('other'));
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe(NOTIF_CONFLICT);
    expect(await notifSettings(c)).toEqual(before);
    expect(await storedToken(c.shop.id, 'shop_notification_settings')).toBe(N);
    expect(await vaultCount(c.shop.id, 'notify')).toBe(1);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));
  });

  it('the dry-run check of an unsaved token refuses the storefront bot too: no test message is sent from it', async () => {
    const c = await fresh();
    const S = token();
    expect((await connect(c, S)).status).toBe(200);
    const channel = chat(`dry_${randomBytes(2).toString('hex')}`);
    const res = await notif(c, { action: 'check', botToken: S, chatId: channel });
    expect(res.status).toBe(409);
    expect(errorCode(res)).toBe(NOTIF_CONFLICT);
    expect(await mockMessages(channel)).toEqual([]);
  });

  it('the stored token of the same bot with a changed chat only (no token typed) is checked by its Bot ID as well', async () => {
    const c = await fresh();
    const N = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    const res = await saveNotif(c, undefined, chat('moved'));
    expect(res.status, res.text).toBe(200);
    expect((await notifSettings(c)).chat_id).toBe(chat('moved'));
  });
});

describe('the same bot in the same section is not a conflict', () => {
  it('re-saving NotificationBot (same token, no token, or a re-issued token) works and keeps the registry', async () => {
    const c = await fresh();
    const N = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await saveNotif(c, undefined, chat('again'))).status).toBe(200);
    const N2 = reissued(N);
    const res = await saveNotif(c, N2, chat('again'));
    expect(res.status, res.text).toBe(200);
    expect(await storedToken(c.shop.id, 'shop_notification_settings')).toBe(N2);
    expect(await vaultCount(c.shop.id, 'notify')).toBe(1);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N]]));
    // ... but the same Bot ID as StoreBot stays forbidden.
    const asStore = await connect(c, N2);
    expect(asStore.status).toBe(409);
    expect(errorCode(asStore)).toBe(BOT_CONFLICT);
  });

  it('re-connecting StoreBot (same token, or a re-issued token) works and keeps the registry', async () => {
    const c = await fresh();
    const S = token();
    expect((await connect(c, S)).status).toBe(200);
    expect((await connect(c, S)).status).toBe(200);
    const S2 = reissued(S);
    expect((await connect(c, S2)).status).toBe(200);
    expect(await storedToken(c.shop.id, 'shop_bot_connections')).toBe(S2);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(1);
    expect(await assignments(c.shop.id)).toEqual(registry([['storefront', S]]));
    const asNotif = await saveNotif(c, S2);
    expect(asNotif.status).toBe(409);
    expect(errorCode(asNotif)).toBe(NOTIF_CONFLICT);
  });
});

describe('disconnecting, replacing and re-connecting', () => {
  it('a bot removed from «Уведомления» can be connected as the storefront bot — and then is no longer free for notifications', async () => {
    const c = await fresh();
    const N = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect(errorCode(await connect(c, N))).toBe(BOT_CONFLICT);

    expect((await notif(c, { action: 'delete' })).status).toBe(200);
    expect(await assignments(c.shop.id)).toEqual([]);
    expect(await vaultCount(c.shop.id, 'notify')).toBe(0);

    const asStore = await connect(c, N);
    expect(asStore.status, asStore.text).toBe(200);
    expect(await assignments(c.shop.id)).toEqual(registry([['storefront', N]]));
    const back = await saveNotif(c, N);
    expect(back.status).toBe(409);
    expect(errorCode(back)).toBe(NOTIF_CONFLICT);
  });

  it('a bot disconnected from the storefront can be used for notifications; re-connecting it to the storefront is then refused', async () => {
    const c = await fresh();
    const S = token();
    expect((await connect(c, S)).status).toBe(200);
    expect(errorCode(await saveNotif(c, S))).toBe(NOTIF_CONFLICT);

    const off = await botFn(c.owner.client, { action: 'disconnect', shopId: c.shop.id });
    expect(off.status, off.text).toBe(200);
    expect(await assignments(c.shop.id)).toEqual([]);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(0);

    expect((await saveNotif(c, S)).status).toBe(200);
    expect(errorCode(await connect(c, S))).toBe(BOT_CONFLICT);
    // The notification bot got no webhook / Menu Button from the refused storefront attempt.
    expect((await mockBotState(botIdOf(S))).webhook).toBeNull();
  });

  it('replacing the token with another bot frees the old Bot ID; a re-issued token of the same bot keeps it', async () => {
    const c = await fresh();
    const N1 = token();
    const N2 = token();
    expect((await saveNotif(c, N1)).status).toBe(200);
    expect(errorCode(await connect(c, N1))).toBe(BOT_CONFLICT);

    expect((await saveNotif(c, N2)).status).toBe(200);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N2]]));
    // N1 is free now ...
    expect((await connect(c, N1)).status).toBe(200);
    // ... and N2 is not.
    expect(errorCode(await connect(c, N2))).toBe(BOT_CONFLICT);

    // Replacing the storefront bot frees ITS old id for the notifications in the same way.
    const S2 = token();
    expect((await connect(c, S2)).status).toBe(200);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N2], ['storefront', S2]]));
    expect((await saveNotif(c, N1)).status).toBe(200);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N1], ['storefront', S2]]));
    expect(await vaultCount(c.shop.id, 'notify')).toBe(1);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(1);
  });

  it('switching the notifications off (pause) keeps their bot reserved; removing the connection releases it', async () => {
    const c = await fresh();
    const N = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await notif(c, { action: 'disable' })).status).toBe(200);
    expect(errorCode(await connect(c, N))).toBe(BOT_CONFLICT);
    expect((await notif(c, { action: 'delete' })).status).toBe(200);
    expect((await connect(c, N)).status).toBe(200);
  });
});

describe('a wrong token and an unavailable Telegram are reported on their own, never as a duplicate bot', () => {
  it('invalid format, revoked token and unavailable Bot API: separate codes in both sections, nothing stored, working connections kept', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await connect(c, S)).status).toBe(200);
    const notifBefore = await notifSettings(c);
    const connBefore = await botConnection(c);

    for (const bad of ['not-a-token', `12345678:short`]) {
      expect(errorCode(await saveNotif(c, bad))).toBe('invalid_token');
      expect(errorCode(await connect(c, bad))).toBe('invalid_token');
    }
    const revoked = token('UNAUTHORIZED');
    const revokedNotif = await saveNotif(c, revoked);
    expect(revokedNotif.status).toBe(400);
    expect(errorCode(revokedNotif)).toBe('telegram_unauthorized');
    const revokedStore = await connect(c, revoked);
    expect(revokedStore.status).toBe(400);
    expect(errorCode(revokedStore)).toBe('telegram_unauthorized');

    const down = token('UNAVAILABLE');
    const downNotif = await saveNotif(c, down);
    expect(downNotif.status).toBe(502);
    expect(errorCode(downNotif)).toBe('telegram_unavailable');
    const downStore = await connect(c, down);
    expect(downStore.status).toBe(502);
    expect(errorCode(downStore)).toBe('telegram_unavailable');
    for (const r of [revokedNotif, revokedStore, downNotif, downStore]) expect(noSecret(r.text)).toBe(true);

    expect(await notifSettings(c)).toEqual(notifBefore);
    expect(await botConnection(c)).toEqual(connBefore);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));
  });

  it('an unavailable Bot API is not a duplicate even for the very bot that is already used by the other section', async () => {
    const c = await fresh();
    const S = token();
    expect((await connect(c, S)).status).toBe(200);
    // Same Bot ID, but the mock answers "unavailable" for this token text: Telegram can not identify it, so the answer is
    // about Telegram — not a (guessed) duplicate.
    const sameBotDown = `${botIdOf(S)}:UNAVAILABLE_${randomBytes(18).toString('hex')}`;
    used.push(sameBotDown.split(':')[1]!);
    const res = await saveNotif(c, sameBotDown);
    expect(res.status).toBe(502);
    expect(errorCode(res)).toBe('telegram_unavailable');
  });
});

describe('concurrent requests for one Bot ID', () => {
  it('5 shops, each saving the SAME token as notifications and as storefront at the same moment: exactly one wins, no partial state', async () => {
    const shops = await Promise.all(Array.from({ length: 5 }, () => fresh()));
    await Promise.all(
      shops.map(async (c) => {
        const T = token();
        const [n, s] = await Promise.all([saveNotif(c, T), connect(c, T)]);
        const statuses = [n.status, s.status].sort();
        expect(statuses, `${n.text} ${s.text}`).toEqual([200, 409]);
        const winner = n.status === 200 ? 'notifications' : 'storefront';
        const loser = n.status === 200 ? s : n;
        expect(errorCode(loser)).toBe(winner === 'notifications' ? BOT_CONFLICT : NOTIF_CONFLICT);
        expect(noSecret(n.text + s.text)).toBe(true);

        expect(await assignments(c.shop.id)).toEqual(registry([[winner, T]]));
        // One Vault secret in total: the loser left none behind.
        expect(await vaultCount(c.shop.id, 'notify')).toBe(winner === 'notifications' ? 1 : 0);
        expect(await vaultCount(c.shop.id, 'bot')).toBe(winner === 'storefront' ? 1 : 0);
        expect((await notifSettings(c)).configured).toBe(winner === 'notifications');
        expect(Boolean(await botConnection(c))).toBe(winner === 'storefront');
        if (winner === 'notifications') expect((await mockBotState(botIdOf(T))).webhook).toBeNull();
      }),
    );
  });

  it('two database sessions: the second save waits for the first and is then refused (per-shop lock); no Vault secret is left', async () => {
    const c = await fresh();
    const T = token();
    const id = botIdOf(T);
    const hash = '0'.repeat(64);
    const first = psqlAsync(`begin;
      select public.notify_save_settings('${c.shop.id}', '${c.owner.userId}', '${T}', '${chat('lock')}', '{"bot_id": ${id}, "bot_username": "mock_${id}_bot", "status": "ok"}'::jsonb);
      select pg_sleep(2);
      commit;`);
    await sleep(700);
    const t0 = Date.now();
    const second = await psqlAsync(
      `select public.bot_save_connection('${c.shop.id}', '${c.owner.userId}', '${T}', ${id}, 'mock_${id}_bot', gen_random_uuid(), '${hash}', 'https://x.test/h', null, null);`,
    );
    const waited = Date.now() - t0;
    const firstRes = await first;
    expect(firstRes.code, firstRes.err).toBe(0);
    expect(second.code).not.toBe(0);
    expect(second.err).toContain(BOT_CONFLICT);
    // It really waited for the first transaction (it did not just see an empty table).
    expect(waited).toBeGreaterThan(900);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', T]]));
    expect(await vaultCount(c.shop.id, 'notify')).toBe(1);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(0);
  });

  it('even without the lock (two plain INSERTs in two sessions) the unique constraint makes the second one wait and fail', async () => {
    const c = await fresh();
    const id = botIdOf(token());
    const hash = '0'.repeat(64);
    const first = psqlAsync(`begin;
      insert into private.shop_notification_settings (shop_id, bot_token_secret_id, token_hint, bot_id, chat_id) values ('${c.shop.id}', gen_random_uuid(), '${id}:••••test', ${id}, '${chat('uniq')}');
      select pg_sleep(2);
      commit;`);
    await sleep(700);
    const t0 = Date.now();
    const second = await psqlAsync(
      `insert into private.shop_bot_connections (shop_id, connection_id, bot_id, bot_username, bot_token_secret_id, token_hint, webhook_secret_hash, webhook_url)
       values ('${c.shop.id}', gen_random_uuid(), ${id}, 'mock_bot_x', gen_random_uuid(), '${id}:••••test', '${hash}', 'https://x.test/h');`,
    );
    expect(Date.now() - t0).toBeGreaterThan(900);
    expect((await first).code).toBe(0);
    expect(second.code).not.toBe(0);
    expect(second.err).toContain(BOT_CONFLICT);
    expect(await assignments(c.shop.id)).toEqual([{ purpose: 'notifications', bot_id: id }]);
  });
});

describe('attempts to get around the server check', () => {
  it('the RPCs are not callable by anon or a signed-in owner (PostgREST): permission denied, nothing changes', async () => {
    const c = await fresh();
    const N = token();
    const args = {
      notify_save_settings: { p_shop_id: c.shop.id, p_actor: c.owner.userId, p_bot_token: N, p_chat_id: chat('rpc'), p_meta: { bot_id: botIdOf(N), status: 'ok' } },
      notify_assert_bot_available: { p_shop_id: c.shop.id, p_actor: c.owner.userId, p_bot_id: botIdOf(N) },
      bot_assert_available: { p_shop_id: c.shop.id, p_actor: c.owner.userId, p_bot_id: botIdOf(N) },
      bot_save_connection: {
        p_shop_id: c.shop.id,
        p_actor: c.owner.userId,
        p_bot_token: N,
        p_bot_id: botIdOf(N),
        p_bot_username: 'x_bot_x',
        p_connection_id: '00000000-0000-4000-8000-000000000001',
        p_webhook_secret_hash: '0'.repeat(64),
        p_webhook_url: 'https://x.test/h',
        p_menu_button_url: null,
        p_menu_button_text: null,
      },
    } as const;
    for (const db of [anon(), c.owner.client]) {
      for (const [fn, a] of Object.entries(args)) {
        const r = await (db as Db).rpc(fn as never, a as never);
        expect(r.error?.message, fn).toMatch(/permission denied/i);
      }
    }
    expect(await assignments(c.shop.id)).toEqual([]);
    expect(await vaultCount(c.shop.id, 'notify')).toBe(0);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(0);
    // The registry is in schema `private`: not reachable through the Data API.
    const direct = await c.owner.client.from('shop_bot_assignments' as never).select('*');
    expect(direct.error).not.toBeNull();
  });

  it('direct Edge Function calls: another shop owner is forbidden; fields that try to set the bot id or purpose are ignored', async () => {
    const mine = await fresh();
    const other = await fresh();
    const N = token();
    const S = token();
    expect((await saveNotif(mine, N)).status).toBe(200);
    expect((await connect(mine, S)).status).toBe(200);

    // Another shop's owner can neither read nor change this shop's connections.
    const T = token();
    const foreignSave = await callAdminFunction('notification-settings', other.owner.client, { action: 'save', shopId: mine.shop.id, botToken: T, chatId: chat('x') });
    expect(foreignSave.status).toBe(403);
    const foreignConnect = await botFn(other.owner.client, { action: 'connect', shopId: mine.shop.id, botToken: T });
    expect(foreignConnect.status).toBe(403);
    expect(await assignments(mine.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));

    // Forged identity fields in the body are not part of the contract: the Bot ID always comes from getMe.
    const N2 = token();
    const forged = await callAdminFunction('notification-settings', mine.owner.client, {
      action: 'save',
      shopId: mine.shop.id,
      botToken: N2,
      chatId: chat('forged'),
      botId: botIdOf(S),
      bot_id: botIdOf(S),
      purpose: 'storefront',
      p_meta: { bot_id: botIdOf(S) },
    });
    expect(forged.status, forged.text).toBe(200);
    expect(await assignments(mine.shop.id)).toEqual(registry([['notifications', N2], ['storefront', S]]));
    // And the same request with the real storefront token is still refused: forging changes nothing.
    expect(errorCode(await callAdminFunction('notification-settings', mine.owner.client, { action: 'save', shopId: mine.shop.id, botToken: S, chatId: chat('forged'), botId: 1 }))).toBe(NOTIF_CONFLICT);
  });

  it('the trusted RPCs themselves refuse a storefront bot for notifications (and the reverse) and a bot id that is not the token\'s', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    expect((await connect(c, S)).status).toBe(200);
    const meta = (t: string) => ({ bot_id: botIdOf(t), bot_username: 'x', status: 'ok' });
    const call = (t: string | null, m: Record<string, unknown>) =>
      svcRpc('notify_save_settings', { p_shop_id: c.shop.id, p_actor: c.owner.userId, p_bot_token: t, p_chat_id: chat('svc'), p_meta: m });

    expect((await call(S, meta(S))).error?.message).toBe(NOTIF_CONFLICT);
    // A bot id that does not belong to the token, or none at all, is not accepted (the id must come from getMe).
    expect((await call(N, meta(S))).error?.message).toBe('invalid_token');
    expect((await call(N, {})).error?.message).toBe('invalid_token');
    expect((await call(N, { bot_id: 'abc' })).error?.message).toBe('invalid_token');
    expect(await vaultCount(c.shop.id, 'notify')).toBe(0);
    expect((await notifSettings(c)).configured).toBe(false);

    expect((await call(N, meta(N))).error).toBeNull();
    const connectRpc = (t: string) =>
      svcRpc('bot_save_connection', {
        p_shop_id: c.shop.id,
        p_actor: c.owner.userId,
        p_bot_token: t,
        p_bot_id: botIdOf(t),
        p_bot_username: `mock_${botIdOf(t)}_bot`,
        p_connection_id: '00000000-0000-4000-8000-0000000000aa',
        p_webhook_secret_hash: '0'.repeat(64),
        p_webhook_url: 'https://x.test/h',
        p_menu_button_url: null,
        p_menu_button_text: null,
      });
    expect((await connectRpc(N)).error?.message).toBe(BOT_CONFLICT);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(1);
    expect(await storedToken(c.shop.id, 'shop_bot_connections')).toBe(S);
    expect(await storedToken(c.shop.id, 'shop_notification_settings')).toBe(N);
  });

  it('writing the tables directly (INSERT / UPDATE) cannot give one bot two purposes either', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await connect(c, S)).status).toBe(200);
    const upd = await psqlAsync(`update private.shop_notification_settings set bot_id = ${botIdOf(S)} where shop_id = '${c.shop.id}';`);
    expect(upd.code).not.toBe(0);
    expect(upd.err).toContain(NOTIF_CONFLICT);
    const upd2 = await psqlAsync(`update private.shop_bot_connections set bot_id = ${botIdOf(N)} where shop_id = '${c.shop.id}';`);
    expect(upd2.code).not.toBe(0);
    expect(upd2.err).toContain(BOT_CONFLICT);
    expect(await assignments(c.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));
  });
});

describe('shops are independent of each other', () => {
  it('the rule is per shop: another shop may use the same bot, its registry rows are its own, and a foreign shop is never touched', async () => {
    const one = await fresh();
    const two = await fresh();
    const N = token();
    const S = token();
    expect((await saveNotif(one, N)).status).toBe(200);
    expect((await connect(one, S)).status).toBe(200);

    // Shop two: NotificationBot of shop one as ITS storefront bot is fine (nothing of shop one prevents it) ...
    const twoStore = await connect(two, N);
    expect(twoStore.status, twoStore.text).toBe(200);
    // ... the storefront bot of shop one is still taken platform-wide (a bot has one webhook), as before this change ...
    const stolen = await connect(two, S);
    expect(stolen.status).toBe(409);
    // ... and the error does not tell which section of the other shop uses it.
    expect(errorCode(stolen)).toBe('bot_in_use');
    // Shop two's own rule still applies to shop two.
    expect(errorCode(await saveNotif(two, N))).toBe(NOTIF_CONFLICT);
    // Shop one is exactly as it was.
    expect(await assignments(one.shop.id)).toEqual(registry([['notifications', N], ['storefront', S]]));
    expect(await assignments(two.shop.id)).toEqual(registry([['storefront', N]]));
  });

  it('deleting a shop releases its registry rows (cascade)', async () => {
    const c = await fresh();
    expect((await saveNotif(c, token())).status).toBe(200);
    expect((await connect(c, token())).status).toBe(200);
    expect(await assignments(c.shop.id)).toHaveLength(2);
    await sql(`delete from public.shops where id = '${c.shop.id}';`);
    expect(await assignments(c.shop.id)).toEqual([]);
    expect(await vaultCount(c.shop.id, 'notify')).toBe(0);
    expect(await vaultCount(c.shop.id, 'bot')).toBe(0);
  });
});

describe('existing data of the migration', () => {
  it('the backfill of 20261126090000 fills the registry from both tables; a shop that already had one bot twice keeps both and is registered once', async () => {
    const migration = readFileSync(new URL('../../../supabase/migrations/20261126090000_separate_telegram_bots.sql', import.meta.url), 'utf8');
    const backfill = /-- Existing rows first[\s\S]*?(?=create trigger)/.exec(migration)?.[0];
    expect(backfill, 'backfill statements').toBeTruthy();

    const clean = await fresh(); // storefront A + notifications B, different bots
    const legacy = await fresh(); // the same bot in both purposes (allowed before the migration)
    const nullId = await fresh(); // a notification row without bot_id (identified by its token hint)
    const [a, b, same] = [token(), token(), token()];
    const dummy = (n: number) => `${n}:••••test`;
    const out = await psqlAsync(`begin;
      set local session_replication_role = replica;  -- as if the triggers did not exist yet
      delete from private.shop_bot_assignments where shop_id in ('${clean.shop.id}', '${legacy.shop.id}', '${nullId.shop.id}');
      insert into private.shop_bot_connections (shop_id, connection_id, bot_id, bot_username, bot_token_secret_id, token_hint, webhook_secret_hash, webhook_url)
        values ('${clean.shop.id}', gen_random_uuid(), ${botIdOf(a)}, 'mock_bot_a', gen_random_uuid(), '${dummy(botIdOf(a))}', '${'0'.repeat(64)}', 'https://x.test/h'),
               ('${legacy.shop.id}', gen_random_uuid(), ${botIdOf(same)}, 'mock_bot_s', gen_random_uuid(), '${dummy(botIdOf(same))}', '${'0'.repeat(64)}', 'https://x.test/h');
      insert into private.shop_notification_settings (shop_id, bot_token_secret_id, token_hint, bot_id, chat_id)
        values ('${clean.shop.id}', gen_random_uuid(), '${dummy(botIdOf(b))}', ${botIdOf(b)}, '${chat('legacy')}'),
               ('${legacy.shop.id}', gen_random_uuid(), '${dummy(botIdOf(same))}', ${botIdOf(same)}, '${chat('legacy')}');
      insert into private.shop_notification_settings (shop_id, bot_token_secret_id, token_hint, bot_id, chat_id)
        values ('${nullId.shop.id}', gen_random_uuid(), '${dummy(botIdOf(b) + 1)}', null, '${chat('legacy')}');
      ${backfill}
      select coalesce(json_agg(json_build_object('shop', shop_id, 'purpose', purpose, 'bot_id', bot_id) order by shop_id, purpose), '[]'::json) from private.shop_bot_assignments;
      rollback;`);
    expect(out.code, out.err).toBe(0);
    const rows = JSON.parse(out.out.split('\n').pop()!) as Array<{ shop: string; purpose: string; bot_id: number }>;
    const of = (id: string) => rows.filter((r) => r.shop === id).map((r) => `${r.purpose}:${r.bot_id}`);
    expect(of(clean.shop.id)).toEqual([`notifications:${botIdOf(b)}`, `storefront:${botIdOf(a)}`]);
    expect(of(legacy.shop.id)).toEqual([`storefront:${botIdOf(same)}`]);
    expect(of(nullId.shop.id)).toEqual([`notifications:${botIdOf(b) + 1}`]);
    // Nothing of the rolled-back block is left behind.
    expect(await assignments(clean.shop.id)).toEqual([]);
  });
});

describe('secrets', () => {
  it('no token is in the registry, in any API answer of this file or in the Edge Runtime logs', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    const answers = [await saveNotif(c, N), await connect(c, S), await saveNotif(c, S), await connect(c, N), await notif(c, { action: 'get' }), await storefront(c)];
    for (const r of answers) expect(noSecret(r.text)).toBe(true);
    const dump = await sql(`select row_to_json(a)::text from private.shop_bot_assignments a where shop_id = '${c.shop.id}';`);
    expect(noSecret(dump)).toBe(true);
    // Secrets of the tokens are only in Vault; the tables keep the Vault id and a masked hint.
    expect(await sql(`select row_to_json(s)::text from private.shop_notification_settings s where shop_id = '${c.shop.id}';`)).not.toContain(N.split(':')[1]!);
    expect(await sql(`select s.secret from vault.secrets s join private.shop_notification_settings n on n.bot_token_secret_id = s.id where n.shop_id = '${c.shop.id}';`)).not.toContain(N.split(':')[1]!);

    const out = spawnSync('docker', ['logs', '--since', startedAt.toISOString(), localStack().edgeRuntimeContainer], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const logs = `${out.stdout}\n${out.stderr}`;
    for (const s of used) expect(logs).not.toContain(s);
  });
});

describe('the storefront keeps working while the notification bot is connected', () => {
  it('/start of a buyer is answered by StoreBot only', async () => {
    const c = await fresh();
    const N = token();
    const S = token();
    expect((await saveNotif(c, N)).status).toBe(200);
    expect((await connect(c, S)).status).toBe(200);
    const user = newTelegramUserId();
    const res = await deliver(S, privateMessage(user, '/start'));
    expect(res.status).toBe(200);
    const sent = await waitFor(() => mockMessages(String(user)), (m) => m.length > 0);
    expect(sent.every((m) => m.bot_id === botIdOf(S))).toBe(true);
  });
});
