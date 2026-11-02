// Complete deletion of DEMO shops (20261102090200, platform-admin actions demo-delete-*). LOCAL ONLY.
// Covers: who may delete (only an aal2 platform admin, on every path), DEMO decided by is_demo (never by mode), the
// strong confirmation, complete removal of the shop's rows / Vault secret / Storage objects under the exact prefix,
// untouched neighbours (other shops' files, look-alike names, client accounts and their other memberships), the
// resumable 'deleting' state (no success while files remain), repeats and races, and the reserved slug.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DARK_PREMIUM_THEME } from '../../../src/domain/theme.ts';
import {
  admin,
  anon,
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
  track,
  type Db,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, PNG, psqlAsync } from './sec-helpers';

const run = randomBytes(3).toString('hex');
const bucket = () => admin.storage.from('shop-media');
const errCode = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;

let pa: PlatformAdmin;
let paAal1: PlatformAdmin;

beforeAll(async () => {
  pa = await createPlatformAdmin();
  paAal1 = await createPlatformAdmin({ mfa: false });
});
afterAll(async () => {
  // Look-alike objects outside any shop prefix are not covered by cleanupSecurity (their "shop" never existed as a row).
  const r = await psqlAsync(`select name from storage.objects where bucket_id = 'shop-media' and name like '%-lookalike-${run}/%';`);
  const names = r.out.split(/\r?\n/).filter(Boolean);
  if (names.length) await bucket().remove(names);
  await cleanupSecurity();
});

async function sql(q: string): Promise<string> {
  const r = await psqlAsync(q);
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}`);
  return r.out;
}

async function plainUser(): Promise<{ client: Db; userId: string }> {
  const email = `plain-${run}-${randomBytes(2).toString('hex')}@it.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  track('user', data.user.id);
  const client = anon();
  const { error: se } = await client.auth.signInWithPassword({ email, password });
  if (se) throw se;
  return { client, userId: data.user.id };
}

async function upload(path: string): Promise<void> {
  const { error } = await bucket().upload(path, PNG, { contentType: 'image/png', upsert: true });
  if (error) throw error;
}

async function objectsUnder(prefix: string): Promise<string[]> {
  const out = await sql(`select name from storage.objects where bucket_id = 'shop-media' and starts_with(name, '${prefix}') order by name;`);
  return out.split(/\r?\n/).filter(Boolean);
}

async function shopRow(id: string) {
  const { data } = await admin.from('shops').select('id, slug, status, is_demo, mode').eq('id', id).maybeSingle();
  return data;
}

const leftovers = async (id: string) => JSON.parse(await sql(`select private.shop_leftover_rows('${id}');`)) as Record<string, number>;
const vaultSecrets = (id: string) => sql(`select count(*) from vault.secrets where name like 'shop_tg_notify:${id}:%';`);
const audit = async (id: string) =>
  JSON.parse(
    (await sql(`select coalesce((select row_to_json(d) from private.shop_deletions d where d.shop_id = '${id}'), 'null'::json);`)) || 'null',
  ) as { slug: string; requested_by: string; requested_at: string; completed_at: string | null; attempts: number; last_error: string | null } | null;

const del = (as: Db | { bearer: string } | null, shopId: string, confirmSlug: string) =>
  callAdminFunction('platform-admin', as, { action: 'demo-delete', shopId, confirmSlug });
const resume = (as: Db, shopId: string) => callAdminFunction('platform-admin', as, { action: 'demo-delete-resume', shopId });
const preview = (as: Db, shopId: string) => callAdminFunction('platform-admin', as, { action: 'demo-delete-preview', shopId });

interface DemoFixture {
  D: TestShop;
  other: TestShop;
  owner: Awaited<ReturnType<typeof createOwner>>;
  manager: Awaited<ReturnType<typeof createMember>>;
  media: string[];
  otherMedia: string;
  lookalike: string;
}

