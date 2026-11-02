// Mandatory MFA for platform admins (20261102090000) and separation of admin / client accounts. LOCAL ONLY.
// Every path is exercised: the Edge Functions, every service-role RPC that takes an actor, PostgREST + RLS, the
// admin_* RPCs and Storage. The MFA flow is the real one of the local Supabase Auth (TOTP enroll → challenge → verify).
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../src/lib/database.types.ts';
import { resetPlatformAdminMfa } from '../../../scripts/lib/mfa-reset.ts';
import { totp } from '../../../scripts/lib/totp.ts';
import {
  admin,
  anon,
  callAdminFunction,
  createMember,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  enrollAndVerifyTotp,
  env,
  serviceAs,
  sessionClaims,
  track,
  type Db,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, PNG, psqlAsync } from './sec-helpers';

const Z = '00000000-0000-4000-8000-000000000000';
const run = randomBytes(3).toString('hex');
const REDIRECT = 'http://127.0.0.1:5173/admin/set-password';

type RpcResult = { data: unknown; error: { message: string } | null };
const rpc = (db: Db, fn: string, args: Record<string, unknown>) => db.rpc(fn as never, args as never) as unknown as Promise<RpcResult>;

/** Every service-role RPC that takes an actor, with arguments that are valid up to the rights check. */
function actorCalls(actor: string, shopId: string): Array<[string, Record<string, unknown>]> {
  return [
    ['platform_list_shops', { p_actor: actor }],
    ['platform_find_user', { p_actor: actor, p_email: `nobody-${run}@it.local` }],
    ['platform_transfer_shop', { p_actor: actor, p_shop_id: shopId, p_new_owner: Z }],
    ['platform_create_demo_shop', { p_actor: actor, p_template_id: shopId, p_slug: `mfa-${run}`, p_name: 'X' }],
    ['platform_publish_demo_shop', { p_actor: actor, p_shop_id: shopId }],
    ['platform_discard_demo_shop', { p_actor: actor, p_shop_id: shopId }],
    ['platform_handover_check', { p_actor: actor, p_shop_id: shopId }],
    ['platform_cancel_handover', { p_actor: actor, p_shop_id: shopId }],
    ['platform_reserve_handover', { p_actor: actor, p_shop_id: shopId, p_email: `nobody-${run}@it.local` }],
    ['platform_release_handover', { p_actor: actor, p_shop_id: shopId, p_token: Z }],
    ['platform_handover_shop', { p_actor: actor, p_shop_id: shopId, p_new_owner: Z, p_invitation: 'existing', p_reservation: null }],
    ['platform_claim_handover_invitation', { p_actor: actor, p_shop_id: shopId, p_reservation: Z }],
    ['platform_release_stale_handover', { p_actor: actor, p_shop_id: shopId }],
    ['platform_demo_delete_preview', { p_actor: actor, p_shop_id: shopId }],
    ['platform_demo_delete_begin', { p_actor: actor, p_shop_id: shopId, p_confirm_slug: 'x' }],
    ['platform_demo_delete_objects', { p_actor: actor, p_shop_id: shopId, p_limit: 10 }],
    ['platform_demo_delete_finalize', { p_actor: actor, p_shop_id: shopId, p_error: null }],
    ['notify_get_settings', { p_shop_id: shopId, p_actor: actor }],
    ['notify_get_credentials', { p_shop_id: shopId, p_actor: actor }],
    ['notify_save_settings', { p_shop_id: shopId, p_actor: actor, p_bot_token: null, p_chat_id: '@mfa_chat', p_meta: {} }],
    ['notify_record_check', { p_shop_id: shopId, p_actor: actor, p_ok: true, p_error: null }],
    ['notify_set_enabled', { p_shop_id: shopId, p_actor: actor, p_enabled: false }],
    ['notify_delete_settings', { p_shop_id: shopId, p_actor: actor }],
    ['notify_requeue_failed', { p_shop_id: shopId, p_actor: actor }],
  ];
}

/** Every action of the platform-admin Edge Function. */
function edgeActions(shopId: string): Array<Record<string, unknown>> {
  return [
    { action: 'list' },
    { action: 'find-user', email: `nobody-${run}@it.local` },
    { action: 'transfer', shopId, userId: Z },
    { action: 'create-demo', templateId: shopId, slug: `mfa-${run}`, name: 'X' },
    { action: 'handover-check', shopId },
    { action: 'handover', shopId, email: `nobody-${run}@it.local`, redirectTo: REDIRECT },
    { action: 'handover-cancel', shopId },
    { action: 'handover-release-stale', shopId },
    { action: 'demo-delete-preview', shopId },
    { action: 'demo-delete', shopId, confirmSlug: 'x' },
    { action: 'demo-delete-resume', shopId },
  ];
}

