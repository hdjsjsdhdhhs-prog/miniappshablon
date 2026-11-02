// Stage-2 security PoC: hand-over / transfer of shops, account states (F-01, F-08), revocation of former owners.
// LOCAL ONLY. Invitation e-mails go to the local Mailpit of this project's stack ([inbucket] port); no real mail is sent.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localStack } from '../../../scripts/lib/local-stack.ts';
import { mockMessages } from '../../../scripts/lib/telegram-mock.ts';
import {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  fakeBotToken,
  initDataFor,
  newTelegramUserId,
  track,
  waitFor,
  type Db,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, PNG, psqlAsync, sleep, svcRpc, svcRpcActsIn } from './sec-helpers';

const MAILPIT = localStack().mailUrl;
const REDIRECT = 'http://127.0.0.1:5173/admin/set-password';
const tag = randomBytes(3).toString('hex');
const email = (kind: string) => `${kind}-${tag}-${randomBytes(2).toString('hex')}@it.local`;

// aal2 platform admin (20261102090000). Direct service-role RPCs act in its MFA session (`pa.svc`, svcRpc) exactly
// like the platform-admin Edge Function; calls for any other actor are still refused by the SQL.
let pa: PlatformAdmin;

beforeAll(async () => {
  pa = await createPlatformAdmin();
  svcRpcActsIn(pa.sessionId);
});
afterAll(async () => {
  // Users created by inviteUserByEmail inside the Edge Function are not tracked by helpers: find them by tag.
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of data.users) if (u.email?.includes(`-${tag}-`)) track('user', u.id);
  await cleanupSecurity();
});

const demoShop = () => createTestShop({ isDemo: true, variants: [{ flavor: 'Mint', stock: 5 }] });
const handover = (shop: TestShop, to: string, redirectTo = REDIRECT) =>
  callAdminFunction('platform-admin', pa.client, { action: 'handover', shopId: shop.id, email: to, redirectTo });

async function owners(shopId: string) {
  const { data } = await admin.from('shop_memberships').select('user_id, role').eq('shop_id', shopId);
  return data ?? [];
}

async function createAccount(kind: string, confirmed: boolean) {
  const e = email(kind);
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email: e, password, email_confirm: confirmed });
  if (error) throw error;
  track('user', data.user.id);
  return { id: data.user.id, email: e, password };
}

async function shopState(shopId: string) {
  const { data } = await admin.from('shops').select('is_demo, mode').eq('id', shopId).single();
  return data;
}

type MailSearch = { messages: Array<{ ID: string }>; messages_count?: number };
async function mails(to: string): Promise<MailSearch> {
  return (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json()) as MailSearch;
}

/**
 * What the client does: opens the newest invitation e-mail in the local Mailpit and follows its link. Supabase Auth
 * verifies the one-time token and confirms the e-mail (exactly like in production); nothing is set by the test.
 */
