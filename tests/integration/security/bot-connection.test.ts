// Shop's own Telegram bot (20261107090000, bot-connection + telegram-webhook Edge Functions). LOCAL ONLY.
// All Telegram traffic goes to the local mock Bot API (global-setup refuses to run otherwise); only fake tokens.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockBotState, mockMessages, mockSetForeignWebhook } from '../../../scripts/lib/telegram-mock.ts';
import { DEFAULT_WELCOME_TEXT } from '../../../supabase/functions/_shared/bot-welcome.ts';
import {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  createMember,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  env,
  fakeBotToken,
  initDataFor,
  newTelegramUserId,
  type Db,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, psqlAsync, svcRpc } from './sec-helpers';

/** PUBLIC_APP_URL of the local Edge Runtime (scripts/supabase-start.ts). */
const PUBLIC = process.env.PUBLIC_APP_URL ?? 'https://miniapp.local.test';
const secrets: string[] = [];
const token = (prefix = 'FAKE') => {
  const t = fakeBotToken(prefix);
  secrets.push(t.split(':')[1]!);
  return t;
};
const botId = (t: string) => Number(t.split(':')[0]);
const noSecret = (text: string) => secrets.every((s) => !text.includes(s));
const sql = async (q: string) => {
  const r = await psqlAsync(q);
  if (r.code !== 0) throw new Error(r.err);
  return r.out;
};

const bot = (client: Db, body: Record<string, unknown>) => callAdminFunction('bot-connection', client, body);

/** Telegram's side of the webhook the platform set: connection id from the URL, secret_token from setWebhook. */
async function webhookOf(t: string): Promise<{ connectionId: string; secret: string; url: string }> {
  const hook = (await mockBotState(botId(t))).webhook;
  if (!hook) throw new Error('no webhook set');
  return { connectionId: new URL(hook.url).searchParams.get('c')!, secret: hook.secret_token!, url: hook.url };
}

