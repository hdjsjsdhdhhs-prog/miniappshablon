import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockFailNext, mockMessages } from '../../scripts/lib/telegram-mock.ts';
import {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  cleanup,
  createMember,
  createOwner,
  createTestShop,
  env,
  fakeBotToken,
  initDataFor,
  localSql,
  newTelegramUserId,
  stockOf,
  waitFor,
  type Db,
  type TestShop,
} from './helpers';

// Telegram order notifications, end-to-end through the local Edge Runtime and the local MOCK Bot API
// (tests/integration/global-setup.ts refuses to run if the runtime points anywhere else). Only fake tokens.

const run = randomBytes(3).toString('hex');
const chat = (kind: string) => `@it_${kind}_${run}`;
const usedSecrets: string[] = [];
const token = (prefix?: string) => {
  const t = fakeBotToken(prefix);
  usedSecrets.push(t.split(':')[1]!);
  return t;
};
const startedAt = new Date();

let A: TestShop;
let B: TestShop;
let ownerA: Db;
let ownerB: Db;

type Settings = {
  configured: boolean;
  enabled: boolean;
  token_hint: string | null;
  chat_id: string | null;
  status: string;
  last_error: string | null;
  queue: { pending: number; sent: number; dead: number };
};

const settingsOf = (res: { body: Record<string, unknown> | null }) => res.body!.settings as Settings;
const save = (as: Db, shop: TestShop, body: Record<string, unknown>) =>
  callAdminFunction('notification-settings', as, { action: 'save', shopId: shop.id, ...body });

function outbox(orderId: string) {
  return localSql<{ status: string; attempts: number; last_error: string | null }>(
    `select status, attempts, last_error from private.order_notifications where order_id = '${orderId}'`,
  );
}

async function checkout(shop: TestShop, quantity = 1, opts: { tgId?: number; key?: string; user?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  const tgId = opts.tgId ?? newTelegramUserId();
  const body = checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity }], { ...(opts.key ? { idempotencyKey: opts.key } : {}), ...opts.extra });
  const res = await callFunction('checkout', await initDataFor(tgId, opts.user ? { user: opts.user } : {}), body);
  return { res, tgId, body, order: res.body?.order as { id: string; order_number: number } | undefined };
}

beforeAll(async () => {
  A = await createTestShop({ isDemo: false, basePrice: 69_000, variants: [{ flavor: 'Черника', stock: 50 }] });
  B = await createTestShop({ basePrice: 10_000, variants: [{ flavor: 'Mint', stock: 50 }] });
  ownerA = (await createOwner(A.id)).client;
  ownerB = (await createOwner(B.id)).client;
});

afterAll(cleanup);

describe('access to notification settings', () => {
  it('requires a signed-in owner of THAT shop; another owner, a manager, anon and the anon key are refused', async () => {
    expect((await callAdminFunction('notification-settings', null, { action: 'get', shopId: A.id })).status).toBe(401);
    expect((await callAdminFunction('notification-settings', { bearer: env.anonKey }, { action: 'get', shopId: A.id })).status).toBe(401);
    for (const action of ['get', 'save', 'check', 'disable', 'delete', 'retry']) {
      const res = await callAdminFunction('notification-settings', ownerB, { action, shopId: A.id, botToken: token(), chatId: chat('hijack') });
      expect(res.status, action).toBe(403);
      expect(res.body!.error).toMatchObject({ code: 'forbidden' });
    }
    const manager = (await createMember(A.id, 'manager')).client;
    expect((await callAdminFunction('notification-settings', manager, { action: 'get', shopId: A.id })).status).toBe(403);
    // Nothing was stored by the refused calls and no test message went out.
    expect((await callAdminFunction('notification-settings', ownerA, { action: 'get', shopId: A.id })).body!.settings).toMatchObject({ configured: false });
    expect(await mockMessages(chat('hijack'))).toEqual([]);
  });

  it('client roles cannot reach the settings, the outbox or Vault directly', async () => {
    for (const db of [anon(), ownerA]) {
      expect((await db.rpc('notify_get_settings' as never, { p_shop_id: A.id, p_actor: null } as never)).error?.message).toMatch(/permission denied/i);
      expect((await db.rpc('notify_claim' as never, { p_order_id: null, p_shop_id: null, p_limit: 5 } as never)).error?.message).toMatch(/permission denied/i);
      // `private` and `vault` are not exposed through the Data API at all.
      expect((await db.schema('private' as never).from('shop_notification_settings').select('*')).error).not.toBeNull();
      expect((await db.schema('vault' as never).from('decrypted_secrets').select('*')).error).not.toBeNull();
    }
  });
});

