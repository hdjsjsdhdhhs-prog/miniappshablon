import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { admin, callFunction, checkoutBody, cleanup, createOwner, createTestShop, initDataFor, newTelegramUserId, stockOf, TEST_BOT_TOKEN } from './helpers';

afterAll(cleanup);

type Order = { id: string; total_minor: number; order_number: number; is_test: boolean; items: Array<{ unit_price_minor: number; quantity: number; flavor: string | null; variant_label: string; product_name: string }> };

describe('checkout (Edge Function → create_order)', () => {
  it('creates an order with server prices, snapshot and stock deduction', async () => {
    const shop = await createTestShop({ basePrice: 50000, variants: [{ flavor: 'Mint', stock: 5 }, { flavor: 'Cherry', stock: 5, price: 65000 }] });
    const user = newTelegramUserId();
    const res = await callFunction('checkout', await initDataFor(user), checkoutBody(shop, [
      { variantId: shop.variants[0]!.id, quantity: 2 },
      { variantId: shop.variants[1]!.id, quantity: 1 },
    ], { expectedTotalMinor: 165000 }));
    expect(res.status).toBe(201);
    const order = res.body!.order as Order;
    expect(order.total_minor).toBe(2 * 50000 + 65000);
    expect(order.items.map((i) => [i.flavor, i.unit_price_minor, i.quantity]).sort()).toEqual([['Cherry', 65000, 1], ['Mint', 50000, 2]]);
    expect(await stockOf(shop.variants[0]!.id)).toBe(3);
    expect(await stockOf(shop.variants[1]!.id)).toBe(4);
    const { data: row } = await admin.from('orders').select('customer_tg_id, status, is_test').eq('id', order.id).single();
    expect(row).toMatchObject({ customer_tg_id: user, status: 'new', is_test: false });
  });

  it('rejects a client-side total that differs from DB prices (price_changed) without creating an order', async () => {
    const shop = await createTestShop({ basePrice: 50000 });
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }], { expectedTotalMinor: 1 }));
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('price_changed');
    expect((await admin.from('orders').select('id').eq('shop_id', shop.id)).data).toEqual([]);
    expect(await stockOf(shop.variants[0]!.id)).toBe(5);
  });

  it('idempotency: a replay returns the original order and deducts stock once', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Mint', stock: 5 }] });
    const init = await initDataFor(newTelegramUserId());
    const body = checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 2 }]);
    const first = await callFunction('checkout', init, body);
    const second = await callFunction('checkout', init, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body!.replayed).toBe(true);
    expect((second.body!.order as Order).id).toBe((first.body!.order as Order).id);
    expect(await stockOf(shop.variants[0]!.id)).toBe(3);
    const conflict = await callFunction('checkout', init, { ...body, items: [{ variantId: shop.variants[0]!.id, quantity: 1 }] });
    expect(conflict.status).toBe(422);
  });

  it('idempotency under concurrency: 5 parallel identical requests create exactly one order', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
    const init = await initDataFor(newTelegramUserId());
    const body = checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]);
    const results = await Promise.all(Array.from({ length: 5 }, () => callFunction('checkout', init, body)));
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => (r.body!.order as Order).id)).size).toBe(1);
    expect((await admin.from('orders').select('id').eq('shop_id', shop.id)).data).toHaveLength(1);
    expect(await stockOf(shop.variants[0]!.id)).toBe(9);
  });

  it('concurrency: 10 buyers racing for the last unit — exactly one wins, stock never negative', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Last', stock: 1 }] });
    const results = await Promise.all(
      Array.from({ length: 10 }, async () =>
        callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }])),
      ),
    );
    const ok = results.filter((r) => r.status === 201);
    const sold = results.filter((r) => r.status === 409 && (r.body!.error as { code: string }).code === 'insufficient_stock');
    const summary = JSON.stringify(results.map((r) => [r.status, (r.body?.error as { code?: string } | undefined)?.code ?? 'ok']));
    expect(ok, summary).toHaveLength(1);
    expect(sold, summary).toHaveLength(9);
    expect(await stockOf(shop.variants[0]!.id)).toBe(0);
    expect((await admin.from('orders').select('id').eq('shop_id', shop.id)).data).toHaveLength(1);
  });

  it('order history keeps the price snapshot after the owner changes prices', async () => {
    const shop = await createTestShop({ basePrice: 40000 });
    const user = newTelegramUserId();
    const res = await callFunction('checkout', await initDataFor(user), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]));
    const order = res.body!.order as Order;
    await admin.from('products').update({ base_price_minor: 99900, name: 'Renamed' }).eq('id', shop.productId);
    await admin.from('product_variants').update({ flavor: 'Changed' }).eq('id', shop.variants[0]!.id);
    const mine = await callFunction('my-orders', await initDataFor(user), { shopSlug: shop.slug });
    const hist = (mine.body!.orders as Order[]).find((o) => o.id === order.id)!;
    expect(hist.total_minor).toBe(40000);
    expect(hist.items[0]).toMatchObject({ unit_price_minor: 40000, product_name: 'Liquid', flavor: 'Mint' });
  });

  it('rejects variants of another shop, inactive variants and unpublished products', async () => {
    const shop = await createTestShop();
    const other = await createTestShop();
    const init = await initDataFor(newTelegramUserId());
    const foreign = await callFunction('checkout', init, checkoutBody(shop, [{ variantId: other.variants[0]!.id, quantity: 1 }]));
    expect(foreign.status).toBe(409);
    expect((foreign.body!.error as { code: string }).code).toBe('item_unavailable');
    expect(await stockOf(other.variants[0]!.id)).toBe(5);

    await admin.from('product_variants').update({ is_active: false }).eq('id', shop.variants[0]!.id);
    expect((await callFunction('checkout', init, checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]))).status).toBe(409);
    await admin.from('product_variants').update({ is_active: true }).eq('id', shop.variants[0]!.id);
    await admin.from('products').update({ is_published: false }).eq('id', shop.productId);
    expect((await callFunction('checkout', init, checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]))).status).toBe(409);
  });

  it('validates quantities and currency', async () => {
    const shop = await createTestShop();
    const init = await initDataFor(newTelegramUserId());
    for (const quantity of [0, 100, 1.5]) {
      expect((await callFunction('checkout', init, checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity }]))).status).toBe(400);
    }
    const cur = await callFunction('checkout', init, checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }], { currency: 'USD' }));
    expect((cur.body!.error as { code: string }).code).toBe('currency_mismatch');
    const tooMany = await callFunction('checkout', init, checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 6 }]));
    expect((tooMany.body!.error as { code: string }).code).toBe('insufficient_stock');
  });

  it('preview shops never accept orders; DEMO shops never store an order or move stock (also from Telegram)', async () => {
    const preview = await createTestShop({ mode: 'preview' });
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(preview, [{ variantId: preview.variants[0]!.id, quantity: 1 }]));
    expect(res.status).toBe(403);
    expect((await admin.from('orders').select('id').eq('shop_id', preview.id)).data).toEqual([]);
    // A DEMO shop shows a client-side "Тестовый заказ"; a forged request with valid initData is refused.
    const demo = await createTestShop({ isDemo: true });
    const d = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(demo, [{ variantId: demo.variants[0]!.id, quantity: 1 }]));
    expect(d.status).toBe(403);
    expect((d.body!.error as { code: string }).code).toBe('shop_demo');
    expect((await admin.from('orders').select('id').eq('shop_id', demo.id)).data).toEqual([]);
    expect(await stockOf(demo.variants[0]!.id)).toBe(5);
    expect((await admin.from('inventory_movements').select('id').eq('shop_id', demo.id).eq('reason', 'checkout')).data).toEqual([]);
  });

  it('rejects missing, tampered, foreign-bot and expired initData', async () => {
    const shop = await createTestShop();
    const body = checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]);
    expect((await callFunction('checkout', null, body)).status).toBe(401);
    const tampered = new URLSearchParams(await initDataFor(1001));
    tampered.set('user', JSON.stringify({ id: 999, first_name: 'Mallory' }));
    expect((await callFunction('checkout', tampered.toString(), body)).status).toBe(401);
    expect((await callFunction('checkout', await initDataFor(1002, { token: `${TEST_BOT_TOKEN}x` }), body)).status).toBe(401);
    const expired = await callFunction('checkout', await initDataFor(1003, { authDate: Math.floor(Date.now() / 1000) - 3 * 86400 }), body);
    expect(expired.status).toBe(401);
    expect((expired.body!.error as { details: { reason: string } }).details.reason).toBe('expired');
    expect((await admin.from('orders').select('id').eq('shop_id', shop.id)).data).toEqual([]);
  });

  it('a buyer-supplied user id in the body is ignored: identity comes from initData only', async () => {
    const shop = await createTestShop();
    const real = newTelegramUserId();
    const res = await callFunction('checkout', await initDataFor(real), { ...checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]), userId: 1, customer_tg_id: 1 });
    // Unknown keys are stripped by the schema; the order belongs to the verified user.
    expect(res.status).toBe(201);
    const { data } = await admin.from('orders').select('customer_tg_id').eq('id', (res.body!.order as Order).id).single();
    expect(data!.customer_tg_id).toBe(real);
  });
});

