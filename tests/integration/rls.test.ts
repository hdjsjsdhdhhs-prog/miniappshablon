import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { admin, anon, callFunction, checkoutBody, cleanup, createOwner, createTestShop, initDataFor, newTelegramUserId, type Db, type TestShop } from './helpers';

let A: TestShop;
let B: TestShop;
let preview: TestShop;
let ownerA: Db;
let ownerB: Db;
let orderB: string;

beforeAll(async () => {
  A = await createTestShop();
  B = await createTestShop();
  preview = await createTestShop({ mode: 'preview' });
  ownerA = (await createOwner(A.id)).client;
  ownerB = (await createOwner(B.id)).client;
  const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(B, [{ variantId: B.variants[0]!.id, quantity: 1 }]));
  expect(res.status).toBe(201);
  orderB = (res.body!.order as { id: string }).id;
});

afterAll(cleanup);

describe('public (anon) access', () => {
  it('reads live shops but not preview shops', async () => {
    const db = anon();
    expect((await db.from('shops').select('id').eq('id', A.id)).data).toHaveLength(1);
    expect((await db.from('shops').select('id').eq('id', preview.id)).data).toHaveLength(0);
    expect((await db.from('products').select('id').eq('shop_id', preview.id)).data).toHaveLength(0);
  });

  it('sees only published products, active variants and active categories', async () => {
    const db = anon();
    const { data: hidden } = await admin
      .from('products')
      .insert({ shop_id: A.id, category_id: A.categoryId, name: 'Hidden', base_price_minor: 1, is_published: false })
      .select('id')
      .single();
    await admin.from('product_variants').update({ is_active: false }).eq('id', A.variants[0]!.id);
    const products = (await db.from('products').select('id').eq('shop_id', A.id)).data!.map((p) => p.id);
    expect(products).toContain(A.productId);
    expect(products).not.toContain(hidden!.id);
    expect((await db.from('product_variants').select('id').eq('id', A.variants[0]!.id)).data).toHaveLength(0);
    await admin.from('product_variants').update({ is_active: true }).eq('id', A.variants[0]!.id);

    await admin.from('categories').update({ is_active: false }).eq('id', A.categoryId);
    expect((await db.from('products').select('id').eq('id', A.productId)).data).toHaveLength(0);
    expect((await db.from('categories').select('id').eq('id', A.categoryId)).data).toHaveLength(0);
    await admin.from('categories').update({ is_active: true }).eq('id', A.categoryId);
  });

  it('cannot read private tables', async () => {
    const db = anon();
    for (const table of ['orders', 'order_items', 'shop_memberships', 'inventory_movements', 'platform_admins', 'shop_order_counters'] as const) {
      const { data, error } = await db.from(table).select('*').limit(5);
      // Either "permission denied" or an empty result — never rows.
      expect(error !== null || (data ?? []).length === 0, table).toBe(true);
      if (!error) expect(data).toEqual([]);
    }
  });

  it('cannot write anything or call privileged RPCs', async () => {
    const db = anon();
    const ins = await db.from('products').insert({ shop_id: A.id, category_id: A.categoryId, name: 'x', base_price_minor: 1 });
    expect(ins.error).not.toBeNull();
    const upd = await db.from('shops').update({ name: 'hacked' }).eq('id', A.id).select('id');
    expect(upd.error !== null || upd.data!.length === 0).toBe(true);
    const rpc = await db.rpc('create_order', {
      p_shop_slug: A.slug, p_customer_tg_id: 1, p_customer_snapshot: {}, p_items: [], p_idempotency_key: randomUUID(),
      p_request_hash: 'x', p_contact_name: 'x', p_contact_phone: '', p_comment: '', p_expected_currency: 'RUB', p_expected_total_minor: 0,
    });
    expect(rpc.error?.message).toMatch(/permission denied/i);
    const stock = await db.rpc('admin_set_variant_stock', { p_variant_id: A.variants[0]!.id, p_quantity: 999 });
    expect(stock.error).not.toBeNull();
    expect((await admin.from('product_variants').select('stock_quantity').eq('id', A.variants[0]!.id).single()).data!.stock_quantity).not.toBe(999);
  });
});

