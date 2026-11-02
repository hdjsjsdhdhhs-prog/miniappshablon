// Stage-2 security PoC: notification-settings Edge Function, notify_* RPCs, outbox concurrency. LOCAL ONLY.
// All Telegram traffic goes to the local mock Bot API (global-setup refuses to run otherwise); only fake tokens.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockMessages } from '../../../scripts/lib/telegram-mock.ts';
import {
  admin,
  callAdminFunction,
  callFunction,
  checkoutBody,
  createMember,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  fakeBotToken,
  initDataFor,
  newTelegramUserId,
  waitFor,
  type Db,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, psqlAsync, svcRpc } from './sec-helpers';

const run = randomBytes(3).toString('hex');
const chat = (kind: string) => `@sec_${kind}_${run}`;
const secrets: string[] = [];
const token = () => {
  const t = fakeBotToken();
  secrets.push(t.split(':')[1]!);
  return t;
};
const noSecret = (text: string) => secrets.every((s) => !text.includes(s));

let A: TestShop;
let ownerA: { client: Db; userId: string };
let managerA: Db;
let tokenA: string;

beforeAll(async () => {
  A = await createTestShop({ variants: [{ flavor: 'Mint', stock: 50 }] });
  ownerA = await createOwner(A.id);
  managerA = (await createMember(A.id, 'manager')).client;
  tokenA = token();
  const saved = await callAdminFunction('notification-settings', ownerA.client, { action: 'save', shopId: A.id, botToken: tokenA, chatId: chat('a') });
  expect(saved.status).toBe(200);
});
afterAll(cleanupSecurity);

