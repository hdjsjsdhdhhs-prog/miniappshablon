// Stage-2 security PoC: checkout contracts (F-03), status lifecycle, stock restore, inventory DoS (F-04). LOCAL ONLY.
import { randomUUID } from 'node:crypto';
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
  stockOf,
  waitFor,
  type Db,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, psqlAsync, svcRpc } from './sec-helpers';

const legacyBody = (shop: TestShop, items: Array<{ variantId: string; quantity: number }>) => ({
  shopSlug: shop.slug,
  idempotencyKey: randomUUID(),
  currency: 'RUB',
  items,
  contact: { name: 'Legacy', phone: '', comment: '' },
});

async function order(shop: TestShop, items: Array<{ variantId: string; quantity: number }>, tgId = newTelegramUserId()) {
  const res = await callFunction('checkout', await initDataFor(tgId), checkoutBody(shop, items));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body!.order as { id: string }).id;
}

async function movements(orderId: string) {
  const { data } = await admin.from('inventory_movements').select('variant_id, delta, reason').eq('order_id', orderId);
  return data ?? [];
}

afterAll(cleanupSecurity);

describe('F-03: legacy checkout contract in DEMO shops', () => {
  let D: TestShop;
  let ownerD: Db;
  const demoChat = `@sec_demo_${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    D = await createTestShop({ isDemo: true, variants: [{ flavor: 'Mint', stock: 10 }] });
    ownerD = (await createOwner(D.id)).client;
    expect((await callAdminFunction('notification-settings', ownerD, { action: 'save', shopId: D.id, botToken: fakeBotToken(), chatId: demoChat })).status).toBe(200);
  });

  it('current contract is refused with shop_demo and has no side effects (negative control)', async () => {
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(D, [{ variantId: D.variants[0]!.id, quantity: 1 }]));
    expect(res.status).toBe(403);
    expect((res.body!.error as { code: string }).code).toBe('shop_demo');
    expect(await stockOf(D.variants[0]!.id)).toBe(10);
  });

  // F-03 fixed in 20261030090100. The three tests below were [VULN F-03]; now regression tests.
  it('legacy body is refused (400) before any database call: no order, no stock change, no notification', async () => {
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), legacyBody(D, [{ variantId: D.variants[0]!.id, quantity: 9 }]));
    expect(res.status).toBe(400);
    expect(res.body!.error).toMatchObject({ code: 'invalid_body' });
    expect(JSON.stringify(res.body)).toContain('contract_removed');
    expect(await stockOf(D.variants[0]!.id)).toBe(10);
    expect((await admin.from('orders').select('id').eq('shop_id', D.id)).data).toEqual([]);
    expect(await waitFor(() => mockMessages(demoChat), (m) => m.length > 0, 2000)).toEqual([]);
    // Both keys at once does not smuggle the old contract in either: the DEMO rule still applies.
    const both = await callFunction('checkout', await initDataFor(newTelegramUserId()), { ...legacyBody(D, [{ variantId: D.variants[0]!.id, quantity: 1 }]), fulfillment: { method: 'pickup' } });
    expect(both.status).toBe(400);
  });

  it('every SQL path refuses DEMO orders, even with the service role: create_order, create_order_v2, direct INSERT', async () => {
    const tg = newTelegramUserId();
    const items = [{ variant_id: D.variants[0]!.id, quantity: 9 }];
    const legacy = await svcRpc('create_order', {
      p_shop_slug: D.slug, p_customer_tg_id: tg, p_customer_snapshot: {}, p_items: items, p_idempotency_key: randomUUID(),
      p_request_hash: 'x', p_contact_name: 'Legacy', p_contact_phone: '', p_comment: '', p_expected_currency: 'RUB', p_expected_total_minor: null,
    });
    expect(legacy.error?.message).toBe('contract_removed');
    const v2 = await svcRpc('create_order_v2', {
      p_shop_slug: D.slug, p_customer_tg_id: tg, p_customer_snapshot: {}, p_items: items, p_idempotency_key: randomUUID(),
      p_request_hash: 'x', p_fulfillment_method: 'pickup', p_delivery_address: null, p_comment: '', p_expected_currency: 'RUB', p_expected_total_minor: null,
    });
    expect(v2.error?.message).toBe('shop_demo');
    const direct = await psqlAsync(`insert into public.orders (shop_id, order_number, customer_tg_id, currency, total_minor, idempotency_key, request_hash)
      values ('${D.id}', 999, ${tg}, 'RUB', 0, '${randomUUID()}', 'x');`);
    expect(direct.code).not.toBe(0);
    expect(direct.err).toContain('shop_demo');
    expect(await stockOf(D.variants[0]!.id)).toBe(10);
    expect((await admin.from('orders').select('id').eq('shop_id', D.id)).data).toEqual([]);
  });

  it('DEMO stock cannot be drained any more: the hand-over stays possible', async () => {
    for (let i = 0; i < 3; i++) {
      await callFunction('checkout', await initDataFor(newTelegramUserId()), legacyBody(D, [{ variantId: D.variants[0]!.id, quantity: 9 }]));
    }
    expect(await stockOf(D.variants[0]!.id)).toBe(10);
    const pa = await platformAdmin();
    const { data } = await pa.svc.rpc('platform_handover_check', { p_actor: pa.userId, p_shop_id: D.id });
    expect((data as { ready: boolean }).ready).toBe(true);
  });

  it('legacy test orders that exist from before the fix: the hand-over cancels them and puts the units back (exactly once)', async () => {
    // Historical state (created by the removed contract): a LIVE shop's order is turned into a DEMO test order.
    const H = await createTestShop({ variants: [{ flavor: 'Mint', stock: 9 }] });
    const id1 = await order(H, [{ variantId: H.variants[0]!.id, quantity: 5 }]);
    const id2 = await order(H, [{ variantId: H.variants[0]!.id, quantity: 4 }]);
    await psqlAsync(`update public.orders set is_test = true where id in ('${id1}', '${id2}');
      update public.orders set status = 'confirmed' where id = '${id2}';
      update public.shops set is_demo = true where id = '${H.id}';`);
    expect(await stockOf(H.variants[0]!.id)).toBe(0);
    // Units held by open test orders count as available: the drained shop can still be handed over.
    const pa = await platformAdmin();
    expect(((await pa.svc.rpc('platform_handover_check', { p_actor: pa.userId, p_shop_id: H.id })).data as { ready: boolean }).ready).toBe(true);
    const { data: u } = await admin.auth.admin.createUser({ email: `client-${randomUUID().slice(0, 8)}@it.local`, password: randomUUID(), email_confirm: true });
    (await import('../helpers')).track('user', u.user!.id);
    const h = await pa.svc.rpc('platform_handover_shop', { p_actor: pa.userId, p_shop_id: H.id, p_new_owner: u.user!.id, p_invitation: 'existing' });
    expect(h.error).toBeNull();
    expect(h.data).toMatchObject({ status: 'completed', legacy_test_orders: 2, cancelled_test_orders: 2 });
    expect(await stockOf(H.variants[0]!.id)).toBe(9);
    const { data: rows } = await admin.from('orders').select('status, stock_state').eq('shop_id', H.id);
    expect(rows!.every((r) => r.status === 'cancelled' && r.stock_state === 'restored')).toBe(true);
    // Journal: exactly one restore per line, ledger balances.
    const mv = [...(await movements(id1)), ...(await movements(id2))];
    expect(mv.filter((m) => m.reason === 'cancel_restore').map((m) => m.delta).sort()).toEqual([4, 5]);
    expect(mv.reduce((s, m) => s + m.delta, 0)).toBe(0);
    // Real orders now work in the handed-over shop.
    await order(H, [{ variantId: H.variants[0]!.id, quantity: 1 }]);
    expect(await stockOf(H.variants[0]!.id)).toBe(8);
  });
});

// Platform RPCs need the admin's aal2 session (20261102090000): `svc` forwards it like the Edge Function does.
let cachedAdmin: PlatformAdmin | null = null;
async function platformAdmin(): Promise<PlatformAdmin> {
  if (cachedAdmin) return cachedAdmin;
  cachedAdmin = await createPlatformAdmin();
  return cachedAdmin;
}

describe('order status lifecycle', () => {
  let S: TestShop;
  let ownerS: Db;
  let managerS: Db;

  beforeAll(async () => {
    S = await createTestShop({ variants: [{ flavor: 'Mint', stock: 100 }, { flavor: 'Berry', stock: 100 }] });
    ownerS = (await createOwner(S.id)).client;
    managerS = (await createMember(S.id, 'manager')).client;
  });

  it('transition table (order_status_transition_allowed) matches the documented model', async () => {
    const r = await psqlAsync(`
      select string_agg(f || '>' || t || '=' || public.order_status_transition_allowed(f, t)::text, ',' order by f, t)
      from unnest(array['new','confirmed','ready','completed','cancelled']) f
      cross join unnest(array['new','confirmed','ready','completed','cancelled','bogus']) t;`);
    const allowed = r.out.split(',').filter((x) => x.endsWith('=true')).map((x) => x.replace('=true', ''));
    console.log('[status] allowed transitions:', allowed.join(' '));
    expect(allowed.sort()).toEqual(['confirmed>cancelled', 'confirmed>ready', 'new>cancelled', 'new>confirmed', 'ready>cancelled', 'ready>completed'].sort());
  });

  it('invalid / terminal transitions are refused; repeating the current status is a no-op', async () => {
    const id = await order(S, [{ variantId: S.variants[0]!.id, quantity: 1 }]);
    expect((await ownerS.rpc('admin_set_order_status', { p_order_id: id, p_status: 'completed' })).error?.message).toBe('invalid_transition');
    expect((await ownerS.rpc('admin_set_order_status', { p_order_id: id, p_status: 'bogus' })).error?.message).toBe('invalid_transition');
    expect((await ownerS.rpc('admin_set_order_status', { p_order_id: id, p_status: 'new' })).error).toBeNull();
    for (const s of ['confirmed', 'confirmed', 'ready', 'completed']) {
      expect((await managerS.rpc('admin_set_order_status', { p_order_id: id, p_status: s })).error, s).toBeNull();
    }
    expect((await ownerS.rpc('admin_set_order_status', { p_order_id: id, p_status: 'cancelled' })).error?.message).toBe('invalid_transition');
    expect(await movements(id)).toHaveLength(1);
  });

  it('orders cannot be changed directly through PostgREST (status, stock_state, total)', async () => {
    const id = await order(S, [{ variantId: S.variants[0]!.id, quantity: 1 }]);
    for (const patch of [{ status: 'cancelled' }, { stock_state: 'restored' }, { total_minor: 0 }]) {
      const { error } = await ownerS.from('orders').update(patch as never).eq('id', id);
      expect(error?.code, JSON.stringify(patch)).toBe('42501');
    }
    const del = await ownerS.from('orders').delete().eq('id', id);
    expect(del.error?.code).toBe('42501');
    const mv = await ownerS.from('inventory_movements').insert({ shop_id: S.id, variant_id: S.variants[0]!.id, delta: 100, reason: 'admin_set', operation_key: randomUUID() } as never);
    expect(mv.error?.code).toBe('42501');
  });

  it('5 parallel cancels of a 2-line order restore stock exactly once per line', async () => {
    const [v1, v2] = [S.variants[0]!.id, S.variants[1]!.id];
    const before = [await stockOf(v1), await stockOf(v2)];
    const id = await order(S, [{ variantId: v1, quantity: 3 }, { variantId: v2, quantity: 4 }]);
    expect([await stockOf(v1), await stockOf(v2)]).toEqual([before[0]! - 3, before[1]! - 4]);
    const res = await Promise.all([ownerS, managerS, ownerS, managerS, ownerS].map((c) => c.rpc('admin_set_order_status', { p_order_id: id, p_status: 'cancelled' })));
    expect(res.every((r) => r.error === null)).toBe(true);
    expect([await stockOf(v1), await stockOf(v2)]).toEqual(before);
    const mv = await movements(id);
    expect(mv.filter((m) => m.reason === 'cancel_restore')).toHaveLength(2);
    expect(mv.reduce((s, m) => s + m.delta, 0)).toBe(0);
  });

  it('ledger: for every variant of the shop, the sum of journal deltas equals the stock change since creation', async () => {
    const r = await psqlAsync(`
      select coalesce(string_agg(v.id::text, ','), '') from public.product_variants v
      where v.shop_id = '${S.id}'
        and v.stock_quantity - 100 <> coalesce((select sum(m.delta) from public.inventory_movements m where m.variant_id = v.id), 0);`);
    expect(r.out).toBe('');
  });

  it('[INFO] cancel after a manual stock reset re-adds the units on top of the counted value', async () => {
    const v = S.variants[1]!.id;
    const id = await order(S, [{ variantId: v, quantity: 5 }]);
    expect((await ownerS.rpc('admin_set_variant_stock', { p_variant_id: v, p_quantity: 0 })).error).toBeNull();
    expect((await ownerS.rpc('admin_set_order_status', { p_order_id: id, p_status: 'cancelled' })).error).toBeNull();
    expect(await stockOf(v)).toBe(5);
  });

  it('quantity validation: 0, negative, >99 and duplicate lines summing over 99 are refused', async () => {
    const v = S.variants[0]!.id;
    const init = await initDataFor(newTelegramUserId());
    for (const items of [[{ variantId: v, quantity: 0 }], [{ variantId: v, quantity: -1 }], [{ variantId: v, quantity: 100 }]]) {
      expect((await callFunction('checkout', init, checkoutBody(S, items))).status, JSON.stringify(items)).toBe(400);
    }
    const dup = await callFunction('checkout', init, checkoutBody(S, [{ variantId: v, quantity: 60 }, { variantId: v, quantity: 60 }]));
    expect(dup.status).toBe(400);
    expect((dup.body!.error as { code: string }).code).toBe('invalid_quantity');
  });

  it('a buyer cannot fetch another buyer\'s order by id (my-orders)', async () => {
    const owner = newTelegramUserId();
    const id = await order(S, [{ variantId: S.variants[0]!.id, quantity: 1 }], owner);
    const res = await callFunction('my-orders', await initDataFor(newTelegramUserId()), { shopSlug: S.slug, orderId: id });
    expect(res.status).toBe(200);
    expect(res.body!.orders).toEqual([]);
  });
});

// F-04 fixed in 20261030090100 (was [VULN F-04]); the full matrix is in checkout-limits.test.ts.
describe('F-04: inventory DoS', () => {
  it('one Telegram user, one reused initData string, 6 sequential orders → only 3 pass (rate limit), stock keeps 297', async () => {
    const T = await createTestShop({ variants: [{ flavor: 'Mint', stock: 594 }] });
    const init = await initDataFor(newTelegramUserId());
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await callFunction('checkout', init, checkoutBody(T, [{ variantId: T.variants[0]!.id, quantity: 99 }]))).status);
    }
    expect(statuses).toEqual([201, 201, 201, 429, 429, 429]);
    expect(await stockOf(T.variants[0]!.id)).toBe(297);
    const { count } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', T.id).eq('status', 'new');
    expect(count).toBe(3);
  });

  it('a single request can no longer hold 50 lines × 99 units (4 950): order_too_large, nothing deducted', async () => {
    const specs = Array.from({ length: 50 }, (_, i) => ({ flavor: `F${i}`, stock: 99 }));
    const T = await createTestShop({ variants: specs });
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(T, T.variants.map((v) => ({ variantId: v.id, quantity: 99 }))));
    expect(res.status).toBe(422);
    expect(res.body!.error).toMatchObject({ code: 'order_too_large', details: { max_units: 200, units: 4950 } });
    const r = await psqlAsync(`select sum(stock_quantity) from public.product_variants where shop_id = '${T.id}';`);
    expect(r.out).toBe('4950');
  });

  it('[INFO F-10] the same initData string works in another shop (one platform bot for all shops, by design); per-shop limits apply separately', async () => {
    const T1 = await createTestShop();
    const T2 = await createTestShop();
    const init = await initDataFor(newTelegramUserId());
    expect((await callFunction('checkout', init, checkoutBody(T1, [{ variantId: T1.variants[0]!.id, quantity: 1 }]))).status).toBe(201);
    expect((await callFunction('checkout', init, checkoutBody(T2, [{ variantId: T2.variants[0]!.id, quantity: 1 }]))).status).toBe(201);
  });

  it('idempotency: replay returns the same order without a second deduction; changed payload is refused', async () => {
    const T = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
    const init = await initDataFor(newTelegramUserId());
    const body = checkoutBody(T, [{ variantId: T.variants[0]!.id, quantity: 2 }]);
    const first = await callFunction('checkout', init, body);
    const replays = await Promise.all(Array.from({ length: 5 }, () => callFunction('checkout', init, body)));
    expect(first.status).toBe(201);
    expect(replays.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await stockOf(T.variants[0]!.id)).toBe(8);
    const changed = await callFunction('checkout', init, { ...body, items: [{ variantId: T.variants[0]!.id, quantity: 3 }] });
    expect(changed.status).toBe(422);
  });
});
