// Stage-3A regression suite for S2-01: an ownership change (transfer AND hand-over) revokes the shop's Telegram
// notification channel atomically — settings row, Vault secret and every undelivered outbox row — and a worker that
// claimed a job before the change does not send it afterwards. LOCAL ONLY: local Supabase + local mock Bot API.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockMessages, TELEGRAM_MOCK_URL } from '../../../scripts/lib/telegram-mock.ts';
import { dispatchNotifications, type Rpc } from '../../../supabase/functions/_shared/notify-dispatch.ts';
import {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  fakeBotToken,
  initDataFor,
  newTelegramUserId,
  track,
  waitFor,
  type Db,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, psqlAsync, sleep, svcRpc } from './sec-helpers';

const run = randomBytes(3).toString('hex');
const chat = (kind: string) => `@s3_${kind}_${run}_${randomBytes(2).toString('hex')}`;

// aal2 platform admin; `pa.svc` forwards its MFA session to service-role RPCs (20261102090000).
let pa: PlatformAdmin;

beforeAll(async () => {
  pa = await createPlatformAdmin();
});
afterAll(cleanupSecurity);

async function confirmedAccount(kind: string): Promise<{ client: Db; userId: string; email: string }> {
  const email = `${kind}-${run}-${randomBytes(2).toString('hex')}@it.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  track('user', data.user.id);
  const client = anon();
  const { error: se } = await client.auth.signInWithPassword({ email, password });
  if (se) throw se;
  return { client, userId: data.user.id, email };
}

async function sql(q: string): Promise<string> {
  const r = await psqlAsync(q);
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}`);
  return r.out;
}

/** A live shop whose (soon former) owner connected their bot + chat. */
async function shopWithChannel(opts: { isDemo?: boolean; stock?: number } = {}) {
  const S = await createTestShop({ isDemo: opts.isDemo, variants: [{ flavor: 'Mint', stock: opts.stock ?? 20 }] });
  const former = await createOwner(S.id);
  const formerChat = chat('former');
  const token = fakeBotToken();
  const saved = await callAdminFunction('notification-settings', former.client, { action: 'save', shopId: S.id, botToken: token, chatId: formerChat });
  expect(saved.status, saved.text).toBe(200);
  const secretId = await sql(`select bot_token_secret_id from private.shop_notification_settings where shop_id = '${S.id}';`);
  expect(secretId).toMatch(/^[0-9a-f-]{36}$/);
  return { S, former, formerChat, token, secretId };
}

const transfer = (shopId: string, userId: string) => callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId, userId });

/** Inserts an order directly (service role): the outbox trigger enqueues a notification nobody dispatched yet. */
async function bareOrder(shop: TestShop): Promise<string> {
  const { data, error } = await admin
    .from('orders')
    .insert({
      shop_id: shop.id,
      order_number: 100_000 + Math.floor(Math.random() * 800_000),
      customer_tg_id: newTelegramUserId(),
      currency: 'RUB',
      total_minor: 0,
      idempotency_key: randomUUID(),
      request_hash: 'poc',
      fulfillment_method: 'delivery',
      delivery_address: 'ул. Секретная, 1',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function outbox(shopId: string): Promise<Array<{ status: string; last_error: string | null }>> {
  const out = await sql(`select coalesce(json_agg(json_build_object('status', status, 'last_error', last_error) order by id), '[]') from private.order_notifications where shop_id = '${shopId}';`);
  return JSON.parse(out) as Array<{ status: string; last_error: string | null }>;
}

async function buy(shop: TestShop, address = 'пр. Новый, 5') {
  const buyer = newTelegramUserId();
  const res = await callFunction(
    'checkout',
    await initDataFor(buyer, { user: { first_name: 'Покупатель', username: `b${buyer}` } }),
    checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }], { fulfillment: { method: 'delivery', address } }),
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body!.order as { id: string }).id;
}

const rpc: Rpc = (fn, args) => admin.rpc(fn as never, args as never) as never;