async function acceptInvitation(to: string): Promise<void> {
  const found = await waitFor(() => mails(to), (r) => r.messages.length > 0);
  const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${found.messages[0]!.ID}`)).json()) as { HTML: string; Text: string };
  const link = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(`${msg.HTML}\n${msg.Text}`)?.[0]?.replace(/&amp;/g, '&');
  expect(link, 'invitation link').toBeTruthy();
  const res = await fetch(link!, { redirect: 'manual' });
  expect([302, 303]).toContain(res.status);
  expect(res.headers.get('location') ?? '').toContain('access_token=');
}

describe('F-01: hand-over against every account state (regression; was [VULN F-01])', () => {
  it('self-registered, UNCONFIRMED account (own password, invited_at = null) → refused, no owner, no invitation, still DEMO', async () => {
    const S = await demoShop();
    const attacker = await createAccount('selfsignup', false);
    const res = await handover(S, attacker.email);
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('owner_unconfirmed');
    expect(await owners(S.id)).toEqual([]);
    expect(await shopState(S.id)).toEqual({ is_demo: true, mode: 'live' });
    expect((await mails(attacker.email)).messages).toHaveLength(0);
    const { data: u } = await admin.auth.admin.getUserById(attacker.id);
    expect(u.user!.invited_at ?? null).toBeNull();
  });

  it('account that only FORMALLY has invited_at (self-registered with a password, invited later) → still refused', async () => {
    const S = await demoShop();
    const attacker = await createAccount('formal', false);
    // Someone (e.g. an earlier hand-over attempt) invited the self-registered account: invited_at is now set.
    expect((await admin.auth.admin.inviteUserByEmail(attacker.email, { redirectTo: REDIRECT })).error).toBeNull();
    const { data: u } = await admin.auth.admin.getUserById(attacker.id);
    expect(u.user!.invited_at).toBeTruthy();
    const res = await handover(S, attacker.email);
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('owner_unconfirmed');
    // Direct SQL with a forged invitation status cannot skip the check either.
    for (const inv of ['sent', 'link', 'existing']) {
      const rpc = await pa.svc.rpc('platform_handover_shop', { p_actor: pa.userId, p_shop_id: S.id, p_new_owner: attacker.id, p_invitation: inv });
      expect(rpc.error?.message, inv).toBe('owner_unconfirmed');
    }
    expect(await owners(S.id)).toEqual([]);
  });

  it('existing confirmed account → completed now ("existing"): only owner, live, no e-mail needed', async () => {
    const S = await demoShop();
    const acc = await createAccount('confirmed', true);
    const res = await handover(S, acc.email);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body!.invitation as { status: string }).status).toBe('existing');
    expect((res.body!.handover as { status: string }).status).toBe('completed');
    expect(await owners(S.id)).toEqual([{ user_id: acc.id, role: 'owner' }]);
    expect(await shopState(S.id)).toEqual({ is_demo: false, mode: 'live' });
  });

  it('existing confirmed account that already owns another shop → completed, both shops owned', async () => {
    const other = await createTestShop();
    const S = await demoShop();
    const acc = await createAccount('multi', true);
    await admin.from('shop_memberships').insert({ shop_id: other.id, user_id: acc.id, role: 'owner' });
    expect((await handover(S, acc.email)).status).toBe(200);
    const { data } = await admin.from('shop_memberships').select('shop_id').eq('user_id', acc.id);
    expect(data!.map((r) => r.shop_id).sort()).toEqual([other.id, S.id].sort());
  });

  it('new e-mail → invitation sent, hand-over PENDING (shop stays DEMO, no owner) until the client confirms the e-mail', async () => {
    const S = await demoShop();
    const e = email('invitee');
    const res = await handover(S, e);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body!.invitation as { status: string }).status).toBe('sent');
    const h = res.body!.handover as { status: string; owner: { user_id: string; email: string } };
    expect(h.status).toBe('pending');
    expect(h.owner.email).toBe(e);
    expect(await owners(S.id)).toEqual([]);
    expect(await shopState(S.id)).toEqual({ is_demo: true, mode: 'live' });
    const check = await callAdminFunction('platform-admin', pa.client, { action: 'handover-check', shopId: S.id });
    expect((check.body!.check as { pending_handover: { email: string } }).pending_handover.email).toBe(e);

    // The client follows the e-mail link → Supabase confirms the address → the hand-over completes by itself.
    await acceptInvitation(e);
    expect(await owners(S.id)).toEqual([{ user_id: h.owner.user_id, role: 'owner' }]);
    expect(await shopState(S.id)).toEqual({ is_demo: false, mode: 'live' });
    const list = (await callAdminFunction('platform-admin', pa.client, { action: 'list' })).body!.shops as Array<{ id: string; pending_handover: unknown; last_handover_at: string | null }>;
    const row = list.find((s) => s.id === S.id)!;
    expect(row.pending_handover).toBeNull();
    expect(row.last_handover_at).not.toBeNull();
  });

  it('re-sending the invitation (invited, not activated) keeps the same account and the pending state; a second e-mail is sent', async () => {
    const S = await demoShop();
    const e = email('resend');
    const first = await handover(S, e);
    const userId = (first.body!.handover as { owner: { user_id: string } }).owner.user_id;
    await waitFor(() => mails(e), (r) => r.messages.length >= 1);
    // The re-send cooldown (60 s, 20261101090000) has passed.
    await ageInvitations(S.id, 61);
    const second = await handover(S, e);
    expect(second.status).toBe(200);
    expect(second.body!.handover).toMatchObject({ status: 'pending', owner: { user_id: userId } });
    expect((await waitFor(() => mails(e), (r) => r.messages.length >= 2)).messages.length).toBeGreaterThanOrEqual(2);
    expect(await owners(S.id)).toEqual([]);
    // The same invited account in another shop: also pending only.
    const S2 = await demoShop();
    expect(((await handover(S2, e)).body!.handover as { status: string }).status).toBe('pending');
    expect(await owners(S2.id)).toEqual([]);
  });

  it('a pending hand-over blocks a different target until cancelled; a cancelled one is never completed', async () => {
    const S = await demoShop();
    const [e1, e2] = [email('p1'), email('p2')];
    expect(((await handover(S, e1)).body!.handover as { status: string }).status).toBe('pending');
    const other = await handover(S, e2);
    expect(other.status).toBe(409);
    expect(other.body!.error).toMatchObject({ code: 'handover_pending', details: { email: e1 } });
    const cancel = await callAdminFunction('platform-admin', pa.client, { action: 'handover-cancel', shopId: S.id });
    expect(cancel.body).toEqual({ cancelled: true });
    await acceptInvitation(e1);
    expect(await owners(S.id)).toEqual([]);
    expect(await shopState(S.id)).toEqual({ is_demo: true, mode: 'live' });
    // Now the other client can get it.
    expect(((await handover(S, e2)).body!.handover as { status: string }).status).toBe('pending');
  });

  it('client-side tampering is ignored: forged ids / flags in the body change nothing', async () => {
    const S = await demoShop();
    const attacker = await createAccount('tamper', false);
    const res = await callAdminFunction('platform-admin', pa.client, {
      action: 'handover', shopId: S.id, email: attacker.email, redirectTo: REDIRECT,
      userId: attacker.id, p_new_owner: attacker.id, p_invitation: 'existing', invitation: 'existing',
      email_confirmed: true, emailConfirmedAt: new Date().toISOString(), state: 'confirmed', p_actor: pa.userId,
    });
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('owner_unconfirmed');
    expect(await owners(S.id)).toEqual([]);
  });

  it('alternative SQL paths enforce the same rules (transfer and hand-over RPCs, service role)', async () => {
    const S = await demoShop();
    const unconfirmed = await createAccount('sqlalt', false);
    expect((await pa.svc.rpc('platform_handover_shop', { p_actor: pa.userId, p_shop_id: S.id, p_new_owner: unconfirmed.id, p_invitation: 'existing' })).error?.message).toBe('owner_unconfirmed');
    expect((await pa.svc.rpc('platform_transfer_shop', { p_actor: pa.userId, p_shop_id: S.id, p_new_owner: unconfirmed.id })).error?.message).toBe('owner_unconfirmed');
    expect((await pa.svc.rpc('platform_transfer_shop', { p_actor: pa.userId, p_shop_id: S.id, p_new_owner: pa.userId })).error?.message).toBe('owner_is_platform_admin');
    // Without the admin's aal2 session the same call is refused (20261102090000).
    expect((await admin.rpc('platform_transfer_shop', { p_actor: pa.userId, p_shop_id: S.id, p_new_owner: unconfirmed.id })).error?.message).toBe('mfa_required');
    // A non-admin actor id is refused before anything else.
    expect((await pa.svc.rpc('platform_transfer_shop', { p_actor: unconfirmed.id, p_shop_id: S.id, p_new_owner: unconfirmed.id })).error?.message).toBe('forbidden');
    expect(await owners(S.id)).toEqual([]);
  });

  it('platform admin as target is refused by hand-over (negative control for F-08)', async () => {
    const S = await demoShop();
    const res = await handover(S, pa.email);
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('owner_is_platform_admin');
    expect(await owners(S.id)).toEqual([]);
  });

  it('[INFO] redirectTo with a foreign host passes the Edge Function schema; Auth falls back to its allow-list', async () => {
    const S = await demoShop();
    const e = email('redirect');
    const res = await handover(S, e, 'https://evil.example/admin/set-password');
    expect(res.status).toBe(200);
    const search = await waitFor(
      async () => (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${e}"`)}`)).json()) as { messages: Array<{ ID: string }> },
      (r) => r.messages.length > 0,
    );
    const msg = (await (await fetch(`${MAILPIT}/api/v1/message/${search.messages[0]!.ID}`)).json()) as { HTML: string; Text: string };
    const body = `${msg.HTML}\n${msg.Text}`;
    const hasEvil = body.includes('evil.example');
    console.log('[redirect] invite link contains evil.example:', hasEvil);
    expect(hasEvil).toBe(false);
  });
});

describe('repeated / concurrent hand-over', () => {
  it('a second hand-over of the same shop is refused (not_demo)', async () => {
    const S = await demoShop();
    expect((await handover(S, (await createAccount('c1', true)).email)).status).toBe(200);
    const again = await handover(S, (await createAccount('c2', true)).email);
    expect(again.status).toBe(409);
    expect(again.body!.error).toMatchObject({ code: 'shop_not_ready', details: ['not_demo'] });
  });

  it.each([2, 5])(
    'S2-06 (regression; was [VULN S2-06]): %i parallel hand-overs to different new e-mails → one reservation wins; losers get 409 and create NO account and NO invitation',
    async (n) => {
      const S = await demoShop();
      const emails = Array.from({ length: n }, (_, i) => email(`race${i}`));
      const res = await Promise.all(emails.map((e) => handover(S, e)));
      const won = res.map((r, i) => ({ r, e: emails[i]! })).filter((x) => x.r.status === 200);
      const lost = res.map((r, i) => ({ r, e: emails[i]! })).filter((x) => x.r.status !== 200);
      expect(won, JSON.stringify(res.map((r) => r.body))).toHaveLength(1);
      expect(lost).toHaveLength(n - 1);
      for (const { r } of lost) {
        expect(r.status).toBe(409);
        // in_progress: the winner still held the reservation; pending: it had already finished. Both are refused in
        // platform_reserve_handover, i.e. BEFORE Supabase Auth.
        expect(['handover_in_progress', 'handover_pending']).toContain((r.body!.error as { code: string }).code);
      }
      const winner = won[0]!;
      expect((winner.r.body!.invitation as { status: string }).status).toBe('sent');
      expect(winner.r.body!.handover).toMatchObject({ status: 'pending', owner: { email: winner.e } });

      // DB: exactly one account for all n e-mails (the winner's), one pending (winner), no reservation left over.
      expect(await accountsFor(emails)).toEqual([winner.e]);
      expect(await pendingOf(S.id)).toEqual([{ email: winner.e }]);
      expect(await reservationsOf(S.id)).toEqual([]);
      expect(await eventsOf(S.id, 'handover_pending')).toBe(1);
      // Invitations: exactly one, to the winner; none to any loser.
      expect((await waitFor(() => mails(winner.e), (m) => m.messages.length > 0)).messages).toHaveLength(1);
      for (const { e } of lost) expect((await mails(e)).messages, e).toHaveLength(0);

      // F-01: the shop does not change hands before the invitation is accepted …
      expect(await owners(S.id)).toEqual([]);
      expect(await shopState(S.id)).toEqual({ is_demo: true, mode: 'live' });
      if (n !== 2) return;
      // … and after it only the winner owns it.
      await acceptInvitation(winner.e);
      const winnerId = (winner.r.body!.handover as { owner: { user_id: string } }).owner.user_id;
      expect(await owners(S.id)).toEqual([{ user_id: winnerId, role: 'owner' }]);
      expect(await shopState(S.id)).toEqual({ is_demo: false, mode: 'live' });
      expect(await accountsFor(emails)).toEqual([winner.e]);
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------
// S2-06: the reservation (private.shop_handover_reservations, 20261031090000) — deterministic scenarios. A request
// "in flight" is simulated with the same RPCs the Edge Function calls, in the same order.
// ---------------------------------------------------------------------------------------------------------------

/** E-mails (of `list`) that have an account in auth.users, sorted. */
async function accountsFor(list: string[]): Promise<string[]> {
  const r = await psqlAsync(`select coalesce(string_agg(lower(email), ',' order by lower(email)), '') from auth.users
    where lower(email) in (${list.map((e) => `'${e.toLowerCase()}'`).join(',')});`);
  if (r.code !== 0) throw new Error(r.err);
  return r.out ? r.out.split(',') : [];
}

async function pendingOf(shopId: string): Promise<Array<{ email: string }>> {
  const { data } = await pa.svc.rpc('platform_handover_check', { p_actor: pa.userId, p_shop_id: shopId });
  const p = (data as { pending_handover: { email: string } | null }).pending_handover;
  return p ? [{ email: p.email }] : [];
}

type Reservation = { email: string; token: string; lease_sec: number; live: boolean };
async function reservationsOf(shopId: string): Promise<Reservation[]> {
  const r = await psqlAsync(`select coalesce(json_agg(json_build_object('email', email, 'token', token,
      'lease_sec', extract(epoch from expires_at - created_at)::int, 'live', expires_at > now())), '[]')
    from private.shop_handover_reservations where shop_id = '${shopId}';`);
  if (r.code !== 0) throw new Error(r.err);
  return JSON.parse(r.out) as Reservation[];
}

async function eventsOf(shopId: string, action: string): Promise<number> {
  const r = await psqlAsync(`select count(*) from private.shop_lifecycle_events where shop_id = '${shopId}' and action = '${action}';`);
  if (r.code !== 0) throw new Error(r.err);
  return Number(r.out);
}

/** What happens after the Edge Function died / the lease ran out: moves the reservation into the past. */
async function expireReservation(shopId: string): Promise<void> {
  const r = await psqlAsync(`update private.shop_handover_reservations
    set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where shop_id = '${shopId}';`);
  if (r.code !== 0) throw new Error(r.err);
}

const reserve = (shopId: string, to: string) => svcRpc('platform_reserve_handover', { p_actor: pa.userId, p_shop_id: shopId, p_email: to });
const finalize = (shopId: string, userId: string, token: string | null, invitation = 'sent') =>
  svcRpc('platform_handover_shop', { p_actor: pa.userId, p_shop_id: shopId, p_new_owner: userId, p_invitation: invitation, p_reservation: token });
const release = (shopId: string, token: string) => svcRpc('platform_release_handover', { p_actor: pa.userId, p_shop_id: shopId, p_token: token });

async function reserved(shopId: string, to: string): Promise<string> {
  const r = await reserve(shopId, to);
  expect(r.error).toBeNull();
  return (r.data as { token: string }).token;
}

/**
 * Makes Supabase Auth fail for e-mails containing `marker`: a BEFORE INSERT trigger on auth.users (local DB only,
 * own schema, removed afterwards) — GoTrue then answers inviteUserByEmail AND generateLink with a database error,
 * exactly like an Auth outage would look to the Edge Function. Nothing in the code under test is mocked.
 */
async function withAuthFailure<T>(marker: string, fn: () => Promise<T>): Promise<T> {
  const up = await psqlAsync(`create schema it_s206;
    create function it_s206.refuse() returns trigger language plpgsql as $f$
    begin
      if new.email like '%${marker}%' then raise exception 'it_s206: simulated auth failure'; end if;
      return new;
    end $f$;
    create trigger it_s206_refuse before insert on auth.users for each row execute function it_s206.refuse();`);
  if (up.code !== 0) throw new Error(`auth failure injection: ${up.err}`);
  return fn().finally(async () => {
    const down = await psqlAsync('drop trigger if exists it_s206_refuse on auth.users; drop schema if exists it_s206 cascade;');
    if (down.code !== 0) throw new Error(`auth failure injection cleanup: ${down.err}`);
  });
}

describe('S2-06: one hand-over per shop, reserved before any Auth call', () => {
  it('while a request holds the reservation (inside Auth), another e-mail is refused BEFORE Auth: 409, no account, no invitation; the holder finishes', async () => {
    const S = await demoShop();
    const [e1, e2] = [email('hold1'), email('hold2')];
    const token = await reserved(S.id, e1); // request #1 is now "inside" inviteUserByEmail
    const [lease] = await reservationsOf(S.id);
    expect(lease).toMatchObject({ email: e1, token, live: true });

    const loser = await handover(S, e2);
    expect(loser.status).toBe(409);
    expect(loser.body!.error).toMatchObject({ code: 'handover_in_progress', details: { email: e1 } });
    expect(await accountsFor([e2])).toEqual([]);
    expect((await mails(e2)).messages).toHaveLength(0);
    expect((await reservationsOf(S.id)).map((r) => r.token)).toEqual([token]); // the loser did not touch it

    // Request #1 continues exactly like the Edge Function: Auth, then the final RPC with its token.
    const invited = await admin.auth.admin.inviteUserByEmail(e1, { redirectTo: REDIRECT });
    expect(invited.error).toBeNull();
    track('user', invited.data.user!.id);
    const done = await finalize(S.id, invited.data.user!.id, token);
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ status: 'pending', owner: { email: e1 } });
    expect(await reservationsOf(S.id)).toEqual([]); // consumed in the same transaction
    expect(await pendingOf(S.id)).toEqual([{ email: e1 }]);
    expect(await owners(S.id)).toEqual([]);
    // Now e2 is refused by the pending hand-over — still before Auth.
    const again = await handover(S, e2);
    expect(again.body!.error).toMatchObject({ code: 'handover_pending', details: { email: e1 } });
    expect(await accountsFor([e2])).toEqual([]);
  });

  it('Supabase Auth failure → 502 invite_failed, the reservation is released at once (shop not blocked), no account, no pending', async () => {
    const S = await demoShop();
    const failing = email(`s206authfail${tag}`);
    const res = await withAuthFailure(`s206authfail${tag}`, () => handover(S, failing));
    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect((res.body!.error as { code: string }).code).toBe('invite_failed');
    expect(await reservationsOf(S.id)).toEqual([]);
    expect(await pendingOf(S.id)).toEqual([]);
    expect(await accountsFor([failing])).toEqual([]);
    expect((await mails(failing)).messages).toHaveLength(0);
    expect(await owners(S.id)).toEqual([]);
    // No waiting for the lease: the next hand-over goes through immediately.
    const next = email('afterfail');
    const ok = await handover(S, next);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body!.handover).toMatchObject({ status: 'pending', owner: { email: next } });
    expect(await reservationsOf(S.id)).toEqual([]);
  });

  it('crash right after the reservation: the lease is bounded (10 min); while live everyone gets 409, after it the shop is free', async () => {
    const S = await demoShop();
    const [e1, e2] = [email('crash1'), email('crash2')];
    await reserved(S.id, e1); // …and the Edge Function died
    const [r] = await reservationsOf(S.id);
    expect(r!.lease_sec).toBe(600);
    for (const e of [e1, e2]) {
      const res = await handover(S, e);
      expect(res.status, e).toBe(409);
      expect((res.body!.error as { code: string }).code).toBe('handover_in_progress');
    }
    expect(await accountsFor([e1, e2])).toEqual([]);
    await expireReservation(S.id);
    const res = await handover(S, e2);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.handover).toMatchObject({ status: 'pending', owner: { email: e2 } });
    expect(await reservationsOf(S.id)).toEqual([]);
    expect(await accountsFor([e1, e2])).toEqual([e2]);
  });

  it('crash after the invitation (final RPC never ran): repeating the request reuses the invited account — no duplicate; the stale token is dead', async () => {
    const S = await demoShop();
    const e = email('crashinv');
    const stale = await reserved(S.id, e);
    const invited = await admin.auth.admin.inviteUserByEmail(e, { redirectTo: REDIRECT });
    expect(invited.error).toBeNull();
    track('user', invited.data.user!.id);
    // …the Edge Function died here. No pending, nobody owns the shop.
    expect(await pendingOf(S.id)).toEqual([]);
    expect(await owners(S.id)).toEqual([]);
    await expireReservation(S.id);

    const res = await handover(S, e);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.handover).toMatchObject({ status: 'pending', owner: { user_id: invited.data.user!.id, email: e } });
    expect(await accountsFor([e])).toEqual([e]);
    const r = await psqlAsync(`select count(*) from auth.users where lower(email) = '${e}';`);
    expect(r.out).toBe('1');
    // The crashed request can never finish later with its old token.
    expect((await finalize(S.id, invited.data.user!.id, stale)).error?.message).toBe('handover_reservation_lost');
    expect((await release(S.id, stale)).data).toBe(false);
    expect(await pendingOf(S.id)).toEqual([{ email: e }]);
  });

  it('identical request: a duplicate in flight → 409 with no second account / invitation; a later repeat → same account, one pending (explicit re-send)', async () => {
    const S = await demoShop();
    const e = email('dup');
    const token = await reserved(S.id, e); // the first request is inside Auth
    const dup = await handover(S, e);
    expect(dup.status).toBe(409);
    expect((dup.body!.error as { code: string }).code).toBe('handover_in_progress');
    expect(await accountsFor([e])).toEqual([]);
    expect((await mails(e)).messages).toHaveLength(0);
    expect((await release(S.id, token)).data).toBe(true);

    const first = await handover(S, e);
    expect(first.status).toBe(200);
    const userId = (first.body!.handover as { owner: { user_id: string } }).owner.user_id;
    expect((await waitFor(() => mails(e), (m) => m.messages.length >= 1)).messages).toHaveLength(1);
    await ageInvitations(S.id, 61); // after the 60 s re-send cooldown
    const repeat = await handover(S, e);
    expect(repeat.status).toBe(200);
    expect(repeat.body!.handover).toMatchObject({ status: 'pending', owner: { user_id: userId } });
    expect(await accountsFor([e])).toEqual([e]);
    expect(await pendingOf(S.id)).toEqual([{ email: e }]);
    expect(await reservationsOf(S.id)).toEqual([]);
    // The re-send is the existing "send the invitation again" feature: one more e-mail to the SAME account.
    expect((await waitFor(() => mails(e), (m) => m.messages.length >= 2)).messages).toHaveLength(2);
  });

  it('identical requests in parallel: one account; exactly one invitation; every refusal happens before Auth (409 in progress / 429 cooldown)', async () => {
    const S = await demoShop();
    const e = email('dupp');
    const res = await Promise.all([handover(S, e), handover(S, e), handover(S, e)]);
    const ok = res.filter((r) => r.status === 200);
    // A request that reserved after the winner finished is refused by the 60 s re-send cooldown (20261101090000).
    expect(ok, JSON.stringify(res.map((r) => r.body))).toHaveLength(1);
    for (const r of res.filter((x) => x.status !== 200)) {
      expect([409, 429]).toContain(r.status);
      expect((r.body!.error as { code: string }).code).toBe(r.status === 409 ? 'handover_in_progress' : 'invitation_rate_limited');
    }
    expect(await invitationSends(S.id, e)).toBe(1);
    expect(new Set(ok.map((r) => (r.body!.handover as { owner: { user_id: string } }).owner.user_id)).size).toBe(1);
    expect(await accountsFor([e])).toEqual([e]);
    expect(await pendingOf(S.id)).toEqual([{ email: e }]);
    expect(await reservationsOf(S.id)).toEqual([]);
    expect((await waitFor(() => mails(e), (m) => m.messages.length >= ok.length)).messages).toHaveLength(ok.length);
  });

  it('different shops are handed over independently, in parallel', async () => {
    const [A, B] = await Promise.all([demoShop(), demoShop()]);
    const [ea, eb] = [email('inda'), email('indb')];
    const [ra, rb] = await Promise.all([handover(A, ea), handover(B, eb)]);
    expect([ra.status, rb.status], JSON.stringify([ra.body, rb.body])).toEqual([200, 200]);
    expect(await pendingOf(A.id)).toEqual([{ email: ea }]);
    expect(await pendingOf(B.id)).toEqual([{ email: eb }]);
    expect(await accountsFor([ea, eb])).toEqual([ea, eb].sort());
    // A reservation of one shop does not block another.
    const C = await demoShop();
    const D = await demoShop();
    await reserved(C.id, email('indc'));
    const rd = await handover(D, email('indd'));
    expect(rd.status).toBe(200);
  });

  it('no path bypasses a live reservation: direct hand-over / transfer RPCs are refused; a token is valid only for its shop and e-mail', async () => {
    const S = await demoShop();
    const other = await demoShop();
    const e = email('bypass');
    const token = await reserved(S.id, e);
    const acc = await createAccount('bypassconf', true);
    expect((await finalize(S.id, acc.id, null, 'existing')).error?.message).toBe('handover_in_progress');
    expect((await pa.svc.rpc('platform_handover_shop', { p_actor: pa.userId, p_shop_id: S.id, p_new_owner: acc.id, p_invitation: 'existing' })).error?.message).toBe('handover_in_progress');
    const tr = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: acc.id });
    expect(tr.status).toBe(409);
    expect((tr.body!.error as { code: string }).code).toBe('handover_in_progress');
    // The token belongs to e, not to acc; and to S, not to `other`.
    expect((await finalize(S.id, acc.id, token, 'existing')).error?.message).toBe('handover_reservation_mismatch');
    expect((await finalize(other.id, acc.id, token, 'existing')).error?.message).toBe('handover_reservation_lost');
    // Someone else's token cannot release it; a non-admin actor cannot reserve or release.
    expect((await release(S.id, '00000000-0000-4000-8000-000000000000')).data).toBe(false);
    expect((await svcRpc('platform_reserve_handover', { p_actor: acc.id, p_shop_id: other.id, p_email: e })).error?.message).toBe('forbidden');
    expect((await svcRpc('platform_release_handover', { p_actor: acc.id, p_shop_id: S.id, p_token: token })).error?.message).toBe('forbidden');
    expect((await reservationsOf(S.id)).map((r) => r.token)).toEqual([token]);
    expect(await owners(S.id)).toEqual([]);
    expect(await shopState(S.id)).toEqual({ is_demo: true, mode: 'live' });
    // Readiness and admin rights are checked by the reservation itself.
    const notDemo = await createTestShop();
    expect((await reserve(notDemo.id, e)).error?.message).toBe('shop_not_ready');
    expect((await release(S.id, token)).data).toBe(true);
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: acc.id })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Invitation re-send cooldown (20261101090000): per (shop, normalized e-mail) one invitation per 60 s, five per hour.
// The counter is private.handover_invitation_sends; "waiting" is simulated by moving its rows into the past.
// ---------------------------------------------------------------------------------------------------------------

/** Moves every recorded invitation of the shop `seconds` into the past (what waiting does). */
async function ageInvitations(shopId: string, seconds: number): Promise<void> {
  const r = await psqlAsync(`update private.handover_invitation_sends set sent_at = sent_at - make_interval(secs => ${seconds})
    where shop_id = '${shopId}';`);
  if (r.code !== 0) throw new Error(r.err);
}

async function invitationSends(shopId: string, to: string): Promise<number> {
  const r = await psqlAsync(`select count(*) from private.handover_invitation_sends
    where shop_id = '${shopId}' and email = '${to.toLowerCase()}' and sent_at > now() - interval '1 hour';`);
  if (r.code !== 0) throw new Error(r.err);
  return Number(r.out);
}

/** Sets the shop's only recorded invitation to exactly `seconds` ago. */
async function lastInvitationAgo(shopId: string, seconds: number): Promise<void> {
  const r = await psqlAsync(`update private.handover_invitation_sends set sent_at = clock_timestamp() - make_interval(secs => ${seconds})
    where shop_id = '${shopId}' returning id;`);
  if (r.code !== 0) throw new Error(r.err);
  expect(r.out.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
}

async function oldestInvitationAgeSec(shopId: string, to: string): Promise<number> {
  const r = await psqlAsync(`select extract(epoch from clock_timestamp() - min(sent_at)) from private.handover_invitation_sends
    where shop_id = '${shopId}' and email = '${to.toLowerCase()}' and sent_at > now() - interval '1 hour';`);
  if (r.code !== 0) throw new Error(r.err);
  return Number(r.out);
}

async function accountCount(to: string): Promise<number> {
  const r = await psqlAsync(`select count(*) from auth.users where lower(email) = '${to.toLowerCase()}';`);
  if (r.code !== 0) throw new Error(r.err);
  return Number(r.out);
}

/** GoTrue's own per-address resend guard (auth.email.max_frequency = 1s locally) must not interfere. */
const pastAuthFrequency = () => sleep(1100);

type Limited = { code: string; details: { reason: string; retry_after_sec: number; limit: number; cooldown_sec: number; window_sec: number } };

/** Expects a 429 refusal and that nothing else changed (no e-mail, no reservation, one account, same pending). */
async function expectLimited(res: Awaited<ReturnType<typeof handover>>, S: TestShop, to: string, mailsBefore: number, reason: 'cooldown' | 'hourly') {
  expect(res.status, JSON.stringify(res.body)).toBe(429);
  const err = res.body!.error as Limited;
  expect(err.code).toBe('invitation_rate_limited');
  expect(err.details).toMatchObject({ reason, limit: 5, cooldown_sec: 60, window_sec: 3600 });
  expect(Number.isInteger(err.details.retry_after_sec) && err.details.retry_after_sec >= 1).toBe(true);
  expect(res.headers.get('retry-after')).toBe(String(err.details.retry_after_sec));
  expect(await reservationsOf(S.id)).toEqual([]); // released in `finally`
  expect(await accountCount(to)).toBe(1);
  await sleep(1500); // an e-mail sent by mistake would have reached Mailpit by now
  expect((await mails(to)).messages).toHaveLength(mailsBefore);
  return err.details;
}

describe('invitation re-send cooldown (per shop + e-mail: 1 per 60 s, 5 per hour)', () => {
  it('a second invitation at 0 s and at 59 s is refused (429, Retry-After); after 60 s it is sent again', async () => {
    const S = await demoShop();
    const e = email('cool');
    const first = await handover(S, e);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const userId = (first.body!.handover as { owner: { user_id: string } }).owner.user_id;
    expect((await waitFor(() => mails(e), (m) => m.messages.length >= 1)).messages).toHaveLength(1);
    expect(await invitationSends(S.id, e)).toBe(1);

    await pastAuthFrequency();
    const now = await expectLimited(await handover(S, e), S, e, 1, 'cooldown');
    expect(now.retry_after_sec).toBeGreaterThan(50);
    expect(now.retry_after_sec).toBeLessThanOrEqual(61);
    // Normalized e-mail: upper case is the same counter.
    await expectLimited(await handover(S, e.toUpperCase()), S, e, 1, 'cooldown');

    await lastInvitationAgo(S.id, 59);
    const late = await expectLimited(await handover(S, e), S, e, 1, 'cooldown');
    expect(late.retry_after_sec).toBeLessThanOrEqual(2);
    // DB: still one counted invitation, the same pending hand-over to the same account; nobody owns the shop.
    expect(await invitationSends(S.id, e)).toBe(1);
    expect(await pendingOf(S.id)).toEqual([{ email: e }]);
    expect(await owners(S.id)).toEqual([]);

    await lastInvitationAgo(S.id, 61);
    const again = await handover(S, e);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body!.handover).toMatchObject({ status: 'pending', owner: { user_id: userId } });
    expect((again.body!.invitation as { status: string }).status).toBe('sent');
    expect((await waitFor(() => mails(e), (m) => m.messages.length >= 2)).messages).toHaveLength(2);
    expect(await invitationSends(S.id, e)).toBe(2);
    expect(await accountCount(e)).toBe(1);
    expect(await reservationsOf(S.id)).toEqual([]);
  });

  it('the sixth invitation within an hour is refused (Retry-After until the oldest leaves the hour); afterwards it is sent again', async () => {
    const S = await demoShop();
    const e = email('hour');
    for (let i = 1; i <= 5; i++) {
      if (i > 1) {
        await ageInvitations(S.id, 61);
        await pastAuthFrequency();
      }
      const res = await handover(S, e);
      expect(res.status, `send #${i}: ${JSON.stringify(res.body)}`).toBe(200);
      expect((res.body!.invitation as { status: string }).status, `send #${i}`).toBe('sent');
    }
    expect((await waitFor(() => mails(e), (m) => m.messages.length >= 5)).messages).toHaveLength(5);
    expect(await invitationSends(S.id, e)).toBe(5);

    // Cooldown over, but 5 invitations in the last hour (the oldest 305 s ago).
    await ageInvitations(S.id, 61);
    await pastAuthFrequency();
    const sixth = await expectLimited(await handover(S, e), S, e, 5, 'hourly');
    const oldestAge = await oldestInvitationAgeSec(S.id, e);
    expect(oldestAge).toBeGreaterThanOrEqual(305);
    expect(Math.abs(sixth.retry_after_sec - (3600 - oldestAge))).toBeLessThanOrEqual(3);
    expect(await invitationSends(S.id, e)).toBe(5);

    // The oldest invitation leaves the one-hour window → one more is allowed.
    await ageInvitations(S.id, sixth.retry_after_sec + 1);
    const later = await handover(S, e);
    expect(later.status, JSON.stringify(later.body)).toBe(200);
    expect((await waitFor(() => mails(e), (m) => m.messages.length >= 6)).messages).toHaveLength(6);
    expect(await invitationSends(S.id, e)).toBe(5); // 4 still inside the hour + this one
    expect(await accountCount(e)).toBe(1);
    expect(await pendingOf(S.id)).toEqual([{ email: e }]);
  });

  it('another e-mail and another shop are not affected by the limit of (shop, e-mail)', async () => {
    const [S, other] = await Promise.all([demoShop(), demoShop()]);
    const [e1, e2] = [email('lim1'), email('lim2')];
    expect((await handover(S, e1)).status).toBe(200);
    await waitFor(() => mails(e1), (m) => m.messages.length >= 1);
    await pastAuthFrequency();
    await expectLimited(await handover(S, e1), S, e1, 1, 'cooldown');

    // The same e-mail, another shop: its own counter.
    const otherShop = await handover(other, e1);
    expect(otherShop.status, JSON.stringify(otherShop.body)).toBe(200);
    expect(otherShop.body!.handover).toMatchObject({ status: 'pending', owner: { email: e1 } });
    expect(await invitationSends(other.id, e1)).toBe(1);

    // Another e-mail, the same shop (after the pending hand-over to e1 is withdrawn — that rule is unrelated).
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'handover-cancel', shopId: S.id })).body).toEqual({ cancelled: true });
    const otherMail = await handover(S, e2);
    expect(otherMail.status, JSON.stringify(otherMail.body)).toBe(200);
    expect(otherMail.body!.handover).toMatchObject({ status: 'pending', owner: { email: e2 } });
    expect((await waitFor(() => mails(e2), (m) => m.messages.length >= 1)).messages).toHaveLength(1);
    expect(await invitationSends(S.id, e2)).toBe(1);
    // Cancelling does not reset the counter of (S, e1).
    expect(await invitationSends(S.id, e1)).toBe(1);

    // A transfer of a shop, and a hand-over to a confirmed account (no invitation), are never limited.
    const live = await createTestShop();
    const acc = await createAccount('limconf', true);
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: live.id, userId: acc.id })).status).toBe(200);
    const third = await demoShop();
    expect((await handover(third, acc.email)).status).toBe(200);
    expect((await handover(other, acc.email)).status).toBe(409); // pending to e1 there — not a rate limit
    expect(await invitationSends(third.id, acc.email)).toBe(0);
  });

  it('claim RPC: only the reservation holder (platform admin) may claim; the counter is not in process memory', async () => {
    const S = await demoShop();
    const e = email('claim');
    const token = await reserved(S.id, e);
    const claim = (actor: string, tok: string | null) => svcRpc('platform_claim_handover_invitation', { p_actor: actor, p_shop_id: S.id, p_reservation: tok });
    const outsider = await createAccount('claimer', true);
    expect((await claim(outsider.id, token)).error?.message).toBe('forbidden');
    expect((await claim(pa.userId, '00000000-0000-4000-8000-000000000000')).error?.message).toBe('handover_reservation_lost');
    expect((await claim(pa.userId, null)).error?.message).toBe('handover_reservation_lost');
    expect(await invitationSends(S.id, e)).toBe(0);
    expect((await claim(pa.userId, token)).error).toBeNull();
    // A second claim (any process, any connection) sees the first one in the table.
    const second = await claim(pa.userId, token);
    expect(second.error?.message).toBe('invitation_rate_limited');
    expect(await invitationSends(S.id, e)).toBe(1);
    expect((await release(S.id, token)).data).toBe(true);
    // A signed-in user cannot call it through PostgREST at all.
    const owner = await createOwner(S.id);
    const direct = await owner.client.rpc('platform_claim_handover_invitation' as never, { p_actor: pa.userId, p_shop_id: S.id, p_reservation: token } as never);
    expect(direct.error?.message).toMatch(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Release of an EXPIRED ("stuck") reservation by the platform admin (20261101090000).
// ---------------------------------------------------------------------------------------------------------------

const releaseStale = (as: Db | null, shopId: string) => callAdminFunction('platform-admin', as, { action: 'handover-release-stale', shopId });

async function staleEvents(shopId: string): Promise<number> {
  const r = await psqlAsync(`select count(*) from private.shop_lifecycle_events
    where shop_id = '${shopId}' and action = 'handover_cancelled' and details ->> 'reason' = 'stale_reservation';`);
  if (r.code !== 0) throw new Error(r.err);
  return Number(r.out);
}

describe('stale hand-over reservation: release only after expiry, only by a platform admin', () => {
  it('handover-check reports the reservation (without its token) and the time left', async () => {
    const S = await demoShop();
    const e = email('state');
    await reserved(S.id, e);
    const check = (await callAdminFunction('platform-admin', pa.client, { action: 'handover-check', shopId: S.id })).body!.check as {
      reservation: Record<string, unknown>;
    };
    expect(check.reservation).toMatchObject({ email: e, expired: false });
    expect(Object.keys(check.reservation).sort()).toEqual(['created_at', 'email', 'expired', 'expires_at', 'remaining_sec']);
    expect(check.reservation.remaining_sec as number).toBeGreaterThan(590);
    expect(check.reservation.remaining_sec as number).toBeLessThanOrEqual(600);
    await expireReservation(S.id);
    const after = (await callAdminFunction('platform-admin', pa.client, { action: 'handover-check', shopId: S.id })).body!.check as {
      reservation: Record<string, unknown>;
    };
    expect(after.reservation).toMatchObject({ email: e, expired: true, remaining_sec: 0 });
    const none = await demoShop();
    expect(((await callAdminFunction('platform-admin', pa.client, { action: 'handover-check', shopId: none.id })).body!.check as { reservation: unknown }).reservation).toBeNull();
  });

  it('an ACTIVE reservation cannot be released (Edge Function and RPC): 409, the reservation and its token stay', async () => {
    const S = await demoShop();
    const token = await reserved(S.id, email('active'));
    const res = await releaseStale(pa.client, S.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body!.error).toMatchObject({ code: 'handover_reservation_active' });
    expect((res.body!.error as { details: { retry_after_sec: number } }).details.retry_after_sec).toBeGreaterThan(590);
    expect((await svcRpc('platform_release_stale_handover', { p_actor: pa.userId, p_shop_id: S.id })).error?.message).toBe('handover_reservation_active');
    expect((await reservationsOf(S.id)).map((r) => ({ token: r.token, live: r.live }))).toEqual([{ token, live: true }]);
    expect(await staleEvents(S.id)).toBe(0);

    // An expired reservation that was replaced by a new live one (another request reserved meanwhile) is kept too.
    await expireReservation(S.id);
    const fresh = await reserved(S.id, email('fresh'));
    expect((await releaseStale(pa.client, S.id)).status).toBe(409);
    expect((await reservationsOf(S.id)).map((r) => r.token)).toEqual([fresh]);
  });

  it('an EXPIRED reservation is released: row deleted, event recorded, the stale token is dead; a repeat is a no-op', async () => {
    const S = await demoShop();
    const e = email('expired');
    const stale = await reserved(S.id, e);
    await expireReservation(S.id);
    const res = await releaseStale(pa.client, S.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ released: true, email: e });
    expect(await reservationsOf(S.id)).toEqual([]);
    expect(await staleEvents(S.id)).toBe(1);
    const acc = await createAccount('stalefin', true);
    expect((await finalize(S.id, acc.id, stale, 'existing')).error?.message).toBe('handover_reservation_lost');
    expect(await owners(S.id)).toEqual([]);
    expect((await releaseStale(pa.client, S.id)).body).toEqual({ released: false });
    expect(await staleEvents(S.id)).toBe(1);
  });

  it('a user without platform admin rights cannot release it (Edge Function 403 / 401, RPC forbidden, PostgREST denied)', async () => {
    const S = await demoShop();
    const token = await reserved(S.id, email('nonadm'));
    await expireReservation(S.id);
    const owner = await createOwner(S.id);
    expect((await releaseStale(owner.client, S.id)).status).toBe(403);
    expect((await releaseStale(null, S.id)).status).toBe(401);
    expect((await svcRpc('platform_release_stale_handover', { p_actor: owner.userId, p_shop_id: S.id })).error?.message).toBe('forbidden');
    const direct = await owner.client.rpc('platform_release_stale_handover' as never, { p_actor: pa.userId, p_shop_id: S.id } as never);
    expect(direct.error?.message).toMatch(/permission denied/i);
    expect((await reservationsOf(S.id)).map((r) => r.token)).toEqual([token]);
    expect(await staleEvents(S.id)).toBe(0);
  });

  it('after releasing an expired reservation the hand-over (and a transfer) work again', async () => {
    const S = await demoShop();
    const [e1, e2] = [email('rel1'), email('rel2')];
    await reserved(S.id, e1); // …and the Edge Function died
    expect((await handover(S, e2)).status).toBe(409);
    await expireReservation(S.id);
    expect((await releaseStale(pa.client, S.id)).body).toMatchObject({ released: true });
    const res = await handover(S, e2);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body!.handover).toMatchObject({ status: 'pending', owner: { email: e2 } });
    expect(await pendingOf(S.id)).toEqual([{ email: e2 }]);
    expect(await reservationsOf(S.id)).toEqual([]);
    expect(await accountsFor([e1, e2])).toEqual([e2]);
    expect((await waitFor(() => mails(e2), (m) => m.messages.length >= 1)).messages).toHaveLength(1);
    // And a transfer of the same kind of stuck shop.
    const T = await demoShop();
    await reserved(T.id, email('rel3'));
    await expireReservation(T.id);
    expect((await releaseStale(pa.client, T.id)).body).toMatchObject({ released: true });
    const acc = await createAccount('reltr', true);
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: T.id, userId: acc.id })).status).toBe(200);
    expect(await owners(T.id)).toEqual([{ user_id: acc.id, role: 'owner' }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// handover-cancel vs. a LIVE reservation (20261101100000; regression — before it, handover-cancel dropped a live
// reservation and broke the lease of a request still inside Supabase Auth). Refused with 409, nothing changes; a
// pending hand-over is still cancelled the normal way; an expired reservation is left to handover-release-stale.
// ---------------------------------------------------------------------------------------------------------------

const cancelHandover = (as: Db | null, shopId: string) => callAdminFunction('platform-admin', as, { action: 'handover-cancel', shopId });

/** The reservation row exactly as stored (token, e-mail, requested_by, created_at, expires_at), or '' if none. */
async function reservationRow(shopId: string): Promise<string> {
  const r = await psqlAsync(`select coalesce((select row_to_json(r)::text from private.shop_handover_reservations r
    where r.shop_id = '${shopId}'), '');`);
  if (r.code !== 0) throw new Error(r.err);
  return r.out;
}

/** to_user_id of every handover_cancelled event of the shop that is NOT a stale-reservation release. */
async function cancelledPending(shopId: string): Promise<string[]> {
  const r = await psqlAsync(`select coalesce(string_agg(coalesce(details ->> 'to_user_id', '-'), ',' order by created_at), '')
    from private.shop_lifecycle_events
    where shop_id = '${shopId}' and action = 'handover_cancelled' and details ->> 'reason' is distinct from 'stale_reservation';`);
  if (r.code !== 0) throw new Error(r.err);
  return r.out ? r.out.split(',') : [];
}

describe('handover-cancel never removes a live reservation; pending hand-overs are still cancellable', () => {
  it('LIVE reservation: handover-cancel → 409 handover_reservation_active (Edge Function and RPC); row, token and lease unchanged; another e-mail still refused; the holder finishes', async () => {
    const S = await demoShop();
    const [e1, e2] = [email('keep1'), email('keep2')];
    const token = await reserved(S.id, e1); // request #1 is "inside" Supabase Auth
    const before = await reservationRow(S.id);
    expect(JSON.parse(before)).toMatchObject({ shop_id: S.id, token, email: e1, requested_by: pa.userId });

    const res = await cancelHandover(pa.client, S.id);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body!.error).toMatchObject({ code: 'handover_reservation_active', details: { email: e1 } });
    expect((res.body!.error as { details: { retry_after_sec: number } }).details.retry_after_sec).toBeGreaterThan(590);
    // Calling the service-role RPC directly is refused the same way: the guard is in SQL, not in the Edge Function.
    expect((await svcRpc('platform_cancel_handover', { p_actor: pa.userId, p_shop_id: S.id })).error?.message).toBe('handover_reservation_active');
    expect(await reservationRow(S.id)).toBe(before);
    expect(await eventsOf(S.id, 'handover_cancelled')).toBe(0);

    // A parallel request to another e-mail is still refused before Auth (the reservation was not freed).
    const loser = await handover(S, e2);
    expect(loser.status).toBe(409);
    expect(loser.body!.error).toMatchObject({ code: 'handover_in_progress', details: { email: e1 } });
    expect(await accountsFor([e2])).toEqual([]);
    expect((await mails(e2)).messages).toHaveLength(0);
    expect(await reservationRow(S.id)).toBe(before);

    // Request #1 continues exactly like the Edge Function and completes with its token.
    const invited = await admin.auth.admin.inviteUserByEmail(e1, { redirectTo: REDIRECT });
    expect(invited.error).toBeNull();
    track('user', invited.data.user!.id);
    const done = await finalize(S.id, invited.data.user!.id, token);
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ status: 'pending', owner: { email: e1 } });
    expect(await reservationsOf(S.id)).toEqual([]);
    expect(await pendingOf(S.id)).toEqual([{ email: e1 }]);
    expect(await eventsOf(S.id, 'handover_pending')).toBe(1);
    expect(await eventsOf(S.id, 'handover_cancelled')).toBe(0);
    expect(await owners(S.id)).toEqual([]);
    await acceptInvitation(e1);
    expect(await owners(S.id)).toEqual([{ user_id: invited.data.user!.id, role: 'owner' }]);
    expect(await shopState(S.id)).toEqual({ is_demo: false, mode: 'live' });
    expect(await accountsFor([e1, e2])).toEqual([e1]);
  });

  it('race: a reservation committed while handover-cancel waits for the shop lock is seen → 409, nothing removed', async () => {
    const S = await demoShop();
    const e = email('racecnl');
    const marker = `it_cancel_race_${tag}_${randomBytes(2).toString('hex')}`;
    // Another session reserves the shop and keeps the shops row lock for 2 s before committing.
    // Same request context PostgREST gives the Edge Function's call: service role + the admin's aal2 session.
    const holder = psqlAsync(`begin;
      select set_config('request.jwt.claims', '{"role":"service_role"}', true),
             set_config('request.headers', '{"x-platform-session":"${pa.sessionId}"}', true);
      select public.platform_reserve_handover('${pa.userId}', '${S.id}', '${e}') is not null;
      select pg_sleep(2) as ${marker};
      commit;`);
    const seen = await waitFor(
      async () => (await psqlAsync(`select count(*) from pg_stat_activity where query like '%${marker}%' and pid <> pg_backend_pid();`)).out,
      (n) => n === '1',
    );
    expect(seen, 'reserving session holds the lock').toBe('1');
    expect(await reservationRow(S.id)).toBe(''); // not committed yet

    const started = Date.now();
    const res = await cancelHandover(pa.client, S.id);
    const waited = Date.now() - started;
    const h = await holder;
    expect(h.code, h.err).toBe(0);
    expect(waited, 'cancel waited for the shops row lock').toBeGreaterThan(500);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body!.error).toMatchObject({ code: 'handover_reservation_active', details: { email: e } });
    expect((await reservationsOf(S.id)).map((r) => ({ email: r.email, live: r.live }))).toEqual([{ email: e, live: true }]);
    expect(await eventsOf(S.id, 'handover_cancelled')).toBe(0);
  });

  it('pending hand-over whose invitation is being re-sent (live reservation): cancel → 409, pending and reservation kept; once the request ends the normal cancel works', async () => {
    const S = await demoShop();
    const e = email('resendcnl');
    const first = await handover(S, e);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const userId = (first.body!.handover as { owner: { user_id: string } }).owner.user_id;
    const token = await reserved(S.id, e); // "send the invitation again" is in flight
    const before = await reservationRow(S.id);

    const refused = await cancelHandover(pa.client, S.id);
    expect(refused.status).toBe(409);
    expect((refused.body!.error as { code: string }).code).toBe('handover_reservation_active');
    expect(await pendingOf(S.id)).toEqual([{ email: e }]);
    expect(await reservationRow(S.id)).toBe(before);
    expect(await cancelledPending(S.id)).toEqual([]);

    // The re-send ended (here: failed and released its own lease, as the Edge Function does in `finally`).
    expect((await release(S.id, token)).data).toBe(true);
    const ok = await cancelHandover(pa.client, S.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ cancelled: true });
    expect(await pendingOf(S.id)).toEqual([]);
    expect(await cancelledPending(S.id)).toEqual([userId]);
    expect(await owners(S.id)).toEqual([]);
  });

  it('no reservation: the normal cancel of a pending hand-over still works (200, pending removed, one event); accepting the old invitation then gives nothing', async () => {
    const S = await demoShop();
    const e = email('plaincnl');
    const first = await handover(S, e);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const userId = (first.body!.handover as { owner: { user_id: string } }).owner.user_id;
    expect(await reservationsOf(S.id)).toEqual([]);

    const res = await cancelHandover(pa.client, S.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    expect(await pendingOf(S.id)).toEqual([]);
    expect(await cancelledPending(S.id)).toEqual([userId]);
    await acceptInvitation(e);
    expect(await owners(S.id)).toEqual([]);
    expect(await shopState(S.id)).toEqual({ is_demo: true, mode: 'live' });
    // A repeat is a no-op and logs nothing.
    expect((await cancelHandover(pa.client, S.id)).body).toEqual({ cancelled: false });
    expect(await cancelledPending(S.id)).toEqual([userId]);
  });

  it('EXPIRED reservation: handover-cancel leaves it alone ({ cancelled: false }); handover-release-stale clears it', async () => {
    const S = await demoShop();
    const stale = await reserved(S.id, email('expcnl'));
    await expireReservation(S.id);
    const before = await reservationRow(S.id);

    const res = await cancelHandover(pa.client, S.id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ cancelled: false });
    expect(await reservationRow(S.id)).toBe(before);
    expect(await eventsOf(S.id, 'handover_cancelled')).toBe(0);

    const rel = await releaseStale(pa.client, S.id);
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect(rel.body).toMatchObject({ released: true });
    expect(await reservationsOf(S.id)).toEqual([]);
    expect(await staleEvents(S.id)).toBe(1);
    expect(await cancelledPending(S.id)).toEqual([]);
    const acc = await createAccount('expcnlfin', true);
    expect((await finalize(S.id, acc.id, stale, 'existing')).error?.message).toBe('handover_reservation_lost');
  });

  it('a user without platform admin rights can neither cancel nor clear (Edge Function 403 / 401, RPC forbidden, PostgREST denied); nothing changes', async () => {
    const P = await demoShop(); // pending hand-over
    const e = email('nacnl');
    expect((await handover(P, e)).status).toBe(200);
    const R = await demoShop(); // expired reservation
    const token = await reserved(R.id, email('nacnlres'));
    await expireReservation(R.id);
    const before = await reservationRow(R.id);
    const owner = await createOwner(P.id);

    for (const shopId of [P.id, R.id]) {
      expect((await cancelHandover(owner.client, shopId)).status).toBe(403);
      expect((await cancelHandover(null, shopId)).status).toBe(401);
      expect((await releaseStale(owner.client, shopId)).status).toBe(403);
      expect((await releaseStale(null, shopId)).status).toBe(401);
      expect((await svcRpc('platform_cancel_handover', { p_actor: owner.userId, p_shop_id: shopId })).error?.message).toBe('forbidden');
      expect((await svcRpc('platform_release_stale_handover', { p_actor: owner.userId, p_shop_id: shopId })).error?.message).toBe('forbidden');
      const direct = await owner.client.rpc('platform_cancel_handover' as never, { p_actor: pa.userId, p_shop_id: shopId } as never);
      expect(direct.error?.message).toMatch(/permission denied/i);
    }
    expect(await pendingOf(P.id)).toEqual([{ email: e }]);
    expect(await reservationRow(R.id)).toBe(before);
    expect(JSON.parse(before)).toMatchObject({ token });
    expect(await eventsOf(P.id, 'handover_cancelled')).toBe(0);
    expect(await eventsOf(R.id, 'handover_cancelled')).toBe(0);
  });
});

