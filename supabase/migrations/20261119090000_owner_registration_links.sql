-- Self-registration of a shop owner by an individual, time-limited, one-time link (stage 4C).
--
-- Flow
--   1. A platform admin (aal2, 20261102090000) creates a link FOR ONE SHOP (platform_owner_link_create). The Edge
--      Function generates a 256-bit random token and sends only its SHA-256 to this function: the database never
--      sees the secret, only the hash is stored.
--   2. The buyer opens the link. The Edge Function `owner-registration` (service role, no user JWT) either
--        * registers a NEW account (Auth Admin API createUser with a confirmed e-mail: no confirmation mail is
--          sent, public sign-up stays switched off), or
--        * applies the link to an EXISTING signed-in account (claim).
--      Either way the shop changes hands in ONE SQL transaction (owner_invite_complete), which also consumes the link.
--
-- Why a reservation (PostgreSQL and Supabase Auth share no transaction)
--   The link is consumed ONLY by owner_invite_complete, in the same transaction that makes the account the owner. So
--   "link burnt, account missing" or "link burnt, no owner" cannot happen. Before the Auth account is created the Edge
--   Function reserves the shop (owner_invite_reserve) in private.shop_handover_reservations — the table the e-mail
--   hand-over already uses, so transfer / hand-over / deletion of the shop are refused while the registration is in
--   flight (handover_in_progress) and the other way round. The reservation has a 3 minute lease (an Edge Function
--   is cut off after 150 s); at most one registration per shop can hold it.
--   Partial failure that remains: the Auth account exists but the link was not consumed (crash between the two
--   steps). The link stays active; the buyer signs in and applies it to that account (claim). Nothing is lost.
--
-- Safety rules enforced here (the Edge Function cannot weaken them)
--   * one link = one shop = one registration: the shop id is stored with the hash and never taken from the request;
--   * at most ONE active link per shop (partial unique index); a new link revokes the previous one (reason 'replaced');
--   * expiry (48 h by default, at most 7 days), manual revocation, single use;
--   * the link stops working if the shop's members changed since it was issued (owner changed another way), if the shop
--     is suspended / being deleted, if a DEMO shop is no longer ready for hand-over, if another hand-over of the shop
--     is pending, or if the admin who issued it is no longer a platform admin;
--   * optional binding to an e-mail: only that address may register / claim;
--   * brute force: attempts are counted in PostgreSQL per IP hash and per token hash (owner_invite_throttle).
--   * a platform admin account can never become the owner (assert_shop_owner_eligible).
--
-- Ownership uses the existing machinery: a DEMO shop goes through private.complete_handover (same readiness, test
-- orders released, DEMO -> real live shop), any other shop through private.change_shop_owner('transfer'). Both make
-- the account the ONLY member, revoke the former owner's Telegram channel and bot, journal private.shop_transfers.
-- Catalog, orders, settings and Storage files are not touched.
--
-- Everything is service_role only; platform rights are re-checked inside (private.assert_platform_admin).

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

create table private.shop_owner_invites (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- SHA-256 (hex) of the token. The token itself is never stored or logged.
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Optional: only this (normalised) address may use the link.
  bound_email text check (bound_email is null or (char_length(bound_email) between 3 and 254 and bound_email = lower(btrim(bound_email)))),
  -- Members of the shop when the link was issued; the link works only while this is still the shop's member set.
  members_snapshot uuid[] not null default '{}',
  status text not null default 'active' check (status in ('active', 'used', 'revoked')),
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text check (revoked_reason in ('manual', 'replaced')),
  used_at timestamptz,
  used_by uuid references auth.users (id) on delete set null,
  used_email text,
  used_via text check (used_via in ('registration', 'claim')),
  check (expires_at > created_at and expires_at <= created_at + interval '7 days'),
  check ((status = 'revoked') = (revoked_at is not null)),
  check ((status = 'used') = (used_at is not null))
);
create unique index shop_owner_invites_one_active on private.shop_owner_invites (shop_id) where status = 'active';
create index shop_owner_invites_shop_idx on private.shop_owner_invites (shop_id, created_at desc);
revoke all on private.shop_owner_invites from public, anon, authenticated;

-- A registration in flight is a reservation of the shop (see header); remember which link holds it.
alter table private.shop_handover_reservations
  add column invite_id uuid references private.shop_owner_invites (id) on delete cascade;

