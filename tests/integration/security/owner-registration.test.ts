// Self-registration of a shop owner by an individual one-time link (20261119090000, Edge Function owner-registration,
// platform-admin actions owner-link-create / owner-link-revoke) and password recovery through Supabase Auth. LOCAL ONLY.
// The local Mailpit of this project's stack is the only mail sink: no real e-mail is sent and no real account is used.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { localStack } from '../../../scripts/lib/local-stack.ts';
import {
  admin,
  anon,
  callAdminFunction,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  env,
  track,
  waitFor,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, psqlAsync } from './sec-helpers';

const MAILPIT = localStack().mailUrl;
const FN = `${env.url}/functions/v1/owner-registration`;
const REDIRECT = 'http://127.0.0.1:5173/admin/set-password';
const tag = randomBytes(3).toString('hex');
const email = (kind: string) => `${kind}-${tag}-${randomBytes(2).toString('hex')}@it.local`;
const password = () => `Pw-${randomBytes(9).toString('base64url')}`;
const code = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;

let pa: PlatformAdmin;

beforeAll(async () => {
  pa = await createPlatformAdmin();
});
beforeEach(async () => {
  // The public endpoint counts attempts per IP; every test starts with a clean counter (the limits have their own tests).
  await sql('delete from private.owner_invite_attempts');
});
afterAll(async () => {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if (u.email?.includes(`-${tag}-`)) track('user', u.id);
  await sql('drop trigger if exists it_owner_reg_suspend on auth.users');
  await sql('drop function if exists public.it_owner_reg_suspend()');
  await cleanupSecurity();
});

async function sql(q: string): Promise<string> {
  const r = await psqlAsync(q);
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}`);
  return r.out;
}

async function ownerFn(body: unknown, bearer?: string) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${bearer ?? env.anonKey}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body: json, text: JSON.stringify(json), headers: res.headers };
}

const preview = (token: string) => ownerFn({ action: 'preview', token });
const register = (token: string, mail: string, pw: string, extra: Record<string, unknown> = {}) =>
  ownerFn({ action: 'register', token, email: mail, password: pw, passwordConfirm: pw, ...extra });
const claim = (token: string, bearer: string) => ownerFn({ action: 'claim', token }, bearer);

type Invite = {
  status: 'active' | 'used' | 'expired' | 'revoked';
  created_at: string;
  expires_at: string;
  bound_email: string | null;
  used_at: string | null;
  used_email: string | null;
  used_via: string | null;
  revoked_reason: string | null;
  stale: boolean;
  in_progress: boolean;
};

async function link(shop: TestShop, extra: Record<string, unknown> = {}) {
  const res = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: shop.id, ...extra });
  expect(res.status, res.text).toBe(201);
  return { token: res.body!.token as string, invite: res.body!.invite as Invite };
}
const revoke = (shop: TestShop) => callAdminFunction('platform-admin', pa.client, { action: 'owner-link-revoke', shopId: shop.id });
const liveShop = () => createTestShop({ isDemo: false });
const demoShop = () => createTestShop({ isDemo: true });

async function members(shopId: string) {
  const { data } = await admin.from('shop_memberships').select('user_id, role').eq('shop_id', shopId);
  return data ?? [];
}
async function userByEmail(mail: string) {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  return data.users.find((u) => u.email === mail) ?? null;
}
async function listedInvite(shop: TestShop): Promise<{ invite: Invite | null; text: string; members: Array<{ email: string; role: string }> }> {
  const res = await callAdminFunction('platform-admin', pa.client, { action: 'list' });
  expect(res.status).toBe(200);
  const row = (res.body!.shops as Array<{ id: string; owner_invite: Invite | null; members: Array<{ email: string; role: string }> }>).find((s) => s.id === shop.id)!;
  return { invite: row.owner_invite, text: res.text, members: row.members };
}
async function inviteRow(shopId: string) {
  return JSON.parse(await sql(`select coalesce(json_agg(i order by created_at), '[]') from private.shop_owner_invites i where shop_id = '${shopId}'`)) as Array<{ token_hash: string; status: string }>;
}
const hashOf = (token: string) => createHash('sha256').update(`owner-invite:${token}`).digest('hex');

async function mailTotal(): Promise<number> {
  const r = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=1`)).json()) as { total?: number; messages_count?: number };
  return r.total ?? r.messages_count ?? 0;
}
async function mailsTo(to: string): Promise<Array<{ ID: string }>> {
  const r = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as { messages: Array<{ ID: string }> };
  return r.messages;
}

