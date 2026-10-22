/// <reference types="vite/client" />
// (vite/client: the storefront modules imported below read import.meta.env at type level.)
//
// Regression: the public storefront must open for an anonymous visitor (no Supabase Auth session)
// exactly when the shop is published (status=active, mode=live), and never otherwise.
//
// These tests call the real storefront data layer (src/features/storefront/api.ts) — the same
// queries the browser sends — with its Supabase client swapped for a session-less anon client of
// the LOCAL stack. An owner session is used only to show why a preview shop "works" in the admin.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Db } from './helpers';

const client: { current: Db | null } = { current: null };

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    if (!client.current) throw new Error('storefront client not set by the test');
    return client.current;
  },
  publicImageUrl: (path: string | null | undefined) => path ?? null,
  functionsUrl: (name: string) => `/functions/v1/${name}`,
}));

const { admin, anon, cleanup, createOwner, createTestShop, env } = await import('./helpers');
const { fetchCategories, fetchProduct, fetchProductsPage, fetchShopBySlug, NotFoundError } = await import(
  '@/features/storefront/api'
);

type TestShop = Awaited<ReturnType<typeof createTestShop>>;

let live: TestShop;
let other: TestShop;
let preview: TestShop;
let suspended: TestShop;
let previewOwner: Db;
let hiddenProductId: string;
let otherHiddenProductId: string;

const asAnon = () => {
  client.current = anon();
};

beforeAll(async () => {
  // Never let these tests touch a hosted project by accident.
  if (!env.isLocal) throw new Error(`storefront regression tests run only against local Supabase, got ${env.url}`);

  live = await createTestShop({ isDemo: true });
  other = await createTestShop();
  preview = await createTestShop({ mode: 'preview', isDemo: true });
  suspended = await createTestShop();
  await admin.from('shops').update({ status: 'suspended' }).eq('id', suspended.id);
  previewOwner = (await createOwner(preview.id)).client;

  await admin.from('product_images').insert({
    shop_id: live.id, product_id: live.productId, storage_path: `${live.id}/products/a.webp`, is_primary: true,
  });
  const hidden = await admin
    .from('products')
    .insert({ shop_id: live.id, category_id: live.categoryId, name: 'Draft', base_price_minor: 1, is_published: false })
    .select('id')
    .single();
  hiddenProductId = hidden.data!.id;
  await admin.from('product_variants').insert({ shop_id: live.id, product_id: hiddenProductId, flavor: 'X', stock_quantity: 3 });
  const otherHidden = await admin
    .from('products')
    .insert({ shop_id: other.id, category_id: other.categoryId, name: 'Other draft', base_price_minor: 1, is_published: false })
    .select('id')
    .single();
  otherHiddenProductId = otherHidden.data!.id;
});

afterAll(async () => {
  client.current = null;
  await cleanup();
});

describe('anonymous visitor, published shop', () => {
  it('finds the live shop by slug without any auth session', async () => {
    asAnon();
    const { data: session } = await client.current!.auth.getSession();
    expect(session.session).toBeNull();
    const shop = await fetchShopBySlug(live.slug);
    expect(shop).toMatchObject({ id: live.id, slug: live.slug, mode: 'live', isDemo: true });
  });

  it('gets public categories, published in-stock products, variants and images', async () => {
    asAnon();
    const categories = await fetchCategories(live.id);
    expect(categories.map((c) => c.id)).toEqual([live.categoryId]);

    const page = await fetchProductsPage(live.id, { categoryId: null, search: '' }, 0);
    expect(page.items.map((p) => p.id)).toEqual([live.productId]);
    expect(page.items[0]!.variants.map((v) => v.id)).toEqual([live.variants[0]!.id]);
    expect(page.items[0]!.images.map((i) => i.storage_path)).toEqual([`${live.id}/products/a.webp`]);

    const detail = await fetchProduct(live.id, live.productId);
    expect(detail.categoryId).toBe(live.categoryId);
  });

  it('does not get unpublished products of this shop', async () => {
    asAnon();
    const page = await fetchProductsPage(live.id, { categoryId: null, search: '' }, 0);
    expect(page.items.map((p) => p.id)).not.toContain(hiddenProductId);
    await expect(fetchProduct(live.id, hiddenProductId)).rejects.toBeInstanceOf(NotFoundError);
    expect((await client.current!.from('product_variants').select('id').eq('product_id', hiddenProductId)).data).toEqual([]);
  });

  it("never mixes in another tenant's data or its drafts", async () => {
    asAnon();
    const page = await fetchProductsPage(live.id, { categoryId: null, search: '' }, 0);
    expect(page.items.map((p) => p.id)).not.toContain(other.productId);
    // Querying a foreign product through this shop's scope finds nothing.
    await expect(fetchProduct(live.id, other.productId)).rejects.toBeInstanceOf(NotFoundError);
    await expect(fetchProduct(other.id, otherHiddenProductId)).rejects.toBeInstanceOf(NotFoundError);
    const { data: unscoped } = await client.current!.from('products').select('id').eq('id', otherHiddenProductId);
    expect(unscoped).toEqual([]);
  });
});

