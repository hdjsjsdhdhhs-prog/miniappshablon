import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  anon,
  callFunction,
  checkoutBody,
  cleanup,
  createOwner,
  createTestShop,
  initDataFor,
  newTelegramUserId,
  type Db,
  type TestShop,
} from './helpers';

// Physical deletion of products, variants (flavor / color rows) and categories through the admin RPCs
// (20261026100000_admin_catalog_delete.sql), checked against the real local database and Storage.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let S: TestShop;
let T: TestShop;
let ownerS: Db;
let ownerT: Db;

beforeAll(async () => {
  S = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }, { flavor: 'Berry', stock: 10 }] });
  T = await createTestShop();
  ownerS = (await createOwner(S.id)).client;
  ownerT = (await createOwner(T.id)).client;
});

afterAll(cleanup);

async function exists(table: 'products' | 'product_variants' | 'categories' | 'product_images', id: string) {
  const { data, error } = await admin.from(table).select('id').eq('id', id);
  if (error) throw error;
  return data.length === 1;
}

async function fileExists(path: string) {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const name = path.slice(path.lastIndexOf('/') + 1);
  const { data, error } = await admin.storage.from('shop-media').list(dir, { limit: 100 });
  if (error) throw error;
  return (data ?? []).some((f) => f.name === name);
}

async function upload(client: Db, path: string) {
  const { error } = await client.storage.from('shop-media').upload(path, PNG, { contentType: 'image/png' });
  if (error) throw error;
  return path;
}

async function newCategory(shop: TestShop, slug: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await admin.from('categories').insert({ shop_id: shop.id, name: slug, slug, ...extra }).select('id').single();
  if (error) throw error;
  return data.id;
}

async function newProduct(shop: TestShop, categoryId: string, flavors: string[] = ['A']) {
  const { data: p, error } = await admin
    .from('products')
    .insert({ shop_id: shop.id, category_id: categoryId, name: `P ${Math.random().toString(36).slice(2, 7)}`, base_price_minor: 1000, is_published: true })
    .select('id')
    .single();
  if (error) throw error;
  const { data: vs, error: ve } = await admin
    .from('product_variants')
    .insert(flavors.map((f, i) => ({ shop_id: shop.id, product_id: p.id, flavor: f, stock_quantity: 5, sort_order: i })))
    .select('id, flavor');
  if (ve) throw ve;
  return { id: p.id, variants: flavors.map((f) => vs.find((v) => v.flavor === f)!.id) };
}

/** A real order through the checkout Edge Function (not a fixture insert). */
async function order(shop: TestShop, variantId: string) {
  const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId, quantity: 1 }]));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body!.order as { id: string }).id;
}