describe('creating a link', () => {
  it('a platform admin creates a link for ONE shop; the database keeps only the hash of the token', async () => {
    const S = await liveShop();
    const { token, invite } = await link(S);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invite.status).toBe('active');
    const hours = (Date.parse(invite.expires_at) - Date.parse(invite.created_at)) / 3_600_000;
    expect(Math.round(hours)).toBe(48);

    const rows = await inviteRow(S.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashOf(token));
    // The secret is nowhere in the table (not even as a substring of any column) and the listing never carries it.
    expect(await sql(`select count(*) from private.shop_owner_invites i where i::text like '%${token}%'`)).toBe('0');
    const listed = await listedInvite(S);
    expect(listed.invite!.status).toBe('active');
    expect(listed.text).not.toContain(token);
    expect(listed.text).not.toContain(hashOf(token));
    // Audit: creation is journalled.
    expect(await sql(`select count(*) from private.shop_lifecycle_events where shop_id = '${S.id}' and action = 'owner_link_created' and actor = '${pa.userId}'`)).toBe('1');
  });

  it('ttl is bounded (1..168 h) and applied', async () => {
    const S = await liveShop();
    const { invite } = await link(S, { ttlHours: 1 });
    expect(Math.round((Date.parse(invite.expires_at) - Date.parse(invite.created_at)) / 3_600_000)).toBe(1);
    for (const ttlHours of [0, 169, 1.5]) {
      const res = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: S.id, ttlHours });
      expect(res.status, String(ttlHours)).toBe(400);
    }
    const rpc = await pa.svc.rpc('platform_owner_link_create', { p_actor: pa.userId, p_shop_id: S.id, p_token_hash: hashOf('x'), p_ttl_hours: 200 });
    expect(rpc.error?.message).toBe('invalid_ttl');
  });

  it('is refused for everyone but an aal2 platform admin; no link and no secret is created', async () => {
    const S = await liveShop();
    const owner = await createOwner(S.id);
    const outsider = await createOwner((await liveShop()).id);
    const aal1 = await createPlatformAdmin({ mfa: false });
    const body = { action: 'owner-link-create', shopId: S.id };
    const refused: Array<[string, Awaited<ReturnType<typeof callAdminFunction>>, number, string]> = [
      ['shop owner', await callAdminFunction('platform-admin', owner.client, body), 403, 'mfa_required'],
      ['unrelated owner', await callAdminFunction('platform-admin', outsider.client, body), 403, 'mfa_required'],
      ['aal1 platform admin', await callAdminFunction('platform-admin', aal1.client, body), 403, 'mfa_required'],
      ['anonymous', await callAdminFunction('platform-admin', null, body), 401, 'auth_required'],
    ];
    for (const [who, res, status] of refused) expect(res.status, who).toBe(status);
    // The SQL refuses too, without the Edge Function: a plain user cannot call the RPCs at all, the service role needs a session.
    const hash = hashOf(randomBytes(8).toString('hex'));
    const args = { p_actor: owner.userId, p_shop_id: S.id, p_token_hash: hash, p_bound_email: null, p_ttl_hours: null };
    expect((await owner.client.rpc('platform_owner_link_create', args as never)).error?.code).toBe('42501');
    expect((await anon().rpc('owner_invite_preview', { p_token_hash: hash })).error?.code).toBe('42501');
    expect((await admin.rpc('platform_owner_link_create', args as never)).error?.message).toBe('forbidden');
    expect((await pa.svc.rpc('platform_owner_link_create', { ...args, p_actor: owner.userId } as never)).error?.message).toBe('forbidden');
    expect((await admin.rpc('platform_owner_link_create', { ...args, p_actor: pa.userId } as never)).error?.message).toBe('mfa_required');
    expect(await inviteRow(S.id)).toEqual([]);
    expect((await owner.client.from('shop_memberships').select('role').eq('shop_id', S.id)).data).toEqual([{ role: 'owner' }]);
  });

  it('refuses a missing / deleting / suspended shop and a DEMO shop that is not ready', async () => {
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: '00000000-0000-4000-8000-000000000000' });
    expect([res.status, code(res)]).toEqual([404, 'shop_not_found']);
    const suspended = await liveShop();
    await admin.from('shops').update({ status: 'suspended' }).eq('id', suspended.id);
    const r2 = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: suspended.id });
    expect([r2.status, code(r2)]).toEqual([409, 'shop_not_ready']);
    const notReady = await createTestShop({ isDemo: true, delivery: false, pickup: false });
    const r3 = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: notReady.id });
    expect([r3.status, code(r3)]).toEqual([409, 'shop_not_ready']);
    expect((r3.body!.error as { details: string[] }).details).toContain('no_fulfillment');
    expect(await inviteRow(notReady.id)).toEqual([]);
  });

  it('refuses a link while a hand-over is pending or in flight', async () => {
    const S = await demoShop();
    const invited = await admin.auth.admin.createUser({ email: email('pending'), password: password(), email_confirm: false });
    track('user', invited.data.user!.id);
    await sql(`insert into private.shop_pending_handovers (shop_id, user_id, invitation, requested_by, expires_at) values ('${S.id}', '${invited.data.user!.id}', 'sent', '${pa.userId}', now() + interval '1 day')`);
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: S.id });
    expect([res.status, code(res)]).toEqual([409, 'handover_pending']);
    await sql(`delete from private.shop_pending_handovers where shop_id = '${S.id}'`);
    await sql(`insert into private.shop_handover_reservations (shop_id, email, requested_by, expires_at) values ('${S.id}', 'someone@it.local', '${pa.userId}', now() + interval '5 minutes')`);
    const r2 = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: S.id });
    expect([r2.status, code(r2)]).toEqual([409, 'handover_in_progress']);
  });

  it('a bound e-mail of a platform admin is refused', async () => {
    const S = await liveShop();
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: S.id, email: pa.email });
    expect([res.status, code(res)]).toEqual([409, 'owner_is_platform_admin']);
  });
});

