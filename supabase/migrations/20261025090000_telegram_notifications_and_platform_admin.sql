-- Telegram order notifications per shop + platform-wide shop management (list, transfer).
--
-- Security model
--   * Bot tokens are stored ONLY in Supabase Vault (encrypted at rest). Tables keep the Vault secret id and a
--     masked hint; nothing here is readable by anon / authenticated.
--   * Settings, the notification outbox and the transfer journal live in schema `private`, which is not
--     exposed through the Data API and has no grants for client roles.
--   * Every new function in `public` is EXECUTE-able by service_role only (Edge Functions). The Edge Function
--     verifies the caller's Supabase Auth JWT, and passes the verified user id as p_actor; each function
--     re-checks that actor's rights (shop owner, or platform admin from public.platform_admins) itself.
--     No right is derived from an email address or from anything the browser sends.
--   * Orders are never blocked by notifications: the outbox row is written by a trigger in the checkout
--     transaction (one row per order → no duplicates on idempotent replays), delivery happens afterwards.

create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table private.shop_notification_settings (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  -- vault.secrets.id of the bot token. The token itself never leaves Vault except into an Edge Function.
  bot_token_secret_id uuid not null,
  -- Masked representation shown to the owner, e.g. "123456789:••••AbCd".
  token_hint text not null check (char_length(token_hint) <= 40),
  bot_id bigint,
  bot_username text check (bot_username is null or char_length(bot_username) <= 64),
  -- "@channelusername" or a numeric chat id ("-100…").
  chat_id text not null check (chat_id ~ '^(@[A-Za-z][A-Za-z0-9_]{3,31}|-?[0-9]{1,20})$'),
  chat_title text check (chat_title is null or char_length(chat_title) <= 255),
  chat_type text check (chat_type is null or char_length(chat_type) <= 20),
  enabled boolean not null default true,
  status text not null default 'unverified' check (status in ('unverified', 'ok', 'error')),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table private.order_notifications (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- One notification per order, ever: an idempotent checkout replay cannot enqueue a second one.
  order_id uuid not null unique references public.orders (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  telegram_message_id bigint,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index order_notifications_due_idx on private.order_notifications (shop_id, status, next_attempt_at);

create table private.shop_transfers (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  from_user_ids uuid[] not null default '{}',
  to_user_id uuid not null,
  transferred_by uuid not null,
  created_at timestamptz not null default now()
);
create index shop_transfers_shop_idx on private.shop_transfers (shop_id, created_at desc);

revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Private helpers (not reachable through the API: schema `private` is not exposed)
-- ---------------------------------------------------------------------------

create or replace function private.is_platform_admin_user(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null and exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id);
$$;

-- Owner of the shop (membership role 'owner') or platform admin. Managers do not manage bot credentials.
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
    return;
  end if;
  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop_id and m.user_id = p_actor and m.role = 'owner'
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

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
end;
$$;

-- What the owner may see about the settings: never the token, only its masked hint.
create or replace function private.notification_settings_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'configured', s.shop_id is not null,
    'enabled', coalesce(s.enabled, false),
    'token_hint', s.token_hint,
    'bot_username', s.bot_username,
    'chat_id', s.chat_id,
    'chat_title', s.chat_title,
    'chat_type', s.chat_type,
    'status', coalesce(s.status, 'unverified'),
    'last_error', s.last_error,
    'last_checked_at', s.last_checked_at,
    'updated_at', s.updated_at,
    'queue', jsonb_build_object(
      'pending', (select count(*) from private.order_notifications n where n.shop_id = p_shop_id and n.status in ('pending', 'sending', 'failed')),
      'sent', (select count(*) from private.order_notifications n where n.shop_id = p_shop_id and n.status = 'sent'),
      'dead', (select count(*) from private.order_notifications n where n.shop_id = p_shop_id and n.status = 'dead')
    )
  )
  from (select p_shop_id as id) x
  left join private.shop_notification_settings s on s.shop_id = x.id;
$$;

create or replace function private.token_hint(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select split_part(p_token, ':', 1) || ':••••' || right(p_token, 4);
$$;

-- Outbox producer: runs inside the checkout transaction (create_order inserts the order row).
create or replace function private.enqueue_order_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into private.order_notifications (shop_id, order_id)
  select new.shop_id, new.id
  from private.shop_notification_settings s
  where s.shop_id = new.shop_id and s.enabled
  on conflict (order_id) do nothing;
  return null;
end;
$$;

create trigger orders_enqueue_notification
  after insert on public.orders
  for each row execute function private.enqueue_order_notification();

revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Notification settings (service_role only; actor re-checked inside)
-- ---------------------------------------------------------------------------

create or replace function public.notify_get_settings(p_shop_id uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  return private.notification_settings_json(p_shop_id);
end;
$$;

-- p_bot_token = null keeps the stored token (e.g. only the chat changes).
-- p_meta: { bot_id, bot_username, chat_title, chat_type, status, last_error } as verified by the Edge Function.
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
    updated_at = now();

  return private.notification_settings_json(p_shop_id);
end;
$$;

-- Stored credentials for a connection check / delivery. Edge Functions only.
create or replace function public.notify_get_credentials(p_shop_id uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  select s.chat_id, d.decrypted_secret as bot_token, sh.name as shop_name
    into v_row
  from private.shop_notification_settings s
  join vault.decrypted_secrets d on d.id = s.bot_token_secret_id
  join public.shops sh on sh.id = s.shop_id
  where s.shop_id = p_shop_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object('bot_token', v_row.bot_token, 'chat_id', v_row.chat_id, 'shop_name', v_row.shop_name);
end;
$$;

create or replace function public.notify_record_check(p_shop_id uuid, p_actor uuid, p_ok boolean, p_error text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  update private.shop_notification_settings
    set status = case when p_ok then 'ok' else 'error' end,
        last_error = case when p_ok then null else left(p_error, 300) end,
        last_checked_at = now(),
        updated_at = now()
    where shop_id = p_shop_id;
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

create or replace function public.notify_delete_settings(p_shop_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret uuid;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  delete from private.shop_notification_settings where shop_id = p_shop_id returning bot_token_secret_id into v_secret;
  if v_secret is not null then
    delete from vault.secrets where id = v_secret;
  end if;
  update private.order_notifications
    set status = 'dead', last_error = 'notifications_removed', locked_until = null, updated_at = now()
    where shop_id = p_shop_id and status in ('pending', 'failed');
  return private.notification_settings_json(p_shop_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Delivery (called by the checkout Edge Function after the order transaction committed)
-- ---------------------------------------------------------------------------

-- Claims due notifications (optionally of one order / one shop) and returns everything needed to send them.
-- A claimed row is locked for 2 minutes; only one worker can hold it, so concurrent calls never double-send.
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

create or replace function public.notify_complete(p_notification_id bigint, p_ok boolean, p_message_id bigint, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.order_notifications%rowtype;
begin
  select * into v_row from private.order_notifications where id = p_notification_id for update;
  if not found or v_row.status <> 'sending' then
    return;
  end if;
  if p_ok then
    update private.order_notifications
      set status = 'sent', sent_at = now(), telegram_message_id = p_message_id, last_error = null,
          locked_until = null, updated_at = now()
      where id = p_notification_id;
    update private.shop_notification_settings
      set status = 'ok', last_error = null, last_checked_at = now()
      where shop_id = v_row.shop_id;
  else
    update private.order_notifications
      set status = case when v_row.attempts >= 5 then 'dead' else 'failed' end,
          next_attempt_at = now() + make_interval(secs => 30 * power(2, greatest(v_row.attempts - 1, 0))),
          last_error = left(coalesce(p_error, 'unknown_error'), 300),
          locked_until = null,
          updated_at = now()
      where id = p_notification_id;
    update private.shop_notification_settings
      set status = 'error', last_error = left(coalesce(p_error, 'unknown_error'), 300), last_checked_at = now()
      where shop_id = v_row.shop_id;
  end if;
end;
$$;

-- Owner-triggered retry: makes failed notifications of the shop due now (they are then claimed as usual).
create or replace function public.notify_requeue_failed(p_shop_id uuid, p_actor uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  update private.order_notifications
    set next_attempt_at = now(), updated_at = now()
    where shop_id = p_shop_id and status = 'failed';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Platform administration (service_role only; platform admin re-checked inside)
-- ---------------------------------------------------------------------------

create or replace function private.shop_members_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', m.user_id, 'email', u.email, 'role', m.role, 'since', m.created_at
  ) order by (m.role = 'owner') desc, m.created_at), '[]'::jsonb)
  from public.shop_memberships m
  join auth.users u on u.id = m.user_id
  where m.shop_id = p_shop_id;
$$;

revoke all on function private.shop_members_json(uuid) from public, anon, authenticated;

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
      'created_at', s.created_at,
      'published_at', s.published_at,
      'last_transfer_at', (select max(t.created_at) from private.shop_transfers t where t.shop_id = s.id),
      'members', private.shop_members_json(s.id),
      'notifications', (
        select jsonb_build_object('enabled', n.enabled, 'status', n.status)
        from private.shop_notification_settings n where n.shop_id = s.id
      )
    ) order by s.created_at desc, s.slug), '[]'::jsonb)
    from public.shops s
  );
end;
$$;

-- Looks up an EXISTING account by email (new accounts are created by the existing pnpm owner:add flow).
create or replace function public.platform_find_user(p_actor uuid, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user record;
begin
  perform private.assert_platform_admin(p_actor);
  select u.id, u.email into v_user
  from auth.users u
  where lower(u.email) = lower(btrim(coalesce(p_email, '')))
  limit 1;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'user_id', v_user.id,
    'email', v_user.email,
    'is_platform_admin', private.is_platform_admin_user(v_user.id),
    'shops', coalesce((
      select jsonb_agg(jsonb_build_object('slug', s.slug, 'name', s.name, 'role', m.role) order by s.name)
      from public.shop_memberships m join public.shops s on s.id = m.shop_id
      where m.user_id = v_user.id
    ), '[]'::jsonb)
  );
end;
$$;

-- Makes p_new_owner the only member (role owner) of the shop. Catalog, images, stock and orders are untouched.
-- Previous members lose access (and the shop leaves their "Мои магазины"); platform admins keep seeing it.
create or replace function public.platform_transfer_shop(p_actor uuid, p_shop_id uuid, p_new_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_removed jsonb;
  v_from uuid[];
begin
  perform private.assert_platform_admin(p_actor);
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  if p_new_owner is null or not exists (select 1 from auth.users u where u.id = p_new_owner) then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;

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

  -- Verify the end state before committing.
  if (select count(*) from public.shop_memberships where shop_id = p_shop_id) <> 1
     or not exists (select 1 from public.shop_memberships where shop_id = p_shop_id and user_id = p_new_owner and role = 'owner') then
    raise exception 'transfer_verification_failed' using errcode = 'P0001';
  end if;

  insert into private.shop_transfers (shop_id, from_user_ids, to_user_id, transferred_by)
  values (p_shop_id, v_from, p_new_owner, p_actor);

  return jsonb_build_object(
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name),
    'owner', (select jsonb_build_object('user_id', u.id, 'email', u.email) from auth.users u where u.id = p_new_owner),
    'removed', v_removed,
    'members', private.shop_members_json(p_shop_id),
    'transferred_at', now()
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- EXECUTE: service_role only (anon / authenticated / PUBLIC get nothing)
-- ---------------------------------------------------------------------------

revoke all on function public.notify_get_settings(uuid, uuid) from public, anon, authenticated;
revoke all on function public.notify_save_settings(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.notify_get_credentials(uuid, uuid) from public, anon, authenticated;
revoke all on function public.notify_record_check(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.notify_set_enabled(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.notify_delete_settings(uuid, uuid) from public, anon, authenticated;
revoke all on function public.notify_claim(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.notify_complete(bigint, boolean, bigint, text) from public, anon, authenticated;
revoke all on function public.notify_requeue_failed(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_list_shops(uuid) from public, anon, authenticated;
revoke all on function public.platform_find_user(uuid, text) from public, anon, authenticated;
revoke all on function public.platform_transfer_shop(uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.notify_get_settings(uuid, uuid) to service_role;
grant execute on function public.notify_save_settings(uuid, uuid, text, text, jsonb) to service_role;
grant execute on function public.notify_get_credentials(uuid, uuid) to service_role;
grant execute on function public.notify_record_check(uuid, uuid, boolean, text) to service_role;
grant execute on function public.notify_set_enabled(uuid, uuid, boolean) to service_role;
grant execute on function public.notify_delete_settings(uuid, uuid) to service_role;
grant execute on function public.notify_claim(uuid, uuid, integer) to service_role;
grant execute on function public.notify_complete(bigint, boolean, bigint, text) to service_role;
grant execute on function public.notify_requeue_failed(uuid, uuid) to service_role;
grant execute on function public.platform_list_shops(uuid) to service_role;
grant execute on function public.platform_find_user(uuid, text) to service_role;
grant execute on function public.platform_transfer_shop(uuid, uuid, uuid) to service_role;