/**
 * A fully populated DEMO shop (mode = live, as DEMO shops usually are): catalog with 2 variants, an image row, media
 * files at several depths + logo, an owner who ALSO owns another shop, a manager, a Telegram channel (Vault secret),
 * an order with its notification. Plus a neighbour shop with its own file and a look-alike object "<id>-lookalike/…".
 */
async function populatedDemo(): Promise<DemoFixture> {
  const D = await createTestShop({ variants: [{ flavor: 'Mint', stock: 9 }, { flavor: 'Cherry', stock: 2 }] });
  const other = await createTestShop();
  const owner = await createOwner(D.id);
  const manager = await createMember(D.id, 'manager');
  // The same client account also owns another shop: it must keep the account and that membership.
  const { error: me } = await admin.from('shop_memberships').insert({ shop_id: other.id, user_id: owner.userId, role: 'owner' });
  if (me) throw me;

  const saved = await callAdminFunction('notification-settings', owner.client, {
    action: 'save', shopId: D.id, botToken: fakeBotToken(), chatId: `@dd_${run}_${randomBytes(2).toString('hex')}`,
  });
  expect(saved.status, saved.text).toBe(200);
  // An order while the shop is still a regular one (DEMO shops take no orders), then it becomes a DEMO again.
  const order = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(D, [{ variantId: D.variants[0]!.id, quantity: 1 }]));
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const { error: de } = await admin.from('shops').update({ is_demo: true }).eq('id', D.id);
  if (de) throw de;

  const media = [
    `${D.id}/logo/${run}.png`,
    `${D.id}/product/${D.productId}/a.png`,
    `${D.id}/product/${D.productId}/deep/b.png`,
  ];
  for (const p of media) await upload(p);
  const { error: ie } = await admin.from('product_images').insert({ shop_id: D.id, product_id: D.productId, storage_path: media[1]! });
  if (ie) throw ie;
  const { error: le } = await admin.from('shops').update({ logo_path: media[0]! }).eq('id', D.id);
  if (le) throw le;
  const otherMedia = `${other.id}/product/${other.productId}/keep.png`;
  await upload(otherMedia);
  const lookalike = `${D.id}-lookalike-${run}/keep.png`;
  await upload(lookalike);
  return { D, other, owner, manager, media, otherMedia, lookalike };
}