describe('unpublished shops stay private', () => {
  it('a preview shop and its catalog are invisible to anon (shown as "not found", not as an error)', async () => {
    asAnon();
    await expect(fetchShopBySlug(preview.slug)).rejects.toBeInstanceOf(NotFoundError);
    expect(await fetchCategories(preview.id)).toEqual([]);
    expect((await fetchProductsPage(preview.id, { categoryId: null, search: '' }, 0)).items).toEqual([]);
  });

  it('a suspended shop is invisible to anon even in live mode', async () => {
    asAnon();
    await expect(fetchShopBySlug(suspended.slug)).rejects.toBeInstanceOf(NotFoundError);
    expect(await fetchCategories(suspended.id)).toEqual([]);
  });

  it("the preview shop is visible only to its owner's session (why it opens only when signed in to the admin)", async () => {
    client.current = previewOwner;
    const shop = await fetchShopBySlug(preview.slug);
    expect(shop.mode).toBe('preview');
    asAnon();
    await expect(fetchShopBySlug(preview.slug)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('publishing (mode=live, as tenant:publish does) opens it to anon; unpublishing hides it again', async () => {
    await admin.from('shops').update({ mode: 'live', published_at: new Date().toISOString() }).eq('id', preview.id);
    asAnon();
    expect((await fetchShopBySlug(preview.slug)).id).toBe(preview.id);
    expect((await fetchProductsPage(preview.id, { categoryId: null, search: '' }, 0)).items).toHaveLength(1);

    await admin.from('shops').update({ mode: 'preview' }).eq('id', preview.id);
    await expect(fetchShopBySlug(preview.slug)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('private data and privileged RPCs remain closed to anon', () => {
  it('orders, order items, memberships and inventory movements return no rows', async () => {
    const db = anon();
    for (const table of ['orders', 'order_items', 'shop_memberships', 'inventory_movements'] as const) {
      const { data, error } = await db.from(table).select('id').limit(5);
      expect(error !== null || (data ?? []).length === 0, table).toBe(true);
      if (!error) expect(data, table).toEqual([]);
    }
  });

  it('create_order and get_customer_orders are denied for the public role', async () => {
    const db = anon();
    const create = await db.rpc('create_order', {
      p_shop_slug: live.slug, p_customer_tg_id: 1, p_customer_snapshot: {}, p_items: [], p_idempotency_key: randomUUID(),
      p_request_hash: 'x', p_contact_name: 'x', p_contact_phone: '', p_comment: '', p_expected_currency: 'RUB', p_expected_total_minor: 0,
    });
    expect(create.error?.message).toMatch(/permission denied/i);
    const orders = await db.rpc('get_customer_orders', { p_shop_slug: live.slug, p_customer_tg_id: 1, p_limit: 30 });
    expect(orders.error?.message).toMatch(/permission denied/i);
  });
});
