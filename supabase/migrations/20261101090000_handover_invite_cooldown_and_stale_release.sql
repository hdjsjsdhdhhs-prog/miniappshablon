-- Follow-ups to S2-06 (audit stage 3A): invitation re-send cooldown and recovery of an expired hand-over reservation.
--
-- 1. Invitation cooldown. A hand-over to a new / invited-only account makes Supabase Auth send an invitation e-mail;
--    repeating the hand-over to the same e-mail is the "send the invitation again" feature. Nothing limited how often
--    that could happen. Now the Edge Function, while holding the shop's reservation and BEFORE calling Auth, claims
--    the send with platform_claim_handover_invitation. Per (shop, normalized e-mail): at most one invitation per
--    60 seconds and at most 5 per hour; otherwise invitation_rate_limited (HTTP 429, Retry-After). The counter is the
--    log table below (PostgreSQL, not process memory), counted under the shops row lock. Another e-mail or another
--    shop has its own counter. An attempt is counted when it is claimed (before Auth): if Auth then fails, the
--    attempt still counts — the e-mail may have been sent even if Auth reported an error.
--
-- 2. Stale reservation. A reservation left by a crashed request blocks the shop until its lease (10 min) expires.
--    platform_handover_check now reports the reservation (never its token), and platform_release_stale_handover
--    removes it — only once it has EXPIRED (checked here, under the same shops lock), only for a platform admin.
--    A live reservation is refused (handover_reservation_active). Reservation, hand-over, transfer and cancel are
--    unchanged.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Invitation send log + limits
-- ---------------------------------------------------------------------------

create table private.handover_invitation_sends (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 254 and email = lower(btrim(email))),
  requested_by uuid not null,
  sent_at timestamptz not null default now()
);
create index handover_invitation_sends_key_idx on private.handover_invitation_sends (shop_id, email, sent_at desc);
revoke all on private.handover_invitation_sends from public, anon, authenticated;

create or replace function private.handover_invitation_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $$ select jsonb_build_object('cooldown_sec', 60, 'max_per_window', 5, 'window_sec', 3600) $$;

revoke all on function private.handover_invitation_limits() from public, anon, authenticated;

-- Called by the Edge Function right before Supabase Auth sends an invitation. Only the holder of the shop's
-- reservation may claim; the e-mail is the reservation's (already normalized: lower(btrim())), never the request's.
create or replace function public.platform_claim_handover_invitation(p_actor uuid, p_shop_id uuid, p_reservation uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.handover_invitation_limits();
  v_cooldown interval := make_interval(secs => (v_limits ->> 'cooldown_sec')::integer);
  v_window interval := make_interval(secs => (v_limits ->> 'window_sec')::integer);
  v_max integer := (v_limits ->> 'max_per_window')::integer;
  v_res private.shop_handover_reservations%rowtype;
  v_now timestamptz;
  v_last timestamptz;
  v_count integer;
  v_oldest timestamptz;
  v_retry integer := 0;
  v_reason text;
begin
  perform private.assert_platform_admin(p_actor);
  -- Same lock as every ownership change and the reservation: claims of one shop run one after another.
  perform 1 from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  select * into v_res from private.shop_handover_reservations where shop_id = p_shop_id;
  if not found or p_reservation is null or v_res.token <> p_reservation then
    raise exception 'handover_reservation_lost' using errcode = 'P0001';
  end if;
  -- After the lock wait: the time the previous claim was committed at is in the past.
  v_now := clock_timestamp();

  select max(s.sent_at) into v_last
  from private.handover_invitation_sends s
  where s.shop_id = p_shop_id and s.email = v_res.email;
  -- "60 seconds or less since the last invitation" is refused; allowed strictly after.
  if v_last is not null and v_last >= v_now - v_cooldown then
    v_retry := greatest(1, floor(extract(epoch from (v_last + v_cooldown - v_now)))::integer + 1);
    v_reason := 'cooldown';
  end if;

  select count(*) into v_count
  from private.handover_invitation_sends s
  where s.shop_id = p_shop_id and s.email = v_res.email and s.sent_at > v_now - v_window;
  if v_count >= v_max then
    -- The send whose leaving the window brings the count below the limit.
    select s.sent_at into v_oldest
    from private.handover_invitation_sends s
    where s.shop_id = p_shop_id and s.email = v_res.email and s.sent_at > v_now - v_window
    order by s.sent_at
    offset v_count - v_max
    limit 1;
    if greatest(1, ceil(extract(epoch from (v_oldest + v_window - v_now)))::integer) > v_retry then
      v_retry := greatest(1, ceil(extract(epoch from (v_oldest + v_window - v_now)))::integer);
      v_reason := 'hourly';
    end if;
  end if;

  if v_reason is not null then
    raise exception 'invitation_rate_limited' using errcode = 'P0001', detail = jsonb_build_object(
      'reason', v_reason,
      'retry_after_sec', v_retry,
      'cooldown_sec', (v_limits ->> 'cooldown_sec')::integer,
      'limit', v_max,
      'window_sec', (v_limits ->> 'window_sec')::integer,
      'sent_in_window', v_count
    )::text;
  end if;

  -- Housekeeping: rows outside the window are never counted again.
  delete from private.handover_invitation_sends s
  where s.shop_id = p_shop_id and s.email = v_res.email and s.sent_at <= v_now - v_window;

  insert into private.handover_invitation_sends (shop_id, email, requested_by, sent_at)
  values (p_shop_id, v_res.email, p_actor, v_now);

  return jsonb_build_object('sent_in_window', v_count + 1, 'limit', v_max, 'cooldown_sec', (v_limits ->> 'cooldown_sec')::integer);
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Reservation state for the platform admin UI; release of an EXPIRED reservation
-- ---------------------------------------------------------------------------

-- What the platform admin may see about a reservation: never the token.
create or replace function private.handover_reservation_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'email', r.email, 'created_at', r.created_at, 'expires_at', r.expires_at,
    'expired', r.expires_at <= now(),
    'remaining_sec', greatest(0, ceil(extract(epoch from (r.expires_at - now()))))::integer
  )
  from private.shop_handover_reservations r
  where r.shop_id = p_shop_id;
