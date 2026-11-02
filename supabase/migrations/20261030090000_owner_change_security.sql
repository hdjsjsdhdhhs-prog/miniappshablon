-- Security fixes for shop ownership changes (audit stage 3A: S2-01, F-01, F-08).
--
-- S2-01  Telegram notification settings (bot token in Vault + chat id) belong to the shop, not to an owner, and
--        survived platform_transfer_shop / platform_handover_shop: the former owner kept receiving every new order
--        (buyer name, username, address). Now ONE shared routine, private.change_shop_owner, runs inside the same
--        transaction as the membership change and
--          * deletes the settings row AND its Vault secret (the transfer fails as a whole if the secret survives),
--          * marks every undelivered notification of the shop (pending / failed / sending) as dead ('owner_changed'),
--          * rotates nothing back: dead rows are never claimed, re-queued or completed again.
--        Workers that claimed a job BEFORE the change re-validate it right before sending (notify_begin_send with the
--        channel id of the claimed settings): once the change committed, no claimed job is sent any more.
--        The new owner connects and verifies their own bot / chat (notification-settings), like a fresh shop.
--
-- F-01 / F-08  An account becomes an owner (transfer AND handover) only if it is a real, confirmed account:
--        email_confirmed_at set (server-side, auth.users), not deleted/banned/anonymous, not a platform admin.
--        A brand-new or invited-but-not-yet-activated client gets an invitation and a PENDING hand-over; the shop
--        changes hands only when that account confirms its e-mail (trigger on auth.users) — never before.
--        An unconfirmed account that already has a password (self-registration, i.e. possibly someone else who
--        registered the client's e-mail) is refused (owner_unconfirmed) and never re-invited: an invitation would
--        not remove the password chosen by whoever registered it.
--
-- Concurrency: every ownership change locks the shops row FOR UPDATE; notify_save_settings / notify_set_enabled
-- lock it FOR SHARE first, so a settings save by the former owner either commits before the change (and is then
-- revoked by it) or runs after it (and is refused: the actor is no longer the owner).

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

-- Identity of one configured delivery channel (token + chat). A new value whenever the token or the chat changes;
-- a job claimed for an older channel is never sent (notify_begin_send).
alter table private.shop_notification_settings
  add column channel_id uuid not null default gen_random_uuid();

-- A hand-over to a client whose account is not confirmed yet. At most one per shop.
create table private.shop_pending_handovers (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  invitation text not null check (invitation in ('sent', 'link')),
  requested_by uuid not null,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index shop_pending_handovers_user_idx on private.shop_pending_handovers (user_id);
revoke all on private.shop_pending_handovers from public, anon, authenticated;

alter table private.shop_lifecycle_events drop constraint shop_lifecycle_events_action_check;
alter table private.shop_lifecycle_events add constraint shop_lifecycle_events_action_check
  check (action in ('demo_created', 'demo_activated', 'handover', 'handover_pending', 'handover_cancelled', 'handover_failed'));

-- ---------------------------------------------------------------------------
-- 2. Account eligibility (server-side truth: auth.users, never the request)
-- ---------------------------------------------------------------------------

-- missing | blocked | confirmed | invited (created by an invitation, never activated, no password) | unconfirmed
create or replace function private.account_state(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when u.id is null or u.deleted_at is not null then 'missing'
    when u.banned_until is not null and u.banned_until > now() then 'blocked'
    when coalesce(u.is_anonymous, false) or u.email is null then 'unconfirmed'
    when u.email_confirmed_at is not null then 'confirmed'
    when u.invited_at is not null and coalesce(u.encrypted_password, '') = '' then 'invited'
    else 'unconfirmed'
  end
  from (select p_user_id as id) x
  left join auth.users u on u.id = x.id;
$$;

-- Raises unless p_user may own a shop. p_allow_invited: an invited, not yet activated account is acceptable as the
-- target of a PENDING hand-over (it becomes the owner only after confirming its e-mail). Returns the state.
create or replace function private.assert_shop_owner_eligible(p_user uuid, p_allow_invited boolean)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state text := private.account_state(p_user);
begin
  if p_user is null or v_state = 'missing' then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  -- A client owns shops; it must never be (or become) a platform administrator.
  if private.is_platform_admin_user(p_user) then
    raise exception 'owner_is_platform_admin' using errcode = 'P0001';
  end if;
  if v_state = 'blocked' then
    raise exception 'owner_blocked' using errcode = 'P0001';
  end if;
  if v_state = 'confirmed' or (coalesce(p_allow_invited, false) and v_state = 'invited') then
    return v_state;
  end if;
  raise exception 'owner_unconfirmed' using errcode = 'P0001';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Revocation of the notification channel (S2-01)
-- ---------------------------------------------------------------------------

create or replace function private.revoke_shop_notifications(p_shop_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
  v_dropped integer;
begin
  -- Waits for a concurrent save / claim holding the row; afterwards no claim can return this token.
  delete from private.shop_notification_settings where shop_id = p_shop_id returning bot_token_secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
    -- Fail closed: the ownership change must not commit while the old token is still stored.
    if exists (select 1 from vault.secrets where id = v_secret) then
      raise exception 'notification_cleanup_failed' using errcode = 'P0001';
    end if;
  end if;
  update private.order_notifications
    set status = 'dead', last_error = p_reason, locked_until = null, updated_at = now()
    where shop_id = p_shop_id and status in ('pending', 'sending', 'failed');
  get diagnostics v_dropped = row_count;
  return jsonb_build_object('settings_removed', v_secret is not null, 'queued_dropped', v_dropped);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Legacy DEMO test orders: released when the shop is handed over (F-03 follow-up)
-- ---------------------------------------------------------------------------

-- Cancels the open test orders of a (DEMO) shop and puts their units back on sale, exactly like an owner's cancel
-- (same operation keys → a unit is never restored twice). They are hidden from the client after the hand-over and
-- could otherwise never be cancelled.
create or replace function private.cancel_open_test_orders(p_shop_id uuid, p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order record;
  v_item record;
  v_inserted integer;
  v_count integer := 0;
begin
  for v_order in
    select o.id, o.stock_state from public.orders o
    where o.shop_id = p_shop_id and o.is_test and o.status in ('new', 'confirmed', 'ready')
    order by o.id
    for update
  loop
    if v_order.stock_state = 'deducted' then
      for v_item in
        select i.id, i.variant_id, i.quantity from public.order_items i
        where i.order_id = v_order.id and i.variant_id is not null
        order by i.variant_id
      loop
        insert into public.inventory_movements (shop_id, variant_id, order_id, delta, reason, operation_key, actor_user_id)
        values (p_shop_id, v_item.variant_id, v_order.id, v_item.quantity, 'cancel_restore',
                'cancel:' || v_order.id::text || ':' || v_item.id::text, p_actor)
        on conflict (shop_id, operation_key) do nothing;
        get diagnostics v_inserted = row_count;
        if v_inserted = 1 then
          update public.product_variants set stock_quantity = stock_quantity + v_item.quantity where id = v_item.variant_id;
        end if;
      end loop;
    end if;
    update public.orders set status = 'cancelled', stock_state = 'restored' where id = v_order.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Readiness: units held by open test orders count as available (they are released by the hand-over itself).
create or replace function private.shop_handover_problems(p_shop public.shops)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(p) filter (where p is not null), '[]'::jsonb)
  from (values
    (case when p_shop.status <> 'active' then 'shop_suspended' end),
    (case when not p_shop.is_demo then 'not_demo' end),
    (case when p_shop.age_restriction < 18 then 'age_restriction' end),
    (case when not (p_shop.delivery_enabled or p_shop.pickup_enabled) then 'no_fulfillment' end),
    (case when not exists (
      select 1 from public.categories c where c.shop_id = p_shop.id and c.is_active and c.archived_at is null
    ) then 'no_categories' end),
    (case when not exists (
      select 1
      from public.products p
      join public.categories c on c.shop_id = p.shop_id and c.id = p.category_id
      join public.product_variants v on v.shop_id = p.shop_id and v.product_id = p.id
      where p.shop_id = p_shop.id and p.is_published and p.archived_at is null
        and c.is_active and c.archived_at is null and v.is_active
        and v.stock_quantity + coalesce((
          select sum(i.quantity)
          from public.order_items i
          join public.orders o on o.shop_id = i.shop_id and o.id = i.order_id
          where i.shop_id = p_shop.id and i.variant_id = v.id
            and o.is_test and o.stock_state = 'deducted' and o.status in ('new', 'confirmed', 'ready')
        ), 0) > 0
    ) then 'no_products' end)
  ) as t(p);
$$;

-- ---------------------------------------------------------------------------
-- 5. The one ownership-change routine shared by transfer and hand-over
-- ---------------------------------------------------------------------------

-- Caller: holds FOR UPDATE on the shops row and has checked the actor and the new owner.
-- Makes p_new_owner the only member (owner), revokes the notification channel unless nothing changes (the new owner
-- already was the only owner), drops a pending hand-over, verifies the end state and journals it.
create or replace function private.change_shop_owner(p_shop_id uuid, p_new_owner uuid, p_actor uuid, p_kind text, p_details jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_removed jsonb;
  v_from uuid[];
  v_unchanged boolean;
  v_notifications jsonb;
begin
  if p_kind not in ('transfer', 'handover') then
    raise exception 'invalid_kind' using errcode = 'P0001';
  end if;

  select coalesce(count(*) = 1 and bool_and(m.user_id = p_new_owner and m.role = 'owner'), false)
    into v_unchanged
  from public.shop_memberships m where m.shop_id = p_shop_id;

  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role)), '[]'::jsonb),
         coalesce(array_agg(m.user_id), '{}')
    into v_removed, v_from
  from public.shop_memberships m
  join auth.users u on u.id = m.user_id
  where m.shop_id = p_shop_id and m.user_id <> p_new_owner;

  delete from public.shop_memberships where shop_id = p_shop_id and user_id <> p_new_owner;
  insert into public.shop_memberships as m (shop_id, user_id, role)
  values (p_shop_id, p_new_owner, 'owner')
  on conflict (shop_id, user_id) do update set role = 'owner';

  -- A hand-over always starts the real shop with a clean channel (DEMO-era chats are never kept).
  if p_kind = 'handover' or not v_unchanged then
    v_notifications := private.revoke_shop_notifications(p_shop_id, 'owner_changed');
  else
    v_notifications := jsonb_build_object('settings_removed', false, 'queued_dropped', 0);
  end if;

  delete from private.shop_pending_handovers where shop_id = p_shop_id;

  if (select count(*) from public.shop_memberships where shop_id = p_shop_id) <> 1
     or not exists (select 1 from public.shop_memberships where shop_id = p_shop_id and user_id = p_new_owner and role = 'owner')
     or (p_kind = 'handover' or not v_unchanged) and exists (select 1 from private.shop_notification_settings where shop_id = p_shop_id) then
    raise exception 'transfer_verification_failed' using errcode = 'P0001';
  end if;

  insert into private.shop_transfers (shop_id, from_user_ids, to_user_id, transferred_by, kind, details)
  values (p_shop_id, v_from, p_new_owner, p_actor, p_kind,
          coalesce(p_details, '{}'::jsonb) || jsonb_build_object('notifications', v_notifications));

  return jsonb_build_object('removed', v_removed, 'notifications', v_notifications);
end;
$$;

-- Completes a hand-over to a CONFIRMED account: readiness, eligibility, release of test orders, ownership change,
-- DEMO → real live shop. p_pending_only: called on e-mail confirmation — do nothing unless the pending hand-over
-- to this account still exists (it may have been cancelled or replaced meanwhile).
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
    -- The admin who started it must still be one.
    perform private.assert_platform_admin(p_actor);
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

-- Fires when an account's e-mail becomes confirmed (invitation link, confirmation link, or an operator). Completes
-- the pending hand-overs of that account. Never blocks the confirmation itself: a failure is recorded on the
-- pending row and in the journal, and the platform admin can repeat the hand-over.
create or replace function private.complete_pending_handovers_on_confirm()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_p record;
begin
  for v_p in
    select p.shop_id, p.requested_by, p.invitation from private.shop_pending_handovers p
    where p.user_id = new.id and p.expires_at > now()
    order by p.created_at
  loop
    begin
      perform private.complete_handover(v_p.shop_id, new.id, v_p.requested_by, v_p.invitation, true);
    exception when others then
      update private.shop_pending_handovers
        set last_error = left(sqlerrm, 300), updated_at = now()
        where shop_id = v_p.shop_id and user_id = new.id;
      insert into private.shop_lifecycle_events (shop_id, action, actor, details)
      values (v_p.shop_id, 'handover_failed', v_p.requested_by, jsonb_build_object('to_user_id', new.id, 'error', left(sqlerrm, 300)));
    end;
  end loop;
  return null;
end;
$$;

create trigger complete_pending_handovers_on_confirm
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function private.complete_pending_handovers_on_confirm();

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Platform RPCs (service_role only; platform admin re-checked inside)
-- ---------------------------------------------------------------------------

-- Same rules as hand-over: a confirmed, non-admin account; the channel of the former owner is revoked. A DEMO shop
-- stays DEMO (switching it to a real shop is what hand-over is for).
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

-- Confirmed account → the hand-over completes now ('completed'). Invited, not yet activated account (p_invitation
-- 'sent' / 'link' — the Edge Function has just sent the invitation) → 'pending': the shop stays DEMO and changes
-- hands when that account confirms its e-mail. Anything else is refused.
create or replace function public.platform_handover_shop(p_actor uuid, p_shop_id uuid, p_new_owner uuid, p_invitation text)
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
begin
  perform private.assert_platform_admin(p_actor);
  if p_invitation is null or p_invitation not in ('sent', 'link', 'existing') then
    raise exception 'invalid_invitation' using errcode = 'P0001';
  end if;
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
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

create or replace function public.platform_cancel_handover(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  perform private.assert_platform_admin(p_actor);
  perform 1 from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  delete from private.shop_pending_handovers where shop_id = p_shop_id returning user_id into v_user;
  if v_user is not null then
    insert into private.shop_lifecycle_events (shop_id, action, actor, details)
    values (p_shop_id, 'handover_cancelled', p_actor, jsonb_build_object('to_user_id', v_user));
  end if;
  return jsonb_build_object('cancelled', v_user is not null);
end;
$$;

create or replace function private.pending_handover_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', p.user_id, 'email', u.email, 'invitation', p.invitation, 'created_at', p.created_at,
    'expires_at', p.expires_at, 'expired', p.expires_at <= now(), 'last_error', p.last_error
  )
  from private.shop_pending_handovers p
  join auth.users u on u.id = p.user_id
  where p.shop_id = p_shop_id;
$$;

revoke all on function private.pending_handover_json(uuid) from public, anon, authenticated;

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
    'pending_handover', private.pending_handover_json(v_shop.id)
  );
end;
$$;

-- `state` comes from auth.users (see private.account_state); the Edge Function decides from it whether an
-- invitation may be sent. Nothing about the account is taken from the request.
create or replace function public.platform_find_user(p_actor uuid, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user record;
  v_state text;
begin
  perform private.assert_platform_admin(p_actor);
  select u.id, u.email into v_user
  from auth.users u
  where lower(u.email) = lower(btrim(coalesce(p_email, '')))
  limit 1;
  if not found then
    return null;
  end if;
  v_state := private.account_state(v_user.id);
  return jsonb_build_object(
    'user_id', v_user.id,
    'email', v_user.email,
    'is_platform_admin', private.is_platform_admin_user(v_user.id),
    'state', v_state,
    'email_confirmed', v_state = 'confirmed',
    'shops', coalesce((
      select jsonb_agg(jsonb_build_object('slug', s.slug, 'name', s.name, 'role', m.role) order by s.name)
      from public.shop_memberships m join public.shops s on s.id = m.shop_id
      where m.user_id = v_user.id
    ), '[]'::jsonb)
  );
end;
$$;

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
      'pending_handover', private.pending_handover_json(s.id)
    ) order by s.created_at desc, s.slug), '[]'::jsonb)
    from public.shops s
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Notification RPCs: serialize with ownership changes; re-validate a claimed job before sending
-- ---------------------------------------------------------------------------

