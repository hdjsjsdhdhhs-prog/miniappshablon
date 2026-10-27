import { randomBytes } from 'node:crypto';
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
  stockOf,
  track,
  type Db,
  type TestShop,
} from './helpers';

// DEMO lifecycle through the platform-admin Edge Function against the LOCAL stack only:
// create DEMO from a template (own shop_id, cloned catalog + media, unique slug) → DEMO never stores orders →
// "Передать клиенту" (invite, single owner, is_demo=false + mode=live, same slug, journal) → real orders work.

const BUCKET = 'shop-media';
const REDIRECT = 'http://127.0.0.1:5173/admin/set-password';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

type Created = { shop: { id: string; slug: string; name: string; mode: string; is_demo: boolean }; media: { copied: number; missing: number } };

let template: TestShop;
let platform: { client: Db; userId: string; email: string };
let owner: { client: Db; userId: string; email: string };
const run = randomBytes(3).toString('hex');
const slugA = `it-demo-a-${run}`;
const slugB = `it-demo-b-${run}`;

async function createDemo(as: Db | null, body: Record<string, unknown>) {
  const res = await callAdminFunction('platform-admin', as, { action: 'create-demo', ...body });
  const created = res.body as Created | null;
  if (res.status === 201 && created?.shop?.id) track('shop', created.shop.id);
  return { ...res, created };
}

async function shopsCount(): Promise<number> {
  const { count, error } = await admin.from('shops').select('id', { count: 'exact', head: true });
  if (error) throw error;
  return count ?? 0;
}