describe('fulfillment: delivery / pickup validated on the server', () => {
  type FOrder = Order & { fulfillment_method: string | null; delivery_address: string | null; contact_name: string | null; contact_phone: string | null };
  const code = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;

  it('delivery stores the trimmed address; no name/phone placeholders are written', async () => {
    const shop = await createTestShop();
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }], {
      fulfillment: { method: 'delivery', address: '  ул. Ленина, 1, кв. 5  ' },
      comment: 'Позвоните за час',
    }));
    expect(res.status).toBe(201);
    const order = res.body!.order as FOrder;
    expect(order).toMatchObject({ fulfillment_method: 'delivery', delivery_address: 'ул. Ленина, 1, кв. 5', comment: 'Позвоните за час', contact_name: null, contact_phone: null });
    const { data: row } = await admin.from('orders').select('fulfillment_method, delivery_address, contact_name, contact_phone').eq('id', order.id).single();
    expect(row).toEqual({ fulfillment_method: 'delivery', delivery_address: 'ул. Ленина, 1, кв. 5', contact_name: null, contact_phone: null });
    expect(await stockOf(shop.variants[0]!.id)).toBe(4);
  });

  it('pickup never stores an address, even when one is injected into the request', async () => {
    const shop = await createTestShop();
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }], {
      fulfillment: { method: 'pickup', address: 'should be ignored' },
      deliveryAddress: 'also ignored',
    }));
    expect(res.status).toBe(201);
    const { data: row } = await admin.from('orders').select('fulfillment_method, delivery_address').eq('id', (res.body!.order as Order).id).single();
    expect(row).toEqual({ fulfillment_method: 'pickup', delivery_address: null });
  });

  it('delivery without a (non-blank) address, unknown methods and the old name/phone body are rejected, nothing is written', async () => {
    const shop = await createTestShop();
    const init = await initDataFor(newTelegramUserId());
    const items = [{ variantId: shop.variants[0]!.id, quantity: 1 }];
    for (const extra of [
      { fulfillment: { method: 'delivery' } },
      { fulfillment: { method: 'delivery', address: '   ' } },
      { fulfillment: { method: 'delivery', address: 'x'.repeat(301) } },
      { fulfillment: { method: 'courier', address: 'ул. Мира, 1' } },
      { fulfillment: undefined, contact: { name: 'Old client', phone: '+79990000000', comment: '' } },
    ]) {
      const r = await callFunction('checkout', init, checkoutBody(shop, items, extra));
      expect(r.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await admin.from('orders').select('id').eq('shop_id', shop.id)).data).toEqual([]);
    expect(await stockOf(shop.variants[0]!.id)).toBe(5);
  });

  it('a disabled method can not be forced through the API; both disabled → no order at all', async () => {
    const noDelivery = await createTestShop({ delivery: false });
    const init = await initDataFor(newTelegramUserId());
    const forced = await callFunction('checkout', init, checkoutBody(noDelivery, [{ variantId: noDelivery.variants[0]!.id, quantity: 1 }], {
      fulfillment: { method: 'delivery', address: 'ул. Ленина, 1' },
    }));
    expect(forced.status).toBe(409);
    expect(code(forced)).toBe('fulfillment_unavailable');
    expect((forced.body!.error as { details: unknown }).details).toEqual({ delivery: false, pickup: true });
    expect((await callFunction('checkout', init, checkoutBody(noDelivery, [{ variantId: noDelivery.variants[0]!.id, quantity: 1 }]))).status).toBe(201);

    const noPickup = await createTestShop({ pickup: false });
    const p = await callFunction('checkout', init, checkoutBody(noPickup, [{ variantId: noPickup.variants[0]!.id, quantity: 1 }]));
    expect(code(p)).toBe('fulfillment_unavailable');

    const none = await createTestShop({ delivery: false, pickup: false });
    for (const fulfillment of [{ method: 'pickup' }, { method: 'delivery', address: 'ул. Ленина, 1' }]) {
      const r = await callFunction('checkout', init, checkoutBody(none, [{ variantId: none.variants[0]!.id, quantity: 1 }], { fulfillment }));
      expect(code(r)).toBe('fulfillment_unavailable');
    }
    for (const s of [noPickup, none]) {
      expect((await admin.from('orders').select('id').eq('shop_id', s.id)).data).toEqual([]);
      expect(await stockOf(s.variants[0]!.id)).toBe(5);
    }
  });

  it("the owner's switch applies to the next checkout immediately; owners can not touch is_demo / mode", async () => {
    const shop = await createTestShop();
    const { client: owner } = await createOwner(shop.id);
    const off = await owner.from('shops').update({ pickup_enabled: false, pickup_instructions: 'ул. Мира, 1, 10–20' }).eq('id', shop.id).select('pickup_enabled');
    expect(off.error).toBeNull();
    const r = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]));
    expect(code(r)).toBe('fulfillment_unavailable');
    // Column grants: the DEMO flag, publication state and legal_notice are not writable by an owner.
    for (const patch of [{ is_demo: true }, { mode: 'preview' }, { status: 'suspended' }, { legal_notice: 'x' }]) {
      const res = await owner.from('shops').update(patch).eq('id', shop.id).select('id');
      expect(res.error?.message, JSON.stringify(patch)).toMatch(/permission denied/i);
    }
    const { data: after } = await admin.from('shops').select('is_demo, mode, status').eq('id', shop.id).single();
    expect(after).toEqual({ is_demo: false, mode: 'live', status: 'active' });
  });

  it('idempotency covers the fulfillment: same key with another address is a conflict, a replay returns the order', async () => {
    const shop = await createTestShop();
    const init = await initDataFor(newTelegramUserId());
    const body = checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }], { fulfillment: { method: 'delivery', address: 'ул. Ленина, 1' } });
    expect((await callFunction('checkout', init, body)).status).toBe(201);
    expect((await callFunction('checkout', init, body)).status).toBe(200);
    const changed = await callFunction('checkout', init, { ...body, fulfillment: { method: 'delivery', address: 'ул. Мира, 2' } });
    expect(changed.status).toBe(422);
    expect(await stockOf(shop.variants[0]!.id)).toBe(4);
  });

  it('legacy test orders of a former DEMO shop are hidden from the owner and from the buyer', async () => {
    const shop = await createTestShop();
    const { client: owner } = await createOwner(shop.id);
    const buyer = newTelegramUserId();
    const real = await callFunction('checkout', await initDataFor(buyer), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]));
    const realId = (real.body!.order as Order).id;
    const { data: legacy, error } = await admin
      .from('orders')
      .insert({
        shop_id: shop.id, order_number: 999, customer_tg_id: buyer, contact_name: 'Demo', currency: 'RUB', total_minor: 1,
        idempotency_key: randomUUID(), request_hash: 'legacy', is_test: true,
      })
      .select('id')
      .single();
    expect(error).toBeNull();
    const { data: seen } = await owner.from('orders').select('id').eq('shop_id', shop.id);
    expect(seen).toEqual([{ id: realId }]);
    const mine = await callFunction('my-orders', await initDataFor(buyer), { shopSlug: shop.slug });
    expect((mine.body!.orders as Order[]).map((o) => o.id)).toEqual([realId]);
    expect((await admin.from('orders').select('id').eq('id', legacy!.id)).data).toHaveLength(1); // kept, not deleted
  });
});