$$;

revoke all on function private.handover_reservation_json(uuid) from public, anon, authenticated;

-- Unchanged from 20261030090000 except the new `reservation` key.
create or replace function public.platform_handover_check(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_problems jsonb;
begin
  perform private.assert_platform_admin(p_actor);
  select * into v_shop from public.shops where id = p_shop_id;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  v_problems := private.shop_handover_problems(v_shop);
  return jsonb_build_object(
    'ready', jsonb_array_length(v_problems) = 0,
    'problems', v_problems,
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'mode', v_shop.mode, 'is_demo', v_shop.is_demo),
    'pending_handover', private.pending_handover_json(v_shop.id),
    'reservation', private.handover_reservation_json(v_shop.id)
  );
end;
$$;

-- Removes the shop's reservation ONLY if its lease has expired. Decided here, under shops FOR UPDATE (the lock the
-- reservation is taken under), so a reservation created or renewed by a concurrent request is seen and kept.
create or replace function public.platform_release_stale_handover(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res private.shop_handover_reservations%rowtype;
begin
  perform private.assert_platform_admin(p_actor);
  perform 1 from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  select * into v_res from private.shop_handover_reservations where shop_id = p_shop_id for update;
  if not found then
    return jsonb_build_object('released', false);
  end if;
  if v_res.expires_at > now() then
    raise exception 'handover_reservation_active' using errcode = 'P0001', detail = jsonb_build_object(
      'email', v_res.email, 'expires_at', v_res.expires_at,
      'retry_after_sec', greatest(1, ceil(extract(epoch from (v_res.expires_at - now()))))::integer
    )::text;
  end if;
  delete from private.shop_handover_reservations where shop_id = p_shop_id and token = v_res.token;
  insert into private.shop_lifecycle_events (shop_id, action, actor, details)
  values (p_shop_id, 'handover_cancelled', p_actor,
    jsonb_build_object('reservation', v_res.email, 'reason', 'stale_reservation', 'expired_at', v_res.expires_at));
  return jsonb_build_object('released', true, 'email', v_res.email, 'expired_at', v_res.expires_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. EXECUTE: service_role only
-- ---------------------------------------------------------------------------

revoke all on function public.platform_claim_handover_invitation(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_release_stale_handover(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_handover_check(uuid, uuid) from public, anon, authenticated;

grant execute on function public.platform_claim_handover_invitation(uuid, uuid, uuid) to service_role;
grant execute on function public.platform_release_stale_handover(uuid, uuid) to service_role;
grant execute on function public.platform_handover_check(uuid, uuid) to service_role;