let live: TestShop; // regular live shop with an owner
let hidden: TestShop; // preview shop: visible only to members / aal2 platform admins
let demo: TestShop; // DEMO shop (target of the destructive actions; must survive every refused call)
let owner: Awaited<ReturnType<typeof createOwner>>;
let aal2: PlatformAdmin;

async function shopSnapshot(id: string) {
  const { data: s } = await admin.from('shops').select('status, mode, is_demo, slug, name').eq('id', id).single();
  const { data: m } = await admin.from('shop_memberships').select('user_id, role').eq('shop_id', id).order('user_id');
  const { count } = await admin.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', id);
  return { s, m, products: count };
}

/** What an authenticated client can see / do with platform-wide or foreign data. */
async function reach(client: Db) {
  const { data: shopsHidden } = await client.from('shops').select('id').eq('id', hidden.id);
  const { data: orders } = await client.from('orders').select('id').eq('shop_id', live.id);
  const { data: members } = await client.from('shop_memberships').select('user_id').eq('shop_id', live.id);
  const isAdmin = await client.rpc('is_platform_admin');
  const member = await client.rpc('is_shop_member', { p_shop_id: hidden.id });
  const stock = await rpc(client, 'admin_variant_stock', { p_shop_id: live.id });
  const setStock = await client.rpc('admin_set_variant_stock', { p_variant_id: live.variants[0]!.id, p_quantity: 77 });
  const path = `${hidden.id}/products/mfa-${randomBytes(3).toString('hex')}.png`;
  const upload = await client.storage.from('shop-media').upload(path, PNG, { contentType: 'image/png' });
  if (!upload.error) await admin.storage.from('shop-media').remove([path]);
  return {
    hiddenShop: (shopsHidden ?? []).length,
    orders: (orders ?? []).length,
    members: (members ?? []).length,
    isPlatformAdmin: isAdmin.data,
    isShopMember: member.data,
    exactStock: stock.error ? stock.error.message : 'ok',
    setStock: setStock.error ? setStock.error.message : 'ok',
    upload: upload.error ? 'denied' : 'ok',
  };
}

const DENIED = { hiddenShop: 0, orders: 0, members: 0, isPlatformAdmin: false, isShopMember: false, exactStock: 'shop_not_found', setStock: 'variant_not_found', upload: 'denied' };

beforeAll(async () => {
  live = await createTestShop({ variants: [{ flavor: 'Mint', stock: 5 }] });
  hidden = await createTestShop({ mode: 'preview' });
  demo = await createTestShop({ isDemo: true });
  owner = await createOwner(live.id);
  aal2 = await createPlatformAdmin();
});
afterAll(cleanupSecurity);

describe('the actor list covers every RPC that takes p_actor', () => {
  it('pg_proc has no actor RPC outside the list (a new one would otherwise escape these tests)', async () => {
    const r = await psqlAsync(
      `select distinct p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and 'p_actor' = any(p.proargnames) order by 1;`,
    );
    expect(r.code).toBe(0);
    expect(r.out.split(/\r?\n/).filter(Boolean)).toEqual([...new Set(actorCalls(Z, Z).map(([fn]) => fn))].sort());
  });
});

describe('platform admin without MFA (password only, aal1, no factor)', () => {
  let pa: PlatformAdmin;
  beforeAll(async () => {
    pa = await createPlatformAdmin({ mfa: false });
  });

  it('every platform-admin Edge Function action → 403 mfa_required, nothing changes', async () => {
    const before = await shopSnapshot(demo.id);
    for (const body of edgeActions(demo.id)) {
      const res = await callAdminFunction('platform-admin', pa.client, body);
      expect([body.action, res.status, (res.body?.error as { code?: string } | undefined)?.code]).toEqual([body.action, 403, 'mfa_required']);
    }
    expect(await shopSnapshot(demo.id)).toEqual(before);
  });

  it('notification-settings for any shop → 403 mfa_required', async () => {
    for (const action of ['get', 'disable', 'delete', 'retry']) {
      const res = await callAdminFunction('notification-settings', pa.client, { action, shopId: live.id });
      expect([action, res.status, (res.body?.error as { code?: string }).code]).toEqual([action, 403, 'mfa_required']);
    }
  });

  it('every service-role actor RPC → mfa_required, without a session and with the admin\'s own aal1 session', async () => {
    const before = await shopSnapshot(demo.id);
    for (const db of [admin, serviceAs(pa.sessionId)]) {
      for (const [fn, args] of actorCalls(pa.userId, demo.id)) {
        expect([fn, (await rpc(db, fn, args)).error?.message]).toEqual([fn, 'mfa_required']);
      }
    }
    expect(await shopSnapshot(demo.id)).toEqual(before);
  });

  it('PostgREST / RLS / admin_* RPCs / Storage: nothing beyond an ordinary signed-in user', async () => {
    expect(await reach(pa.client)).toEqual(DENIED);
    // It may read its own platform_admins row (the UI uses it to ask for MFA) — nothing else.
    expect((await pa.client.from('platform_admins').select('user_id')).data).toEqual([{ user_id: pa.userId }]);
  });
});