describe('who may delete', () => {
  let F: DemoFixture;
  beforeAll(async () => {
    F = await populatedDemo();
  });

  it('nobody but an aal2 platform admin: anonymous, plain user, the shop own owner / manager, aal1 admin — all refused', async () => {
    const plain = await plainUser();
    expect((await del(null, F.D.id, F.D.slug)).status).toBe(401);
    for (const [who, client, code] of [
      ['plain', plain.client, 'forbidden'],
      ['owner', F.owner.client, 'forbidden'],
      ['manager', F.manager.client, 'forbidden'],
      ['aal1 platform admin', paAal1.client, 'mfa_required'],
    ] as const) {
      for (const body of [
        { action: 'demo-delete-preview', shopId: F.D.id },
        { action: 'demo-delete', shopId: F.D.id, confirmSlug: F.D.slug },
        { action: 'demo-delete-resume', shopId: F.D.id },
      ]) {
        const res = await callAdminFunction('platform-admin', client, body);
        expect(res.status, `${who} ${body.action}`).toBe(403);
        expect(errCode(res), `${who} ${body.action}`).toBe(code);
      }
    }
    expect((await shopRow(F.D.id))?.status).toBe('active');
  });

  it('the RPCs cannot be reached directly: PostgREST for users, service role without / with a wrong session', async () => {
    const args = { p_actor: F.owner.userId, p_shop_id: F.D.id, p_confirm_slug: F.D.slug };
    for (const c of [F.owner.client, F.manager.client, pa.client]) {
      const r = await c.rpc('platform_demo_delete_begin', args);
      expect(r.error?.message).toMatch(/permission denied/i);
    }
    // Service role, actor = the aal2 admin, but no forwarded session (a compromised caller cannot skip MFA).
    expect((await admin.rpc('platform_demo_delete_begin', { ...args, p_actor: pa.userId })).error?.message).toBe('mfa_required');
    // The aal2 session of one admin does not authorize another account.
    expect((await pa.svc.rpc('platform_demo_delete_begin', args)).error?.message).toBe('forbidden');
    expect((await paAal1.svc.rpc('platform_demo_delete_begin', { ...args, p_actor: paAal1.userId })).error?.message).toBe('mfa_required');
    expect((await shopRow(F.D.id))?.status).toBe('active');
    expect(await objectsUnder(`${F.D.id}/`)).toHaveLength(3);
  });

  it('a LIVE (non-DEMO) shop cannot be deleted — whatever its mode', async () => {
    for (const mode of ['live', 'preview'] as const) {
      const L = await createTestShop({ mode });
      await upload(`${L.id}/logo/live.png`);
      const res = await del(pa.client, L.id, L.slug);
      expect(res.status, res.text).toBe(409);
      expect(errCode(res)).toBe('not_demo');
      expect((await pa.svc.rpc('platform_demo_delete_begin', { p_actor: pa.userId, p_shop_id: L.id, p_confirm_slug: L.slug })).error?.message).toBe('not_demo');
      expect((await preview(pa.client, L.id)).body?.preview).toMatchObject({ status: 'not_demo' });
      expect(await shopRow(L.id)).toMatchObject({ status: 'active', is_demo: false, mode });
      expect(await objectsUnder(`${L.id}/`)).toEqual([`${L.id}/logo/live.png`]);
    }
  });

  it('the confirmation must be the exact slug', async () => {
    for (const wrong of [F.D.slug.slice(0, -1), `${F.D.slug}x`, F.D.slug.toUpperCase(), 'yes']) {
      const res = await del(pa.client, F.D.id, wrong);
      expect(res.status, wrong).toBe(400);
      expect(errCode(res)).toBe('confirmation_mismatch');
    }
    expect((await shopRow(F.D.id))?.status).toBe('active');
    expect(await audit(F.D.id)).toBeNull();
  });
});

describe('preview', () => {
  it('shows name, slug, counts, media files and the owner (with has_owner)', async () => {
    const F = await populatedDemo();
    const res = await preview(pa.client, F.D.id);
    expect(res.status, res.text).toBe(200);
    const p = res.body!.preview as Record<string, unknown>;
    expect(p).toMatchObject({
      status: 'ready',
      shop: { id: F.D.id, slug: F.D.slug, name: `IT ${F.D.slug}`, is_demo: true, mode: 'live' },
      counts: { products: 1, categories: 1, variants: 2, images: 1, media_files: 3, orders: 1, members: 2 },
      has_owner: true,
      notifications: true,
    });
    expect((p.members as Array<{ user_id: string; role: string }>).map((m) => [m.user_id, m.role]).sort()).toEqual(
      [[F.owner.userId, 'owner'], [F.manager.userId, 'manager']].sort(),
    );
    // Preview changes nothing.
    expect((await shopRow(F.D.id))?.status).toBe('active');
  });
});