describe('owner isolation', () => {
  it('owner A reads and edits only tenant A', async () => {
    const own = await ownerA.from('products').update({ name: 'Renamed by A' }).eq('id', A.productId).select('id');
    expect(own.data).toHaveLength(1);
    const foreign = await ownerA.from('products').update({ name: 'pwned' }).eq('id', B.productId).select('id');
    expect(foreign.data ?? []).toHaveLength(0);
    expect((await admin.from('products').select('name').eq('id', B.productId).single()).data!.name).toBe('Liquid');
  });

  it("owner A cannot read tenant B's orders, memberships or inventory", async () => {
    expect((await ownerA.from('orders').select('id').eq('id', orderB)).data).toEqual([]);
    expect((await ownerA.from('order_items').select('id').eq('shop_id', B.id)).data).toEqual([]);
    expect((await ownerA.from('shop_memberships').select('shop_id').eq('shop_id', B.id)).data).toEqual([]);
    expect((await ownerA.from('inventory_movements').select('id').eq('shop_id', B.id)).data).toEqual([]);
    expect((await ownerB.from('orders').select('id').eq('id', orderB)).data).toHaveLength(1);
  });

  it('owner A cannot insert into tenant B, nor link A product to B category (composite FK)', async () => {
    const intoB = await ownerA.from('products').insert({ shop_id: B.id, category_id: B.categoryId, name: 'x', base_price_minor: 1 });
    expect(intoB.error).not.toBeNull();
    const crossFk = await ownerA.from('products').insert({ shop_id: A.id, category_id: B.categoryId, name: 'x', base_price_minor: 1 });
    expect(crossFk.error?.message).toMatch(/foreign key/i);
    const crossVariant = await ownerA.from('product_variants').insert({ shop_id: A.id, product_id: B.productId, flavor: 'x' });
    expect(crossVariant.error).not.toBeNull();
  });

  it('owners cannot bypass stock/order/publish controls with direct writes', async () => {
    const stock = await ownerA.from('product_variants').update({ stock_quantity: 1000 } as never).eq('id', A.variants[0]!.id);
    expect(stock.error?.message).toMatch(/permission denied/i);
    const mode = await ownerA.from('shops').update({ mode: 'live', is_demo: false } as never).eq('id', A.id);
    expect(mode.error?.message).toMatch(/permission denied/i);
    const order = await ownerA.from('orders').update({ status: 'completed' } as never).eq('shop_id', A.id);
    expect(order.error?.message).toMatch(/permission denied/i);
    const del = await ownerA.from('products').delete().eq('id', A.productId);
    expect(del.error?.message).toMatch(/permission denied/i);
  });

  it("owner A's admin RPCs reject tenant B objects", async () => {
    const s = await ownerA.rpc('admin_set_variant_stock', { p_variant_id: B.variants[0]!.id, p_quantity: 50 });
    expect(s.error?.message).toBe('variant_not_found');
    const o = await ownerA.rpc('admin_set_order_status', { p_order_id: orderB, p_status: 'cancelled' });
    expect(o.error?.message).toBe('order_not_found');
    const ok = await ownerA.rpc('admin_set_variant_stock', { p_variant_id: A.variants[0]!.id, p_quantity: 7 });
    expect(ok.error).toBeNull();
    const { data: mv } = await admin.from('inventory_movements').select('reason, delta').eq('variant_id', A.variants[0]!.id).eq('reason', 'admin_set');
    expect(mv!.length).toBeGreaterThan(0);
  });

  it('theme is validated server-side', async () => {
    const bad = await ownerA.from('shops').update({ theme_config: { mode: 'dark' } }).eq('id', A.id);
    expect(bad.error?.message).toMatch(/check constraint/i);
  });
});