describe('registration by a valid link (no e-mail confirmation, no e-mail sent, session, ownership)', () => {
  it('creates the account, makes it the only owner of THAT shop and lets it into the admin at once', async () => {
    const S = await liveShop();
    const other = await createTestShop({ mode: 'preview' });
    const old = await createOwner(S.id);
    const before = await sql(`select (select count(*) from products where shop_id='${S.id}') || '/' || (select count(*) from product_variants where shop_id='${S.id}') || '/' || (select count(*) from categories where shop_id='${S.id}')`);
    const { token } = await link(S);

    const pv = await preview(token);
    expect(pv.status).toBe(200);
    expect(pv.body).toEqual({ invite: { status: 'active', shop: { name: `IT ${S.slug}`, logo_path: null }, email_bound: false, expires_at: expect.any(String) } });
    expect(pv.text).not.toContain(S.id);

    const mail = email('buyer');
    const pw = password();
    const mailsBefore = await mailTotal();
    // A forged shop id in the body changes nothing: the shop comes from the link.
    const res = await register(token, mail.toUpperCase(), pw, { shopId: other.id, shop_id: other.id, slug: 'x' });
    expect(res.status, res.text).toBe(200);
    expect(res.body).toMatchObject({ status: 'completed', via: 'registration', shop: { slug: S.slug } });
    // The response carries no token, session or password.
    expect(res.text).not.toContain(pw);
    expect(res.text).not.toMatch(/access_token|refresh_token/);
    expect(res.headers.get('cache-control')).toBe('no-store');

    // Auth account: created with the normalised e-mail, confirmed without any mail, password only in Auth.
    const user = (await userByEmail(mail.toLowerCase()))!;
    expect(user).toBeTruthy();
    expect(user.email_confirmed_at).toBeTruthy();
    expect(user.app_metadata.registered_via).toBe('owner_invite');
    expect(await mailTotal()).toBe(mailsBefore);
    expect(await mailsTo(mail)).toHaveLength(0);
    expect(await sql(`select count(*) from private.shop_owner_invites i where i::text like '%${pw}%'`)).toBe('0');
    expect(await sql(`select count(*) from private.shop_lifecycle_events e where e::text like '%${pw}%'`)).toBe('0');

    // The browser signs in with the password it just chose: a real session, no e-mail step.
    const buyer = anon();
    const { data: session, error } = await buyer.auth.signInWithPassword({ email: mail, password: pw });
    expect(error).toBeNull();
    expect(session.session!.access_token).toBeTruthy();

    // Ownership: exactly this account, role owner; the previous owner is gone; the other shop is untouched.
    expect(await members(S.id)).toEqual([{ user_id: user.id, role: 'owner' }]);
    expect(await members(other.id)).toEqual([]);
    expect((await old.client.from('shop_memberships').select('role').eq('shop_id', S.id)).data).toEqual([]);
    expect((await old.client.from('categories').update({ name: 'hijack' }).eq('shop_id', S.id).select()).data).toEqual([]);

    // Immediate admin access: the same RLS paths the admin UI uses.
    expect((await buyer.from('shop_memberships').select('role').eq('shop_id', S.id)).data).toEqual([{ role: 'owner' }]);
    expect((await buyer.from('products').select('id').eq('shop_id', S.id)).data).toHaveLength(1);
    const renamed = await buyer.from('shops').update({ name: 'Renamed by new owner' }).eq('id', S.id).select('name');
    expect(renamed.data).toEqual([{ name: 'Renamed by new owner' }]);
    // ... and nothing else: no foreign shop, no platform rights.
    expect((await buyer.from('shops').select('id').eq('id', other.id)).data).toEqual([]);
    expect((await buyer.from('platform_admins').select('user_id')).data).toEqual([]);
    const platform = await callAdminFunction('platform-admin', buyer, { action: 'list' });
    expect([platform.status, code(platform)]).toEqual([403, 'forbidden']);
    expect(await sql(`select count(*) from public.platform_admins where user_id = '${user.id}'`)).toBe('0');

    // Data of the shop is untouched.
    expect(await sql(`select (select count(*) from products where shop_id='${S.id}') || '/' || (select count(*) from product_variants where shop_id='${S.id}') || '/' || (select count(*) from categories where shop_id='${S.id}')`)).toBe(before);
    const shop = await admin.from('shops').select('is_demo, mode, status').eq('id', S.id).single();
    expect(shop.data).toEqual({ is_demo: false, mode: 'live', status: 'active' });
  });

  it('the platform admin sees which account registered, with e-mail and dates; the link is used up', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const mail = email('visible');
    expect((await register(token, mail, password())).status).toBe(200);
    const listed = await listedInvite(S);
    expect(listed.invite).toMatchObject({ status: 'used', used_email: mail, used_via: 'registration', in_progress: false, stale: false });
    expect(listed.invite!.used_at).toBeTruthy();
    expect(listed.members.map((m) => [m.email, m.role])).toEqual([[mail, 'owner']]);
    expect(await sql(`select count(*) from private.shop_lifecycle_events where shop_id = '${S.id}' and action = 'owner_link_used'`)).toBe('1');
    expect(await sql(`select count(*) from private.shop_transfers where shop_id = '${S.id}' and to_user_id = '${(await userByEmail(mail))!.id}'`)).toBe('1');
  });

  it('a DEMO shop goes through the hand-over: it becomes a real live shop, test orders are released', async () => {
    const S = await demoShop();
    const { token } = await link(S);
    const mail = email('demo');
    expect((await register(token, mail, password())).status).toBe(200);
    const shop = await admin.from('shops').select('is_demo, mode').eq('id', S.id).single();
    expect(shop.data).toEqual({ is_demo: false, mode: 'live' });
    expect(await sql(`select count(*) from private.shop_lifecycle_events where shop_id = '${S.id}' and action = 'handover'`)).toBe('1');
    expect(await members(S.id)).toHaveLength(1);
  });

  it('validation: passwords must match and be strong enough, the e-mail must be valid — nothing is created, the link stays', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const mail = email('invalid');
    const pw = password();
    const mismatch = await ownerFn({ action: 'register', token, email: mail, password: pw, passwordConfirm: `${pw}x` });
    expect([mismatch.status, code(mismatch)]).toEqual([400, 'password_mismatch']);
    const short = await register(token, mail, 'short');
    expect([short.status, code(short)]).toEqual([422, 'weak_password']);
    const long = await register(token, mail, 'x'.repeat(80));
    expect([long.status, code(long)]).toEqual([422, 'weak_password']);
    const badMail = await register(token, 'not-an-email', pw);
    expect([badMail.status, code(badMail)]).toEqual([400, 'invalid_body']);
    expect(await userByEmail(mail)).toBeNull();
    expect(await members(S.id)).toEqual([]);
    expect((await listedInvite(S)).invite!.status).toBe('active');
    // ...and the same link still registers once the form is right.
    expect((await register(token, mail, pw)).status).toBe(200);
  });
});

