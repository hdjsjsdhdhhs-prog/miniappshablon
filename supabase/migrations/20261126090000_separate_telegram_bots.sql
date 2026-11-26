-- One Telegram bot may serve only ONE purpose of a shop: «Уведомления» (order notifications into the owner's channel) OR
-- «Подключение бота» (the storefront: /start, welcome message, Menu Button, Mini App). Stage 4D, Expand: additive only.
--
-- Identity of a bot is its numeric Telegram Bot ID, determined by the Edge Functions with the official Bot API method
-- `getMe` (never by comparing token texts: a re-issued token of the same bot has another text and the same id).
--   * private.shop_notification_settings.bot_id and private.shop_bot_connections.bot_id already hold that id.
--   * NEW private.shop_bot_assignments is the registry of «which bot serves which purpose of which shop». Its constraints
--     are the guarantee, whatever code path writes a connection:
--       primary key (shop_id, purpose)         one bot per purpose of a shop;
--       unique (shop_id, bot_id)               the same bot can not hold two purposes of one shop.
--     The registry is maintained ONLY by triggers on the two connection tables, so a disconnect, a replacement, an ownership
--     change (private.change_shop_owner), a demo / shop deletion or a cascade all release the bot without a separate step,
--     and a connection row can never exist without its registry row (they commit or roll back together, Vault included).
--   * Concurrency: both save RPCs take a per-shop transaction advisory lock before they check and before they write to Vault,
--     so two requests for one shop are serialised and the loser sees the winner's committed row. If anything slipped past
--     (e.g. a direct INSERT), the unique constraint makes the second transaction wait for the first one and then fail with
--     the same coded error — never a bot assigned to both purposes, never a Vault secret left without its connection.
--   * Coded errors (P0001, the Edge Functions map them to HTTP 409 and the admin UI to Russian text):
--       bot_used_for_notifications  the bot of the storefront connection is already the notification bot of this shop
--       bot_used_for_storefront     the bot of the notification channel is already the storefront bot of this shop
--
-- Scope: the rule is per shop (shop_id), as asked. Between shops nothing new is restricted: a storefront bot still belongs to
-- at most one shop (its webhook and Menu Button can point to one storefront only; unique bot_id of 20261107090000), while a
-- notification bot only POSTS messages, holds no webhook, and stays free of any cross-shop rule it never had.
--
-- Existing data: the registry is filled from both tables (a notification row without bot_id gets the id from its token hint:
-- a BotFather token is "<bot id>:<secret>", which the Edge Functions verify against getMe on every save). A shop that
-- ALREADY has one bot in both purposes keeps both working (nothing is deleted or switched off); only its storefront side is
-- registered, and the next save of the notification settings is refused with bot_used_for_storefront until another bot is used.
--
-- Security model is unchanged: every new function in `public` is EXECUTE-able by service_role only; the actor is re-checked
-- inside; tokens stay in Supabase Vault and appear in no error text.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Registry
-- ---------------------------------------------------------------------------

create table private.shop_bot_assignments (
  shop_id uuid not null references public.shops (id) on delete cascade,
  purpose text not null check (purpose in ('notifications', 'storefront')),
  bot_id bigint not null check (bot_id > 0),
  assigned_at timestamptz not null default now(),
  primary key (shop_id, purpose),
  constraint shop_bot_assignments_one_purpose_per_bot unique (shop_id, bot_id)
);

revoke all on private.shop_bot_assignments from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Private helpers and triggers
-- ---------------------------------------------------------------------------

-- Serialises everything that assigns a bot within one shop for the rest of the transaction.
create or replace function private.lock_shop_bots(p_shop_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(hashtextextended('shop_bots:' || p_shop_id::text, 0));
$$;

-- Keeps the registry in step with a connection table (TG_ARGV[0] = purpose).
create or replace function private.sync_bot_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purpose text := tg_argv[0];
begin
  if tg_op = 'DELETE' then
    delete from private.shop_bot_assignments where shop_id = old.shop_id and purpose = v_purpose;
    return null;
  end if;
  if new.bot_id is null then
    delete from private.shop_bot_assignments where shop_id = new.shop_id and purpose = v_purpose;
    return null;
  end if;
  begin
    insert into private.shop_bot_assignments as a (shop_id, purpose, bot_id)
    values (new.shop_id, v_purpose, new.bot_id)
    on conflict (shop_id, purpose) do update set bot_id = excluded.bot_id, assigned_at = now()
      where a.bot_id is distinct from excluded.bot_id;
  exception when unique_violation then
    -- The other purpose of this shop already uses this bot.
    raise exception 'bot_used_for_%', case when v_purpose = 'storefront' then 'notifications' else 'storefront' end
      using errcode = 'P0001';
  end;
  return null;
end;
$$;

-- Existing rows first, triggers afterwards (so the backfill itself is not run through them).
insert into private.shop_bot_assignments (shop_id, purpose, bot_id)
select c.shop_id, 'storefront', c.bot_id from private.shop_bot_connections c
on conflict do nothing;

insert into private.shop_bot_assignments (shop_id, purpose, bot_id)
select n.shop_id, 'notifications', coalesce(n.bot_id, nullif(split_part(n.token_hint, ':', 1), '')::bigint)
from private.shop_notification_settings n
where coalesce(n.bot_id, nullif(split_part(n.token_hint, ':', 1), '')::bigint) > 0
-- A shop that already has the same bot in both purposes: its storefront row is kept, see the header.
on conflict do nothing;

create trigger shop_bot_connections_sync_assignment
  after insert or update of bot_id or delete on private.shop_bot_connections
  for each row execute function private.sync_bot_assignment('storefront');

create trigger shop_notification_settings_sync_assignment
  after insert or update of bot_id or delete on private.shop_notification_settings
  for each row execute function private.sync_bot_assignment('notifications');

revoke all on function private.lock_shop_bots(uuid) from public, anon, authenticated;
revoke all on function private.sync_bot_assignment() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Storefront bot («Подключение бота»)
-- ---------------------------------------------------------------------------

-- Pre-check before anything is changed in Telegram. Raises bot_in_use (another shop of the platform has this bot) and
-- bot_used_for_notifications (this shop sends its order notifications with this bot).
create or replace function public.bot_assert_available(p_shop_id uuid, p_actor uuid, p_bot_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  if exists (select 1 from private.shop_bot_connections c where c.bot_id = p_bot_id and c.shop_id <> p_shop_id) then
    raise exception 'bot_in_use' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.shop_bot_assignments a where a.shop_id = p_shop_id and a.purpose = 'notifications' and a.bot_id = p_bot_id) then
    raise exception 'bot_used_for_notifications' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'same_bot', exists (select 1 from private.shop_bot_connections c where c.bot_id = p_bot_id and c.shop_id = p_shop_id)
  );
end;
$$;

-- Creates or replaces the shop's storefront connection (body of 20261107090000 plus the per-shop lock and the
-- notification-bot check, both BEFORE the Vault secret is written).
create or replace function public.bot_save_connection(
  p_shop_id uuid,
  p_actor uuid,
  p_bot_token text,
  p_bot_id bigint,
  p_bot_username text,
  p_connection_id uuid,
  p_webhook_secret_hash text,
  p_webhook_url text,
  p_menu_button_url text,
  p_menu_button_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old private.shop_bot_connections%rowtype;
  v_has_old boolean;
  v_secret uuid;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  -- Serialises with an ownership change (which locks the shop FOR UPDATE): a save by a former owner either commits
  -- before the change (and is revoked by it) or runs after it (and is refused above).
  perform 1 from public.shops where id = p_shop_id for share;
  if p_bot_token is null or p_bot_token !~ '^[0-9]{5,12}:[A-Za-z0-9_-]{30,64}$' or split_part(p_bot_token, ':', 1)::bigint <> p_bot_id then
    raise exception 'invalid_token' using errcode = 'P0001';
  end if;
  if p_connection_id is null or p_webhook_secret_hash is null or p_webhook_url is null then
    raise exception 'invalid_connection' using errcode = 'P0001';
  end if;
  -- One bot, one purpose: from here on no other save of this shop's bots runs until this transaction ends.
  perform private.lock_shop_bots(p_shop_id);
  if exists (select 1 from private.shop_bot_connections c where c.bot_id = p_bot_id and c.shop_id <> p_shop_id) then
    raise exception 'bot_in_use' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.shop_bot_assignments a where a.shop_id = p_shop_id and a.purpose = 'notifications' and a.bot_id = p_bot_id) then
    raise exception 'bot_used_for_notifications' using errcode = 'P0001';
  end if;

  select * into v_old from private.shop_bot_connections where shop_id = p_shop_id for update;
  v_has_old := found;
  if v_has_old then
    -- Update ids of the previous connection mean nothing for the new one (and would block the key change).
    delete from private.bot_updates where connection_id = v_old.connection_id;
  end if;

  v_secret := vault.create_secret(
    p_bot_token,
    'shop_tg_bot:' || p_shop_id::text || ':' || gen_random_uuid()::text,
    'Telegram bot token of the bot connection of shop ' || p_shop_id::text
  );

  begin
    insert into private.shop_bot_connections as c (
      shop_id, connection_id, bot_id, bot_username, bot_token_secret_id, token_hint, webhook_secret_hash, webhook_url,
      menu_button_url, menu_button_text, status, last_error, connected_at, updated_by
    ) values (
      p_shop_id, p_connection_id, p_bot_id, p_bot_username, v_secret, private.token_hint(p_bot_token), p_webhook_secret_hash,
      p_webhook_url, p_menu_button_url, p_menu_button_text, 'connected', null, now(), p_actor
    )
    on conflict (shop_id) do update set
      connection_id = excluded.connection_id,
      bot_id = excluded.bot_id,
      bot_username = excluded.bot_username,
      bot_token_secret_id = excluded.bot_token_secret_id,
      token_hint = excluded.token_hint,
      webhook_secret_hash = excluded.webhook_secret_hash,
      webhook_url = excluded.webhook_url,
      menu_button_url = excluded.menu_button_url,
      menu_button_text = excluded.menu_button_text,
      status = 'connected',
      last_error = null,
      connected_at = now(),
      updated_by = excluded.updated_by,
      updated_at = now();
  exception when unique_violation then
    -- Concurrent connection of the same bot to another shop. (A clash with the notification bot of this shop is raised by
    -- the registry trigger as bot_used_for_notifications and is not caught here.)
    raise exception 'bot_in_use' using errcode = 'P0001';
  end;

  if v_has_old then
    delete from vault.secrets where id = v_old.bot_token_secret_id;
  end if;

  return private.bot_settings_json(p_shop_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Notification bot («Уведомления»)
-- ---------------------------------------------------------------------------

-- Pre-check before the Bot API is asked about the chat. Raises bot_used_for_storefront when this shop's storefront runs on
-- this bot.
create or replace function public.notify_assert_bot_available(p_shop_id uuid, p_actor uuid, p_bot_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  if p_bot_id is null or p_bot_id <= 0 then
    raise exception 'invalid_token' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.shop_bot_assignments a where a.shop_id = p_shop_id and a.purpose = 'storefront' and a.bot_id = p_bot_id) then
    raise exception 'bot_used_for_storefront' using errcode = 'P0001';
  end if;
  return jsonb_build_object(
    'same_bot', exists (select 1 from private.shop_bot_assignments a where a.shop_id = p_shop_id and a.purpose = 'notifications' and a.bot_id = p_bot_id)
  );
end;
$$;

-- Body of 20261030090000 plus: the bot id of the saved token is REQUIRED (p_meta.bot_id, from getMe), it must be the id in
-- the token, and it must not be this shop's storefront bot. p_bot_token = null keeps the stored token (only the chat changes);
-- the bot id is then the stored one. Everything is checked before the Vault secret is written.
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
  v_meta_bot bigint;
  v_bot_id bigint;
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
  begin
    v_meta_bot := nullif(p_meta ->> 'bot_id', '')::bigint;
  exception when others then
    raise exception 'invalid_token' using errcode = 'P0001';
  end;

  -- One bot, one purpose: from here on no other save of this shop's bots runs until this transaction ends.
  perform private.lock_shop_bots(p_shop_id);

  select * into v_existing from private.shop_notification_settings where shop_id = p_shop_id for update;
  v_has_existing := found;
  if not v_has_existing and p_bot_token is null then
    raise exception 'token_required' using errcode = 'P0001';
  end if;

  if p_bot_token is not null then
    -- The id comes from getMe (Edge Function); it must be the id the token itself carries.
    v_bot_id := split_part(p_bot_token, ':', 1)::bigint;
    if v_meta_bot is distinct from v_bot_id then
      raise exception 'invalid_token' using errcode = 'P0001';
    end if;
  else
    v_bot_id := coalesce(v_existing.bot_id, nullif(split_part(v_existing.token_hint, ':', 1), '')::bigint);
    if v_meta_bot is not null and v_meta_bot is distinct from v_bot_id then
      raise exception 'invalid_token' using errcode = 'P0001';
    end if;
  end if;
  if exists (select 1 from private.shop_bot_assignments a where a.shop_id = p_shop_id and a.purpose = 'storefront' and a.bot_id = v_bot_id) then
    raise exception 'bot_used_for_storefront' using errcode = 'P0001';
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
    v_bot_id,
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
    bot_id = excluded.bot_id,
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

-- ---------------------------------------------------------------------------
-- 5. EXECUTE: service_role only (anon / authenticated / PUBLIC get nothing)
-- ---------------------------------------------------------------------------

revoke all on function public.bot_assert_available(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.bot_save_connection(uuid, uuid, text, bigint, text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.notify_assert_bot_available(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.notify_save_settings(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.bot_assert_available(uuid, uuid, bigint) to service_role;
grant execute on function public.bot_save_connection(uuid, uuid, text, bigint, text, uuid, text, text, text, text) to service_role;
grant execute on function public.notify_assert_bot_available(uuid, uuid, bigint) to service_role;
grant execute on function public.notify_save_settings(uuid, uuid, text, text, jsonb) to service_role;