describe('initial MFA enrollment opens nothing until the code is verified', () => {
  it('enrolled (unverified) and challenged → still refused; verified → aal2 → allowed', async () => {
    const pa = await createPlatformAdmin({ mfa: false });
    const { data: factor, error } = await pa.client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `it-${run}` });
    expect(error).toBeNull();
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'list' })).status).toBe(403);
    expect(await reach(pa.client)).toEqual(DENIED);

    const challenge = await pa.client.auth.mfa.challenge({ factorId: factor!.id });
    expect(challenge.error).toBeNull();
    // A wrong code does not upgrade the session.
    const wrong = await pa.client.auth.mfa.verify({ factorId: factor!.id, challengeId: challenge.data!.id, code: '000000' === totp(factor!.totp.secret) ? '111111' : '000000' });
    expect(wrong.error).not.toBeNull();
    expect((await sessionClaims(pa.client)).aal).toBe('aal1');
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'list' })).body?.error).toMatchObject({ code: 'mfa_required' });
    for (const [fn, args] of actorCalls(pa.userId, demo.id)) expect((await rpc(serviceAs(pa.sessionId), fn, args)).error?.message).toBe('mfa_required');

    const ok = await pa.client.auth.mfa.challengeAndVerify({ factorId: factor!.id, code: totp(factor!.totp.secret) });
    expect(ok.error).toBeNull();
    const claims = await sessionClaims(pa.client);
    expect(claims.aal).toBe('aal2');
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'list' })).status).toBe(200);
    expect((await rpc(serviceAs(claims.session_id!), 'platform_list_shops', { p_actor: pa.userId })).error).toBeNull();
  });
});

describe('platform admin with a verified factor but a password-only session', () => {
  it('is refused everywhere and cannot enroll a factor of its own choice (no takeover by password)', async () => {
    const second = anon();
    expect((await second.auth.signInWithPassword({ email: aal2.email, password: aal2.password })).error).toBeNull();
    const claims = await sessionClaims(second);
    expect(claims.aal).toBe('aal1');
    expect((await callAdminFunction('platform-admin', second, { action: 'list' })).body?.error).toMatchObject({ code: 'mfa_required' });
    expect(await reach(second)).toEqual(DENIED);
    for (const [fn, args] of actorCalls(aal2.userId, demo.id)) expect((await rpc(serviceAs(claims.session_id!), fn, args)).error?.message).toBe('mfa_required');
    // Supabase Auth requires aal2 to add or remove factors once one is verified.
    expect((await second.auth.mfa.enroll({ factorType: 'totp', friendlyName: `attacker-${run}` })).error).not.toBeNull();
    expect((await second.auth.mfa.unenroll({ factorId: aal2.factorId! })).error).not.toBeNull();
    const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: aal2.userId });
    expect(factors!.factors.map((f) => f.id)).toEqual([aal2.factorId]);
  });
});