describe('expiry, revocation, single use, replacement', () => {
  it('an expired link is refused everywhere and creates nothing', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    await sql(`update private.shop_owner_invites set created_at = now() - interval '49 hours', expires_at = now() - interval '1 hour' where shop_id = '${S.id}'`);
    expect((await preview(token)).body).toEqual({ invite: { status: 'expired' } });
    const mail = email('expired');
    const res = await register(token, mail, password());
    expect([res.status, code(res)]).toEqual([410, 'invite_expired']);
    expect(await userByEmail(mail)).toBeNull();
    expect(await members(S.id)).toEqual([]);
    expect((await listedInvite(S)).invite!.status).toBe('expired');
  });

  it('a revoked link is refused; an unknown token is just "invalid"', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const rev = await revoke(S);
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ revoked: true, invite: { status: 'revoked', revoked_reason: 'manual' } });
    expect((await preview(token)).body).toEqual({ invite: { status: 'revoked' } });
    const mail = email('revoked');
    const res = await register(token, mail, password());
    expect([res.status, code(res)]).toEqual([410, 'invite_revoked']);
    expect(await userByEmail(mail)).toBeNull();
    expect((await revoke(S)).body).toMatchObject({ revoked: false });
    expect((await preview(randomBytes(32).toString('base64url'))).body).toEqual({ invite: { status: 'invalid' } });
    const unknown = await register(randomBytes(32).toString('base64url'), email('unknown'), password());
    expect([unknown.status, code(unknown)]).toEqual([404, 'invite_invalid']);
    const malformed = await register('short', email('unknown'), password());
    expect([malformed.status, code(malformed)]).toEqual([404, 'invite_invalid']);
    expect(await sql(`select count(*) from private.shop_lifecycle_events where shop_id = '${S.id}' and action = 'owner_link_revoked'`)).toBe('1');
  });

  it('a link works once: a repeat — same or other e-mail — is refused and creates no second account', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const first = email('first');
    const pw = password();
    expect((await register(token, first, pw)).status).toBe(200);
    const again = await register(token, first, pw);
    expect([again.status, code(again)]).toEqual([410, 'invite_used']);
    const second = email('second');
    const other = await register(token, second, password());
    expect([other.status, code(other)]).toEqual([410, 'invite_used']);
    expect(await userByEmail(second)).toBeNull();
    expect((await preview(token)).body).toEqual({ invite: { status: 'used' } });
    expect(await members(S.id)).toEqual([{ user_id: (await userByEmail(first))!.id, role: 'owner' }]);
    // A claim of a used link is refused as well.
    const acc = await createOwner((await liveShop()).id);
    const c = await claim(token, (await acc.client.auth.getSession()).data.session!.access_token);
    expect([c.status, code(c)]).toEqual([410, 'invite_used']);
  });

  it('a new link replaces the previous one of the same shop; only the newest works; other shops keep theirs', async () => {
    const S = await liveShop();
    const T = await liveShop();
    const a = await link(S);
    const keep = await link(T);
    const b = await link(S);
    expect((await listedInvite(S)).invite!.status).toBe('active');
    const rows = await inviteRow(S.id);
    expect(rows.map((r) => r.status)).toEqual(['revoked', 'active']);
    expect(await sql(`select revoked_reason from private.shop_owner_invites where token_hash = '${hashOf(a.token)}'`)).toBe('replaced');
    const old = await register(a.token, email('old'), password());
    expect([old.status, code(old)]).toEqual([410, 'invite_revoked']);
    expect((await register(b.token, email('new'), password())).status).toBe(200);
    expect((await preview(keep.token)).body).toMatchObject({ invite: { status: 'active' } });
    expect(await sql(`select count(*) from private.shop_lifecycle_events where shop_id = '${S.id}' and action = 'owner_link_replaced'`)).toBe('1');
  });

  it('a link stops working when the shop changed hands another way (e-mail hand-over / transfer), is refused when the issuer lost admin rights', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const acc = await admin.auth.admin.createUser({ email: email('direct'), password: password(), email_confirm: true });
    track('user', acc.data.user!.id);
    const transfer = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: acc.data.user!.id });
    expect(transfer.status, transfer.text).toBe(200);
    expect((await listedInvite(S)).invite).toMatchObject({ status: 'active', stale: true });
    expect((await preview(token)).body).toEqual({ invite: { status: 'unavailable' } });
    const mail = email('late');
    const res = await register(token, mail, password());
    expect([res.status, code(res)]).toEqual([409, 'invite_unavailable']);
    expect((res.body!.error as { details: unknown }).details).toEqual({ reason: 'owner_changed' });
    expect(await userByEmail(mail)).toBeNull();
    expect(await members(S.id)).toEqual([{ user_id: acc.data.user!.id, role: 'owner' }]);
    // Re-issuing for the already owned shop is the "hand it over again" path.
    const again = await link(S);
    expect((await register(again.token, email('again'), password())).status).toBe(200);
    expect(await members(S.id)).toHaveLength(1);
    expect((await members(S.id))[0]!.user_id).not.toBe(acc.data.user!.id);

    const T = await liveShop();
    const t = await link(T);
    await sql(`update private.shop_owner_invites set created_by = '${(await admin.auth.admin.createUser({ email: email('notadmin'), password: password(), email_confirm: true }).then((r) => { track('user', r.data.user!.id); return r.data.user!.id; }))}' where shop_id = '${T.id}'`);
    const lost = await register(t.token, email('issuer'), password());
    expect([lost.status, code(lost)]).toEqual([409, 'invite_unavailable']);
    expect(await members(T.id)).toEqual([]);
  });

  it('a link is refused while another hand-over of the shop is pending', async () => {
    const S = await demoShop();
    const { token } = await link(S);
    const invited = await admin.auth.admin.createUser({ email: email('pend'), password: password(), email_confirm: false });
    track('user', invited.data.user!.id);
    await sql(`insert into private.shop_pending_handovers (shop_id, user_id, invitation, requested_by, expires_at) values ('${S.id}', '${invited.data.user!.id}', 'sent', '${pa.userId}', now() + interval '1 day')`);
    const res = await register(token, email('busy'), password());
    expect([res.status, code(res)]).toEqual([409, 'invite_in_progress']);
    expect((await preview(token)).body).toEqual({ invite: { status: 'busy' } });
    expect(await members(S.id)).toEqual([]);
  });
});