describe('connect, verify, store', () => {
  it('rejects a wrong token or an unknown chat without storing anything', async () => {
    const bad = await save(ownerA, A, { botToken: token('UNAUTHORIZED'), chatId: chat('orders') });
    expect(bad.status).toBe(400);
    expect(bad.body!.error).toMatchObject({ code: 'telegram_unauthorized' });
    const missing = await save(ownerA, A, { botToken: token(), chatId: chat('missing') });
    expect(missing.body!.error).toMatchObject({ code: 'chat_not_found' });
    expect((await save(ownerA, A, { botToken: 'not-a-token', chatId: chat('orders') })).body!.error).toMatchObject({ code: 'invalid_token' });
    expect((await save(ownerA, A, { botToken: token(), chatId: 'https://t.me/+invite' })).body!.error).toMatchObject({ code: 'invalid_chat' });
    expect(settingsOf(await callAdminFunction('notification-settings', ownerA, { action: 'get', shopId: A.id })).configured).toBe(false);
  });

  it('a bot without posting rights is saved with an error status so the owner can fix rights and re-check', async () => {
    const res = await save(ownerA, A, { botToken: token(), chatId: chat('noperm') });
    expect(res.status).toBe(200);
    expect(settingsOf(res)).toMatchObject({ configured: true, status: 'error' });
    expect(settingsOf(res).last_error).toMatch(/^bot_cannot_post/);
  });

  it('saves a verified connection; the token is only in Vault and only a mask ever leaves the server', async () => {
    const t = token();
    const res = await save(ownerA, A, { botToken: t, chatId: `https://t.me/${chat('orders').slice(1)}` });
    expect(res.status).toBe(200);
    const s = settingsOf(res);
    expect(s).toMatchObject({ configured: true, enabled: true, status: 'ok', chat_id: chat('orders') });
    expect(s.token_hint).toBe(`${t.split(':')[0]}:••••${t.slice(-4)}`);
    expect(res.text).not.toContain(t.split(':')[1]);
    const get = await callAdminFunction('notification-settings', ownerA, { action: 'get', shopId: A.id });
    expect(get.text).not.toContain(t.split(':')[1]);

    // Plaintext appears nowhere in the settings table or in vault.secrets (encrypted column).
    const [row] = localSql<{ settings: string; secret: string }>(
      `select (select row_to_json(s)::text from private.shop_notification_settings s where s.shop_id = '${A.id}') as settings,
              (select v.secret from vault.secrets v join private.shop_notification_settings s on s.bot_token_secret_id = v.id where s.shop_id = '${A.id}') as secret`,
    );
    expect(row!.settings).not.toContain(t.split(':')[1]);
    expect(row!.secret).not.toContain(t.split(':')[1]);
    // The public shop row (storefront config) carries no notification data at all.
    const pub = await anon().from('shops').select('*').eq('id', A.id).maybeSingle();
    expect(JSON.stringify(pub.data)).not.toMatch(new RegExp(`${t.split(':')[1]}|it_orders_${run}`));
  });

  it('"Проверить подключение" sends one test message to the stored chat (mock)', async () => {
    const res = await callAdminFunction('notification-settings', ownerA, { action: 'check', shopId: A.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, chat: { type: 'channel' } });
    const msgs = await mockMessages(chat('orders'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain('уведомления о заказах подключены');
    expect(msgs[0]!.text).toContain(`IT ${A.slug}`);
  });

  it('changing only the chat keeps the stored token', async () => {
    const before = settingsOf(await callAdminFunction('notification-settings', ownerA, { action: 'get', shopId: A.id }));
    const res = await save(ownerA, A, { chatId: chat('orders2') });
    expect(settingsOf(res)).toMatchObject({ chat_id: chat('orders2'), token_hint: before.token_hint, status: 'ok' });
    expect(settingsOf(await save(ownerA, A, { chatId: chat('orders') })).chat_id).toBe(chat('orders'));
  });
});

describe('order notification after checkout', () => {
  it('sends exactly one message with the order content and the VERIFIED buyer username', async () => {
    const stock = await stockOf(A.variants[0]!.id);
    // Extra body fields cannot change the identity used in the message.
    const { res, tgId, body, order } = await checkout(A, 2, { extra: { customer: { username: 'forged_name' }, username: 'forged_name' } });
    expect(res.status).toBe(201);
    const msgs = await waitFor(() => mockMessages(chat('orders')), (m) => m.some((x) => x.text.includes(`№${order!.order_number}<`)));
    const mine = msgs.filter((m) => m.text.includes(`Новый заказ №${order!.order_number}</b>`));
    expect(mine).toHaveLength(1);
    const text = mine[0]!.text;
    expect(mine[0]!.parse_mode).toBe('HTML');
    expect(text).toContain(`— IT ${A.slug}`);
    expect(text).toContain(`@u${tgId} (Telegram ID ${tgId})`);
    expect(text).not.toContain('forged_name');
    expect(text).toMatch(/1\. Liquid · Черника — 2 × 690\s₽ = 1\s380\s₽/);
    expect(text).toMatch(/Итого:<\/b> 1\s380\s₽/);
    expect(text).toMatch(/Дата:<\/b> \d{2}\.\d{2}\.\d{4}, \d{2}:\d{2} \(МСК\)/);
    expect(outbox(order!.id)).toEqual([{ status: 'sent', attempts: 1, last_error: null }]);

    // Replaying the same checkout returns the same order and sends nothing new.
    const replay = await callFunction('checkout', await initDataFor(tgId), body);
    expect(replay.status).toBe(200);
    expect((replay.body!.order as { id: string }).id).toBe(order!.id);
    await new Promise((r) => setTimeout(r, 2500));
    expect((await mockMessages(chat('orders'))).filter((m) => m.text.includes(`Новый заказ №${order!.order_number}</b>`))).toHaveLength(1);
    expect(await stockOf(A.variants[0]!.id)).toBe(stock - 2);
  });

  it('without a username the verified name and ID are shown', async () => {
    const { order } = await checkout(A, 1, { user: { first_name: 'Мария', last_name: 'Ким' } });
    const msgs = await waitFor(() => mockMessages(chat('orders')), (m) => m.some((x) => x.text.includes(`№${order!.order_number}<`)));
    const text = msgs.find((m) => m.text.includes(`Новый заказ №${order!.order_number}</b>`))!.text;
    expect(text).toMatch(/Покупатель:<\/b> Мария Ким \(Telegram ID \d+\)/);
  });

  it('a Telegram failure does not cancel the order; the owner retry delivers it once', async () => {
    expect(settingsOf(await save(ownerA, A, { chatId: chat('flaky') })).status).toBe('ok');
    await mockFailNext(chat('flaky'), 1);
    const stock = await stockOf(A.variants[0]!.id);
    const { res, order } = await checkout(A, 1);
    expect(res.status).toBe(201);
    const failed = await waitFor(async () => outbox(order!.id), (r) => r[0]?.status === 'failed');
    expect(failed).toEqual([{ status: 'failed', attempts: 1, last_error: expect.stringMatching(/^telegram_unavailable/) }]);
    // The order stands: persisted, stock deducted, nothing sent.
    expect((await admin.from('orders').select('status').eq('id', order!.id).single()).data!.status).toBe('new');
    expect(await stockOf(A.variants[0]!.id)).toBe(stock - 1);
    expect(await mockMessages(chat('flaky'))).toEqual([]);
    expect(settingsOf(await callAdminFunction('notification-settings', ownerA, { action: 'get', shopId: A.id }))).toMatchObject({ status: 'error' });

    const retry = await callAdminFunction('notification-settings', ownerA, { action: 'retry', shopId: A.id });
    expect(retry.body).toMatchObject({ sent: 1, failed: 0 });
    expect(outbox(order!.id)[0]).toMatchObject({ status: 'sent', attempts: 2 });
    const again = await callAdminFunction('notification-settings', ownerA, { action: 'retry', shopId: A.id });
    expect(again.body).toMatchObject({ sent: 0 });
    expect((await mockMessages(chat('flaky'))).filter((m) => m.text.includes(`№${order!.order_number}<`))).toHaveLength(1);
    expect(settingsOf(again)).toMatchObject({ status: 'ok' });
  });

  it('a permanently failing chat never blocks checkout either', async () => {
    expect((await save(ownerA, A, { chatId: chat('alwaysfail') })).status).toBe(200);
    const { res, order } = await checkout(A, 1);
    expect(res.status).toBe(201);
    expect((await waitFor(async () => outbox(order!.id), (r) => r[0]?.status === 'failed'))[0]!.status).toBe('failed');
    await save(ownerA, A, { chatId: chat('orders') });
  });

  it('tenant isolation: shop B orders create no notification and never reach shop A chat', async () => {
    const before = (await mockMessages(chat('orders'))).length;
    const { res, order } = await checkout(B, 1);
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 2000));
    expect(outbox(order!.id)).toEqual([]);
    expect((await mockMessages(chat('orders'))).length).toBe(before);
    expect((await mockMessages(chat('orders'))).some((m) => m.text.includes(B.slug))).toBe(false);
  });

  it('disabled notifications send nothing; deleting removes the token from Vault', async () => {
    expect(settingsOf(await callAdminFunction('notification-settings', ownerA, { action: 'disable', shopId: A.id })).enabled).toBe(false);
    const { order } = await checkout(A, 1);
    await new Promise((r) => setTimeout(r, 2000));
    expect(outbox(order!.id)).toEqual([]);

    const [{ id: secretId }] = localSql<{ id: string }>(`select bot_token_secret_id as id from private.shop_notification_settings where shop_id = '${A.id}'`) as [{ id: string }];
    const del = await callAdminFunction('notification-settings', ownerA, { action: 'delete', shopId: A.id });
    expect(settingsOf(del).configured).toBe(false);
    expect(localSql(`select count(*)::int as n from vault.secrets where id = '${secretId}'`)).toEqual([{ n: 0 }]);
  });

  it('a newly created shop supports notifications right away (no extra setup)', async () => {
    const fresh = await createTestShop();
    const owner = (await createOwner(fresh.id)).client;
    expect(settingsOf(await callAdminFunction('notification-settings', owner, { action: 'get', shopId: fresh.id }))).toMatchObject({
      configured: false,
      queue: { pending: 0, sent: 0, dead: 0 },
    });
    expect((await save(owner, fresh, { botToken: token(), chatId: chat('fresh') })).status).toBe(200);
    const { order } = await checkout(fresh, 1);
    await waitFor(() => mockMessages(chat('fresh')), (m) => m.some((x) => x.text.includes(`№${order!.order_number}<`)));
    expect((await mockMessages(chat('fresh'))).filter((m) => m.text.includes(fresh.slug))).toHaveLength(1);
  });
});

describe('no token in logs', () => {
  it('Edge Runtime logs of this run contain none of the fake tokens', () => {
    // The container's stdout and stderr both matter (console.error goes to stderr).
    const out = spawnSync('docker', ['logs', '--since', startedAt.toISOString(), 'supabase_edge_runtime_tma-shop-showcase'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(out.status).toBe(0);
    const logs = `${out.stdout}\n${out.stderr}`;
    expect(usedSecrets.length).toBeGreaterThan(5);
    for (const s of usedSecrets) expect(logs).not.toContain(s);
  });
});