alter table private.shop_lifecycle_events drop constraint shop_lifecycle_events_action_check;
alter table private.shop_lifecycle_events add constraint shop_lifecycle_events_action_check
  check (action in (
    'demo_created', 'demo_activated', 'handover', 'handover_pending', 'handover_cancelled', 'handover_failed',
    'owner_link_created', 'owner_link_replaced', 'owner_link_revoked', 'owner_link_used'
  ));

-- Attempt counter for the public endpoint. Keys are hashes (no raw IP address, no token) and carry no shop id.
create table private.owner_invite_attempts (
  id bigint generated always as identity primary key,
  scope text not null check (scope in ('ip_preview', 'ip_action', 'token_action')),
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index owner_invite_attempts_key_idx on private.owner_invite_attempts (scope, key_hash, created_at desc);
revoke all on private.owner_invite_attempts from public, anon, authenticated;

-- The links of a shop that is being deleted go with its data (the deletion verifies that no row with its shop_id is
-- left; this runs inside private.shop_delete_begin, which marks the shop 'deleting').
create or replace function private.shops_purge_owner_invites()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.shop_owner_invites where shop_id = new.id;
  return null;
end;
$$;

create trigger shops_purge_owner_invites
  after update of status on public.shops
  for each row
  when (new.status = 'deleting' and old.status is distinct from 'deleting')
  execute function private.shops_purge_owner_invites();

-- ---------------------------------------------------------------------------
-- 2. Helpers
-- ---------------------------------------------------------------------------

create or replace function private.owner_invite_reservation_lease()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '3 minutes' $$;

-- active | used | revoked | expired
create or replace function private.owner_invite_effective_status(p_invite private.shop_owner_invites)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_invite.status = 'used' then 'used'
    when p_invite.status = 'revoked' then 'revoked'
    when p_invite.expires_at <= now() then 'expired'
    else 'active'
  end;
$$;

create or replace function private.shop_member_ids(p_shop_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.user_id order by m.user_id), '{}'::uuid[])
  from public.shop_memberships m where m.shop_id = p_shop_id;
$$;

-- Raises unless an ACTIVE link may be used right now. Caller holds shops FOR UPDATE (or only reads, for the preview).
--   invite_used / invite_revoked / invite_expired — status of the link;
--   invite_unavailable (detail.reason) — the link is valid but the shop can no longer be handed over by it;
--   shop_busy — a hand-over of the shop is pending (it would be silently replaced).
create or replace function private.owner_invite_assert_usable(p_invite private.shop_owner_invites, p_shop public.shops)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text := private.owner_invite_effective_status(p_invite);
  v_problems jsonb;
begin
  if v_status <> 'active' then
    raise exception 'invite_%', v_status using errcode = 'P0001';
  end if;
  if p_shop.status <> 'active' then
    raise exception 'invite_unavailable' using errcode = 'P0001', detail = jsonb_build_object('reason', 'shop_not_active')::text;
  end if;
  if not private.is_platform_admin_user(p_invite.created_by) then
    raise exception 'invite_unavailable' using errcode = 'P0001', detail = jsonb_build_object('reason', 'issuer_not_admin')::text;
  end if;
  if private.shop_member_ids(p_shop.id) is distinct from p_invite.members_snapshot then
    raise exception 'invite_unavailable' using errcode = 'P0001', detail = jsonb_build_object('reason', 'owner_changed')::text;
  end if;
  if exists (select 1 from private.shop_pending_handovers h where h.shop_id = p_shop.id and h.expires_at > now()) then
    raise exception 'shop_busy' using errcode = 'P0001';
  end if;
  if p_shop.is_demo then
    v_problems := private.shop_handover_problems(p_shop);
    if jsonb_array_length(v_problems) > 0 then
      raise exception 'invite_unavailable' using errcode = 'P0001', detail = jsonb_build_object('reason', 'shop_not_ready')::text;
    end if;
  end if;
end;
$$;