describe('concurrency and partial failure', () => {
  it('parallel registrations with one token: exactly one owner, exactly one account, the rest refused before Auth', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const mails = Array.from({ length: 5 }, (_, i) => email(`race${i}`));
    const results = await Promise.all(mails.map((m) => register(token, m, password())));
    const ok = results.filter((r) => r.status === 200);
    expect(ok, JSON.stringify(results.map((r) => [r.status, code(r)]))).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) {
      expect([409, 410]).toContain(r.status);
      expect(['invite_in_progress', 'invite_used']).toContain(code(r));
    }
    const created = (await Promise.all(mails.map(userByEmail))).filter(Boolean);
    expect(created).toHaveLength(1);
    expect(await members(S.id)).toEqual([{ user_id: created[0]!.id, role: 'owner' }]);
    expect(await sql(`select count(*) from private.shop_handover_reservations where shop_id = '${S.id}'`)).toBe('0');
    expect(await sql(`select count(*) from private.shop_lifecycle_events where shop_id = '${S.id}' and action = 'owner_link_used'`)).toBe('1');
  });

  it('the same request repeated in parallel (double click / retry) creates one account and one owner', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const mail = email('double');
    const pw = password();
    const results = await Promise.all([register(token, mail, pw), register(token, mail, pw), register(token, mail, pw)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.filter((u) => u.email === mail)).toHaveLength(1);
    expect(await members(S.id)).toHaveLength(1);
    // The retry after the fact ends in invite_used; the buyer's sign-in with the same password works.
    expect(code(await register(token, mail, pw))).toBe('invite_used');
    expect((await anon().auth.signInWithPassword({ email: mail, password: pw })).error).toBeNull();
  });

  it('a registration in flight (live reservation) blocks a second one, a transfer and a new link; an expired one does not', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const reserved = await admin.rpc('owner_invite_reserve', { p_token_hash: hashOf(token), p_email: email('held'), p_user_id: null } as never);
    expect(reserved.error).toBeNull();
    const mail = email('blocked');
    const blocked = await register(token, mail, password());
    expect([blocked.status, code(blocked)]).toEqual([409, 'invite_in_progress']);
    expect(await userByEmail(mail)).toBeNull();
    expect((await listedInvite(S)).invite).toMatchObject({ status: 'active', in_progress: true });
    const regen = await callAdminFunction('platform-admin', pa.client, { action: 'owner-link-create', shopId: S.id });
    expect([regen.status, code(regen)]).toEqual([409, 'handover_in_progress']);
    expect([(await revoke(S)).status]).toEqual([409]);
    const acc = await admin.auth.admin.createUser({ email: email('tr'), password: password(), email_confirm: true });
    track('user', acc.data.user!.id);
    const tr = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: acc.data.user!.id });
    expect([tr.status, code(tr)]).toEqual([409, 'handover_in_progress']);
    // Crash recovery: once the lease is over the shop is free again and the link still works.
    await sql(`update private.shop_handover_reservations set created_at = now() - interval '10 minutes', expires_at = now() - interval '1 minute' where shop_id = '${S.id}'`);
    expect((await register(token, mail, password())).status).toBe(200);
  });

  it('the final step is bound to the reservation: a lost / foreign reservation, another e-mail or a changed shop change nothing', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const hash = hashOf(token);
    const acc = await admin.auth.admin.createUser({ email: email('final'), password: password(), email_confirm: true });
    track('user', acc.data.user!.id);
    const complete = (reservation: string, user: string) => admin.rpc('owner_invite_complete', { p_token_hash: hash, p_reservation: reservation, p_user_id: user, p_via: 'claim' });
    expect((await complete(randomUUID(), acc.data.user!.id)).error?.message).toBe('handover_reservation_lost');
    const held = await admin.rpc('owner_invite_reserve', { p_token_hash: hash, p_email: 'someone-else@it.local', p_user_id: null } as never);
    const reservation = (held.data as { reservation: string }).reservation;
    expect((await complete(randomUUID(), acc.data.user!.id)).error?.message).toBe('handover_reservation_lost');
    expect((await complete(reservation, acc.data.user!.id)).error?.message).toBe('handover_reservation_mismatch');
    // A member added after the reservation (the shop changed): the link is no longer usable.
    const m = await admin.auth.admin.createUser({ email: email('member'), password: password(), email_confirm: true });
    track('user', m.data.user!.id);
    await admin.from('shop_memberships').insert({ shop_id: S.id, user_id: m.data.user!.id, role: 'manager' });
    await sql(`update private.shop_handover_reservations set email = '${acc.data.user!.email}' where shop_id = '${S.id}'`);
    expect((await complete(reservation, acc.data.user!.id)).error?.message).toBe('invite_unavailable');
    expect(await members(S.id)).toEqual([{ user_id: m.data.user!.id, role: 'manager' }]);
    expect((await inviteRow(S.id))[0]!.status).toBe('active');
    expect((await admin.rpc('owner_invite_release', { p_token_hash: hash, p_reservation: reservation })).data).toBe(true);
  });

  it('a refused final step removes the account the request just created and keeps the link usable', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    // Simulates "the shop became unavailable between the reservation and the final step": creating the Auth account
    // suspends the shop inside the same Auth transaction.
    await sql(`create or replace function public.it_owner_reg_suspend() returns trigger language plpgsql security definer set search_path = '' as $$
      begin update public.shops set status = 'suspended' where id = '${S.id}'; return new; end $$`);
    await sql(`create trigger it_owner_reg_suspend after insert on auth.users for each row when (new.email like 'compensate-${tag}-%') execute function public.it_owner_reg_suspend()`);
    const mail = `compensate-${tag}-${randomBytes(2).toString('hex')}@it.local`;
    const res = await register(token, mail, password());
    await sql('drop trigger if exists it_owner_reg_suspend on auth.users');
    expect([res.status, code(res)]).toEqual([409, 'invite_unavailable']);
    expect(await userByEmail(mail)).toBeNull();
    expect(await members(S.id)).toEqual([]);
    expect(await sql(`select count(*) from private.shop_handover_reservations where shop_id = '${S.id}'`)).toBe('0');
    expect((await inviteRow(S.id))[0]!.status).toBe('active');
    // The shop is repaired: the same link and the same e-mail now work.
    await admin.from('shops').update({ status: 'active' }).eq('id', S.id);
    expect((await register(token, mail, password())).status).toBe(200);
  });

  it('an account left behind by an interrupted registration is not duplicated: the buyer signs in and claims the link', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const mail = email('halfway');
    const pw = password();
    // The state after "account created, final step never ran".
    const half = await admin.auth.admin.createUser({ email: mail, password: pw, email_confirm: true });
    track('user', half.data.user!.id);
    const res = await register(token, mail, password());
    expect([res.status, code(res)]).toEqual([409, 'account_exists']);
    expect(await sql(`select count(*) from private.shop_handover_reservations where shop_id = '${S.id}'`)).toBe('0');
    // Nobody's password was touched: the original one still signs in.
    const buyer = anon();
    expect((await buyer.auth.signInWithPassword({ email: mail, password: pw })).error).toBeNull();
    const token2 = (await buyer.auth.getSession()).data.session!.access_token;
    const done = await claim(token, token2);
    expect(done.status, done.text).toBe(200);
    expect(done.body).toMatchObject({ via: 'claim', shop: { slug: S.slug } });
    expect(await members(S.id)).toEqual([{ user_id: half.data.user!.id, role: 'owner' }]);
    expect((await listedInvite(S)).invite).toMatchObject({ status: 'used', used_via: 'claim', used_email: mail });
  });
});