create or replace function public.notify_save_settings(
  p_shop_id uuid,
  p_actor uuid,
  p_bot_token text,
  p_chat_id text,
  p_meta jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing private.shop_notification_settings%rowtype;
  v_has_existing boolean;
  v_secret uuid;
  v_status text := coalesce(p_meta ->> 'status', 'unverified');
begin
  -- Serializes with platform_transfer_shop / platform_handover_shop (FOR UPDATE on the same row): the rights below
  -- are checked against the ownership AFTER a concurrent change committed.
  perform 1 from public.shops where id = p_shop_id for share;
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  if p_bot_token is not null and p_bot_token !~ '^[0-9]{5,12}:[A-Za-z0-9_-]{30,64}$' then
    raise exception 'invalid_token' using errcode = 'P0001';
  end if;
  if p_chat_id is null or p_chat_id !~ '^(@[A-Za-z][A-Za-z0-9_]{3,31}|-?[0-9]{1,20})$' then
    raise exception 'invalid_chat' using errcode = 'P0001';
  end if;
  if v_status not in ('unverified', 'ok', 'error') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  select * into v_existing from private.shop_notification_settings where shop_id = p_shop_id for update;
  v_has_existing := found;
  if not v_has_existing and p_bot_token is null then
    raise exception 'token_required' using errcode = 'P0001';
  end if;

  if p_bot_token is not null then
    if v_has_existing then
      perform vault.update_secret(v_existing.bot_token_secret_id, p_bot_token);
      v_secret := v_existing.bot_token_secret_id;
    else
      v_secret := vault.create_secret(
        p_bot_token,
        'shop_tg_notify:' || p_shop_id::text || ':' || gen_random_uuid()::text,
        'Telegram bot token for order notifications of shop ' || p_shop_id::text
      );
    end if;
  else
    v_secret := v_existing.bot_token_secret_id;
  end if;

  insert into private.shop_notification_settings as s (
    shop_id, bot_token_secret_id, token_hint, bot_id, bot_username, chat_id, chat_title, chat_type,
    enabled, status, last_error, last_checked_at, updated_by
  ) values (
    p_shop_id, v_secret,
    coalesce(private.token_hint(p_bot_token), v_existing.token_hint),
    nullif(p_meta ->> 'bot_id', '')::bigint,
    left(nullif(p_meta ->> 'bot_username', ''), 64),
    p_chat_id,
    left(nullif(p_meta ->> 'chat_title', ''), 255),
    left(nullif(p_meta ->> 'chat_type', ''), 20),
    true, v_status, left(nullif(p_meta ->> 'last_error', ''), 300),
    case when v_status = 'unverified' then null else now() end,
    p_actor
  )
  on conflict (shop_id) do update set
    bot_token_secret_id = excluded.bot_token_secret_id,
    token_hint = excluded.token_hint,
    bot_id = coalesce(excluded.bot_id, s.bot_id),
    bot_username = coalesce(excluded.bot_username, s.bot_username),
    chat_id = excluded.chat_id,
    chat_title = excluded.chat_title,
    chat_type = excluded.chat_type,
    enabled = true,
    status = excluded.status,
    last_error = excluded.last_error,
    last_checked_at = excluded.last_checked_at,
    updated_by = excluded.updated_by,
    updated_at = now(),
    -- A job claimed for the previous token / chat is not sent any more.
    channel_id = case
      when p_bot_token is not null or s.chat_id is distinct from excluded.chat_id then gen_random_uuid()
      else s.channel_id
    end;

  return private.notification_settings_json(p_shop_id);
end;
$$;

create or replace function public.notify_set_enabled(p_shop_id uuid, p_actor uuid, p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.shops where id = p_shop_id for share;
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  update private.shop_notification_settings
    set enabled = coalesce(p_enabled, false), updated_by = p_actor, updated_at = now()
    where shop_id = p_shop_id;
  if not found then
    raise exception 'not_configured' using errcode = 'P0001';
  end if;
  if not coalesce(p_enabled, false) then
    -- Disabled means "do not send": undelivered notifications are dropped, not sent later in bulk.
    update private.order_notifications
      set status = 'dead', last_error = 'notifications_disabled', locked_until = null, updated_at = now()
      where shop_id = p_shop_id and status in ('pending', 'failed');
  end if;
  return private.notification_settings_json(p_shop_id);
end;
$$;

-- Same as before plus `channel_id` in every job (used by notify_begin_send).
create or replace function public.notify_claim(p_order_id uuid, p_shop_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs jsonb := '[]'::jsonb;
  v_row record;
begin
  for v_row in
    with picked as (
      select n.id
      from private.order_notifications n
      join private.shop_notification_settings s on s.shop_id = n.shop_id and s.enabled
      where (p_order_id is null or n.order_id = p_order_id)
        and (p_shop_id is null or n.shop_id = p_shop_id)
        and (n.status in ('pending', 'failed') or (n.status = 'sending' and n.locked_until < now()))
        and n.next_attempt_at <= now()
        and n.created_at > now() - interval '24 hours'
      order by n.id
      limit least(greatest(coalesce(p_limit, 1), 1), 20)
      for update of n skip locked
    )
    update private.order_notifications n
      set status = 'sending', attempts = n.attempts + 1, locked_until = now() + interval '2 minutes', updated_at = now()
      from picked
      where n.id = picked.id
      returning n.id, n.order_id, n.shop_id, n.attempts
  loop
    v_jobs := v_jobs || jsonb_build_array((
      select jsonb_build_object(
        'notification_id', v_row.id,
        'attempt', v_row.attempts,
        'channel_id', s.channel_id,
        'shop_name', sh.name,
        'chat_id', s.chat_id,
        'bot_token', d.decrypted_secret,
        'customer_tg_id', o.customer_tg_id,
        'customer', o.customer_snapshot,
        'order', public.order_to_json(o.id)
      )
      from private.shop_notification_settings s
      join vault.decrypted_secrets d on d.id = s.bot_token_secret_id
      join public.shops sh on sh.id = s.shop_id
      join public.orders o on o.id = v_row.order_id
      where s.shop_id = v_row.shop_id
    ));
  end loop;
  return v_jobs;
end;
$$;

-- Called by the worker right before sendMessage: true only while the job is still claimed by this attempt and the
-- shop's current channel is the one the job was claimed for. False after an ownership change (job dead, settings
-- gone), after the owner disabled / replaced the settings, or when the claim expired (another worker may own it).
create or replace function public.notify_begin_send(p_notification_id bigint, p_attempt integer, p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.order_notifications n
    join private.shop_notification_settings s on s.shop_id = n.shop_id
    where n.id = p_notification_id
      and n.status = 'sending'
      and n.attempts = p_attempt
      and n.locked_until > now()
      and s.enabled
      and s.channel_id = p_channel_id
  );
$$;

-- ---------------------------------------------------------------------------
-- 8. EXECUTE: service_role only
-- ---------------------------------------------------------------------------

revoke all on function public.platform_transfer_shop(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_handover_shop(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.platform_cancel_handover(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_handover_check(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_find_user(uuid, text) from public, anon, authenticated;
revoke all on function public.platform_list_shops(uuid) from public, anon, authenticated;
revoke all on function public.notify_save_settings(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.notify_set_enabled(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.notify_claim(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.notify_begin_send(bigint, integer, uuid) from public, anon, authenticated;

grant execute on function public.platform_transfer_shop(uuid, uuid, uuid) to service_role;
grant execute on function public.platform_handover_shop(uuid, uuid, uuid, text) to service_role;
grant execute on function public.platform_cancel_handover(uuid, uuid) to service_role;
grant execute on function public.platform_handover_check(uuid, uuid) to service_role;
grant execute on function public.platform_find_user(uuid, text) to service_role;
grant execute on function public.platform_list_shops(uuid) to service_role;
grant execute on function public.notify_save_settings(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.notify_set_enabled(uuid, uuid, boolean) to service_role;
grant execute on function public.notify_claim(uuid, uuid, integer) to service_role;
grant execute on function public.notify_begin_send(bigint, integer, uuid) to service_role;
