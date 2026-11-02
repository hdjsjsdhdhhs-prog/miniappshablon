// Stage-2 security PoC: cross-tenant isolation for owner / manager of shop A against shop B. LOCAL ONLY.
// Assertions document the behaviour observed on the local stack; "[VULN]" tests assert the CURRENT (weak)
// behaviour and are expected to be inverted by the fix stage.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, callFunction, checkoutBody, createMember, createOwner, createTestShop, initDataFor, newTelegramUserId, stockOf, type Db, type TestShop } from '../helpers';
import { cleanupSecurity, PNG } from './sec-helpers';

let A: TestShop;
let B: TestShop;
let ownerA: Db;
let managerA: Db;
let bOrderId: string;
const bFile = () => `${B.id}/product/${B.productId}/b-secret.png`;

beforeAll(async () => {
  A = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
  B = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
  ownerA = (await createOwner(A.id)).client;
  managerA = (await createMember(A.id, 'manager')).client;
  await createOwner(B.id);
  const up = await admin.storage.from('shop-media').upload(bFile(), PNG, { contentType: 'image/png' });
  if (up.error) throw up.error;
  const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(B, [{ variantId: B.variants[0]!.id, quantity: 1 }]));
  expect(res.status).toBe(201);
  bOrderId = (res.body!.order as { id: string }).id;
});
afterAll(cleanupSecurity);

describe.each([
  ['owner', () => ownerA],
  ['manager', () => managerA],
])('%s of shop A against shop B', (_role, who) => {
  it('cannot move rows to another shop by UPDATE shop_id (no column privilege)', async () => {
    const db = who();
    for (const [table, id] of [
      ['categories', A.categoryId],
      ['products', A.productId],
      ['product_variants', A.variants[0]!.id],
    ] as const) {
      const { error } = await db.from(table).update({ shop_id: B.id } as never).eq('id', id);
      expect(error?.code, table).toBe('42501');
    }
    const { data } = await admin.from('products').select('shop_id').eq('id', A.productId).single();
    expect(data!.shop_id).toBe(A.id);
  });

  it('cannot INSERT rows with a forged shop_id (RLS)', async () => {
    const db = who();
    const cat = await db.from('categories').insert({ shop_id: B.id, name: 'x', slug: `x-${Date.now()}` });
    expect(cat.error?.code).toBe('42501');
    const prod = await db.from('products').insert({ shop_id: B.id, category_id: B.categoryId, name: 'x', base_price_minor: 1 });
    expect(prod.error?.code).toBe('42501');
  });

  it("composite FKs refuse links to B's category / product even with shop_id = A", async () => {
    const db = who();
    const p = await db.from('products').insert({ shop_id: A.id, category_id: B.categoryId, name: 'x', base_price_minor: 1 });
    expect(p.error?.code).toBe('23503');
    const move = await db.from('products').update({ category_id: B.categoryId }).eq('id', A.productId);
    expect(move.error?.code).toBe('23503');
    const v = await db.from('product_variants').insert({ shop_id: A.id, product_id: B.productId, flavor: 'evil' });
    expect(v.error?.code).toBe('23503');
    const img = await db.from('product_images').insert({ shop_id: A.id, product_id: B.productId, storage_path: `${A.id}/product/x/a.png` });
    expect(img.error?.code).toBe('23503');
  });

  it("SECURITY DEFINER RPCs treat B's ids as missing and change nothing", async () => {
    const db = who();
    const before = await stockOf(B.variants[0]!.id);
    expect((await db.rpc('admin_set_variant_stock', { p_variant_id: B.variants[0]!.id, p_quantity: 0 })).error?.message).toBe('variant_not_found');
    expect((await db.rpc('admin_set_order_status', { p_order_id: bOrderId, p_status: 'cancelled' })).error?.message).toBe('order_not_found');
    expect((await db.rpc('admin_delete_product', { p_product_id: B.productId })).error?.message).toBe('product_not_found');
    expect((await db.rpc('admin_delete_variant', { p_variant_id: B.variants[0]!.id })).error?.message).toBe('variant_not_found');
    expect((await db.rpc('admin_delete_category', { p_category_id: B.categoryId })).error?.message).toBe('category_not_found');
    expect(await stockOf(B.variants[0]!.id)).toBe(before);
    const { data: o } = await admin.from('orders').select('status').eq('id', bOrderId).single();
    expect(o!.status).toBe('new');
    expect((await admin.from('products').select('id').eq('id', B.productId)).data).toHaveLength(1);
  });

  it("admin_delete_category: move target of shop B is refused (target_not_found)", async () => {
    const db = who();
    expect((await db.rpc('admin_delete_category', { p_category_id: A.categoryId, p_move_products_to: B.categoryId })).error?.message).toBe('target_not_found');
    const { data } = await admin.from('products').select('category_id').eq('id', A.productId).single();
    expect(data!.category_id).toBe(A.categoryId);
  });

  it("cannot read B's orders, order items or stock journal through PostgREST", async () => {
    const db = who();
    expect((await db.from('orders').select('id').eq('shop_id', B.id)).data).toEqual([]);
    expect((await db.from('order_items').select('id').eq('shop_id', B.id)).data).toEqual([]);
    expect((await db.from('inventory_movements').select('id').eq('shop_id', B.id)).data).toEqual([]);
  });
});

describe('media path scoping (CHECK "<shop_id>/%" is a prefix match, not a path check)', () => {
  const traversal = () => `${A.id}/../${B.id}/product/${B.productId}/b-secret.png`;

  it('[VULN] product_images / categories.image_path / shops.logo_path accept "<A>/../<B>/…" paths', async () => {
    const img = await ownerA.from('product_images').insert({ shop_id: A.id, product_id: A.productId, storage_path: traversal() }).select('id').single();
    expect(img.error).toBeNull();
    const cat = await ownerA.from('categories').update({ image_path: traversal() }).eq('id', A.categoryId);
    expect(cat.error).toBeNull();
    const logo = await ownerA.from('shops').update({ logo_path: traversal() }).eq('id', A.id);
    expect(logo.error).toBeNull();
  });

  it("[VULN] the public URL built from such a path (supabase-js getPublicUrl) resolves to shop B's object", async () => {
    const url = ownerA.storage.from('shop-media').getPublicUrl(traversal()).data.publicUrl;
    // WHATWG URL parsing (browsers, fetch) removes the dot segments: the request goes to B's file.
    expect(new URL(url).pathname).toContain(`/shop-media/${B.id}/product/`);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('a plain foreign-prefix path is still refused by the CHECK constraint (negative control)', async () => {
    const { error } = await ownerA.from('product_images').insert({ shop_id: A.id, product_id: A.productId, storage_path: bFile() });
    expect(error?.code).toBe('23514');
  });
});