describe('F-08: platform_transfer_shop applies the same account rules as hand-over (regression; was [VULN F-08])', () => {
  it('transfer to a platform admin is refused', async () => {
    const S = await createTestShop();
    const other = await createPlatformAdmin();
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: other.userId });
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('owner_is_platform_admin');
    expect(await owners(S.id)).toEqual([]);
  });

  it('transfer to an UNCONFIRMED or invited-only account is refused', async () => {
    const S = await createTestShop();
    const acc = await createAccount('unconfirmed', false);
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: acc.id });
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('owner_unconfirmed');
    const invited = await admin.auth.admin.inviteUserByEmail(email('tinv'), { redirectTo: REDIRECT });
    track('user', invited.data.user!.id);
    const res2 = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: invited.data.user!.id });
    expect((res2.body!.error as { code: string }).code).toBe('owner_unconfirmed');
    expect(await owners(S.id)).toEqual([]);
  });

  it('transfer to a confirmed account works; find-user reports the server-side state', async () => {
    const S = await createTestShop();
    const acc = await createAccount('tok', true);
    const found = await callAdminFunction('platform-admin', pa.client, { action: 'find-user', email: acc.email });
    expect(found.body!.user).toMatchObject({ user_id: acc.id, state: 'confirmed', email_confirmed: true });
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: acc.id });
    expect(res.status).toBe(200);
    expect(await owners(S.id)).toEqual([{ user_id: acc.id, role: 'owner' }]);
  });

  it('[INFO] transfer of a DEMO shop keeps it DEMO (switching to a real shop is the hand-over); a pending hand-over is dropped', async () => {
    const S = await demoShop();
    expect(((await handover(S, email('pend'))).body!.handover as { status: string }).status).toBe('pending');
    const acc = await createAccount('demotr', true);
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: acc.id });
    expect(res.status).toBe(200);
    expect(await shopState(S.id)).toEqual({ is_demo: true, mode: 'live' });
    const check = await callAdminFunction('platform-admin', pa.client, { action: 'handover-check', shopId: S.id });
    expect((check.body!.check as { pending_handover: unknown }).pending_handover).toBeNull();
  });

  it('non-admin cannot call transfer / handover (negative control)', async () => {
    const S = await createTestShop();
    const o = await createOwner(S.id);
    expect((await callAdminFunction('platform-admin', o.client, { action: 'transfer', shopId: S.id, userId: o.userId })).status).toBe(403);
    expect((await callAdminFunction('platform-admin', o.client, { action: 'list' })).status).toBe(403);
  });
});