/** Delivers an update exactly like Telegram does: no apikey, no Authorization — only the secret header. */
async function deliver(connectionId: string | null, secret: string | null, update: unknown, method = 'POST') {
  const res = await fetch(`${env.url}/functions/v1/telegram-webhook${connectionId ? `?c=${connectionId}` : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) },
    body: method === 'POST' ? JSON.stringify(update) : undefined,
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

let updateSeq = Math.floor(Math.random() * 1_000_000);
const start = (chatId: number, text = '/start') => ({
  update_id: updateSeq++,
  message: { message_id: 1, date: Math.floor(Date.now() / 1000), text, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false, first_name: 'Buyer' } },
});

let A: TestShop;
let B: TestShop;
let ownerA: { client: Db; userId: string };
let ownerB: { client: Db; userId: string };
let tokenA: string;

beforeAll(async () => {
  A = await createTestShop({ variants: [{ flavor: 'Mint', stock: 50 }] });
  B = await createTestShop({ variants: [{ flavor: 'Lime', stock: 50 }] });
  ownerA = await createOwner(A.id);
  ownerB = await createOwner(B.id);
  tokenA = token();
  const res = await bot(ownerA.client, { action: 'connect', shopId: A.id, botToken: tokenA });
  expect(res.status, res.text).toBe(200);
});
afterAll(cleanupSecurity);

describe('connect: verification, storage and Telegram setup', () => {
  it('stores the token only in Vault (encrypted), never returns it, and sets the Menu Button + secret webhook', async () => {
    const view = await bot(ownerA.client, { action: 'get', shopId: A.id });
    expect(view.status).toBe(200);
    expect(noSecret(view.text)).toBe(true);
    const settings = view.body!.settings as { connection: { bot_username: string; token_hint: string }; welcome: { welcome_text: string } };
    expect(settings.connection.bot_username).toBe(`mock_${botId(tokenA)}_bot`);
    expect(settings.connection.token_hint).toBe(`${botId(tokenA)}:••••${tokenA.slice(-4)}`);
    expect(view.body!.storefront_url).toBe(`${PUBLIC}/s/${A.slug}/`);
    // SQL defaults = the server's defaults.
    expect(settings.welcome.welcome_text).toBe(DEFAULT_WELCOME_TEXT);

    const secret = tokenA.split(':')[1]!;
    expect(await sql(`select row_to_json(c)::text from private.shop_bot_connections c where shop_id = '${A.id}';`)).not.toContain(secret);
    expect(await sql(`select s.secret from vault.secrets s join private.shop_bot_connections c on c.bot_token_secret_id = s.id where c.shop_id = '${A.id}';`)).not.toContain(secret);
    expect(await sql(`select d.decrypted_secret from vault.decrypted_secrets d join private.shop_bot_connections c on c.bot_token_secret_id = d.id where c.shop_id = '${A.id}';`)).toBe(tokenA);

    const state = await mockBotState(botId(tokenA));
    expect(state.menu_button).toEqual({ type: 'web_app', text: 'Открыть приложение', web_app: { url: `${PUBLIC}/s/${A.slug}/` } });
    const hook = await webhookOf(tokenA);
    expect(hook.url).toMatch(/\/functions\/v1\/telegram-webhook\?c=[0-9a-f-]{36}$/);
    expect(hook.url).not.toContain(secret);
    expect(hook.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the SHA-256 of the webhook secret is stored.
    expect(await sql(`select row_to_json(c)::text from private.shop_bot_connections c where shop_id = '${A.id}';`)).not.toContain(hook.secret);
  });

  it('an invalid token is refused with a plain code and nothing is stored', async () => {
    const X = await createTestShop();
    const ownerX = await createOwner(X.id);
    const bad = token('UNAUTHORIZED');
    for (const botToken of ['not-a-token', bad]) {
      const res = await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken });
      expect(res.status, botToken).toBe(400);
      expect((res.body!.error as { code: string }).code).toMatch(/^(invalid_token|telegram_unauthorized)$/);
      expect(noSecret(res.text)).toBe(true);
    }
    expect(await sql(`select count(*) from private.shop_bot_connections where shop_id = '${X.id}';`)).toBe('0');
  });

  it('the same bot can never be bound to a second shop (server check and unique constraint)', async () => {
    const res = await bot(ownerB.client, { action: 'connect', shopId: B.id, botToken: tokenA });
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('bot_in_use');
    expect(await sql(`select count(*) from private.shop_bot_connections where bot_id = ${botId(tokenA)};`)).toBe('1');
    const direct = await psqlAsync(
      `insert into private.shop_bot_connections (shop_id, connection_id, bot_id, bot_username, bot_token_secret_id, token_hint, webhook_secret_hash, webhook_url)
       values ('${B.id}', gen_random_uuid(), ${botId(tokenA)}, 'dup_bot', gen_random_uuid(), 'x', '${'0'.repeat(64)}', 'https://x');`,
    );
    expect(direct.code).not.toBe(0);
    expect(direct.err).toMatch(/shop_bot_connections_bot_id_key/);
  });

  it('a webhook of another service is never replaced silently', async () => {
    const X = await createTestShop();
    const ownerX = await createOwner(X.id);
    const t = token();
    await mockSetForeignWebhook(botId(t), 'https://crm.example/hook');
    const res = await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken: t });
    expect(res.status).toBe(409);
    expect(res.body!.error).toEqual({ code: 'webhook_conflict', details: { host: 'crm.example' } });
    expect((await mockBotState(botId(t))).webhook!.url).toBe('https://crm.example/hook');
    const confirmed = await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken: t, confirmReplaceWebhook: true });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect((await mockBotState(botId(t))).webhook!.url).toContain('/telegram-webhook?c=');
  });

  it('connect attempts are rate limited per shop', async () => {
    const X = await createTestShop();
    const ownerX = await createOwner(X.id);
    for (let i = 0; i < 10; i++) expect((await svcRpc('bot_register_connect_attempt', { p_shop_id: X.id, p_actor: ownerX.userId })).error).toBeNull();
    expect((await svcRpc('bot_register_connect_attempt', { p_shop_id: X.id, p_actor: ownerX.userId })).error?.message).toBe('bot_connect_rate_limited');
    const res = await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken: token() });
    expect(res.status).toBe(429);
  });
});

describe('access control and tenant isolation', () => {
  it('a manager and the owner of another shop are refused for every action', async () => {
    const manager = (await createMember(A.id, 'manager')).client;
    for (const client of [manager, ownerB.client]) {
      for (const body of [
        { action: 'get', shopId: A.id },
        { action: 'connect', shopId: A.id, botToken: token() },
        { action: 'sync', shopId: A.id },
        { action: 'disconnect', shopId: A.id },
        { action: 'save-welcome', shopId: A.id, welcome: { welcomeText: 'x', openButtonText: 'x', managerButtonText: 'x', managerUrl: '' } },
      ]) {
        const res = await bot(client, body);
        expect(res.status, body.action).toBe(403);
        expect(noSecret(res.text)).toBe(true);
      }
    }
    expect(await sql(`select count(*) from private.shop_bot_welcome where shop_id = '${A.id}';`)).toBe('0');
    expect(await sql(`select bot_id from private.shop_bot_connections where shop_id = '${A.id}';`)).toBe(String(botId(tokenA)));
  });

  it('without a session nothing is answered', async () => {
    expect((await callAdminFunction('bot-connection', null, { action: 'get', shopId: A.id })).status).toBe(401);
  });

  it('browsers (anon / authenticated) can call no bot_* RPC and cannot read the private tables', async () => {
    for (const client of [anon(), ownerA.client]) {
      for (const [fn, args] of [
        ['bot_get_settings', { p_shop_id: A.id, p_actor: ownerA.userId }],
        ['bot_get_credentials', { p_shop_id: A.id, p_actor: ownerA.userId }],
        ['bot_initdata_token', { p_shop_slug: A.slug }],
        ['bot_webhook_begin', { p_connection_id: randomUUID(), p_secret_hash: '0'.repeat(64), p_update_id: 1 }],
      ] as const) {
        const r = await client.rpc(fn as never, args as never);
        expect(r.error?.message, fn).toMatch(/permission denied|Could not find/i);
        expect(JSON.stringify(r.data ?? null)).not.toContain(tokenA.split(':')[1]);
      }
      const t = await (client as unknown as { schema: (s: string) => Db }).schema('private').from('shop_bot_connections' as never).select('*');
      expect(t.error).not.toBeNull();
    }
  });
});

describe('telegram-webhook: /start', () => {
  it('answers /start with the welcome and exactly two buttons: this shop’s Mini App and the manager', async () => {
    const saved = await bot(ownerA.client, {
      action: 'save-welcome',
      shopId: A.id,
      welcome: { welcomeText: 'Добро пожаловать в {название_магазина} 🎉', openButtonText: 'Открыть приложение', managerButtonText: 'Связаться с менеджером', managerUrl: '@noir_manager' },
    });
    expect(saved.status, saved.text).toBe(200);
    const { connectionId, secret } = await webhookOf(tokenA);
    const chat = newTelegramUserId();
    const res = await deliver(connectionId, secret, start(chat));
    expect(res, JSON.stringify(res.body)).toEqual({ status: 200, body: { ok: true, handled: true } });
    const [msg, ...rest] = await mockMessages(String(chat));
    expect(rest).toEqual([]);
    expect(msg!.bot_id).toBe(botId(tokenA));
    expect(msg!.text).toBe(`Добро пожаловать в IT ${A.slug} 🎉`);
    expect(msg!.parse_mode).toBeNull();
    expect(msg!.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Открыть приложение', web_app: { url: `${PUBLIC}/s/${A.slug}/` } }],
        [{ text: 'Связаться с менеджером', url: 'https://t.me/noir_manager' }],
      ],
    });
  });

  it('a re-delivered update is answered once; the next /start gets the edited welcome', async () => {
    const { connectionId, secret } = await webhookOf(tokenA);
    const chat = newTelegramUserId();
    const update = start(chat, '/start promo');
    expect((await deliver(connectionId, secret, update)).status).toBe(200);
    expect(await deliver(connectionId, secret, update)).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(await mockMessages(String(chat))).toHaveLength(1);
    await bot(ownerA.client, {
      action: 'save-welcome',
      shopId: A.id,
      welcome: { welcomeText: 'Новый текст', openButtonText: 'В магазин', managerButtonText: 'Менеджер', managerUrl: 'https://t.me/new_manager' },
    });
    await deliver(connectionId, secret, start(chat));
    const msgs = await mockMessages(String(chat));
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toBe('Новый текст');
    expect(JSON.stringify(msgs[1]!.reply_markup)).toContain('https://t.me/new_manager');
  });

  it('refuses requests that are not proven to come from Telegram for this connection', async () => {
    const { connectionId, secret } = await webhookOf(tokenA);
    const chat = newTelegramUserId();
    for (const [c, s] of [
      [connectionId, null],
      [connectionId, 'wrong_secret'],
      [randomUUID(), secret],
      [null, secret],
    ] as const) {
      expect((await deliver(c, s, start(chat))).status, `${c} ${s}`).toBe(401);
    }
    expect(await deliver(connectionId, secret, null, 'GET')).toEqual({ status: 405, body: { error: { code: 'method_not_allowed', details: null } } });
    expect(await mockMessages(String(chat))).toEqual([]);
  });
});

describe('Mini App opened from the shop’s own bot (initData signed by that bot)', () => {
  it('is accepted for that shop only; the platform bot keeps working for every shop', async () => {
    const buyer = newTelegramUserId();
    const viaShopBot = await initDataFor(buyer, { token: tokenA });
    const created = await callFunction('checkout', viaShopBot, checkoutBody(A, [{ variantId: A.variants[0]!.id, quantity: 1 }]));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const mine = await callFunction('my-orders', viaShopBot, { shopSlug: A.slug });
    expect(mine.status).toBe(200);
    expect((mine.body!.orders as unknown[]).length).toBe(1);

    // Shop A's bot can never vouch for a buyer in shop B.
    expect((await callFunction('checkout', viaShopBot, checkoutBody(B, [{ variantId: B.variants[0]!.id, quantity: 1 }]))).status).toBe(401);
    expect((await callFunction('my-orders', viaShopBot, { shopSlug: B.slug })).status).toBe(401);
    // An unknown bot is refused; no initData is refused before the body is read.
    expect((await callFunction('checkout', await initDataFor(buyer, { token: token() }), checkoutBody(A, [{ variantId: A.variants[0]!.id, quantity: 1 }]))).status).toBe(401);
    expect((await callFunction('checkout', null, {})).status).toBe(401);

    // Shops without a connected bot work exactly as before (platform bot).
    expect(await sql(`select count(*) from private.shop_bot_connections where shop_id = '${B.id}';`)).toBe('0');
    const platform = await initDataFor(newTelegramUserId());
    expect((await callFunction('checkout', platform, checkoutBody(B, [{ variantId: B.variants[0]!.id, quantity: 1 }]))).status).toBe(201);
    expect((await callFunction('checkout', platform, checkoutBody(A, [{ variantId: A.variants[0]!.id, quantity: 1 }]))).status).toBe(201);
  });
});

describe('independence from «Уведомления» and lifecycle', () => {
  it('connecting, replacing and disconnecting the bot never touches the notification settings', async () => {
    const X = await createTestShop();
    const ownerX = await createOwner(X.id);
    const notifyToken = token();
    const chat = `@sec_bot_${randomBytes(3).toString('hex')}`;
    expect((await callAdminFunction('notification-settings', ownerX.client, { action: 'save', shopId: X.id, botToken: notifyToken, chatId: chat })).status).toBe(200);
    const before = await svcRpc('notify_get_settings', { p_shop_id: X.id, p_actor: ownerX.userId });
    const notifySecret = await sql(`select bot_token_secret_id from private.shop_notification_settings where shop_id = '${X.id}';`);

    const t1 = token();
    expect((await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken: t1 })).status).toBe(200);
    const t2 = token();
    const replaced = await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken: t2 });
    expect(replaced.status, replaced.text).toBe(200);
    expect(replaced.body!.previous).toEqual({ bot_username: `mock_${botId(t1)}_bot`, webhook_removed: true, menu_reset: true, error: null });
    expect(await mockBotState(botId(t1))).toEqual({ webhook: null, menu_button: { type: 'default' } });
    const disconnected = await bot(ownerX.client, { action: 'disconnect', shopId: X.id });
    expect(disconnected.status).toBe(200);
    expect(disconnected.body!.cleanup).toEqual({ webhook_removed: true, menu_reset: true, telegram: 'ok' });
    expect(await mockBotState(botId(t2))).toEqual({ webhook: null, menu_button: { type: 'default' } });

    expect(await svcRpc('notify_get_settings', { p_shop_id: X.id, p_actor: ownerX.userId })).toEqual(before);
    expect(await sql(`select bot_token_secret_id from private.shop_notification_settings where shop_id = '${X.id}';`)).toBe(notifySecret);
    expect(await sql(`select count(*) from vault.decrypted_secrets where decrypted_secret = '${notifyToken}';`)).toBe('1');
    // Disconnect removed the bot's Vault secrets, but kept nothing else of the shop changed.
    expect(await sql(`select count(*) from vault.decrypted_secrets where decrypted_secret in ('${t1}', '${t2}');`)).toBe('0');
  });

  it('an ownership change revokes the connection, its Vault secret and the welcome of the former owner', async () => {
    const X = await createTestShop();
    const ownerX = await createOwner(X.id);
    const t = token();
    expect((await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken: t })).status).toBe(200);
    await bot(ownerX.client, { action: 'save-welcome', shopId: X.id, welcome: { welcomeText: 'Hi', openButtonText: 'Open', managerButtonText: 'Manager', managerUrl: '@old_manager' } });
    const { connectionId, secret } = await webhookOf(t);

    const pa = await createPlatformAdmin();
    const next = await createMember(B.id, 'manager'); // any confirmed account
    const transfer = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: X.id, userId: next.userId });
    expect(transfer.status, transfer.text).toBe(200);

    expect(await sql(`select count(*) from private.shop_bot_connections where shop_id = '${X.id}';`)).toBe('0');
    expect(await sql(`select count(*) from private.shop_bot_welcome where shop_id = '${X.id}';`)).toBe('0');
    expect(await sql(`select count(*) from vault.decrypted_secrets where decrypted_secret = '${t}';`)).toBe('0');
    // The bot's webhook still points here, but the connection is gone: refused, nothing sent.
    const chat = newTelegramUserId();
    expect((await deliver(connectionId, secret, start(chat))).status).toBe(401);
    expect(await mockMessages(String(chat))).toEqual([]);
  });

  it('deleting a shop removes its connection and Vault secret (cascade)', async () => {
    const X = await createTestShop();
    const ownerX = await createOwner(X.id);
    const t = token();
    expect((await bot(ownerX.client, { action: 'connect', shopId: X.id, botToken: t })).status).toBe(200);
    const { error } = await admin.from('shops').delete().eq('id', X.id);
    expect(error).toBeNull();
    expect(await sql(`select count(*) from vault.decrypted_secrets where decrypted_secret = '${t}';`)).toBe('0');
  });
});