describe('complete deletion', () => {
  let F: DemoFixture;
  let res: Awaited<ReturnType<typeof del>>;
  beforeAll(async () => {
    F = await populatedDemo();
    expect(await vaultSecrets(F.D.id)).not.toBe('0');
    res = await del(pa.client, F.D.id, F.D.slug);
  });

  it('reports success only once everything is gone', async () => {
    expect(res.status, res.text).toBe(200);
    expect(res.body?.deletion).toMatchObject({ status: 'deleted' });
    expect(res.body?.storage).toEqual({ removed: 3, error: null });
  });

  it('no row of the shop is left in any table, the Vault secret and every object under the prefix are gone', async () => {
    expect(await shopRow(F.D.id)).toBeNull();
    expect(await leftovers(F.D.id)).toEqual({});
    expect(await vaultSecrets(F.D.id)).toBe('0');
    expect(await objectsUnder(`${F.D.id}/`)).toEqual([]);
    expect(await sql(`select count(*) from private.order_notifications where shop_id = '${F.D.id}';`)).toBe('0');
  });

  it("neighbours are untouched: another shop's file, a look-alike name, the other shop itself", async () => {
    expect(await objectsUnder(F.otherMedia)).toEqual([F.otherMedia]);
    expect(await objectsUnder(F.lookalike)).toEqual([F.lookalike]);
    expect((await shopRow(F.other.id))?.status).toBe('active');
  });

  it('client accounts stay; only the memberships of the deleted shop are gone', async () => {
    for (const id of [F.owner.userId, F.manager.userId]) {
      const { data, error } = await admin.auth.admin.getUserById(id);
      expect(error).toBeNull();
      expect(data.user?.id).toBe(id);
    }
    const { data: m } = await admin.from('shop_memberships').select('shop_id, role').eq('user_id', F.owner.userId);
    expect(m).toEqual([{ shop_id: F.other.id, role: 'owner' }]);
    const { data: mm } = await admin.from('shop_memberships').select('shop_id').eq('user_id', F.manager.userId);
    expect(mm).toEqual([]);
    // The former owner still runs the other shop.
    expect((await F.owner.client.rpc('is_shop_member', { p_shop_id: F.other.id })).data).toBe(true);
  });

  it('a minimal audit row stays: slug, initiator, time', async () => {
    const a = await audit(F.D.id);
    expect(a).toMatchObject({ slug: F.D.slug, requested_by: pa.userId, last_error: null });
    expect(a!.completed_at).not.toBeNull();
    expect(Date.parse(a!.requested_at)).toBeLessThanOrEqual(Date.parse(a!.completed_at!));
  });

  it('the old link shows "not found" and the slug can never be given to another shop', async () => {
    expect((await anon().from('shops').select('id').eq('slug', F.D.slug)).data).toEqual([]);
    const inserted = await admin.from('shops').insert({ slug: F.D.slug, name: 'Squatter', currency: 'RUB', theme_config: DARK_PREMIUM_THEME }).select('id');
    expect(inserted.error?.message).toBe('slug_taken');
    const renamed = await admin.from('shops').update({ slug: F.D.slug }).eq('id', F.other.id).select('id');
    expect(renamed.error?.message).toBe('slug_taken');
    const template = await createTestShop({ isDemo: true });
    const created = await callAdminFunction('platform-admin', pa.client, { action: 'create-demo', templateId: template.id, slug: F.D.slug, name: 'Again' });
    expect(created.status, created.text).toBe(409);
    expect(errCode(created)).toBe('slug_taken');
  });

  it('repeating the deletion (or resuming it) is harmless and reports it as deleted', async () => {
    const again = await del(pa.client, F.D.id, F.D.slug);
    expect(again.status, again.text).toBe(200);
    expect(again.body?.deletion).toMatchObject({ status: 'deleted' });
    const resumed = await resume(pa.client, F.D.id);
    expect(resumed.status, resumed.text).toBe(200);
    expect(resumed.body?.deletion).toMatchObject({ status: 'deleted' });
    expect(await objectsUnder(F.otherMedia)).toEqual([F.otherMedia]);
  });
});

