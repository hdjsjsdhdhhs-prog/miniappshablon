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

  it('preview shops never accept orders; demo shops create orders marked as test', async () => {
    const preview = await createTestShop({ mode: 'preview' });
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(preview, [{ variantId: preview.variants[0]!.id, quantity: 1 }]));
    expect(res.status).toBe(403);
    expect((await admin.from('orders').select('id').eq('shop_id', preview.id)).data).toEqual([]);
    const demo = await createTestShop({ isDemo: true });
    const d = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(demo, [{ variantId: demo.variants[0]!.id, quantity: 1 }]));
    expect((d.body!.order as Order).is_test).toBe(true);
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
