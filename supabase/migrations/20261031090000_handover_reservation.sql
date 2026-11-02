-- Atomic reservation of a hand-over BEFORE any Supabase Auth call (audit stage 3A: S2-06).
--
-- S2-06  platform-admin `handover` invited the client (inviteUserByEmail / generateLink: creates the account and sends
--        the e-mail) BEFORE platform_handover_shop took the shops row lock. Two parallel hand-overs of one DEMO shop to
--        different e-mails both created an account and both sent an invitation; only then did SQL refuse the loser.
--
-- Now the Edge Function first calls platform_reserve_handover: under shops FOR UPDATE (the lock every ownership change
-- takes) it re-checks the admin, readiness and a live pending hand-over to someone else, and records ONE reservation
-- per shop (primary key shop_id) with a random token and a short lease. Only the request holding the token may call
-- Auth and then platform_handover_shop(p_reservation), which accepts only that token for that e-mail and consumes the
-- reservation in the same transaction that records the pending / completed hand-over. Any other request — a
-- different e-mail, an identical duplicate, a transfer — is refused with handover_in_progress BEFORE touching Auth.
--
-- Recovery: the Edge Function releases its reservation on every failure (platform_release_handover). If it dies
-- between the reservation, the invitation and the final RPC, the lease expires (10 min, longer than the maximum
-- wall-clock time of an Edge Function, so a live request is never overtaken) and the shop is free again; the platform
-- admin can also drop it at once with handover-cancel. A repeat for the same e-mail after a crash reuses the invited
-- account (platform_find_user → state 'invited'), so no second account is created.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

create table private.shop_handover_reservations (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  token uuid not null default gen_random_uuid(),
  email text not null check (char_length(email) between 3 and 254 and email = lower(email)),
  requested_by uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '1 hour')
);
revoke all on private.shop_handover_reservations from public, anon, authenticated;

-- Lease of one reservation. Longer than an Edge Function can run (150 s free / 400 s paid wall clock).
create or replace function private.handover_reservation_lease()
returns interval
language sql
immutable
set search_path = ''
as $$ select interval '10 minutes' $$;

