import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  cleanup,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  env,
  initDataFor,
  newTelegramUserId,
  type Db,
  type TestShop,
} from './helpers';

// "Мои магазины" (membership, RLS) vs "Все магазины платформы" (platform admins only, server-checked), and the
// shop hand-over. Platform admin rights come only from public.platform_admins, written with the service role.

type PlatformShop = { id: string; slug: string; members: Array<{ user_id: string; email: string; role: string }>; last_transfer_at: string | null };

let S: TestShop;
let T: TestShop;
let platform: { client: Db; userId: string; email: string };
let ownerS: { client: Db; userId: string; email: string };
let client: { client: Db; userId: string; email: string };
let orderId: string;

/** Exactly what the "Мои магазины" page queries (RLS: own memberships only). */
async function myShopSlugs(db: Db): Promise<string[]> {
  const { data: u } = await db.auth.getUser();
  const { data, error } = await db.from('shop_memberships').select('role, shops(slug)').eq('user_id', u.user!.id);
  if (error) throw error;
  return (data as unknown as Array<{ shops: { slug: string } | null }>).map((r) => r.shops!.slug).sort();
}

async function catalogSnapshot(shopId: string) {
  const count = async (table: 'products' | 'product_variants' | 'product_images' | 'orders' | 'order_items' | 'categories') => {
    const { count: c, error } = await admin.from(table).select('id', { count: 'exact', head: true }).eq('shop_id', shopId);
    if (error) throw error;
    return c;
  };
  const { data: v } = await admin.from('product_variants').select('id, stock_quantity').eq('shop_id', shopId).order('id');
  return {
    products: await count('products'),
    variants: await count('product_variants'),
    images: await count('product_images'),
    categories: await count('categories'),
    orders: await count('orders'),
    items: await count('order_items'),
    stock: v,
  };
}

beforeAll(async () => {
  S = await createTestShop({ variants: [{ flavor: 'Mint', stock: 9 }] });
  T = await createTestShop();
  platform = await createPlatformAdmin();
  ownerS = await createOwner(S.id);
  client = await createOwner(T.id);
  await admin.from('product_images').insert({ shop_id: S.id, product_id: S.productId, storage_path: `${S.id}/products/x.webp`, is_primary: true });
  const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: 2 }]));
  expect(res.status).toBe(201);
  orderId = (res.body!.order as { id: string }).id;
});

afterAll(cleanup);

describe('platform list', () => {
  it('a platform admin sees every shop with its owners, including freshly created ones', async () => {
    const res = await callAdminFunction('platform-admin', platform.client, { action: 'list' });
    expect(res.status).toBe(200);
    const shops = res.body!.shops as PlatformShop[];
    const s = shops.find((x) => x.slug === S.slug)!;
    expect(s.members).toEqual([expect.objectContaining({ email: ownerS.email, role: 'owner' })]);
    expect(shops.find((x) => x.slug === T.slug)!.members).toEqual([expect.objectContaining({ email: client.email, role: 'owner' })]);
    // Demo tenants are part of the platform list too.
    const { count } = await admin.from('shops').select('id', { count: 'exact', head: true });
    expect(shops.length).toBe(count);
  });

  it('owners, anon and forged bodies are refused; the browser cannot grant itself the role', async () => {
    for (const action of [{ action: 'list' }, { action: 'find-user', email: client.email }, { action: 'transfer', shopId: S.id, userId: ownerS.userId }]) {
      const res = await callAdminFunction('platform-admin', ownerS.client, { ...action, p_actor: platform.userId, actor: platform.userId, isPlatformAdmin: true });
      expect(res.status, action.action).toBe(403);
    }
    expect((await callAdminFunction('platform-admin', null, { action: 'list' })).status).toBe(401);
    expect((await callAdminFunction('platform-admin', { bearer: env.anonKey }, { action: 'list' })).status).toBe(401);

    // Direct RPC with a forged actor id: not executable by client roles at all.
    for (const db of [anon(), ownerS.client]) {
      expect((await db.rpc('platform_list_shops' as never, { p_actor: platform.userId } as never)).error?.message).toMatch(/permission denied/i);
      expect(
        (await db.rpc('platform_transfer_shop' as never, { p_actor: platform.userId, p_shop_id: S.id, p_new_owner: ownerS.userId } as never)).error
          ?.message,
      ).toMatch(/permission denied/i);
    }
    // No write path to platform_admins for authenticated users.
    const ins = await ownerS.client.from('platform_admins').insert({ user_id: ownerS.userId });
    expect(ins.error).not.toBeNull();
    // Self-edited user metadata (what a browser CAN change) grants nothing.
    await ownerS.client.auth.updateUser({ data: { role: 'platform_admin', is_platform_admin: true } });
    await ownerS.client.auth.refreshSession();
    expect((await callAdminFunction('platform-admin', ownerS.client, { action: 'list' })).status).toBe(403);
    expect((await admin.from('platform_admins').select('user_id').eq('user_id', ownerS.userId)).data).toEqual([]);
  });

  it('"Мои магазины" lists only own memberships, also for the platform admin', async () => {
    expect(await myShopSlugs(ownerS.client)).toEqual([S.slug]);
    expect(await myShopSlugs(client.client)).toEqual([T.slug]);
    expect(await myShopSlugs(platform.client)).toEqual([]);
  });
});