describe('S2-01 transfer: the former owner is cut off from every delivery path', () => {
  it('settings row and Vault secret are gone in the same transaction; no new order reaches the former chat', async () => {
    const { S, former, formerChat, secretId } = await shopWithChannel();
    const next = await confirmedAccount('next');
    const res = await transfer(S.id, next.userId);
    expect(res.status, res.text).toBe(200);
    expect((res.body!.transfer as { notifications: unknown }).notifications).toEqual({ settings_removed: true, queued_dropped: 0 });

    expect(await sql(`select count(*) from private.shop_notification_settings where shop_id = '${S.id}';`)).toBe('0');
    expect(await sql(`select count(*) from vault.secrets where id = '${secretId}';`)).toBe('0');
    expect((await pa.svc.rpc('notify_get_credentials', { p_shop_id: S.id, p_actor: pa.userId })).data).toBeNull();
    expect((await callAdminFunction('notification-settings', former.client, { action: 'get', shopId: S.id })).status).toBe(403);

    await buy(S, 'ул. Секретная, 1');
    await sleep(1500);
    expect(await mockMessages(formerChat)).toEqual([]);
    // No outbox row is even created while the new owner has not connected a channel.
    expect(await outbox(S.id)).toEqual([]);
  });

  it('notifications queued BEFORE the transfer (pending / failed) are dropped, never sent later, never re-queued', async () => {
    const { S, formerChat } = await shopWithChannel();
    const pending = await bareOrder(S);
    const failed = await bareOrder(S);
    await sql(`update private.order_notifications set status = 'failed', attempts = 1 where order_id = '${failed}';`);
    expect((await outbox(S.id)).map((n) => n.status)).toEqual(['pending', 'failed']);

    const next = await confirmedAccount('next');
    const res = await transfer(S.id, next.userId);
    expect((res.body!.transfer as { notifications: unknown }).notifications).toEqual({ settings_removed: true, queued_dropped: 2 });
    expect(await outbox(S.id)).toEqual([
      { status: 'dead', last_error: 'owner_changed' },
      { status: 'dead', last_error: 'owner_changed' },
    ]);

    // Repeated claim / retry / re-enable cannot revive them.
    for (let i = 0; i < 3; i++) {
      expect((await svcRpc('notify_claim', { p_order_id: null, p_shop_id: S.id, p_limit: 20 })).data).toEqual([]);
      expect((await svcRpc('notify_claim', { p_order_id: pending, p_shop_id: null, p_limit: 1 })).data).toEqual([]);
    }
    expect((await pa.svc.rpc('notify_requeue_failed', { p_shop_id: S.id, p_actor: pa.userId })).data).toBe(0);
    expect((await callAdminFunction('notification-settings', next.client, { action: 'enable', shopId: S.id })).status).toBe(404);
    // A later checkout also dispatches due retries of the shop: still nothing for the former chat.
    await buy(S);
    await sleep(1500);
    expect(await mockMessages(formerChat)).toEqual([]);
    expect((await outbox(S.id)).every((n) => n.status === 'dead')).toBe(true);
  });

  it('the new owner gets nothing until they connect their own channel, then exactly the new orders', async () => {
    const { S, formerChat } = await shopWithChannel();
    await bareOrder(S); // queued for the former owner
    const next = await confirmedAccount('next');
    expect((await transfer(S.id, next.userId)).status).toBe(200);

    const before = await callAdminFunction('notification-settings', next.client, { action: 'get', shopId: S.id });
    expect(before.status).toBe(200);
    expect(before.body!.settings).toMatchObject({ configured: false, enabled: false, token_hint: null, chat_id: null });
    await buy(S);

    const newChat = chat('new');
    const saved = await callAdminFunction('notification-settings', next.client, { action: 'save', shopId: S.id, botToken: fakeBotToken(), chatId: newChat });
    expect(saved.status, saved.text).toBe(200);
    expect((await callAdminFunction('notification-settings', next.client, { action: 'check', shopId: S.id })).status).toBe(200);

    await buy(S, 'ул. Новая, 9');
    const msgs = await waitFor(() => mockMessages(newChat), (m) => m.filter((x) => x.text.includes('Новый заказ')).length > 0);
    const orderMsgs = msgs.filter((m) => m.text.includes('Новый заказ'));
    expect(orderMsgs).toHaveLength(1);
    expect(orderMsgs[0]!.text).toContain('ул. Новая, 9');
    await sleep(1000);
    expect(await mockMessages(formerChat)).toEqual([]);
  });

  it('repeated transfer: to the same sole owner keeps their channel; to someone else revokes it', async () => {
    const { S } = await shopWithChannel();
    const b = await confirmedAccount('b');
    expect((await transfer(S.id, b.userId)).status).toBe(200);
    const bChat = chat('b');
    expect((await callAdminFunction('notification-settings', b.client, { action: 'save', shopId: S.id, botToken: fakeBotToken(), chatId: bChat })).status).toBe(200);

    const again = await transfer(S.id, b.userId);
    expect(again.status).toBe(200);
    expect((again.body!.transfer as { notifications: unknown; removed: unknown[] }).notifications).toEqual({ settings_removed: false, queued_dropped: 0 });
    expect(await sql(`select chat_id from private.shop_notification_settings where shop_id = '${S.id}';`)).toBe(bChat);

    const c = await confirmedAccount('c');
    const toC = await transfer(S.id, c.userId);
    expect((toC.body!.transfer as { notifications: { settings_removed: boolean } }).notifications.settings_removed).toBe(true);
    expect(await sql(`select count(*) from private.shop_notification_settings where shop_id = '${S.id}';`)).toBe('0');
  });

  it('two parallel transfers serialize: one final owner, channel revoked, both journaled', async () => {
    const { S, secretId } = await shopWithChannel();
    const [b, c] = [await confirmedAccount('pb'), await confirmedAccount('pc')];
    const res = await Promise.all([transfer(S.id, b.userId), transfer(S.id, c.userId)]);
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    const { data: members } = await admin.from('shop_memberships').select('user_id, role').eq('shop_id', S.id);
    expect(members).toHaveLength(1);
    expect([b.userId, c.userId]).toContain(members![0]!.user_id);
    expect(await sql(`select count(*) from vault.secrets where id = '${secretId}';`)).toBe('0');
    expect(await sql(`select count(*) from private.shop_transfers where shop_id = '${S.id}' and kind = 'transfer';`)).toBe('2');
  });
});

