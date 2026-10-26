/// <reference types="vite/client" />
// (vite/client: the storefront modules imported below read import.meta.env at type level.)
//
// The demo profile of a DEMO shop opened outside Telegram is a client-side mock-up. This suite runs the exact
// data path it uses (shop by slug + public catalog listing → in-memory "Тестовый заказ") with a session-less
// anon client of the LOCAL stack and checks that it signs nobody in and writes nothing: auth users, orders and
// order items are counted before and after.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const { admin, anon, cleanup, createTestShop, env } = await import('./helpers');
const { fetchProductsPage, fetchShopBySlug } = await import('@/features/storefront/api');
const { buildDemoOrder, shouldShowDemoProfile } = await import('@/features/storefront/demo-profile');

type TestShop = Awaited<ReturnType<typeof createTestShop>>;
let demo: TestShop;
let regular: TestShop;

async function counts() {
  // Global counters (not only this shop): the scenario must not create a user or an order anywhere.
  const users = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (users.error) throw users.error;
  const orders = await admin.from('orders').select('id', { count: 'exact', head: true });
  const items = await admin.from('order_items').select('id', { count: 'exact', head: true });
  if (orders.error) throw orders.error;
  if (items.error) throw items.error;
  return { users: users.data.users.length, orders: orders.count, items: items.count };
}

const browser = { inTelegram: false, rawInitData: null };

beforeAll(async () => {
  if (!env.isLocal) throw new Error(`demo profile tests run only against local Supabase, got ${env.url}`);
  demo = await createTestShop({ isDemo: true, basePrice: 69_000, variants: [{ flavor: 'Черника', stock: 5 }] });
  regular = await createTestShop({ isDemo: false });
});

afterAll(async () => {
  client.current = null;
  await cleanup();
});

describe('demo profile outside Telegram', () => {
  it('builds the mock-up from public data only: no session, no user, no order, no order item', async () => {
    const before = await counts();
    client.current = anon();

    const shop = await fetchShopBySlug(demo.slug);
    expect(shop.isDemo).toBe(true);
    expect(shouldShowDemoProfile(shop, browser)).toBe(true);
    const page = await fetchProductsPage(shop.id, { categoryId: null, search: '' }, 0);
    const order = buildDemoOrder(page.items, shop.currency);
    expect(order.title).toBe('Тестовый заказ');
    expect(order.lines).toEqual([
      expect.objectContaining({ name: 'Liquid', variantLabel: 'Черника', quantity: 2, unitPriceMinor: 69_000, lineTotalMinor: 138_000 }),
    ]);
    expect(order.totalMinor).toBe(138_000);

    // Still anonymous, and nothing was persisted anywhere.
    const { data: session } = await client.current.auth.getSession();
    expect(session.session).toBeNull();
    expect(await counts()).toEqual(before);
    const { count: shopOrders } = await admin.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', demo.id);
    expect(shopOrders).toBe(0);
  });

  it('a regular shop never qualifies for the mock-up', async () => {
    client.current = anon();
    const shop = await fetchShopBySlug(regular.slug);
    expect(shop.isDemo).toBe(false);
    expect(shouldShowDemoProfile(shop, browser)).toBe(false);
  });
});