describe('cancellation restores stock at most once', () => {
  it('restores on cancel, rejects invalid transitions and never double-restores', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Mint', stock: 5 }] });
    const { client: owner } = await createOwner(shop.id);
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 3 }]));
    const orderId = (res.body!.order as Order).id;
    expect(await stockOf(shop.variants[0]!.id)).toBe(2);

    expect((await owner.rpc('admin_set_order_status', { p_order_id: orderId, p_status: 'completed' })).error?.message).toBe('invalid_transition');
    expect((await owner.rpc('admin_set_order_status', { p_order_id: orderId, p_status: 'confirmed' })).error).toBeNull();

    const cancels = await Promise.all(Array.from({ length: 4 }, () => owner.rpc('admin_set_order_status', { p_order_id: orderId, p_status: 'cancelled' })));
    expect(cancels.some((c) => c.error === null)).toBe(true);
    expect(await stockOf(shop.variants[0]!.id)).toBe(5);
    const { data: mv } = await admin.from('inventory_movements').select('id').eq('order_id', orderId).eq('reason', 'cancel_restore');
    expect(mv).toHaveLength(1);
    expect((await owner.rpc('admin_set_order_status', { p_order_id: orderId, p_status: 'new' })).error?.message).toBe('invalid_transition');
    expect(await stockOf(shop.variants[0]!.id)).toBe(5);
  });
});

describe('buyer can read only own orders', () => {
  it('my-orders is scoped to the verified Telegram user and shop', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
    const other = await createTestShop();
    const alice = newTelegramUserId();
    const bob = newTelegramUserId();
    const r = await callFunction('checkout', await initDataFor(alice), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }]));
    const aliceOrder = (r.body!.order as Order).id;

    const mine = await callFunction('my-orders', await initDataFor(alice), { shopSlug: shop.slug });
    expect((mine.body!.orders as Order[]).map((o) => o.id)).toEqual([aliceOrder]);

    const bobs = await callFunction('my-orders', await initDataFor(bob), { shopSlug: shop.slug });
    expect(bobs.body!.orders).toEqual([]);
    const guess = await callFunction('my-orders', await initDataFor(bob), { shopSlug: shop.slug, orderId: aliceOrder });
    expect(guess.body!.orders).toEqual([]);
    const otherShop = await callFunction('my-orders', await initDataFor(alice), { shopSlug: other.slug });
    expect(otherShop.body!.orders).toEqual([]);
    expect((await callFunction('my-orders', null, { shopSlug: shop.slug })).status).toBe(401);
    expect(randomUUID()).toBeTruthy();
  });
});