describe('platform admin in an aal2 session', () => {
  it('Edge Function, service-role RPCs, RLS, admin_* RPCs and Storage are allowed', async () => {
    expect((await callAdminFunction('platform-admin', aal2.client, { action: 'list' })).status).toBe(200);
    expect((await callAdminFunction('platform-admin', aal2.client, { action: 'demo-delete-preview', shopId: demo.id })).status).toBe(200);
    expect((await callAdminFunction('notification-settings', aal2.client, { action: 'get', shopId: live.id })).status).toBe(200);
    expect((await rpc(aal2.svc, 'platform_list_shops', { p_actor: aal2.userId })).error).toBeNull();
    const r = await reach(aal2.client);
    expect(r).toMatchObject({ hiddenShop: 1, isPlatformAdmin: true, isShopMember: true, exactStock: 'ok', setStock: 'ok', upload: 'ok' });
    await admin.rpc('admin_set_variant_stock', { p_variant_id: live.variants[0]!.id, p_quantity: 5 });
  });

  it("a forwarded session counts only for its own user, and only for the service role", async () => {
    const other = await createPlatformAdmin();
    // Admin B's RPC with admin A's session → refused.
    expect((await rpc(aal2.svc, 'platform_list_shops', { p_actor: other.userId })).error?.message).toBe('mfa_required');
    // An end user cannot send the header to PostgREST for themselves: aal1 token + own aal2 session id → nothing.
    const second = anon();
    await second.auth.signInWithPassword({ email: aal2.email, password: aal2.password });
    const token = (await second.auth.getSession()).data.session!.access_token;
    const spoof = createClient<Database>(env.url, env.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${token}`, 'x-platform-session': aal2.sessionId } },
    });
    expect(await reach(spoof)).toEqual(DENIED);
    // The owner's (aal1) session forwarded with the owner as actor gives no platform right either.
    const ownerSession = (await sessionClaims(owner.client)).session_id!;
    expect((await rpc(serviceAs(ownerSession), 'platform_list_shops', { p_actor: owner.userId })).error?.message).toBe('forbidden');
  });

  it('a signed-out (revoked) aal2 session stops working at once, before its token expires', async () => {
    const pa = await createPlatformAdmin();
    const token = (await pa.client.auth.getSession()).data.session!.access_token;
    expect((await rpc(pa.svc, 'platform_list_shops', { p_actor: pa.userId })).error).toBeNull();
    await pa.client.auth.signOut({ scope: 'local' });
    expect((await rpc(pa.svc, 'platform_list_shops', { p_actor: pa.userId })).error?.message).toBe('mfa_required');
    expect((await callAdminFunction('platform-admin', { bearer: token }, { action: 'list' })).status).toBe(401);
  });

  it('recovery (lost authenticator): factors removed + every session ended; nothing works until a NEW factor is verified', async () => {
    const errCode = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;
    const pa = await createPlatformAdmin();
    const lostDevice = pa.client; // aal2 session on the "lost" device
    const lostToken = (await lostDevice.auth.getSession()).data.session!.access_token;
    // Only for platform admins: an owner account is refused and keeps everything.
    await expect(resetPlatformAdminMfa(admin, owner.userId)).rejects.toThrow(/not_platform_admin/);
    expect((await admin.rpc('platform_admin_revoke_sessions', { p_user_id: owner.userId })).error?.message).toBe('forbidden');
    expect((await owner.client.rpc('platform_admin_revoke_sessions' as never, { p_user_id: pa.userId } as never)).error?.message).toMatch(/permission denied/i);

    const res = await resetPlatformAdminMfa(admin, pa.userId);
    expect(res).toMatchObject({ userId: pa.userId, factorsRemoved: 1 });
    expect(res.sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await admin.auth.admin.mfa.listFactors({ userId: pa.userId })).data!.factors).toEqual([]);
    // The lost device is out at once: Edge Function, forwarded session, PostgREST, refresh.
    expect((await callAdminFunction('platform-admin', { bearer: lostToken }, { action: 'list' })).status).toBe(401);
    expect((await rpc(pa.svc, 'platform_list_shops', { p_actor: pa.userId })).error?.message).toBe('mfa_required');
    expect((await lostDevice.rpc('is_platform_admin')).data).not.toBe(true);
    expect((await lostDevice.auth.refreshSession()).error).not.toBeNull();

    // Password sign-in: aal1, no factor → refused everywhere; enrollment is the only thing it can do.
    const fresh = anon();
    expect((await fresh.auth.signInWithPassword({ email: pa.email, password: pa.password })).error).toBeNull();
    expect((await sessionClaims(fresh)).aal).toBe('aal1');
    expect(errCode(await callAdminFunction('platform-admin', fresh, { action: 'list' }))).toBe('mfa_required');
    expect(await reach(fresh)).toEqual(DENIED);
    const { data: enrolled, error: ee } = await fresh.auth.mfa.enroll({ factorType: 'totp', friendlyName: `recovered-${run}` });
    expect(ee).toBeNull();
    expect(errCode(await callAdminFunction('platform-admin', fresh, { action: 'list' }))).toBe('mfa_required');
    expect((await fresh.auth.mfa.challengeAndVerify({ factorId: enrolled!.id, code: totp(enrolled!.totp.secret) })).error).toBeNull();
    expect((await sessionClaims(fresh)).aal).toBe('aal2');
    expect((await callAdminFunction('platform-admin', fresh, { action: 'list' })).status).toBe(200);
    // The old aal2 session does not come back with the new factor.
    expect((await rpc(pa.svc, 'platform_list_shops', { p_actor: pa.userId })).error?.message).toBe('mfa_required');
  });

  it('a banned account is refused even with a live aal2 session', async () => {
    const pa = await createPlatformAdmin();
    await admin.auth.admin.updateUserById(pa.userId, { ban_duration: '1h' });
    expect((await rpc(pa.svc, 'platform_list_shops', { p_actor: pa.userId })).error?.message).toBe('mfa_required');
  });
});

describe('client accounts (owners / managers) stay separate from platform admins', () => {
  it('a shop member can never become a platform admin; a platform admin can never become a member', async () => {
    const m = await createMember(live.id, 'manager');
    expect((await admin.from('platform_admins').insert({ user_id: m.userId })).error?.message).toBe('platform_admin_has_memberships');
    expect((await admin.from('platform_admins').insert({ user_id: owner.userId })).error?.message).toBe('platform_admin_has_memberships');
    expect((await admin.from('shop_memberships').insert({ shop_id: hidden.id, user_id: aal2.userId, role: 'owner' })).error?.message).toBe(
      'owner_is_platform_admin',
    );
    // Clients cannot grant themselves anything.
    expect((await owner.client.from('platform_admins').insert({ user_id: owner.userId } as never)).error).not.toBeNull();
    expect((await owner.client.from('shop_memberships').insert({ shop_id: hidden.id, user_id: owner.userId, role: 'owner' } as never)).error).not.toBeNull();
    const { data } = await admin.from('platform_admins').select('user_id').in('user_id', [m.userId, owner.userId]);
    expect(data).toEqual([]);
  });

  it('transfer / hand-over to a platform admin is refused', async () => {
    expect((await rpc(aal2.svc, 'platform_transfer_shop', { p_actor: aal2.userId, p_shop_id: hidden.id, p_new_owner: aal2.userId })).error?.message).toBe(
      'owner_is_platform_admin',
    );
  });

  it('an account that had both before the migration reaches its shop only as an aal2 platform admin', async () => {
    const email = `mixed-${run}@it.local`;
    const password = randomBytes(12).toString('base64url');
    const { data: u } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    track('user', u.user!.id);
    await admin.from('shop_memberships').insert({ shop_id: hidden.id, user_id: u.user!.id, role: 'owner' });
    // Legacy state, created with the guard triggers disabled for this one statement.
    const r = await psqlAsync(`set session_replication_role = replica; insert into public.platform_admins (user_id) values ('${u.user!.id}');`);
    expect(r.code).toBe(0);
    const c = anon();
    await c.auth.signInWithPassword({ email, password });
    expect((await c.from('shops').select('id').eq('id', hidden.id)).data).toEqual([]);
    expect((await c.rpc('is_shop_member', { p_shop_id: hidden.id })).data).toBe(false);
    expect((await callAdminFunction('notification-settings', c, { action: 'get', shopId: hidden.id })).body?.error).toMatchObject({ code: 'mfa_required' });
    await enrollAndVerifyTotp(c);
    expect((await c.from('shops').select('id').eq('id', hidden.id)).data).toEqual([{ id: hidden.id }]);
  });

  it('an owner reaches only its own shop: other shops, platform actions and foreign Storage are refused', async () => {
    const foreignStock = await rpc(owner.client, 'admin_variant_stock', { p_shop_id: hidden.id });
    expect(foreignStock.error?.message).toBe('shop_not_found');
    expect((await rpc(owner.client, 'admin_variant_stock', { p_shop_id: live.id })).error).toBeNull();
    expect((await owner.client.from('shops').select('id').eq('id', hidden.id)).data).toEqual([]);
    const up = await owner.client.storage.from('shop-media').upload(`${hidden.id}/products/x-${run}.png`, PNG, { contentType: 'image/png' });
    expect(up.error).not.toBeNull();
    expect((await callAdminFunction('platform-admin', owner.client, { action: 'list' })).body?.error).toMatchObject({ code: 'forbidden' });
    expect((await callAdminFunction('notification-settings', owner.client, { action: 'get', shopId: hidden.id })).body?.error).toMatchObject({ code: 'forbidden' });
    for (const [fn, args] of actorCalls(owner.userId, hidden.id)) {
      const msg = (await rpc(admin, fn, args)).error?.message;
      expect([fn, msg]).toEqual([fn, 'forbidden']);
    }
  });
});
