-- S2-06 follow-up (audit stage 3A): handover-cancel must not remove a LIVE hand-over reservation.
--
-- Before: platform_cancel_handover (20261031090000) deleted the shop's pending hand-over AND its reservation, live or
-- not. The UI hid "Отменить передачу" while a reservation was live, but the API (handover-cancel → this RPC) still
-- dropped it at once. That let a platform admin (or any caller of the service-role RPC) break the one-operation-per-
-- shop guarantee while a hand-over request was inside Supabase Auth: the request lost its lease mid-flight and a
-- parallel request could reserve the shop and invite another e-mail before the first one finished.
--
-- Now:
--   * a live reservation (expires_at > now()) makes the cancel fail with handover_reservation_active (HTTP 409) and
--     NOTHING changes — neither the reservation (token, e-mail, lease) nor the pending hand-over. The decision is
--     taken under shops FOR UPDATE, the lock platform_reserve_handover / platform_handover_shop take, so a
--     reservation created concurrently is always seen;
--   * otherwise only the pending hand-over is cancelled (as before). The cancel never touches a reservation: an
--     expired one does not block anything and is cleared by platform_release_stale_handover (20261101090000).
-- Admin check, signature, result shape ({ cancelled }) and EXECUTE privileges are unchanged.

select set_config('lock_timeout', '5s', true);

create or replace function public.platform_cancel_handover(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_res private.shop_handover_reservations%rowtype;
  v_user uuid;
begin
  perform private.assert_platform_admin(p_actor);
  -- Same lock as the reservation and the hand-over: a concurrent reservation is either committed and seen below,
  -- or waits until this cancel has finished.
  perform 1 from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  select * into v_res from private.shop_handover_reservations where shop_id = p_shop_id for update;
  if found and v_res.expires_at > now() then
    -- A hand-over request holds the shop right now (possibly re-sending the invitation of the pending hand-over).
    -- Cancelling anything under it would either break its lease or be undone when it finishes.
    raise exception 'handover_reservation_active' using errcode = 'P0001', detail = jsonb_build_object(
      'email', v_res.email, 'expires_at', v_res.expires_at,
      'retry_after_sec', greatest(1, ceil(extract(epoch from (v_res.expires_at - now()))))::integer
    )::text;
  end if;

  delete from private.shop_pending_handovers where shop_id = p_shop_id returning user_id into v_user;
  if v_user is not null then
    insert into private.shop_lifecycle_events (shop_id, action, actor, details)
    values (p_shop_id, 'handover_cancelled', p_actor, jsonb_build_object('to_user_id', v_user));
  end if;
  return jsonb_build_object('cancelled', v_user is not null);
end;
$$;

revoke all on function public.platform_cancel_handover(uuid, uuid) from public, anon, authenticated;
grant execute on function public.platform_cancel_handover(uuid, uuid) to service_role;