describe('existing accounts', () => {
  it('registering with the e-mail of an existing account creates no duplicate, changes no password, sends no mail', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const existing = await createOwner((await liveShop()).id);
    const mailsBefore = await mailTotal();
    const res = await register(token, existing.email, password());
    expect([res.status, code(res)]).toEqual([409, 'account_exists']);
    expect(await mailTotal()).toBe(mailsBefore);
    expect((await admin.auth.admin.listUsers({ perPage: 1000 })).data.users.filter((u) => u.email === existing.email)).toHaveLength(1);
    expect((await anon().auth.signInWithPassword({ email: existing.email, password: existing.password })).error).toBeNull();
    expect(await members(S.id)).toEqual([]);
    expect((await listedInvite(S)).invite!.status).toBe('active');
  });

  it('an existing signed-in account applies the link: becomes the only owner, keeps its other shops, the old owner is cut off', async () => {
    const S = await liveShop();
    const mine = await liveShop();
    const old = await createOwner(S.id);
    const buyer = await createOwner(mine.id);
    const { token } = await link(S);
    const access = (await buyer.client.auth.getSession()).data.session!.access_token;
    const res = await claim(token, access);
    expect(res.status, res.text).toBe(200);
    expect(await members(S.id)).toEqual([{ user_id: buyer.userId, role: 'owner' }]);
    expect(await members(mine.id)).toEqual([{ user_id: buyer.userId, role: 'owner' }]);
    expect((await old.client.from('shop_memberships').select('role').eq('shop_id', S.id)).data).toEqual([]);
    const { data } = await buyer.client.from('shop_memberships').select('shop_id');
    expect(data!.map((r) => r.shop_id).sort()).toEqual([S.id, mine.id].sort());
  });

  it('claim needs the buyer’s own session; a platform admin can never claim; the e-mail binding applies', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const anonymous = await claim(token, env.anonKey);
    expect([anonymous.status, code(anonymous)]).toEqual([401, 'auth_required']);
    const noHeader = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'claim', token }) });
    expect(noHeader.status).toBe(401);
    const adminClaim = await claim(token, (await pa.client.auth.getSession()).data.session!.access_token);
    expect([adminClaim.status, code(adminClaim)]).toEqual([409, 'owner_not_allowed']);
    expect(await members(S.id)).toEqual([]);

    const bound = email('bound');
    const B = await liveShop();
    const bl = await link(B, { email: bound });
    expect((await preview(bl.token)).body).toMatchObject({ invite: { status: 'active', email_bound: true } });
    expect((await listedInvite(B)).invite!.bound_email).toBe(bound);
    const wrong = await register(bl.token, email('wrong'), password());
    expect([wrong.status, code(wrong)]).toEqual([403, 'invite_email_mismatch']);
    expect(wrong.text).not.toContain(bound);
    const stranger = await createOwner((await liveShop()).id);
    const c = await claim(bl.token, (await stranger.client.auth.getSession()).data.session!.access_token);
    expect([c.status, code(c)]).toEqual([403, 'invite_email_mismatch']);
    expect(await members(B.id)).toEqual([]);
    expect((await register(bl.token, bound.toUpperCase(), password())).status).toBe(200);
  });
});