-- What the platform admin sees about the newest link of a shop. Never the hash, never the token.
create or replace function private.owner_invite_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', private.owner_invite_effective_status(i),
    'created_at', i.created_at,
    'expires_at', i.expires_at,
    'created_by_email', (select u.email from auth.users u where u.id = i.created_by),
    'bound_email', i.bound_email,
    'used_at', i.used_at,
    'used_by', i.used_by,
    'used_email', i.used_email,
    'used_via', i.used_via,
    'revoked_at', i.revoked_at,
    'revoked_reason', i.revoked_reason,
    -- An active link that no longer matches the shop (owner changed another way): it will be refused.
    'stale', i.status = 'active' and private.shop_member_ids(i.shop_id) is distinct from i.members_snapshot,
    'in_progress', exists (
      select 1 from private.shop_handover_reservations r
      where r.shop_id = i.shop_id and r.invite_id = i.id and r.expires_at > now()
    )
  )
  from private.shop_owner_invites i
  where i.shop_id = p_shop_id
  order by i.created_at desc, i.id
  limit 1;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Platform admin: create / revoke (service_role only; aal2 platform admin re-checked inside)
-- ---------------------------------------------------------------------------

-- Creates the shop's link. The previous active link of THIS shop is revoked in the same transaction.
-- p_ttl_hours: 1..168, default 48 — long enough for a buyer to answer in a messenger within two days, short enough that
-- a forwarded or leaked link does not stay a way into the shop for long; the admin can always issue another one.
create or replace function public.platform_owner_link_create(
  p_actor uuid,
  p_shop_id uuid,
  p_token_hash text,
  p_bound_email text default null,
  p_ttl_hours integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_ttl integer := coalesce(p_ttl_hours, 48);
  v_email text := nullif(lower(btrim(coalesce(p_bound_email, ''))), '');
  v_problems jsonb;
  v_old uuid;
  v_new uuid;
begin
  perform private.assert_platform_admin(p_actor);
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_token_hash' using errcode = 'P0001';
  end if;
  if v_ttl not between 1 and 168 then
    raise exception 'invalid_ttl' using errcode = 'P0001';
  end if;
  if v_email is not null then
    if char_length(v_email) not between 3 and 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'invalid_email' using errcode = 'P0001';
    end if;
    -- The address of an administrator account can never own a shop.
    if exists (
      select 1 from auth.users u
      where lower(u.email) = v_email and private.is_platform_admin_user(u.id)
    ) then
      raise exception 'owner_is_platform_admin' using errcode = 'P0001';
    end if;
  end if;

  -- The lock every ownership change, reservation and hand-over takes.
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  if v_shop.status = 'deleting' then
    raise exception 'shop_deleting' using errcode = 'P0001';
  end if;
  if v_shop.status <> 'active' then
    raise exception 'shop_not_ready' using errcode = 'P0001', detail = '["shop_suspended"]';
  end if;
  -- A hand-over / registration request is in flight right now: let it finish (or expire) first.
  perform private.assert_no_live_handover_reservation(p_shop_id);
  if exists (select 1 from private.shop_pending_handovers h where h.shop_id = p_shop_id and h.expires_at > now()) then
    raise exception 'handover_pending' using errcode = 'P0001', detail = private.pending_handover_json(p_shop_id)::text;
  end if;
  if v_shop.is_demo then
    v_problems := private.shop_handover_problems(v_shop);
    if jsonb_array_length(v_problems) > 0 then
      raise exception 'shop_not_ready' using errcode = 'P0001', detail = v_problems::text;
    end if;
  end if;

  update private.shop_owner_invites
    set status = 'revoked', revoked_at = now(), revoked_by = p_actor, revoked_reason = 'replaced'
    where shop_id = p_shop_id and status = 'active'
    returning id into v_old;
  if v_old is not null then
    insert into private.shop_lifecycle_events (shop_id, action, actor, details)
    values (p_shop_id, 'owner_link_replaced', p_actor, jsonb_build_object('invite_id', v_old));
  end if;

  insert into private.shop_owner_invites (shop_id, token_hash, created_by, expires_at, bound_email, members_snapshot)
  values (p_shop_id, p_token_hash, p_actor, now() + make_interval(hours => v_ttl), v_email, private.shop_member_ids(p_shop_id))
  returning id into v_new;

  insert into private.shop_lifecycle_events (shop_id, action, actor, details)
  values (p_shop_id, 'owner_link_created', p_actor,
    jsonb_build_object('invite_id', v_new, 'ttl_hours', v_ttl, 'bound', v_email is not null, 'replaced', v_old));

  return jsonb_build_object('invite', private.owner_invite_json(p_shop_id));
end;
$$;

create or replace function public.platform_owner_link_revoke(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.assert_platform_admin(p_actor);
  perform 1 from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  -- A registration holds the shop right now: revoking under it would either break its lease or be undone when it
  -- finishes (same rule as handover-cancel).
  perform private.assert_no_live_handover_reservation(p_shop_id);
  update private.shop_owner_invites
    set status = 'revoked', revoked_at = now(), revoked_by = p_actor, revoked_reason = 'manual'
    where shop_id = p_shop_id and status = 'active'
    returning id into v_id;
  if v_id is not null then
    insert into private.shop_lifecycle_events (shop_id, action, actor, details)
    values (p_shop_id, 'owner_link_revoked', p_actor, jsonb_build_object('invite_id', v_id));
  end if;
  return jsonb_build_object('revoked', v_id is not null, 'invite', private.owner_invite_json(p_shop_id));
end;
$$;

-- Unchanged from 20261102090200 plus the `owner_invite` key.
create or replace function public.platform_list_shops(p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor);
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id,
      'slug', s.slug,
      'name', s.name,
      'mode', s.mode,
      'status', s.status,
      'is_demo', s.is_demo,
      'logo_path', s.logo_path,
      'delivery_enabled', s.delivery_enabled,
      'pickup_enabled', s.pickup_enabled,
      'created_at', s.created_at,
      'published_at', s.published_at,
      'last_transfer_at', (select max(t.created_at) from private.shop_transfers t where t.shop_id = s.id),
      'last_handover_at', (select max(t.created_at) from private.shop_transfers t where t.shop_id = s.id and t.kind = 'handover'),
      'members', private.shop_members_json(s.id),
      'notifications', (
        select jsonb_build_object('enabled', n.enabled, 'status', n.status)
        from private.shop_notification_settings n where n.shop_id = s.id
      ),
      'pending_handover', private.pending_handover_json(s.id),
      'deletion', private.shop_deletion_json(s.id),
      'owner_invite', private.owner_invite_json(s.id)
    ) order by s.created_at desc, s.slug), '[]'::jsonb)
    from public.shops s
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Public endpoint support (service_role only; no actor: the token is the credential)
-- ---------------------------------------------------------------------------