async function mailFor(email: string): Promise<number | null> {
  // Local Mailpit (supabase/config.toml [local_smtp]); null when its API is not reachable.
  try {
    const res = await fetch(`http://127.0.0.1:54324/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    if (!res.ok) return null;
    return ((await res.json()) as { messages_count?: number }).messages_count ?? 0;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  template = await createTestShop({ isDemo: true, variants: [{ flavor: 'Mint', stock: 7 }, { flavor: 'Cherry', stock: 3 }] });
  platform = await createPlatformAdmin();
  owner = await createOwner(template.id);
  // Template media: one real object, one row pointing at a missing object.
  const logo = `${template.id}/logo/${run}.png`;
  const photo = `${template.id}/products/${run}.png`;
  for (const path of [logo, photo]) {
    const { error } = await admin.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png', upsert: true });
    if (error) throw error;
  }
  const upd = await admin.from('shops').update({ logo_path: logo, pickup_instructions: 'ул. Шаблонная, 1' }).eq('id', template.id);
  if (upd.error) throw upd.error;
  const imgs = await admin.from('product_images').insert([
    { shop_id: template.id, product_id: template.productId, storage_path: photo, is_primary: true, sort_order: 0 },
    { shop_id: template.id, product_id: template.productId, storage_path: `${template.id}/products/missing-${run}.png`, is_primary: false, sort_order: 1 },
  ]);
  if (imgs.error) throw imgs.error;
});

afterAll(cleanup);

describe('create DEMO shop', () => {
  it('only a platform admin can create; anon, owners and forged actors are refused', async () => {
    const before = await shopsCount();
    expect((await createDemo(null, { templateId: template.id, slug: slugA, name: 'X' })).status).toBe(401);
    expect((await createDemo(owner.client, { templateId: template.id, slug: slugA, name: 'X', p_actor: platform.userId })).status).toBe(403);
    for (const db of [anon(), owner.client]) {
      const rpc = await db.rpc('platform_create_demo_shop' as never, { p_actor: platform.userId, p_template_id: template.id, p_slug: slugA, p_name: 'X' } as never);
      expect(rpc.error?.message).toMatch(/permission denied/i);
    }
    expect(await shopsCount()).toBe(before);
  });

  it('creates a separate live DEMO tenant (own shop_id) with the cloned catalog, stock and media', async () => {
    const res = await createDemo(platform.client, { templateId: template.id, slug: slugA, name: 'Демо A' });
    expect(res.status, res.text).toBe(201);
    const shop = res.created!.shop;
    expect(shop).toMatchObject({ slug: slugA, name: 'Демо A', mode: 'live', is_demo: true });
    expect(shop.id).not.toBe(template.id);
    expect(res.created!.media).toEqual({ copied: 2, missing: 1 });

    const { data: row } = await admin.from('shops').select('*').eq('id', shop.id).single();
    expect(row).toMatchObject({ status: 'active', mode: 'live', is_demo: true, currency: 'RUB', pickup_instructions: 'ул. Шаблонная, 1' });
    expect(row!.logo_path).toBe(`${shop.id}/logo/${run}.png`);
    expect(row!.published_at).not.toBeNull();

    const { data: variants } = await admin.from('product_variants').select('id, flavor, stock_quantity, shop_id').eq('shop_id', shop.id).order('flavor');
    expect(variants!.map((v) => [v.flavor, v.stock_quantity])).toEqual([['Cherry', 3], ['Mint', 7]]);
    expect(variants!.every((v) => !template.variants.some((t) => t.id === v.id))).toBe(true);
    const { data: images } = await admin.from('product_images').select('storage_path').eq('shop_id', shop.id);
    expect(images!.length).toBe(2);
    expect(images!.every((i) => i.storage_path.startsWith(`${shop.id}/`))).toBe(true);
    const { data: movements } = await admin.from('inventory_movements').select('delta').eq('shop_id', shop.id).eq('reason', 'seed');
    expect(movements!.map((m) => m.delta).sort()).toEqual([3, 7]);

    // The copied object is publicly reachable under the new shop id; the template keeps its own.
    const copied = await fetch(`${env.url}/storage/v1/object/public/${BUCKET}/${shop.id}/products/${run}.png`);
    expect(copied.status).toBe(200);
    expect((await admin.storage.from(BUCKET).list(`${template.id}/products`)).data!.some((o) => o.name === `${run}.png`)).toBe(true);

    // Public storefront access works for anon without any build (same SPA, /s/<slug>/).
    const pub = await anon().from('shops').select('id, slug, is_demo').eq('slug', slugA).maybeSingle();
    expect(pub.data).toEqual({ id: shop.id, slug: slugA, is_demo: true });
    expect((await anon().from('products').select('id').eq('shop_id', shop.id)).data).toHaveLength(1);

    // The template is untouched.
    expect(await stockOf(template.variants[0]!.id)).toBe(7);
    const { data: tpl } = await admin.from('shops').select('slug, is_demo, mode').eq('id', template.id).single();
    expect(tpl).toEqual({ slug: template.slug, is_demo: true, mode: 'live' });
  });

  it('several DEMO shops coexist; a taken slug is blocked and nothing is created', async () => {
    const b = await createDemo(platform.client, { templateId: template.id, slug: slugB, name: 'Демо B' });
    expect(b.status, b.text).toBe(201);
    const before = await shopsCount();
    for (const slug of [slugA, slugB, template.slug, slugA.toUpperCase()]) {
      const dup = await createDemo(platform.client, { templateId: template.id, slug, name: 'Дубль' });
      expect(dup.status, slug).toBe(409);
      expect(dup.body!.error).toMatchObject({ code: 'slug_taken' });
    }
    // Concurrent creation with one slug: exactly one wins.
    const race = `it-race-${run}`;
    const results = await Promise.all([1, 2, 3].map(() => createDemo(platform.client, { templateId: template.id, slug: race, name: 'Race' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await shopsCount()).toBe(before + 1);
    const { data: ids } = await admin.from('shops').select('id').in('slug', [slugA, slugB, race]);
    expect(new Set(ids!.map((r) => r.id)).size).toBe(3);
  });

  it('validates slug, name and template (a non-DEMO shop is never a template)', async () => {
    for (const slug of ['ab', '-bad', 'bad-', 'a_b', 'x'.repeat(41)]) {
      expect((await createDemo(platform.client, { templateId: template.id, slug, name: 'X' })).status, slug).toBe(400);
    }
    expect((await createDemo(platform.client, { templateId: template.id, slug: `it-ok-${run}`, name: '   ' })).status).toBe(400);
    const regular = await createTestShop();
    const r = await createDemo(platform.client, { templateId: regular.id, slug: `it-ok-${run}`, name: 'X' });
    expect(r.status).toBe(404);
    expect(r.body!.error).toMatchObject({ code: 'template_not_found' });
  });

  it('a DEMO shop never stores an order, even with valid Telegram initData', async () => {
    const { data: shop } = await admin.from('shops').select('id').eq('slug', slugA).single();
    const { data: v } = await admin.from('product_variants').select('id, stock_quantity').eq('shop_id', shop!.id).limit(1).single();
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), {
      ...checkoutBody({ ...template, slug: slugA }, [{ variantId: v!.id, quantity: 1 }]),
    });
    expect(res.status).toBe(403);
    expect((res.body!.error as { code: string }).code).toBe('shop_demo');
    expect((await admin.from('orders').select('id').eq('shop_id', shop!.id)).data).toEqual([]);
    expect(await stockOf(v!.id)).toBe(v!.stock_quantity);
  });
});

describe('hand over to a paying client', () => {
  const clientEmail = `it-client-${run}@it.local`;
  let shopId: string;
  let clientId: string;

  beforeAll(async () => {
    shopId = (await admin.from('shops').select('id').eq('slug', slugA).single()).data!.id;
  });

  it('readiness is checked first: no fulfillment method → refused before any account is created', async () => {
    await admin.from('shops').update({ delivery_enabled: false, pickup_enabled: false }).eq('id', shopId);
    const check = await callAdminFunction('platform-admin', platform.client, { action: 'handover-check', shopId });
    expect(check.body!.check).toMatchObject({ ready: false, problems: ['no_fulfillment'] });
    const res = await callAdminFunction('platform-admin', platform.client, { action: 'handover', shopId, email: clientEmail, redirectTo: REDIRECT });
    expect(res.status).toBe(409);
    expect(res.body!.error).toMatchObject({ code: 'shop_not_ready', details: ['no_fulfillment'] });
    const users = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(users.data.users.some((u) => u.email === clientEmail)).toBe(false);
    await admin.from('shops').update({ delivery_enabled: true, pickup_enabled: true }).eq('id', shopId);
  });

  it('refuses non-admins, foreign redirect targets and platform-admin accounts as owners', async () => {
    expect((await callAdminFunction('platform-admin', owner.client, { action: 'handover', shopId, email: clientEmail, redirectTo: REDIRECT })).status).toBe(403);
    expect((await callAdminFunction('platform-admin', null, { action: 'handover', shopId, email: clientEmail, redirectTo: REDIRECT })).status).toBe(401);
    for (const redirectTo of ['https://evil.example/admin/set-password/../x', 'https://evil.example/steal', 'javascript:alert(1)']) {
      expect((await callAdminFunction('platform-admin', platform.client, { action: 'handover', shopId, email: clientEmail, redirectTo })).status, redirectTo).toBe(400);
    }
    const self = await callAdminFunction('platform-admin', platform.client, { action: 'handover', shopId, email: platform.email, redirectTo: REDIRECT });
    expect(self.status).toBe(409);
    expect(self.body!.error).toMatchObject({ code: 'owner_is_platform_admin' });
    const rpc = await owner.client.rpc('platform_handover_shop' as never, { p_actor: platform.userId, p_shop_id: shopId, p_new_owner: owner.userId, p_invitation: 'existing' } as never);
    expect(rpc.error?.message).toMatch(/permission denied/i);
    const { data } = await admin.from('shops').select('is_demo, mode').eq('id', shopId).single();
    expect(data).toEqual({ is_demo: true, mode: 'live' });
  });

  it('invites a new client, makes them the only owner and turns the shop into a regular live one with the same slug', async () => {
    const mailsBefore = await mailFor(clientEmail);
    const res = await callAdminFunction('platform-admin', platform.client, { action: 'handover', shopId, email: clientEmail.toUpperCase(), redirectTo: REDIRECT });
    expect(res.status, res.text).toBe(200);
    const body = res.body as { handover: { owner: { user_id: string; email: string }; shop: { slug: string; is_demo: boolean; mode: string } }; invitation: { status: string; link: string | null } };
    clientId = body.handover.owner.user_id;
    track('user', clientId);
    expect(body.handover.owner.email).toBe(clientEmail);
    expect(body.handover.shop).toMatchObject({ slug: slugA, is_demo: false, mode: 'live' });
    expect(['sent', 'link']).toContain(body.invitation.status);
    if (body.invitation.status === 'sent') {
      expect(body.invitation.link).toBeNull();
      const after = await mailFor(clientEmail);
      if (after !== null && mailsBefore !== null) expect(after).toBeGreaterThan(mailsBefore);
    }
    // The response never leaks the service role key.
    expect(res.text).not.toContain(env.serviceRoleKey);

    const { data: u } = await admin.auth.admin.getUserById(clientId);
    expect(u.user!.invited_at).toBeTruthy();
    expect((await admin.from('shop_memberships').select('user_id, role').eq('shop_id', shopId)).data).toEqual([{ user_id: clientId, role: 'owner' }]);
    expect((await admin.from('platform_admins').select('user_id').eq('user_id', clientId)).data).toEqual([]);
    const { data: shop } = await admin.from('shops').select('slug, is_demo, mode, status').eq('id', shopId).single();
    expect(shop).toEqual({ slug: slugA, is_demo: false, mode: 'live', status: 'active' });

    // Journal: hand-over transfer row is visible in the platform list.
    const list = (await callAdminFunction('platform-admin', platform.client, { action: 'list' })).body!.shops as Array<{ id: string; last_handover_at: string | null }>;
    expect(list.find((s) => s.id === shopId)!.last_handover_at).not.toBeNull();
  });

  it('the client sets a password, sees only this shop, gets no platform rights; real orders now work', async () => {
    const password = randomBytes(12).toString('base64url');
    await admin.auth.admin.updateUserById(clientId, { password, email_confirm: true });
    const db = anon();
    expect((await db.auth.signInWithPassword({ email: clientEmail, password })).error).toBeNull();
    const { data: mine } = await db.from('shop_memberships').select('shop_id, role').eq('user_id', clientId);
    expect(mine).toEqual([{ shop_id: shopId, role: 'owner' }]);
    expect((await callAdminFunction('platform-admin', db, { action: 'list' })).status).toBe(403);
    expect((await db.rpc('is_shop_member', { p_shop_id: template.id })).data).toBe(false);
    expect((await db.from('products').update({ name: 'hijack' }).eq('shop_id', template.id).select('id')).data).toEqual([]);
    // The owner can not flip the shop back to DEMO or unpublish it.
    expect((await db.from('shops').update({ is_demo: true }).eq('id', shopId).select('id')).error?.message).toMatch(/permission denied/i);

    const { data: v } = await admin.from('product_variants').select('id, stock_quantity').eq('shop_id', shopId).eq('flavor', 'Mint').single();
    const order = await callFunction('checkout', await initDataFor(newTelegramUserId()), {
      ...checkoutBody({ ...template, slug: slugA }, [{ variantId: v!.id, quantity: 2 }]),
      fulfillment: { method: 'delivery', address: 'пр. Мира, 10' },
    });
    expect(order.status, JSON.stringify(order.body)).toBe(201);
    expect(await stockOf(v!.id)).toBe(v!.stock_quantity - 2);
    const { data: seen } = await db.from('orders').select('fulfillment_method, delivery_address, is_test').eq('shop_id', shopId);
    expect(seen).toEqual([{ fulfillment_method: 'delivery', delivery_address: 'пр. Мира, 10', is_test: false }]);
  });

  it('a second hand-over of the same shop is refused (already a real shop)', async () => {
    const res = await callAdminFunction('platform-admin', platform.client, { action: 'handover', shopId, email: `x-${run}@it.local`, redirectTo: REDIRECT });
    expect(res.status).toBe(409);
    expect(res.body!.error).toMatchObject({ code: 'shop_not_ready', details: ['not_demo'] });
    expect((await admin.from('shop_memberships').select('user_id').eq('shop_id', shopId)).data).toEqual([{ user_id: clientId }]);
  });

  it('an existing, active account is linked without a new invitation', async () => {
    const shopB = (await admin.from('shops').select('id').eq('slug', slugB).single()).data!.id;
    const res = await callAdminFunction('platform-admin', platform.client, { action: 'handover', shopId: shopB, email: owner.email, redirectTo: REDIRECT });
    expect(res.status, res.text).toBe(200);
    expect(res.body!.invitation).toEqual({ status: 'existing', link: null });
    // The client now owns both its shops; the original membership elsewhere is untouched.
    const { data } = await admin.from('shop_memberships').select('shop_id').eq('user_id', owner.userId).order('shop_id');
    expect(data!.map((r) => r.shop_id).sort()).toEqual([template.id, shopB].sort());
  });
});