describe('former owner keeps a valid JWT after transfer', () => {
  let S: TestShop;
  let former: { client: Db; userId: string };
  let orderId: string;

  beforeAll(async () => {
    S = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
    former = await createOwner(S.id);
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: 1 }]));
    orderId = (res.body!.order as { id: string }).id;
    const next = await createAccount('next', true);
    expect((await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: S.id, userId: next.id })).status).toBe(200);
  });

  it('the token still authenticates (no session revocation) …', async () => {
    const token = (await former.client.auth.getSession()).data.session!.access_token;
    const { data, error } = await admin.auth.getUser(token);
    expect(error).toBeNull();
    expect(data.user!.id).toBe(former.userId);
  });

  it('… but every data path re-checks membership: catalog, RPCs, orders, storage, notification settings', async () => {
    const db = former.client;
    const upd = await db.from('products').update({ name: 'pwned' }).eq('id', S.productId).select('id');
    expect(upd.data).toEqual([]);
    expect((await admin.from('products').select('name').eq('id', S.productId).single()).data!.name).not.toBe('pwned');
    expect((await db.rpc('admin_set_variant_stock', { p_variant_id: S.variants[0]!.id, p_quantity: 0 })).error?.message).toBe('variant_not_found');
    expect((await db.rpc('admin_set_order_status', { p_order_id: orderId, p_status: 'cancelled' })).error?.message).toBe('order_not_found');
    expect((await db.rpc('admin_delete_product', { p_product_id: S.productId })).error?.message).toBe('product_not_found');
    expect((await db.from('orders').select('id').eq('shop_id', S.id)).data).toEqual([]);
    expect((await db.from('shops').select('id').eq('id', S.id).eq('mode', 'preview')).data).toEqual([]);
    expect((await db.storage.from('shop-media').upload(`${S.id}/x/${tag}.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();
    expect((await callAdminFunction('notification-settings', db, { action: 'get', shopId: S.id })).status).toBe(403);
    expect((await db.from('shop_memberships').select('shop_id').eq('shop_id', S.id)).data).toEqual([]);
  });

  it('[INFO] the former owner can still change the account password with the old session (secure_password_change = false locally)', async () => {
    const { error } = await former.client.auth.updateUser({ password: randomBytes(12).toString('base64url') });
    console.log('[session] password change without re-auth:', error ? `refused (${error.message})` : 'allowed');
    expect(error).toBeNull();
  });
});

// S2-01 (fixed in 20261030090000). Was [VULN]: real orders went to the DEMO-era chat after the hand-over.
describe('hand-over drops the DEMO notification settings', () => {
  it('orders of the handed-over (now real) shop are NOT sent to the DEMO-era chat', async () => {
    const S = await demoShop();
    const operator = await createOwner(S.id); // whoever configured the DEMO shop (operator / demo owner)
    const demoChat = `@sec_demochat_${tag}`;
    expect((await callAdminFunction('notification-settings', operator.client, { action: 'save', shopId: S.id, botToken: fakeBotToken(), chatId: demoChat })).status).toBe(200);
    const client = await createAccount('client', true);
    expect((await handover(S, client.email)).status).toBe(200);
    const buyer = newTelegramUserId();
    const res = await callFunction('checkout', await initDataFor(buyer, { user: { first_name: 'Покупатель', username: `real${buyer}` } }), checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: 1 }], { fulfillment: { method: 'delivery', address: 'Реальный адрес 7' } }));
    expect(res.status).toBe(201);
    const msgs = await waitFor(() => mockMessages(demoChat), (m) => m.length > 0, 3000);
    expect(msgs).toEqual([]);
  });
});

it('anon cannot reach platform-admin (sanity)', async () => {
  const res = await callAdminFunction('platform-admin', null, { action: 'list' });
  expect(res.status).toBe(401);
  void anon;
});