describe('products', () => {
  it('owner deletes a product without orders: product, variants, images, stock journal gone; unused files reported and removed', async () => {
    const p = await newProduct(S, S.categoryId, ['A', 'B']);
    // Stock journal rows exist for the variants (admin_set) and must go with them.
    expect((await ownerS.rpc('admin_set_variant_stock', { p_variant_id: p.variants[0]!, p_quantity: 7 })).error).toBeNull();
    const own = await upload(ownerS, `${S.id}/product/${p.id}/own.png`);
    // The same file is also used as the shop logo: it must survive the product delete.
    const shared = await upload(ownerS, `${S.id}/product/${p.id}/shared.png`);
    expect((await admin.from('shops').update({ logo_path: shared }).eq('id', S.id)).error).toBeNull();
    const { data: imgs, error: ie } = await admin
      .from('product_images')
      .insert([
        { shop_id: S.id, product_id: p.id, storage_path: own, sort_order: 0, is_primary: true },
        { shop_id: S.id, product_id: p.id, storage_path: shared, sort_order: 1, is_primary: false },
      ])
      .select('id');
    if (ie) throw ie;

    const res = await ownerS.rpc('admin_delete_product', { p_product_id: p.id });
    expect(res.error).toBeNull();
    const r = res.data as { deleted: boolean; variants: number; images: number; unused_media: string[] };
    expect(r).toMatchObject({ deleted: true, variants: 2, images: 2, unused_media: [own] });

    expect(await exists('products', p.id)).toBe(false);
    for (const v of p.variants) expect(await exists('product_variants', v)).toBe(false);
    for (const i of imgs) expect(await exists('product_images', i.id)).toBe(false);
    const { count: moves } = await admin.from('inventory_movements').select('id', { count: 'exact', head: true }).in('variant_id', p.variants);
    expect(moves).toBe(0);

    // What the admin does next: remove exactly the reported files through Storage (member policy applies).
    const rm = await ownerS.storage.from('shop-media').remove(r.unused_media);
    expect(rm.error).toBeNull();
    expect(await fileExists(own)).toBe(false);
    expect(await fileExists(shared)).toBe(true);
    expect((await admin.from('shops').select('logo_path').eq('id', S.id).single()).data!.logo_path).toBe(shared);
    await admin.from('shops').update({ logo_path: null }).eq('id', S.id);
  });

  it('a product that is in an order is NOT deleted: clear reason, order history intact, archiving still works', async () => {
    const p = await newProduct(S, S.categoryId, ['A', 'B']);
    const orderId = await order(S, p.variants[1]!);
    const before = (await admin.from('order_items').select('*').eq('order_id', orderId)).data!;

    const res = await ownerS.rpc('admin_delete_product', { p_product_id: p.id });
    expect(res.error?.message).toBe('product_has_orders');
    expect(JSON.parse(res.error!.details!)).toEqual({ orders: 1 });

    expect(await exists('products', p.id)).toBe(true);
    for (const v of p.variants) expect(await exists('product_variants', v)).toBe(true);
    const after = (await admin.from('order_items').select('*').eq('order_id', orderId)).data!;
    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ product_id: p.id, variant_id: p.variants[1] });

    const arch = await ownerS.from('products').update({ archived_at: new Date().toISOString() }).eq('id', p.id).select('archived_at');
    expect(arch.error).toBeNull();
    expect(arch.data![0]!.archived_at).not.toBeNull();
  });

  it('defense in depth: even the service role can not physically delete an ordered product or variant (FK RESTRICT)', async () => {
    const p = await newProduct(S, S.categoryId, ['A']);
    const orderId = await order(S, p.variants[0]!);
    const delP = await admin.from('products').delete().eq('id', p.id);
    expect(delP.error?.code).toBe('23503');
    const delV = await admin.from('product_variants').delete().eq('id', p.variants[0]!);
    expect(delV.error?.code).toBe('23503');
    expect(await exists('products', p.id)).toBe(true);
    expect((await admin.from('order_items').select('product_id, variant_id').eq('order_id', orderId)).data).toEqual([
      { product_id: p.id, variant_id: p.variants[0] },
    ]);
  });
});

describe('variants (flavor / color rows)', () => {
  it('deletes an unordered variant; refuses an ordered one and the last one', async () => {
    const p = await newProduct(S, S.categoryId, ['Keep', 'Drop', 'Sold']);
    await order(S, p.variants[2]!);

    const drop = await ownerS.rpc('admin_delete_variant', { p_variant_id: p.variants[1]! });
    expect(drop.error).toBeNull();
    expect(drop.data).toMatchObject({ id: p.variants[1], product_id: p.id, deleted: true });
    expect(await exists('product_variants', p.variants[1]!)).toBe(false);

    const sold = await ownerS.rpc('admin_delete_variant', { p_variant_id: p.variants[2]! });
    expect(sold.error?.message).toBe('variant_has_orders');
    expect(JSON.parse(sold.error!.details!)).toEqual({ orders: 1 });
    expect(await exists('product_variants', p.variants[2]!)).toBe(true);
    // The suggested alternative works: deactivate.
    expect((await ownerS.from('product_variants').update({ is_active: false }).eq('id', p.variants[2]!).select('id')).error).toBeNull();

    const solo = await newProduct(S, S.categoryId, ['Only']);
    const last = await ownerS.rpc('admin_delete_variant', { p_variant_id: solo.variants[0]! });
    expect(last.error?.message).toBe('last_variant');
    expect(await exists('product_variants', solo.variants[0]!)).toBe(true);
  });

  it('the storefront no longer offers a deleted variant and checkout refuses it', async () => {
    const p = await newProduct(S, S.categoryId, ['X', 'Y']);
    expect((await ownerS.rpc('admin_delete_variant', { p_variant_id: p.variants[0]! })).error).toBeNull();
    expect((await anon().from('product_variants').select('id').eq('product_id', p.id)).data).toEqual([{ id: p.variants[1] }]);
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(S, [{ variantId: p.variants[0]!, quantity: 1 }]));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toContain('item_unavailable');
  });
});