describe('rate limits and secrecy', () => {
  it('attempts per token are limited (10 / 15 min); a limited request changes nothing and says when to retry', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const mail = email('limited');
    const pw = password();
    for (let i = 0; i < 10; i += 1) {
      const r = await ownerFn({ action: 'register', token, email: mail, password: pw, passwordConfirm: `${pw}-no` });
      expect(r.status, `attempt ${i + 1}`).toBe(400);
    }
    const limited = await register(token, mail, pw);
    expect([limited.status, code(limited)]).toEqual([429, 'rate_limited']);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await userByEmail(mail)).toBeNull();
    expect(await members(S.id)).toEqual([]);
    // Another link is not affected by this token's counter.
    const T = await liveShop();
    expect((await register((await link(T)).token, email('other'), password())).status).toBe(200);
  });

  it('attempts per client address are limited, whatever the token', async () => {
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      last = (await register(randomBytes(32).toString('base64url'), email('flood'), password())).status;
      if (i < 20) expect(last, `attempt ${i + 1}`).toBe(404);
    }
    expect(last).toBe(429);
    // The preview has its own, larger allowance.
    expect((await preview(randomBytes(32).toString('base64url'))).status).toBe(200);
  });

  it('the token never appears in a response, an error or the stored audit trail', async () => {
    const S = await liveShop();
    const { token } = await link(S);
    const mail = email('secret');
    const responses = [
      await preview(token),
      await register(token, mail, 'short'),
      await register(token, 'broken', password()),
      await register(token, mail, password()),
      await register(token, mail, password()),
    ];
    for (const r of responses) {
      expect(r.text).not.toContain(token);
      expect(r.text).not.toContain(hashOf(token));
    }
    expect(await sql(`select count(*) from private.shop_lifecycle_events e where e::text like '%${token}%' or e::text like '%${hashOf(token)}%'`)).toBe('0');
    // The attempt counter keys by the same one-way hash as the link table; never by the token or the raw address.
    expect(await sql(`select count(*) from private.owner_invite_attempts a where a::text like '%${token}%'`)).toBe('0');
  });

  it('the public endpoint needs no user and offers nothing else: wrong method, unknown action, no body', async () => {
    expect((await fetch(FN, { method: 'GET', headers: { apikey: env.anonKey } })).status).toBe(405);
    expect((await ownerFn({ action: 'list' })).status).toBe(400);
    expect((await ownerFn({})).status).toBe(400);
    const res = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
  });
});

describe('shop deletion and platform separation', () => {
  it('deleting a shop removes its links; the deletion verification finds nothing left', async () => {
    const S = await demoShop();
    const { token } = await link(S);
    expect((await inviteRow(S.id))).toHaveLength(1);
    const del = await callAdminFunction('platform-admin', pa.client, { action: 'demo-delete', shopId: S.id, confirmSlug: S.slug });
    expect(del.status, del.text).toBe(200);
    expect(await sql(`select count(*) from private.shop_owner_invites where shop_id = '${S.id}'`)).toBe('0');
    expect((await preview(token)).body).toEqual({ invite: { status: 'invalid' } });
  });

  it('a link for one shop never reaches another shop or another owner', async () => {
    const S = await liveShop();
    const T = await liveShop();
    const ownerT = await createOwner(T.id);
    const { token } = await link(S);
    const mail = email('isolated');
    expect((await register(token, mail, password())).status).toBe(200);
    expect(await members(T.id)).toEqual([{ user_id: ownerT.userId, role: 'owner' }]);
    const buyer = (await userByEmail(mail))!;
    expect((await admin.from('shop_memberships').select('shop_id').eq('user_id', buyer.id)).data).toEqual([{ shop_id: S.id }]);
    const tNotifications = await sql(`select count(*) from private.shop_notification_settings where shop_id = '${T.id}'`);
    expect(tNotifications).toBe('0');
  });
});