/** Inserts an order row directly (service role) so the outbox trigger enqueues a notification nobody dispatched yet. */
async function bareOrder(shop: TestShop): Promise<string> {
  const { data: n } = await admin.from('orders').select('order_number').eq('shop_id', shop.id).order('order_number', { ascending: false }).limit(1);
  const { data, error } = await admin
    .from('orders')
    .insert({
      shop_id: shop.id,
      order_number: (n?.[0]?.order_number ?? 0) + 1000,
      customer_tg_id: newTelegramUserId(),
      contact_name: 'PoC',
      currency: 'RUB',
      total_minor: 0,
      idempotency_key: randomUUID(),
      request_hash: 'poc',
      fulfillment_method: 'pickup',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

describe('owner / manager rights on notification settings', () => {
  it('manager is refused for every action (owner-only by design)', async () => {
    for (const action of ['get', 'save', 'check', 'enable', 'disable', 'delete', 'retry']) {
      const res = await callAdminFunction('notification-settings', managerA, { action, shopId: A.id, botToken: token(), chatId: chat('m') });
      expect(res.status, action).toBe(403);
    }
  });

  it("owner of another shop cannot read, check or change shop A's settings", async () => {
    const X = await createTestShop();
    const ownerX = (await createOwner(X.id)).client;
    for (const action of ['get', 'check', 'disable', 'delete', 'retry']) {
      expect((await callAdminFunction('notification-settings', ownerX, { action, shopId: A.id })).status, action).toBe(403);
    }
  });
});

describe("'check' action", () => {
  it('[VULN] chatId without botToken: the STORED shop bot posts to an arbitrary chat and the stored status becomes ok', async () => {
    const target = chat('foreign');
    const res = await callAdminFunction('notification-settings', ownerA.client, { action: 'check', shopId: A.id, chatId: target });
    expect(res.status).toBe(200);
    const msgs = await mockMessages(target);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.bot_id).toBe(Number(tokenA.split(':')[0]));
    // Recorded as a check of the stored connection, although a different chat was tested.
    expect((res.body!.settings as { status: string; chat_id: string }).chat_id).toBe(chat('a'));
    expect((res.body!.settings as { status: string }).status).toBe('ok');
    expect(noSecret(res.text)).toBe(true);
  });

  it('[INFO] dry run with any token + chat sends one fixed test message (no free text), never persists the token', async () => {
    const other = token();
    const target = chat('dry');
    const res = await callAdminFunction('notification-settings', ownerA.client, { action: 'check', shopId: A.id, botToken: other, chatId: target });
    expect(res.status).toBe(200);
    const msgs = await mockMessages(target);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toMatch(/уведомления о заказах подключены/);
    expect(noSecret(res.text)).toBe(true);
    const get = await callAdminFunction('notification-settings', ownerA.client, { action: 'get', shopId: A.id });
    expect((get.body!.settings as { token_hint: string }).token_hint.startsWith(tokenA.split(':')[0]!)).toBe(true);
  });

  it('bot token never appears in responses, even for Telegram errors', async () => {
    const bad = `${100_000_000 + Math.floor(Math.random() * 1e8)}:UNAUTHORIZED_${randomBytes(16).toString('hex')}`;
    secrets.push(bad.split(':')[1]!);
    const res = await callAdminFunction('notification-settings', ownerA.client, { action: 'check', shopId: A.id, botToken: bad, chatId: chat('x') });
    expect(res.status).toBe(400);
    expect(noSecret(res.text)).toBe(true);
    const missing = await callAdminFunction('notification-settings', ownerA.client, { action: 'check', shopId: A.id, chatId: chat('missing') });
    expect(missing.status).toBe(400);
    expect(noSecret(missing.text)).toBe(true);
  });
});

describe('outbox: notify_claim / notify_complete', () => {
  it('10 parallel notify_claim calls hand one notification to exactly one worker', async () => {
    const orderId = await bareOrder(A);
    const results = await Promise.all(Array.from({ length: 10 }, () => svcRpc('notify_claim', { p_order_id: orderId, p_shop_id: null, p_limit: 1 })));
    const jobs = results.flatMap((r) => (r.data as unknown[]) ?? []);
    expect(results.every((r) => r.error === null)).toBe(true);
    expect(jobs).toHaveLength(1);
    // The service-role RPC result carries the decrypted token (by design: it is consumed inside the Edge Function).
    expect((jobs[0] as { bot_token: string }).bot_token).toBe(tokenA);
  });

  it('[VULN] at-least-once: after the 2-minute lock expires the same notification is claimed again (duplicate send)', async () => {
    const orderId = await bareOrder(A);
    const first = await svcRpc('notify_claim', { p_order_id: orderId, p_shop_id: null, p_limit: 1 });
    expect(first.data as unknown[]).toHaveLength(1);
    // Simulates a slow worker (send took > 2 min or the worker died after sendMessage but before notify_complete).
    const r = await psqlAsync(`update private.order_notifications set locked_until = now() - interval '1 second' where order_id = '${orderId}';`);
    expect(r.code).toBe(0);
    const second = await svcRpc('notify_claim', { p_order_id: orderId, p_shop_id: null, p_limit: 1 });
    expect(second.data as unknown[]).toHaveLength(1);
    const [j1, j2] = [(first.data as Array<{ notification_id: number }>)[0]!, (second.data as Array<{ notification_id: number; attempt: number }>)[0]!];
    expect(j2.notification_id).toBe(j1.notification_id);
    expect(j2.attempt).toBe(2);
    // Both workers would call sendMessage; the second completion is silently ignored.
    await svcRpc('notify_complete', { p_notification_id: j1.notification_id, p_ok: true, p_message_id: 1, p_error: null });
    await svcRpc('notify_complete', { p_notification_id: j2.notification_id, p_ok: true, p_message_id: 2, p_error: null });
    const row = await psqlAsync(`select status || ':' || attempts || ':' || telegram_message_id from private.order_notifications where order_id = '${orderId}';`);
    expect(row.out).toBe('sent:2:1');
  });

  it('[VULN] lost notification: a pending row older than 24 h is never claimed again and never marked dead', async () => {
    const orderId = await bareOrder(A);
    await psqlAsync(`update private.order_notifications set created_at = now() - interval '25 hours' where order_id = '${orderId}';`);
    const res = await svcRpc('notify_claim', { p_order_id: null, p_shop_id: A.id, p_limit: 20 });
    expect((res.data as Array<{ order: { id: string } }>).some((j) => j.order.id === orderId)).toBe(false);
    const row = await psqlAsync(`select status from private.order_notifications where order_id = '${orderId}';`);
    expect(row.out).toBe('pending');
  });

  it('[INFO] retries are only driven by later checkouts / manual retry: no scheduler picks a failed row on its own', async () => {
    const orderId = await bareOrder(A);
    const c = await svcRpc('notify_claim', { p_order_id: orderId, p_shop_id: null, p_limit: 1 });
    const job = (c.data as Array<{ notification_id: number }>)[0]!;
    await svcRpc('notify_complete', { p_notification_id: job.notification_id, p_ok: false, p_message_id: null, p_error: 'telegram_unavailable: mock' });
    const cron = await psqlAsync(`select count(*) from pg_extension where extname = 'pg_cron';`);
    console.log('[outbox] pg_cron installed:', cron.out);
    const row = await psqlAsync(`select status from private.order_notifications where order_id = '${orderId}';`);
    expect(row.out).toBe('failed');
  });
});

// S2-01 (fixed in 20261030090000). Was [VULN]: the former owner kept receiving every new order. Now a regression
// test; the full matrix is in owner-change-notifications.test.ts.
describe('notification settings across ownership changes', () => {
  it('after platform transfer the FORMER owner no longer receives new orders (settings and token revoked)', async () => {
    const S = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
    const former = await createOwner(S.id);
    const formerChat = chat('former');
    expect((await callAdminFunction('notification-settings', former.client, { action: 'save', shopId: S.id, botToken: token(), chatId: formerChat })).status).toBe(200);

    const pa = await createPlatformAdmin();
    const { data: u } = await admin.auth.admin.createUser({ email: `new-${run}-${randomBytes(3).toString('hex')}@it.local`, password: randomBytes(12).toString('base64url'), email_confirm: true });
    const { track } = await import('../helpers');
    track('user', u.user!.id);
    const tr = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: u.user!.id });
    expect(tr.status).toBe(200);

    // Former owner can no longer even see or disable the settings…
    expect((await callAdminFunction('notification-settings', former.client, { action: 'get', shopId: S.id })).status).toBe(403);
    // …and the shop's orders are no longer delivered to the former owner's chat.
    const buyer = newTelegramUserId();
    const res = await callFunction('checkout', await initDataFor(buyer, { user: { first_name: 'Real', username: `buyer${buyer}` } }), checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: 1 }], { fulfillment: { method: 'delivery', address: 'ул. Секретная, 1' } }));
    expect(res.status).toBe(201);
    // Give the post-response dispatch the same time the old PoC needed to observe the leak.
    const msgs = await waitFor(() => mockMessages(formerChat), (m) => m.length > 0, 3000);
    expect(msgs).toEqual([]);
    expect((tr.body!.transfer as { notifications: { settings_removed: boolean } }).notifications.settings_removed).toBe(true);
  });
});