describe('categories', () => {
  it('an empty category is deleted together with its unused image', async () => {
    const id = await newCategory(S, 'empty-cat');
    const img = await upload(ownerS, `${S.id}/category/${id}/c.png`);
    await admin.from('categories').update({ image_path: img }).eq('id', id);
    const res = await ownerS.rpc('admin_delete_category', { p_category_id: id });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ deleted: true, moved_products: 0, unused_media: [img] });
    expect(await exists('categories', id)).toBe(false);
    expect((await ownerS.storage.from('shop-media').remove([img])).error).toBeNull();
    expect(await fileExists(img)).toBe(false);
  });

  it('a category with products is refused without a target, and moved + deleted with one (archived products included)', async () => {
    const from = await newCategory(S, 'from-cat');
    const to = await newCategory(S, 'to-cat');
    const live = await newProduct(S, from);
    const archived = await newProduct(S, from);
    await admin.from('products').update({ archived_at: new Date().toISOString() }).eq('id', archived.id);
    // Ordered products move too: the order keeps its product link.
    const orderId = await order(S, live.variants[0]!);

    const refused = await ownerS.rpc('admin_delete_category', { p_category_id: from });
    expect(refused.error?.message).toBe('category_has_products');
    expect(JSON.parse(refused.error!.details!)).toEqual({ products: 2 });
    expect(await exists('categories', from)).toBe(true);

    const res = await ownerS.rpc('admin_delete_category', { p_category_id: from, p_move_products_to: to });
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ deleted: true, moved_products: 2, moved_to: to });
    expect(await exists('categories', from)).toBe(false);
    const { data: moved } = await admin.from('products').select('id, category_id').in('id', [live.id, archived.id]);
    expect(moved!.every((m) => m.category_id === to)).toBe(true);
    expect((await admin.from('order_items').select('product_id').eq('order_id', orderId)).data).toEqual([{ product_id: live.id }]);
  });

  it('refuses invalid targets and changes nothing: itself, an archived category, a category of another shop', async () => {
    const from = await newCategory(S, 'guard-cat');
    const p = await newProduct(S, from);
    const archivedTarget = await newCategory(S, 'arch-target', { archived_at: new Date().toISOString(), is_active: false });

    expect((await ownerS.rpc('admin_delete_category', { p_category_id: from, p_move_products_to: from })).error?.message).toBe('invalid_target');
    expect((await ownerS.rpc('admin_delete_category', { p_category_id: from, p_move_products_to: archivedTarget })).error?.message).toBe('target_not_found');
    expect((await ownerS.rpc('admin_delete_category', { p_category_id: from, p_move_products_to: T.categoryId })).error?.message).toBe('target_not_found');

    expect(await exists('categories', from)).toBe(true);
    expect((await admin.from('products').select('category_id').eq('id', p.id).single()).data!.category_id).toBe(from);
  });
});

describe('shop isolation and roles', () => {
  it("another shop's owner can not delete S's product, variant or category (looks like a missing row)", async () => {
    const p = await newProduct(S, S.categoryId, ['A', 'B']);
    const cat = await newCategory(S, 'iso-cat');
    expect((await ownerT.rpc('admin_delete_product', { p_product_id: p.id })).error?.message).toBe('product_not_found');
    expect((await ownerT.rpc('admin_delete_variant', { p_variant_id: p.variants[0]! })).error?.message).toBe('variant_not_found');
    expect((await ownerT.rpc('admin_delete_category', { p_category_id: cat })).error?.message).toBe('category_not_found');
    // Moving S's products into T's category through T's own delete is impossible as well.
    expect((await ownerT.rpc('admin_delete_category', { p_category_id: T.categoryId, p_move_products_to: cat })).error?.message).toBe('target_not_found');
    expect(await exists('products', p.id)).toBe(true);
    expect(await exists('product_variants', p.variants[0]!)).toBe(true);
    expect(await exists('categories', cat)).toBe(true);
    expect(await exists('categories', T.categoryId)).toBe(true);
  });

  it('anon can not call the delete RPCs; owners still have no direct DELETE on catalog tables', async () => {
    const p = await newProduct(S, S.categoryId, ['A', 'B']);
    const db = anon();
    expect((await db.rpc('admin_delete_product', { p_product_id: p.id })).error?.message).toMatch(/permission denied/i);
    expect((await db.rpc('admin_delete_variant', { p_variant_id: p.variants[0]! })).error?.message).toMatch(/permission denied/i);
    expect((await db.rpc('admin_delete_category', { p_category_id: S.categoryId })).error?.message).toMatch(/permission denied/i);
    // The RPC is the only delete path: a direct PostgREST delete is refused (no DELETE grant).
    expect((await ownerS.from('products').delete().eq('id', p.id)).error?.message).toMatch(/permission denied/i);
    expect((await ownerS.from('product_variants').delete().eq('id', p.variants[0]!)).error?.message).toMatch(/permission denied/i);
    expect((await ownerS.from('categories').delete().eq('id', S.categoryId)).error?.message).toMatch(/permission denied/i);
    expect(await exists('products', p.id)).toBe(true);
  });
});