-- Raises handover_in_progress while a live reservation holds the shop. Caller holds shops FOR UPDATE.
create or replace function private.assert_no_live_handover_reservation(p_shop_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_res private.shop_handover_reservations%rowtype;
begin
  select * into v_res from private.shop_handover_reservations where shop_id = p_shop_id;
  if found and v_res.expires_at > now() then
    raise exception 'handover_in_progress' using errcode = 'P0001',
      detail = jsonb_build_object('email', v_res.email, 'expires_at', v_res.expires_at)::text;
  end if;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reserve / release (service_role only; platform admin re-checked inside)
-- ---------------------------------------------------------------------------

create or replace function public.platform_reserve_handover(p_actor uuid, p_shop_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_shop public.shops%rowtype;
  v_problems jsonb;
  v_pending record;
  v_res private.shop_handover_reservations%rowtype;
begin
  perform private.assert_platform_admin(p_actor);
  if char_length(v_email) not between 3 and 254 or position('@' in v_email) = 0 then
    raise exception 'invalid_email' using errcode = 'P0001';
  end if;
  -- The same lock as platform_handover_shop / platform_transfer_shop / platform_cancel_handover / complete_handover:
  -- parallel reservations of one shop run one after another and the second sees the first.
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  v_problems := private.shop_handover_problems(v_shop);
  if jsonb_array_length(v_problems) > 0 then
    raise exception 'shop_not_ready' using errcode = 'P0001', detail = v_problems::text;
  end if;

  -- A live pending hand-over to another client blocks the shop until it is cancelled (same rule and details as
  -- platform_handover_shop). A pending one to this very e-mail is a re-send of the invitation.
  select p.user_id, p.expires_at, lower(u.email) as email into v_pending
  from private.shop_pending_handovers p
  left join auth.users u on u.id = p.user_id
  where p.shop_id = p_shop_id;
  if found and v_pending.expires_at > now() and v_pending.email is distinct from v_email then
    raise exception 'handover_pending' using errcode = 'P0001',
      detail = jsonb_build_object('email', v_pending.email, 'expires_at', v_pending.expires_at)::text;
  end if;

  -- One operation per shop: any live reservation (another e-mail OR an identical duplicate) refuses this one.
  perform private.assert_no_live_handover_reservation(p_shop_id);

  insert into private.shop_handover_reservations (shop_id, token, email, requested_by, created_at, expires_at)
  values (p_shop_id, gen_random_uuid(), v_email, p_actor, now(), now() + private.handover_reservation_lease())
  on conflict (shop_id) do update set
    token = excluded.token, email = excluded.email, requested_by = excluded.requested_by,
    created_at = excluded.created_at, expires_at = excluded.expires_at
  returning * into v_res;

  return jsonb_build_object('token', v_res.token, 'email', v_res.email, 'expires_at', v_res.expires_at);
end;
$$;

-- Drops the caller's own reservation (after a failed invitation / hand-over). Never drops someone else's.
create or replace function public.platform_release_handover(p_actor uuid, p_shop_id uuid, p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  perform private.assert_platform_admin(p_actor);
  delete from private.shop_handover_reservations where shop_id = p_shop_id and token = p_token;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Hand-over: accepts only the holder of the reservation; consumes it atomically
-- ---------------------------------------------------------------------------

-- The signature changes (new p_reservation): drop the 4-argument version so there is exactly one function.
drop function public.platform_handover_shop(uuid, uuid, uuid, text);

-- Same rules as in 20261030090000, plus the reservation:
--   * p_reservation given (Edge Function): it must still be the shop's reservation and belong to p_new_owner's e-mail,
--     otherwise handover_reservation_lost / handover_reservation_mismatch (the request lost its lease or is forged);
--   * p_reservation null (direct service-role call, no Auth involved): refused while another operation is live.
-- On success the reservation is deleted in the same transaction as the pending / completed hand-over.
create or replace function public.platform_handover_shop(p_actor uuid, p_shop_id uuid, p_new_owner uuid, p_invitation text, p_reservation uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_problems jsonb;
  v_state text;
  v_pending private.shop_pending_handovers%rowtype;
  v_res private.shop_handover_reservations%rowtype;
begin
  perform private.assert_platform_admin(p_actor);
  if p_invitation is null or p_invitation not in ('sent', 'link', 'existing') then
    raise exception 'invalid_invitation' using errcode = 'P0001';
  end if;
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;

  if p_reservation is null then
    perform private.assert_no_live_handover_reservation(p_shop_id);
  else
    select * into v_res from private.shop_handover_reservations where shop_id = p_shop_id;
    if not found or v_res.token <> p_reservation then
      raise exception 'handover_reservation_lost' using errcode = 'P0001';
    end if;
    if not exists (select 1 from auth.users u where u.id = p_new_owner and lower(u.email) = v_res.email) then
      raise exception 'handover_reservation_mismatch' using errcode = 'P0001';
    end if;
  end if;

  v_problems := private.shop_handover_problems(v_shop);
  if jsonb_array_length(v_problems) > 0 then
    raise exception 'shop_not_ready' using errcode = 'P0001', detail = v_problems::text;
  end if;
  v_state := private.assert_shop_owner_eligible(p_new_owner, p_invitation in ('sent', 'link'));

  select * into v_pending from private.shop_pending_handovers where shop_id = p_shop_id;
  if found and v_pending.user_id <> p_new_owner and v_pending.expires_at > now() then
    raise exception 'handover_pending' using errcode = 'P0001',
      detail = jsonb_build_object(
        'email', (select u.email from auth.users u where u.id = v_pending.user_id),
        'expires_at', v_pending.expires_at
      )::text;
  end if;

  -- The operation is finished by this transaction (or rolled back with the reservation intact for the caller to
  -- release). An expired leftover of a crashed request is dropped as well.
  delete from private.shop_handover_reservations where shop_id = p_shop_id;

  if v_state = 'confirmed' then
    return private.complete_handover(p_shop_id, p_new_owner, p_actor, p_invitation, false);
  end if;

  insert into private.shop_pending_handovers (shop_id, user_id, invitation, requested_by, expires_at)
  values (p_shop_id, p_new_owner, p_invitation, p_actor, now() + interval '7 days')
  on conflict (shop_id) do update set
    user_id = excluded.user_id, invitation = excluded.invitation, requested_by = excluded.requested_by,
    last_error = null, updated_at = now(), expires_at = excluded.expires_at
  returning * into v_pending;

  insert into private.shop_lifecycle_events (shop_id, action, actor, details)
  values (p_shop_id, 'handover_pending', p_actor, jsonb_build_object('to_user_id', p_new_owner, 'invitation', p_invitation));

  return jsonb_build_object(
    'status', 'pending',
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'mode', v_shop.mode, 'is_demo', v_shop.is_demo),
    'owner', (select jsonb_build_object('user_id', u.id, 'email', u.email) from auth.users u where u.id = p_new_owner),
    'removed', '[]'::jsonb,
    'members', private.shop_members_json(p_shop_id),
    'invitation', p_invitation,
    'expires_at', v_pending.expires_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Transfer and cancel respect / clear the reservation
-- ---------------------------------------------------------------------------

-- Unchanged from 20261030090000 except: refused while a hand-over of the shop is in progress (one operation per shop).
create or replace function public.platform_transfer_shop(p_actor uuid, p_shop_id uuid, p_new_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_change jsonb;
begin
  perform private.assert_platform_admin(p_actor);
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  perform private.assert_no_live_handover_reservation(p_shop_id);
  perform private.assert_shop_owner_eligible(p_new_owner, false);

  v_change := private.change_shop_owner(p_shop_id, p_new_owner, p_actor, 'transfer', '{}'::jsonb);

  return jsonb_build_object(
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name),
    'owner', (select jsonb_build_object('user_id', u.id, 'email', u.email) from auth.users u where u.id = p_new_owner),
    'removed', v_change -> 'removed',
    'members', private.shop_members_json(p_shop_id),
    'notifications', v_change -> 'notifications',
    'transferred_at', now()
  );
end;
$$;

-- Also drops a reservation (live or not): the platform admin's way to free a shop left by a crashed request at once.
-- A request still in flight then fails with handover_reservation_lost and changes nothing.
create or replace function public.platform_cancel_handover(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_reserved text;
begin
  perform private.assert_platform_admin(p_actor);
  perform 1 from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  delete from private.shop_pending_handovers where shop_id = p_shop_id returning user_id into v_user;
  delete from private.shop_handover_reservations where shop_id = p_shop_id returning email into v_reserved;
  if v_user is not null or v_reserved is not null then
    insert into private.shop_lifecycle_events (shop_id, action, actor, details)
    values (p_shop_id, 'handover_cancelled', p_actor, jsonb_strip_nulls(jsonb_build_object('to_user_id', v_user, 'reservation', v_reserved)));
  end if;
  return jsonb_build_object('cancelled', v_user is not null or v_reserved is not null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. EXECUTE: service_role only
-- ---------------------------------------------------------------------------

revoke all on function public.platform_reserve_handover(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.platform_release_handover(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_handover_shop(uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.platform_transfer_shop(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_cancel_handover(uuid, uuid) from public, anon, authenticated;

grant execute on function public.platform_reserve_handover(uuid, uuid, text) to service_role;
grant execute on function public.platform_release_handover(uuid, uuid, uuid) to service_role;
grant execute on function public.platform_handover_shop(uuid, uuid, uuid, text, uuid) to service_role;
grant execute on function public.platform_transfer_shop(uuid, uuid, uuid) to service_role;
grant execute on function public.platform_cancel_handover(uuid, uuid) to service_role;