describe('S2-01 hand-over: DEMO-era channel never survives into the real shop', () => {
  it('the operator chat of the DEMO shop receives nothing after the hand-over; the client starts unconfigured', async () => {
    const { S, formerChat, secretId } = await shopWithChannel({ isDemo: true });
    const client = await confirmedAccount('client');
    const res = await callAdminFunction('platform-admin', pa.client, {
      action: 'handover', shopId: S.id, email: client.email, redirectTo: 'http://127.0.0.1:5173/admin/set-password',
    });
    expect(res.status, res.text).toBe(200);
    const h = res.body!.handover as { status: string; notifications: unknown; shop: { is_demo: boolean } };
    expect(h).toMatchObject({ status: 'completed', notifications: { settings_removed: true }, shop: { is_demo: false } });
    expect(await sql(`select count(*) from vault.secrets where id = '${secretId}';`)).toBe('0');

    await buy(S, 'Реальный адрес 7');
    await sleep(1500);
    expect(await mockMessages(formerChat)).toEqual([]);
    const get = await callAdminFunction('notification-settings', client.client, { action: 'get', shopId: S.id });
    expect(get.body!.settings).toMatchObject({ configured: false });
  });
});

describe('S2-01 failures roll the whole ownership change back', () => {
  it('an error after the revocation (journal insert fails) leaves owner, settings, secret and queue untouched', async () => {
    const { S, former, secretId } = await shopWithChannel();
    await bareOrder(S);
    const next = await confirmedAccount('next');
    const fn = `it_fail_transfer_${run}`;
    await sql(`create function private.${fn}() returns trigger language plpgsql as $f$ begin
        if new.shop_id = '${S.id}' then raise exception 'injected_failure'; end if; return new; end $f$;
      create trigger ${fn} before insert on private.shop_transfers for each row execute function private.${fn}();`);
    try {
      const res = await transfer(S.id, next.userId);
      expect(res.status).toBe(500);
    } finally {
      await sql(`drop trigger if exists ${fn} on private.shop_transfers; drop function if exists private.${fn}();`);
    }
    const { data: members } = await admin.from('shop_memberships').select('user_id').eq('shop_id', S.id);
    expect(members).toEqual([{ user_id: former.userId }]);
    expect(await sql(`select count(*) from vault.secrets where id = '${secretId}';`)).toBe('1');
    expect((await outbox(S.id)).map((n) => n.status)).toEqual(['pending']);
    // Still the owner → still allowed to manage the channel.
    expect((await callAdminFunction('notification-settings', former.client, { action: 'get', shopId: S.id })).status).toBe(200);
  });

  it('a Vault error while deleting the old token fails the transfer: nothing changes (fail closed)', async () => {
    const { S, former, secretId } = await shopWithChannel();
    const next = await confirmedAccount('next');
    const original = await sql(`select pg_get_functiondef('private.delete_notification_secret()'::regprocedure);`);
    expect(original).toContain('delete from vault.secrets');
    await sql(`create or replace function private.delete_notification_secret() returns trigger language plpgsql security definer set search_path = '' as $f$
      begin
        if old.shop_id = '${S.id}' then raise exception 'vault_unavailable (injected)'; end if;
        delete from vault.secrets where id = old.bot_token_secret_id;
        return null;
      end $f$;`);
    try {
      const res = await transfer(S.id, next.userId);
      expect(res.status).toBe(500);
    } finally {
      const restored = await psqlAsync(`${original};`);
      expect(restored.code, restored.err).toBe(0);
    }
    expect(await sql(`select pg_get_functiondef('private.delete_notification_secret()'::regprocedure);`)).toBe(original);
    const { data: members } = await admin.from('shop_memberships').select('user_id').eq('shop_id', S.id);
    expect(members).toEqual([{ user_id: former.userId }]);
    expect(await sql(`select count(*) from private.shop_notification_settings where shop_id = '${S.id}';`)).toBe('1');
    expect(await sql(`select count(*) from vault.secrets where id = '${secretId}';`)).toBe('1');
    // After the outage the same transfer succeeds and cleans up.
    expect((await transfer(S.id, next.userId)).status).toBe(200);
    expect(await sql(`select count(*) from vault.secrets where id = '${secretId}';`)).toBe('0');
  });
});