-- Counts one attempt and refuses (rate_limited, detail.retry_after_sec) once the limit of the window is reached.
-- p_key is a SHA-256 hex computed by the Edge Function (of the client IP or of the token); the count is taken under
-- an advisory lock of the key, so parallel requests cannot all slip under the limit.
create or replace function public.owner_invite_throttle(p_scope text, p_key text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_window interval := interval '15 minutes';
  v_count integer;
  v_oldest timestamptz;
begin
  v_limit := case p_scope when 'ip_preview' then 60 when 'ip_action' then 20 when 'token_action' then 10 end;
  if v_limit is null or p_key is null or p_key !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_throttle' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('owner-invite-throttle:' || p_scope || ':' || p_key, 0));
  delete from private.owner_invite_attempts a where a.scope = p_scope and a.key_hash = p_key and a.created_at <= clock_timestamp() - v_window;
  select count(*), min(a.created_at) into v_count, v_oldest
  from private.owner_invite_attempts a where a.scope = p_scope and a.key_hash = p_key;
  if v_count >= v_limit then
    raise exception 'rate_limited' using errcode = 'P0001', detail = jsonb_build_object(
      'retry_after_sec', greatest(1, ceil(extract(epoch from (v_oldest + v_window - clock_timestamp()))))::integer,
      'limit', v_limit, 'window_sec', 900
    )::text;
  end if;
  insert into private.owner_invite_attempts (scope, key_hash) values (p_scope, p_key);
  -- Housekeeping of keys nobody uses any more.
  if random() < 0.02 then
    delete from private.owner_invite_attempts a where a.created_at <= clock_timestamp() - interval '1 day';
  end if;
  return jsonb_build_object('count', v_count + 1, 'limit', v_limit);
end;
$$;

-- What the registration page may show for a token. A token that does not exist is just 'invalid'.
create or replace function public.owner_invite_preview(p_token_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv private.shop_owner_invites%rowtype;
  v_shop public.shops%rowtype;
  v_status text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into v_inv from private.shop_owner_invites where token_hash = p_token_hash;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_status := private.owner_invite_effective_status(v_inv);
  if v_status <> 'active' then
    -- Nothing about the shop is revealed for a link that can no longer be used.
    return jsonb_build_object('status', v_status);
  end if;
  select * into v_shop from public.shops where id = v_inv.shop_id;
  begin
    perform private.owner_invite_assert_usable(v_inv, v_shop);
  exception when others then
    if sqlerrm = 'shop_busy' then
      return jsonb_build_object('status', 'busy');
    end if;
    return jsonb_build_object('status', 'unavailable');
  end;
  if exists (select 1 from private.shop_handover_reservations r where r.shop_id = v_shop.id and r.expires_at > now()) then
    return jsonb_build_object('status', 'busy');
  end if;
  return jsonb_build_object(
    'status', 'active',
    'shop', jsonb_build_object('name', v_shop.name, 'logo_path', v_shop.logo_path),
    'email_bound', v_inv.bound_email is not null,
    'expires_at', v_inv.expires_at
  );
end;
$$;

-- Step 1 of a registration / claim: validates everything and reserves the shop for p_email. p_user_id: the existing
-- account of a claim (its eligibility is checked here as well, before anything else happens).
create or replace function public.owner_invite_reserve(p_token_hash text, p_email text, p_user_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
  v_shop_id uuid;
  v_shop public.shops%rowtype;
  v_inv private.shop_owner_invites%rowtype;
  v_res private.shop_handover_reservations%rowtype;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  if char_length(v_email) not between 3 and 254 or position('@' in v_email) = 0 then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;
  select i.id, i.shop_id into v_id, v_shop_id from private.shop_owner_invites i where i.token_hash = p_token_hash;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  -- Same order as every ownership change: the shops row first, then the link.
  select * into v_shop from public.shops where id = v_shop_id for update;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  select * into v_inv from private.shop_owner_invites where id = v_id for update;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  perform private.owner_invite_assert_usable(v_inv, v_shop);
  if v_inv.bound_email is not null and v_inv.bound_email <> v_email then
    raise exception 'invite_email_mismatch' using errcode = 'P0001';
  end if;
  if p_user_id is not null then
    if not exists (select 1 from auth.users u where u.id = p_user_id and lower(u.email) = v_email) then
      raise exception 'user_not_found' using errcode = 'P0001';
    end if;
    perform private.assert_shop_owner_eligible(p_user_id, false);
  elsif private.is_platform_admin_user((select u.id from auth.users u where lower(u.email) = v_email limit 1)) then
    raise exception 'owner_is_platform_admin' using errcode = 'P0001';
  end if;
  -- One operation per shop: any live reservation (another registration, an e-mail hand-over, a duplicate) refuses this.
  perform private.assert_no_live_handover_reservation(v_shop.id);

  insert into private.shop_handover_reservations as r (shop_id, token, email, requested_by, created_at, expires_at, invite_id)
  values (v_shop.id, gen_random_uuid(), v_email, v_inv.created_by, now(), now() + private.owner_invite_reservation_lease(), v_inv.id)
  on conflict (shop_id) do update set
    token = excluded.token, email = excluded.email, requested_by = excluded.requested_by,
    created_at = excluded.created_at, expires_at = excluded.expires_at, invite_id = excluded.invite_id
  returning * into v_res;

  return jsonb_build_object('reservation', v_res.token, 'expires_at', v_res.expires_at);
end;
$$;

-- Drops the caller's own reservation after a failed attempt. Never someone else's.
create or replace function public.owner_invite_release(p_token_hash text, p_reservation uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from private.shop_handover_reservations r
  where r.token = p_reservation
    and r.invite_id = (select i.id from private.shop_owner_invites i where i.token_hash = p_token_hash);
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- Step 2: ONE transaction — re-validates the link and the reservation, makes the account the shop's only owner (the
-- existing hand-over / transfer routines) and consumes the link. Either all of it happens or none of it.
-- p_via: 'registration' (an account just created by the Edge Function) or 'claim' (an existing signed-in account).
create or replace function public.owner_invite_complete(p_token_hash text, p_reservation uuid, p_user_id uuid, p_via text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_shop_id uuid;
  v_shop public.shops%rowtype;
  v_inv private.shop_owner_invites%rowtype;
  v_res private.shop_handover_reservations%rowtype;
  v_change jsonb;
  v_updated integer;
  v_email text;
begin
  if p_via is null or p_via not in ('registration', 'claim') then
    raise exception 'invalid_via' using errcode = 'P0001';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  select i.id, i.shop_id into v_id, v_shop_id from private.shop_owner_invites i where i.token_hash = p_token_hash;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  select * into v_shop from public.shops where id = v_shop_id for update;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;
  select * into v_inv from private.shop_owner_invites where id = v_id for update;
  if not found then
    raise exception 'invite_invalid' using errcode = 'P0001';
  end if;

  -- A second request for a link that has just been used lands here (invite_used), never further.
  perform private.owner_invite_assert_usable(v_inv, v_shop);

  select * into v_res from private.shop_handover_reservations
    where shop_id = v_shop.id and token = p_reservation and invite_id = v_inv.id and expires_at > now();
  if not found then
    raise exception 'handover_reservation_lost' using errcode = 'P0001';
  end if;
  select lower(u.email) into v_email from auth.users u where u.id = p_user_id;
  if v_email is null or v_email <> v_res.email then
    raise exception 'handover_reservation_mismatch' using errcode = 'P0001';
  end if;
  if v_inv.bound_email is not null and v_inv.bound_email <> v_email then
    raise exception 'invite_email_mismatch' using errcode = 'P0001';
  end if;
  -- confirmed, not blocked, not a platform admin
  perform private.assert_shop_owner_eligible(p_user_id, false);

  delete from private.shop_handover_reservations where shop_id = v_shop.id;

  if v_shop.is_demo then
    v_change := private.complete_handover(v_shop.id, p_user_id, v_inv.created_by, 'registration_link', false);
  else
    v_change := private.change_shop_owner(v_shop.id, p_user_id, v_inv.created_by, 'transfer',
      jsonb_build_object('source', 'owner_link', 'invite_id', v_inv.id));
  end if;

  update private.shop_owner_invites
    set status = 'used', used_at = now(), used_by = p_user_id, used_email = v_email, used_via = p_via
    where id = v_inv.id and status = 'active';
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    raise exception 'invite_used' using errcode = 'P0001';
  end if;

  if (select count(*) from public.shop_memberships where shop_id = v_shop.id) <> 1
     or not exists (select 1 from public.shop_memberships where shop_id = v_shop.id and user_id = p_user_id and role = 'owner') then
    raise exception 'transfer_verification_failed' using errcode = 'P0001';
  end if;

  insert into private.shop_lifecycle_events (shop_id, action, actor, details)
  values (v_shop.id, 'owner_link_used', p_user_id, jsonb_build_object(
    'invite_id', v_inv.id, 'via', p_via, 'email', v_email, 'issued_by', v_inv.created_by, 'was_demo', v_shop.is_demo));

  return jsonb_build_object(
    'status', 'completed',
    'shop', (select jsonb_build_object('slug', s.slug, 'name', s.name) from public.shops s where s.id = v_shop.id),
    'via', p_via
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. EXECUTE: service_role only
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.platform_owner_link_create(uuid, uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.platform_owner_link_revoke(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_list_shops(uuid) from public, anon, authenticated;
revoke all on function public.owner_invite_throttle(text, text) from public, anon, authenticated;
revoke all on function public.owner_invite_preview(text) from public, anon, authenticated;
revoke all on function public.owner_invite_reserve(text, text, uuid) from public, anon, authenticated;
revoke all on function public.owner_invite_release(text, uuid) from public, anon, authenticated;
revoke all on function public.owner_invite_complete(text, uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.platform_owner_link_create(uuid, uuid, text, text, integer) to service_role;
grant execute on function public.platform_owner_link_revoke(uuid, uuid) to service_role;
grant execute on function public.platform_list_shops(uuid) to service_role;
grant execute on function public.owner_invite_throttle(text, text) to service_role;
grant execute on function public.owner_invite_preview(text) to service_role;
grant execute on function public.owner_invite_reserve(text, text, uuid) to service_role;
grant execute on function public.owner_invite_release(text, uuid) to service_role;
grant execute on function public.owner_invite_complete(text, uuid, uuid, text) to service_role;