describe('interrupted deletion (Storage not cleaned yet) is resumable and never reported as done', () => {
  it("'deleting': shop already unreachable; finalize stays pending while files remain; resume completes it", async () => {
    const F = await populatedDemo();
    // Step 1 only (as if the Edge Function died right after the SQL transaction).
    const begun = await pa.svc.rpc('platform_demo_delete_begin', { p_actor: pa.userId, p_shop_id: F.D.id, p_confirm_slug: F.D.slug });
    expect(begun.error).toBeNull();
    expect(begun.data).toMatchObject({ status: 'pending' });

    // Immediately unreachable: storefront, members, Storage writes; no order can be placed.
    expect(await shopRow(F.D.id)).toMatchObject({ status: 'deleting' });
    expect((await anon().from('shops').select('id').eq('slug', F.D.slug)).data).toEqual([]);
    expect((await anon().from('products').select('id').eq('shop_id', F.D.id)).data).toEqual([]);
    expect((await F.owner.client.rpc('is_shop_member', { p_shop_id: F.D.id })).data).toBe(false);
    expect((await pa.client.rpc('is_shop_member', { p_shop_id: F.D.id })).data).toBe(false);
    const up = await F.owner.client.storage.from('shop-media').upload(`${F.D.id}/logo/late.png`, PNG, { contentType: 'image/png' });
    expect(up.error).not.toBeNull();
    const order = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(F.D, [{ variantId: F.D.variants[0]!.id, quantity: 1 }]));
    expect(order.status).toBeGreaterThanOrEqual(400);
    // Data already gone (only the blocked shops row itself remains), files not yet.
    expect(await leftovers(F.D.id)).toEqual({});
    expect(await objectsUnder(`${F.D.id}/`)).toHaveLength(3);
    // 'deleting' is terminal and nobody can be added meanwhile.
    expect((await admin.from('shops').update({ status: 'active' }).eq('id', F.D.id).select('id')).error?.message).toBe('shop_deleting');
    expect((await admin.from('shop_memberships').insert({ shop_id: F.D.id, user_id: F.owner.userId, role: 'owner' })).error?.message).toBe('shop_deleting');

    // Finalize while files remain: pending, attempt + error recorded, NOT deleted.
    const early = await pa.svc.rpc('platform_demo_delete_finalize', { p_actor: pa.userId, p_shop_id: F.D.id, p_error: 'remove_failed: simulated' });
    expect(early.error).toBeNull();
    expect(early.data).toMatchObject({ status: 'pending', remaining: 3 });
    expect(await audit(F.D.id)).toMatchObject({ completed_at: null, attempts: 1, last_error: 'remove_failed: simulated' });
    // The panel keeps listing it as "deleting", with the error.
    const list = await callAdminFunction('platform-admin', pa.client, { action: 'list' });
    const row = (list.body!.shops as Array<{ id: string; status: string; deletion: { last_error: string } | null }>).find((s) => s.id === F.D.id);
    expect(row).toMatchObject({ status: 'deleting', deletion: { last_error: 'remove_failed: simulated' } });
    // "Продолжить удаление": removes the remaining files and completes.
    const resumed = await resume(pa.client, F.D.id);
    expect(resumed.status, resumed.text).toBe(200);
    expect(resumed.body?.deletion).toMatchObject({ status: 'deleted' });
    expect(resumed.body?.storage).toEqual({ removed: 3, error: null });
    // A later demo-delete of the same shop starts nothing new.
    const repeated = await del(pa.client, F.D.id, F.D.slug);
    expect(repeated.status, repeated.text).toBe(200);
    expect(repeated.body?.deletion).toMatchObject({ status: 'deleted' });
    expect(await shopRow(F.D.id)).toBeNull();
    expect(await objectsUnder(`${F.D.id}/`)).toEqual([]);
    expect(await leftovers(F.D.id)).toEqual({});
    expect(await objectsUnder(F.otherMedia)).toEqual([F.otherMedia]);
    expect(await audit(F.D.id)).toMatchObject({ last_error: null });
  });

  it('two parallel deletions of the same shop end in one consistent deleted state', async () => {
    const F = await populatedDemo();
    const [a, b] = await Promise.all([del(pa.client, F.D.id, F.D.slug), del(pa.client, F.D.id, F.D.slug)]);
    for (const r of [a, b]) expect([200, 202], r.text).toContain(r.status);
    if (a.status !== 200 || b.status !== 200) expect((await resume(pa.client, F.D.id)).status).toBe(200);
    expect(await shopRow(F.D.id)).toBeNull();
    expect(await leftovers(F.D.id)).toEqual({});
    expect(await objectsUnder(`${F.D.id}/`)).toEqual([]);
    expect(await sql(`select count(*) from private.shop_deletions where shop_id = '${F.D.id}' and completed_at is not null;`)).toBe('1');
  });
});
