-- Mandatory MFA (TOTP, Supabase Auth MFA) for platform admins, enforced by the database on EVERY path.
--
-- Before: a platform admin was anyone with a row in public.platform_admins. The password alone (aal1) opened
--   * every platform RPC (service role, Edge Function platform-admin → private.assert_platform_admin(p_actor)),
--   * the admin branch of notification settings (private.assert_can_manage_shop),
--   * every tenant table, the admin_* RPCs and Storage of EVERY shop through RLS (public.is_shop_member →
--     public.is_platform_admin()).
--
-- Now a platform admin is AUTHORIZED only while the request comes from one of their own Supabase Auth sessions that
-- reached aal2 (TOTP verified), checked against auth.sessions itself, not against anything the caller sends:
--   * user requests (PostgREST, RLS, Storage policies, admin_* RPCs): the JWT must be aal2 AND its session_id must be a
--     live aal2 session of that same user in auth.sessions (a signed-out / revoked session stops working at once,
--     not only when the access token expires);
--   * service-role RPCs (Edge Functions): the Edge Function forwards the session id of the verified access token in
--     the request header x-platform-session — only when that token is aal2. The header is honoured ONLY for the
--     service role (an end user cannot set it for themselves) and the session must again be a live aal2 session of
--     p_actor. A direct service-role call without a valid aal2 session of the actor is refused (mfa_required).
-- The account must also still exist, not be banned and own a verified MFA factor.
--
-- Enrollment: the standard Supabase Auth MFA endpoints (enroll / challenge / verify) work at aal1 as usual; nothing in
-- the database is opened by them. Until the session is aal2 a platform admin can read only their own platform_admins
-- row (to know that MFA is required) — no shop, no platform data, no platform operation.
--
-- Recovery: no bypass flag, no permanent exception. A lost authenticator is recovered by an operator who deletes the
-- admin's MFA factor (Supabase Dashboard → Authentication → Users → MFA factors, or `pnpm platform-admin:mfa-reset`,
-- which also signs the account out everywhere); the admin then signs in with the password and must enroll a new
-- factor before anything is allowed again. A second (backup) authenticator can be enrolled at aal2.
--
-- Separation of accounts: a platform admin account never holds a shop membership and a shop member never becomes a
-- platform admin (triggers below; hand-over / transfer already refused admins). Accounts that had both before this
-- migration keep their rows, but is_shop_member() ignores the membership of a platform admin account: such an account
-- reaches shops only as an aal2 platform admin.
--
-- The e-mail-confirmation trigger that completes a PENDING hand-over (private.complete_handover, p_pending_only) runs
-- inside GoTrue's own transaction, without any user request: it checks only that the admin who started the hand-over
-- (at aal2, see platform_handover_shop) still is a platform admin.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Session helpers
-- ---------------------------------------------------------------------------

-- Claims of the current PostgREST request (null outside PostgREST, e.g. GoTrue triggers or psql).
create or replace function private.request_claims()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  return nullif(current_setting('request.jwt.claims', true), '')::jsonb;
exception when others then
  return null;
end;
$$;

-- Session id forwarded by an Edge Function for the service role (x-platform-session). Ignored for any other role.
create or replace function private.request_platform_session()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v text;
begin
  if coalesce(private.request_claims() ->> 'role', '') <> 'service_role' then
    return null;
  end if;
  v := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-platform-session';
  if v ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