/** Opens the newest recovery mail of `to` in the local Mailpit and returns the Auth verification link inside it. */
async function recoveryLink(to: string, atLeast = 1): Promise<string> {
  const found = await waitFor(() => mailsTo(to), (r) => r.length >= atLeast);
  expect(found.length, `recovery mail for ${to}`).toBeGreaterThanOrEqual(atLeast);
  const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${found[0]!.ID}`)).json()) as { HTML: string; Text: string };
  const url = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(`${msg.HTML}\n${msg.Text}`)?.[0]?.replace(/&amp;/g, '&');
  expect(url, 'recovery link').toBeTruthy();
  return url!;
}
const fragment = (location: string | null) => new URLSearchParams((location ?? '').split('#')[1] ?? '');

describe('password recovery (Supabase Auth resetPasswordForEmail, redirect to /admin/set-password)', () => {
  async function registeredBuyer() {
    const S = await liveShop();
    const { token } = await link(S);
    const mail = email('recover');
    const pw = password();
    expect((await register(token, mail, pw)).status).toBe(200);
    return { mail, pw, shop: S };
  }

  it('request → mail from Supabase → link → new password → sign in with it (and not with the old one)', async () => {
    const { mail, pw } = await registeredBuyer();
    const { error } = await anon().auth.resetPasswordForEmail(mail, { redirectTo: REDIRECT });
    expect(error).toBeNull();
    const url = await recoveryLink(mail);
    const res = await fetch(url, { redirect: 'manual' });
    expect([302, 303]).toContain(res.status);
    const location = res.headers.get('location');
    expect(location).toContain('/admin/set-password');
    const params = fragment(location);
    expect(params.get('type')).toBe('recovery');
    expect(params.get('access_token')).toBeTruthy();

    // What the set-password page does: the session from the link, then updateUser({ password }).
    const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: se } = await client.auth.setSession({ access_token: params.get('access_token')!, refresh_token: params.get('refresh_token')! });
    expect(se).toBeNull();
    const fresh = password();
    expect((await client.auth.updateUser({ password: fresh })).error).toBeNull();
    expect((await anon().auth.signInWithPassword({ email: mail, password: fresh })).error).toBeNull();
    expect((await anon().auth.signInWithPassword({ email: mail, password: pw })).error).not.toBeNull();
    // A too short new password is refused by Auth.
    expect((await client.auth.updateUser({ password: 'short' })).error).not.toBeNull();
  });

  it('a link is good once: opening it again, or after it expired, ends in otp_expired — no session', async () => {
    const { mail } = await registeredBuyer();
    expect((await anon().auth.resetPasswordForEmail(mail, { redirectTo: REDIRECT })).error).toBeNull();
    const url = await recoveryLink(mail);
    expect(fragment((await fetch(url, { redirect: 'manual' })).headers.get('location')).get('access_token')).toBeTruthy();
    const again = fragment((await fetch(url, { redirect: 'manual' })).headers.get('location'));
    expect(again.get('access_token')).toBeNull();
    expect(again.get('error_code')).toBe('otp_expired');

    // Expired by time: the recovery request is older than the OTP lifetime.
    await new Promise((r) => setTimeout(r, 1100));
    expect((await anon().auth.resetPasswordForEmail(mail, { redirectTo: REDIRECT })).error).toBeNull();
    const url2 = await recoveryLink(mail, 2);
    await sql(`update auth.users set recovery_sent_at = now() - interval '3 hours' where email = '${mail}'`);
    const late = fragment((await fetch(url2, { redirect: 'manual' })).headers.get('location'));
    expect(late.get('access_token')).toBeNull();
    expect(late.get('error_code')).toBe('otp_expired');
  });

  it('an unknown e-mail gets the same answer and no mail (no account enumeration); a repeat is limited by Auth', async () => {
    const ghost = email('ghost');
    const total = await mailTotal();
    expect((await anon().auth.resetPasswordForEmail(ghost, { redirectTo: REDIRECT })).error).toBeNull();
    await new Promise((r) => setTimeout(r, 1500));
    expect(await mailsTo(ghost)).toHaveLength(0);
    expect(await mailTotal()).toBe(total);

    const { mail } = await registeredBuyer();
    const client = anon();
    expect((await client.auth.resetPasswordForEmail(mail, { redirectTo: REDIRECT })).error).toBeNull();
    const second = await client.auth.resetPasswordForEmail(mail, { redirectTo: REDIRECT });
    // [auth.email] max_frequency = 1s locally (60 s on a hosted project): an immediate repeat is refused with 429.
    expect(second.error?.status).toBe(429);
  });

  it('recovery does not bypass MFA: a platform admin who resets the password is still aal1 and gets nothing', async () => {
    const victim = await createPlatformAdmin();
    expect((await anon().auth.resetPasswordForEmail(victim.email, { redirectTo: REDIRECT })).error).toBeNull();
    const params = fragment((await fetch(await recoveryLink(victim.email), { redirect: 'manual' })).headers.get('location'));
    const token = params.get('access_token')!;
    expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).aal).toBe('aal1');
    const list = await callAdminFunction('platform-admin', { bearer: token }, { action: 'list' });
    expect([list.status, code(list)]).toEqual([403, 'mfa_required']);
  });
});

describe('no way around the one-time link: public sign-up stays closed', () => {
  it('Auth refuses a public sign-up (no account, no mail), so only the link can create an owner', async () => {
    const mail = email('nolink');
    const total = await mailTotal();
    const { data, error } = await anon().auth.signUp({ email: mail, password: password() });
    expect(error?.code).toBe('signup_disabled');
    expect(data.user).toBeNull();
    expect(await userByEmail(mail)).toBeNull();
    await new Promise((r) => setTimeout(r, 1000));
    expect(await mailsTo(mail)).toHaveLength(0);
    expect(await mailTotal()).toBe(total);
  });

  it('the registration endpoint creates no account for a token that is not a live link', async () => {
    const mail = email('guess');
    const res = await register(randomBytes(32).toString('base64url'), mail, password());
    expect([res.status, code(res)]).toEqual([404, 'invite_invalid']);
    expect(await userByEmail(mail)).toBeNull();
  });
});