describe('shop hand-over', () => {
  it('find-user looks up existing accounts only (case-insensitive)', async () => {
    const found = await callAdminFunction('platform-admin', platform.client, { action: 'find-user', email: client.email.toUpperCase() });
    expect(found.body!.user).toMatchObject({ user_id: client.userId, email: client.email, is_platform_admin: false, shops: [{ slug: T.slug, role: 'owner' }] });
    const none = await callAdminFunction('platform-admin', platform.client, { action: 'find-user', email: 'nobody-here@it.local' });
    expect(none.status).toBe(200);
    expect(none.body!.user).toBeNull();
  });

  it('transfers S to the client: verified single owner, previous owner loses access, data untouched, platform keeps it', async () => {
    const before = await catalogSnapshot(S.id);
    const res = await callAdminFunction('platform-admin', platform.client, { action: 'transfer', shopId: S.id, userId: client.userId });
    expect(res.status).toBe(200);
    expect(res.body!.transfer).toMatchObject({
      shop: { slug: S.slug },
      owner: { user_id: client.userId, email: client.email },
      removed: [{ user_id: ownerS.userId, email: ownerS.email, role: 'owner' }],
      members: [expect.objectContaining({ user_id: client.userId, role: 'owner' })],
    });

    // Nothing of the shop's content changed.
    expect(await catalogSnapshot(S.id)).toEqual(before);
    expect(before).toMatchObject({ products: 1, variants: 1, images: 1, orders: 1, items: 1 });

    // Previous owner: gone from "Мои магазины" and from every RLS-protected path.
    expect(await myShopSlugs(ownerS.client)).toEqual([]);
    expect((await ownerS.client.rpc('is_shop_member', { p_shop_id: S.id })).data).toBe(false);
    expect((await ownerS.client.from('orders').select('id').eq('id', orderId)).data).toEqual([]);
    expect((await ownerS.client.from('products').update({ name: 'hijack' }).eq('id', S.productId).select('id')).data).toEqual([]);
    expect((await callAdminFunction('notification-settings', ownerS.client, { action: 'get', shopId: S.id })).status).toBe(403);

    // New owner: both shops, full access.
    expect(await myShopSlugs(client.client)).toEqual([S.slug, T.slug].sort());
    expect((await client.client.from('orders').select('id').eq('id', orderId)).data).toEqual([{ id: orderId }]);
    expect((await client.client.from('products').update({ name: 'Liquid v2' }).eq('id', S.productId).select('name')).data).toEqual([{ name: 'Liquid v2' }]);
    expect((await callAdminFunction('notification-settings', client.client, { action: 'get', shopId: S.id })).status).toBe(200);

    // Platform list still shows it, with the new owner and the transfer date.
    const list = (await callAdminFunction('platform-admin', platform.client, { action: 'list' })).body!.shops as PlatformShop[];
    const s = list.find((x) => x.slug === S.slug)!;
    expect(s.members.map((m) => m.email)).toEqual([client.email]);
    expect(s.last_transfer_at).not.toBeNull();
    // The platform admin can still open its admin panel (is_shop_member covers platform admins).
    expect((await platform.client.rpc('is_shop_member', { p_shop_id: S.id })).data).toBe(true);
  });

  it('rejects unknown users and shops without changing memberships', async () => {
    const before = (await admin.from('shop_memberships').select('user_id, role').eq('shop_id', S.id)).data;
    const bad = await callAdminFunction('platform-admin', platform.client, { action: 'transfer', shopId: S.id, userId: '00000000-0000-4000-8000-000000000000' });
    expect(bad.status).toBe(404);
    expect(bad.body!.error).toMatchObject({ code: 'user_not_found' });
    const noShop = await callAdminFunction('platform-admin', platform.client, { action: 'transfer', shopId: '00000000-0000-4000-8000-000000000001', userId: client.userId });
    expect(noShop.body!.error).toMatchObject({ code: 'shop_not_found' });
    expect((await admin.from('shop_memberships').select('user_id, role').eq('shop_id', S.id)).data).toEqual(before);
  });
});