-- The session the current request acts in for p_actor: the forwarded one (service role) or the caller's own aal2 JWT.
create or replace function private.request_session_for(p_actor uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_claims jsonb := private.request_claims();
begin
  if p_actor is null or v_claims is null then
    return null;
  end if;
  if v_claims ->> 'role' = 'service_role' then
    return private.request_platform_session();
  end if;
  if v_claims ->> 'sub' = p_actor::text and v_claims ->> 'aal' = 'aal2' then
    return nullif(v_claims ->> 'session_id', '')::uuid;
  end if;
  return null;
exception when others then
  return null;
end;
$$;

-- True only for a live aal2 session of an existing, not banned account that owns a verified MFA factor.
create or replace function private.session_is_aal2(p_user uuid, p_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user is not null and p_session is not null
    and exists (
      select 1 from auth.users u
      where u.id = p_user and u.deleted_at is null and (u.banned_until is null or u.banned_until <= now())
    )
    and exists (
      select 1 from auth.sessions s
      where s.id = p_session and s.user_id = p_user and s.aal::text = 'aal2'
        and (s.not_after is null or s.not_after > now())
    )
    and exists (
      select 1 from auth.mfa_factors f where f.user_id = p_user and f.status::text = 'verified'
    );
$$;

-- Platform admin AND acting in an aal2 session right now.
create or replace function private.platform_admin_authorized(p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.is_platform_admin_user(p_actor)
    and private.session_is_aal2(p_actor, private.request_session_for(p_actor));
$$;

-- ---------------------------------------------------------------------------
-- 2. Authorization helpers used by every platform RPC (bodies unchanged elsewhere)
-- ---------------------------------------------------------------------------

-- forbidden: not a platform admin. mfa_required: a platform admin, but not in an aal2 session.
create or replace function private.assert_platform_admin(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin_user(p_actor) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if not private.platform_admin_authorized(p_actor) then
    raise exception 'mfa_required' using errcode = 'P0001';
  end if;
end;
$$;

-- Role only. Used solely by the e-mail-confirmation trigger (no user request exists there).
create or replace function private.assert_platform_admin_role(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not private.is_platform_admin_user(p_actor) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

-- Owner of the shop, or an aal2 platform admin. A platform admin account is never treated as an owner.
create or replace function private.assert_can_manage_shop(p_shop_id uuid, p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null or p_shop_id is null then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if private.is_platform_admin_user(p_actor) then
    if private.platform_admin_authorized(p_actor) then
      return;
    end if;
    raise exception 'mfa_required' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop_id and m.user_id = p_actor and m.role = 'owner'
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. RLS / Storage helpers
-- ---------------------------------------------------------------------------

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.platform_admin_authorized((select auth.uid()));
$$;

-- Members see their shops; a platform admin account sees shops ONLY as an aal2 platform admin (its own memberships,
-- if any survived from before 20261102090000, are ignored).
create or replace function public.is_shop_member(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    (
      not private.is_platform_admin_user((select auth.uid()))
      and exists (
        select 1 from public.shop_memberships m
        where m.shop_id = p_shop_id and m.user_id = (select auth.uid())
      )
    )
    or public.is_platform_admin()
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Pending hand-over completed on e-mail confirmation: role check only (see header)
-- ---------------------------------------------------------------------------

-- Unchanged from 20261030090000 except assert_platform_admin → assert_platform_admin_role in the p_pending_only branch.
create or replace function private.complete_handover(p_shop_id uuid, p_new_owner uuid, p_actor uuid, p_invitation text, p_pending_only boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_problems jsonb;
  v_change jsonb;
  v_test_orders integer;
  v_cancelled integer;
begin
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  if p_pending_only then
    if not exists (
      select 1 from private.shop_pending_handovers p
      where p.shop_id = p_shop_id and p.user_id = p_new_owner and p.expires_at > now()
    ) then
      return null;
    end if;
    -- The admin who started it (at aal2) must still be one. No user request exists inside GoTrue's transaction.
    perform private.assert_platform_admin_role(p_actor);
  end if;
  v_problems := private.shop_handover_problems(v_shop);
  if jsonb_array_length(v_problems) > 0 then
    raise exception 'shop_not_ready' using errcode = 'P0001', detail = v_problems::text;
  end if;
  perform private.assert_shop_owner_eligible(p_new_owner, false);

  v_cancelled := private.cancel_open_test_orders(p_shop_id, p_actor);
  select count(*) into v_test_orders from public.orders where shop_id = p_shop_id and is_test;

  v_change := private.change_shop_owner(p_shop_id, p_new_owner, p_actor, 'handover',
    jsonb_build_object('invitation', p_invitation, 'legacy_test_orders', v_test_orders, 'cancelled_test_orders', v_cancelled));

  update public.shops
    set is_demo = false, mode = 'live', published_at = coalesce(published_at, now())
    where id = p_shop_id
    returning * into v_shop;
  if v_shop.is_demo or v_shop.mode <> 'live' then
    raise exception 'transfer_verification_failed' using errcode = 'P0001';
  end if;

  insert into private.shop_lifecycle_events (shop_id, action, actor, details)
  values (p_shop_id, 'handover', p_actor, jsonb_build_object(
    'to_user_id', p_new_owner, 'invitation', p_invitation, 'legacy_test_orders', v_test_orders,
    'cancelled_test_orders', v_cancelled, 'notifications', v_change -> 'notifications'));

  return jsonb_build_object(
    'status', 'completed',
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'mode', v_shop.mode, 'is_demo', v_shop.is_demo),
    'owner', (select jsonb_build_object('user_id', u.id, 'email', u.email) from auth.users u where u.id = p_new_owner),
    'removed', v_change -> 'removed',
    'members', private.shop_members_json(p_shop_id),
    'invitation', p_invitation,
    'legacy_test_orders', v_test_orders,
    'cancelled_test_orders', v_cancelled,
    'notifications', v_change -> 'notifications',
    'transferred_at', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Platform admin accounts and client (owner / manager) accounts stay separate
-- ---------------------------------------------------------------------------

-- Both triggers take the same per-account advisory lock, so a concurrent "make admin" + "add membership" of one
-- account cannot both succeed.
create or replace function private.platform_admins_refuse_members()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('account-role:' || new.user_id::text, 0));
  if exists (select 1 from public.shop_memberships m where m.user_id = new.user_id) then
    raise exception 'platform_admin_has_memberships' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create or replace function private.memberships_refuse_platform_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('account-role:' || new.user_id::text, 0));
  if private.is_platform_admin_user(new.user_id) then
    raise exception 'owner_is_platform_admin' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger platform_admins_refuse_members
  before insert or update of user_id on public.platform_admins
  for each row execute function private.platform_admins_refuse_members();

create trigger shop_memberships_refuse_platform_admin
  before insert or update of user_id on public.shop_memberships
  for each row execute function private.memberships_refuse_platform_admin();

-- ---------------------------------------------------------------------------
-- 6. EXECUTE
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.is_platform_admin() from public, anon;
revoke all on function public.is_shop_member(uuid) from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;
grant execute on function public.is_shop_member(uuid) to authenticated, service_role;