describe('S2-01 concurrency with workers and with the former owner', () => {
  it('a job claimed BEFORE the transfer is not sent after it (pre-send re-validation); positive control sends', async () => {
    // Positive control: same worker, no transfer in between → the message is delivered.
    const ctl = await shopWithChannel();
    const ctlOrder = await bareOrder(ctl.S);
    const sentCtl = await dispatchNotifications(rpc, { orderId: ctlOrder, apiBase: TELEGRAM_MOCK_URL, log: () => {} });
    expect(sentCtl).toMatchObject({ sent: 1, failed: 0 });
    expect(await mockMessages(ctl.formerChat)).toHaveLength(1);

    const { S, formerChat } = await shopWithChannel();
    const orderId = await bareOrder(S);
    const next = await confirmedAccount('next');
    // Slow worker: claims (gets token + chat), then the platform transfers the shop, then the worker tries to send.
    const slowRpc: Rpc = async (fn, args) => {
      const r = await rpc(fn, args);
      if (fn === 'notify_claim') expect((await transfer(S.id, next.userId)).status).toBe(200);
      return r;
    };
    const res = await dispatchNotifications(slowRpc, { orderId, apiBase: TELEGRAM_MOCK_URL, log: () => {} });
    expect(res).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await mockMessages(formerChat)).toEqual([]);
    // Late completion of the stale job (another worker) changes nothing either.
    const { data: row } = await svcRpc('notify_claim', { p_order_id: orderId, p_shop_id: null, p_limit: 1 });
    expect(row).toEqual([]);
    expect((await outbox(S.id)).map((n) => n.status)).toEqual(['dead']);
  });

  it('a job claimed for an old channel is not sent after the owner replaced the chat (channel id rotates)', async () => {
    const { S, former, formerChat } = await shopWithChannel();
    const orderId = await bareOrder(S);
    const replaced = chat('replaced');
    const slowRpc: Rpc = async (fn, args) => {
      const r = await rpc(fn, args);
      if (fn === 'notify_claim') {
        expect((await callAdminFunction('notification-settings', former.client, { action: 'save', shopId: S.id, chatId: replaced })).status).toBe(200);
      }
      return r;
    };
    expect(await dispatchNotifications(slowRpc, { orderId, apiBase: TELEGRAM_MOCK_URL, log: () => {} })).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(await mockMessages(formerChat)).toEqual([]);
  });

  it('notify_complete of a job claimed before the transfer cannot mark the new owner channel as ok', async () => {
    const { S } = await shopWithChannel();
    const orderId = await bareOrder(S);
    const { data: jobs } = await svcRpc('notify_claim', { p_order_id: orderId, p_shop_id: null, p_limit: 1 });
    const job = (jobs as Array<{ notification_id: number }>)[0]!;
    const next = await confirmedAccount('next');
    expect((await transfer(S.id, next.userId)).status).toBe(200);
    // The mock refuses posting to "noperm" chats → the new channel is stored with status "error".
    const saved = await callAdminFunction('notification-settings', next.client, { action: 'save', shopId: S.id, botToken: fakeBotToken(), chatId: chat('noperm') });
    expect(saved.status, saved.text).toBe(200);
    const statusBefore = await sql(`select status from private.shop_notification_settings where shop_id = '${S.id}';`);
    expect(statusBefore).toBe('error');
    await svcRpc('notify_complete', { p_notification_id: job.notification_id, p_ok: true, p_message_id: 1, p_error: null });
    expect(await sql(`select status from private.shop_notification_settings where shop_id = '${S.id}';`)).toBe(statusBefore);
    expect((await outbox(S.id)).map((n) => n.status)).toEqual(['dead']);
  });

  it("the former owner's settings save racing the transfer waits for it and is then refused (no channel survives)", async () => {
    const { S, former } = await shopWithChannel();
    await callAdminFunction('notification-settings', former.client, { action: 'delete', shopId: S.id });
    const next = await confirmedAccount('next');
    const marker = `hold_${randomUUID().slice(0, 8)}`;
    // As the platform-admin Edge Function does: service role + the admin's aal2 session (20261102090000).
    const holder = psqlAsync(`begin;
      select set_config('request.jwt.claims', '{"role":"service_role"}', true),
             set_config('request.headers', '{"x-platform-session":"${pa.sessionId}"}', true);
      select public.platform_transfer_shop('${pa.userId}', '${S.id}', '${next.userId}');
      select pg_sleep(2) /* ${marker} */;
      commit;`);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const r = await psqlAsync(`select count(*) from pg_stat_activity where query like '%${marker}%' and query not like '%pg_stat_activity%' and state = 'active';`);
      if (r.out === '1') break;
      await sleep(100);
    }
    const save = await callAdminFunction('notification-settings', former.client, { action: 'save', shopId: S.id, botToken: fakeBotToken(), chatId: chat('race') });
    const h = await holder;
    expect(h.code, h.err).toBe(0);
    expect(save.status).toBe(403);
    expect(await sql(`select count(*) from private.shop_notification_settings where shop_id = '${S.id}';`)).toBe('0');
  });
});
