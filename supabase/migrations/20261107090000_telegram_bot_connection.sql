-- Telegram bot connection of a shop (stage 4A, Expand: additive only, no existing row or function is changed).
--
-- A shop owner connects their OWN bot (BotFather token) in the admin tab «Подключение бота». The bot then answers
-- /start with a configurable welcome message and two inline buttons (open the shop's Mini App, contact the manager),
-- and gets a web_app Menu Button that opens the same storefront.
--
-- Security model (same as the order notifications of 20261025090000):
--   * The bot token is stored ONLY in Supabase Vault (encrypted at rest); tables keep the Vault id and a masked hint.
--   * Everything lives in schema `private` (not exposed through the Data API, no grants for client roles).
--   * Every new function in `public` is EXECUTE-able by service_role only. The admin Edge Function passes the user id
--     it verified from the Supabase Auth JWT as p_actor; private.assert_can_manage_shop re-checks it (shop owner, or a
--     platform admin in an aal2 session). Nothing from the request body can choose another shop's data.
--   * One Telegram bot belongs to at most ONE shop of the platform (unique bot_id).
--   * Incoming Telegram updates are bound to one connection by a random connection_id in the webhook URL and proven by
--     Telegram's secret_token header. Only the SHA-256 of that secret is stored.
--   * Every update_id is processed at most once per connection (bot_updates primary key).
--   * Connection attempts are rate limited per shop and per actor.
--   * The connection and the welcome settings belong to the shop's current owner: an ownership change (transfer or
--     hand-over, journalled in private.shop_transfers) removes both, like the notification channel (audit S2-01).
--
-- Existing shops are untouched: no row is written until an owner connects a bot.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table private.shop_bot_connections (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  -- Public, random binding of the webhook URL to this connection (never the token). New for every (re)connection.
  connection_id uuid not null unique,
  -- One bot per platform shop.
  bot_id bigint not null unique check (bot_id > 0),
  bot_username text not null check (bot_username ~ '^[A-Za-z0-9_]{5,32}$'),
  -- vault.secrets.id of the bot token. The token itself never leaves Vault except into an Edge Function.
  bot_token_secret_id uuid not null,
  token_hint text not null check (char_length(token_hint) <= 40),
  -- SHA-256 (hex) of the secret_token given to setWebhook; Telegram sends the secret in X-Telegram-Bot-Api-Secret-Token.
  webhook_secret_hash text not null check (webhook_secret_hash ~ '^[0-9a-f]{64}$'),
  -- Webhook URL the platform set (used to remove ONLY our own webhook on disconnect).
  webhook_url text not null check (char_length(webhook_url) <= 500),
  -- Menu Button the platform set (used to reset ONLY our own button, and to re-sync when the storefront URL changes).
  menu_button_url text check (menu_button_url is null or char_length(menu_button_url) <= 500),
  menu_button_text text check (menu_button_text is null or char_length(menu_button_text) <= 64),
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- Welcome message and buttons. Kept separately from the connection, so a re-connection or a disconnect keeps them.
-- The URL of button 1 is NOT stored: it is always the shop's current storefront URL, computed on the server.
create table private.shop_bot_welcome (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  -- Plain text (sent without parse_mode: no HTML / Markdown is ever interpreted). Telegram limit: 4096 characters.
  welcome_text text not null check (char_length(welcome_text) between 1 and 4096),
  open_button_text text not null check (char_length(btrim(open_button_text)) between 1 and 64),
  manager_button_text text not null check (char_length(btrim(manager_button_text)) between 1 and 64),
  -- Canonical https://t.me/<username> only (normalised by the Edge Function, re-checked here).
  manager_url text check (manager_url is null or manager_url ~ '^https://t\.me/[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$'),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

-- Idempotency of webhook deliveries: Telegram re-delivers an update until it gets a 2xx.
create table private.bot_updates (
  connection_id uuid not null references private.shop_bot_connections (connection_id) on delete cascade,
  update_id bigint not null,
  received_at timestamptz not null default now(),
  primary key (connection_id, update_id)
);
create index bot_updates_received_idx on private.bot_updates (received_at);

-- Rate limit of connect attempts (each one calls the Bot API with a token typed by the user).
create table private.bot_connect_attempts (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  actor uuid not null,
  created_at timestamptz not null default now()
);
create index bot_connect_attempts_shop_idx on private.bot_connect_attempts (shop_id, created_at);
create index bot_connect_attempts_actor_idx on private.bot_connect_attempts (actor, created_at);

revoke all on private.shop_bot_connections, private.shop_bot_welcome, private.bot_updates, private.bot_connect_attempts
  from public, anon, authenticated;
revoke all on sequence private.bot_connect_attempts_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Private helpers
-- ---------------------------------------------------------------------------

-- Defaults of the welcome message (shown and used until the owner saves their own).
create or replace function private.bot_welcome_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'welcome_text',
      'Добро пожаловать в {название_магазина}' || chr(10) || chr(10)
      || 'Нажмите кнопку "Открыть приложение", чтобы просмотреть каталог и ознакомиться с товарами.' || chr(10) || chr(10)
      || 'По вопросам и помощи нажмите кнопку "Связаться с менеджером" ниже.',
    'open_button_text', 'Открыть приложение',
    'manager_button_text', 'Связаться с менеджером',
    'manager_url', null
  );
$$;

-- Effective welcome settings of a shop (saved values or the defaults).
create or replace function private.bot_welcome_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when w.shop_id is null then private.bot_welcome_defaults() || jsonb_build_object('customized', false, 'updated_at', null)
    else jsonb_build_object(
      'welcome_text', w.welcome_text,
      'open_button_text', w.open_button_text,
      'manager_button_text', w.manager_button_text,
      'manager_url', w.manager_url,
      'customized', true,
      'updated_at', w.updated_at
    )
  end
  from (select p_shop_id as id) x
  left join private.shop_bot_welcome w on w.shop_id = x.id;
$$;

-- What the owner may see: never the token or the webhook secret, only the masked hint and public bot data.
create or replace function private.bot_settings_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'shop', jsonb_build_object('id', sh.id, 'slug', sh.slug, 'name', sh.name),
    'connection', case when c.shop_id is null then null else jsonb_build_object(
      'bot_id', c.bot_id,
      'bot_username', c.bot_username,
      'token_hint', c.token_hint,
      'status', c.status,
      'last_error', c.last_error,
      'menu_button_url', c.menu_button_url,
      'connected_at', c.connected_at,
      'updated_at', c.updated_at
    ) end,
    'welcome', private.bot_welcome_json(sh.id)
  )
  from public.shops sh
  left join private.shop_bot_connections c on c.shop_id = sh.id
  where sh.id = p_shop_id;
$$;

-- The Vault secret lives exactly as long as its connection row (disconnect, ownership change, shop deletion).
create or replace function private.delete_bot_connection_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets where id = old.bot_token_secret_id;
  return null;
end;
$$;

create trigger shop_bot_connections_delete_secret
  after delete on private.shop_bot_connections
  for each row execute function private.delete_bot_connection_secret();

-- Ownership change (private.change_shop_owner journals every transfer / hand-over in private.shop_transfers): the
-- bot of the former owner and their manager link must not keep serving the new owner's shop. Same rule as the
-- notification channel (private.change_shop_owner): a hand-over always; a transfer whenever a previous member lost
-- access (from_user_ids). A repeated transfer to the shop's current sole owner keeps their bot. The new owner connects
-- their own bot, like a fresh shop; the webhook left in Telegram points at an unknown connection and is refused.
create or replace function private.revoke_bot_connection_on_owner_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'handover' or coalesce(cardinality(new.from_user_ids), 0) > 0 then
    delete from private.shop_bot_connections where shop_id = new.shop_id;
    delete from private.shop_bot_welcome where shop_id = new.shop_id;
  end if;
  return null;
end;
$$;

create trigger shop_transfers_revoke_bot_connection
  after insert on private.shop_transfers
  for each row execute function private.revoke_bot_connection_on_owner_change();

revoke all on function private.bot_welcome_defaults() from public, anon, authenticated;
revoke all on function private.bot_welcome_json(uuid) from public, anon, authenticated;
revoke all on function private.bot_settings_json(uuid) from public, anon, authenticated;
revoke all on function private.delete_bot_connection_secret() from public, anon, authenticated;
revoke all on function private.revoke_bot_connection_on_owner_change() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Admin RPCs (service_role only; actor re-checked inside)
-- ---------------------------------------------------------------------------

create or replace function public.bot_get_settings(p_shop_id uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  return private.bot_settings_json(p_shop_id);
end;
$$;

-- Records one connect attempt and refuses when the shop (10 / 15 min) or the actor (20 / 15 min) made too many.
create or replace function public.bot_register_connect_attempt(p_shop_id uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  delete from private.bot_connect_attempts where created_at < now() - interval '1 day';
  if (select count(*) from private.bot_connect_attempts a where a.shop_id = p_shop_id and a.created_at > now() - interval '15 minutes') >= 10
     or (select count(*) from private.bot_connect_attempts a where a.actor = p_actor and a.created_at > now() - interval '15 minutes') >= 20 then
    raise exception 'bot_connect_rate_limited' using errcode = 'P0001';
  end if;
  insert into private.bot_connect_attempts (shop_id, actor) values (p_shop_id, p_actor);
end;
$$;

-- Raises bot_in_use when the bot is already connected to ANOTHER shop of the platform.
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
  return jsonb_build_object(
    'same_bot', exists (select 1 from private.shop_bot_connections c where c.bot_id = p_bot_id and c.shop_id = p_shop_id)
  );
end;
$$;

-- Stored credentials of the shop's connection, for the Edge Function only (sync, disconnect, replace).
create or replace function public.bot_get_credentials(p_shop_id uuid, p_actor uuid)
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
  select c.connection_id, c.bot_id, c.bot_username, c.webhook_url, c.menu_button_url, c.menu_button_text,
         d.decrypted_secret as bot_token
    into v_row
  from private.shop_bot_connections c
  join vault.decrypted_secrets d on d.id = c.bot_token_secret_id
  where c.shop_id = p_shop_id;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'bot_token', v_row.bot_token,
    'bot_id', v_row.bot_id,
    'bot_username', v_row.bot_username,
    'connection_id', v_row.connection_id,
    'webhook_url', v_row.webhook_url,
    'menu_button_url', v_row.menu_button_url,
    'menu_button_text', v_row.menu_button_text
  );
end;
$$;

-- Creates or replaces the shop's connection after the Edge Function verified the bot (getMe), set the webhook and the
-- Menu Button. A replaced token gets a NEW Vault secret; the previous one is deleted in the same transaction.
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
  if exists (select 1 from private.shop_bot_connections c where c.bot_id = p_bot_id and c.shop_id <> p_shop_id) then
    raise exception 'bot_in_use' using errcode = 'P0001';
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
    -- Concurrent connection of the same bot to another shop.
    raise exception 'bot_in_use' using errcode = 'P0001';
  end;

  if v_has_old then
    delete from vault.secrets where id = v_old.bot_token_secret_id;
  end if;

  return private.bot_settings_json(p_shop_id);
end;
$$;

-- Menu Button state after a (re-)sync by the Edge Function; p_ok = false records the error for the owner.
create or replace function public.bot_record_sync(
  p_shop_id uuid,
  p_actor uuid,
  p_ok boolean,
  p_error text,
  p_menu_button_url text,
  p_menu_button_text text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  update private.shop_bot_connections
    set status = case when p_ok then 'connected' else 'error' end,
        last_error = case when p_ok then null else left(p_error, 300) end,
        menu_button_url = case when p_ok then p_menu_button_url else menu_button_url end,
        menu_button_text = case when p_ok then p_menu_button_text else menu_button_text end,
        updated_by = p_actor,
        updated_at = now()
    where shop_id = p_shop_id;
  if not found then
    raise exception 'not_connected' using errcode = 'P0001';
  end if;
  return private.bot_settings_json(p_shop_id);
end;
$$;

-- Removes the connection (and, by trigger, the Vault secret). The welcome settings stay for a later re-connection.
-- p_connection_id: only the connection the Edge Function cleaned up in Telegram is deleted (a concurrent re-connect
-- with another connection id is kept).
create or replace function public.bot_delete_connection(p_shop_id uuid, p_actor uuid, p_connection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  delete from private.shop_bot_connections where shop_id = p_shop_id and connection_id = p_connection_id;
  return private.bot_settings_json(p_shop_id);
end;
$$;

-- Saves the welcome message and both button texts / the manager link (validated by the Edge Function, re-checked by
-- the table constraints).
create or replace function public.bot_save_welcome(
  p_shop_id uuid,
  p_actor uuid,
  p_welcome_text text,
  p_open_button_text text,
  p_manager_button_text text,
  p_manager_url text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  perform 1 from public.shops where id = p_shop_id for share;
  begin
    insert into private.shop_bot_welcome as w (shop_id, welcome_text, open_button_text, manager_button_text, manager_url, updated_by)
    values (p_shop_id, p_welcome_text, btrim(p_open_button_text), btrim(p_manager_button_text), nullif(p_manager_url, ''), p_actor)
    on conflict (shop_id) do update set
      welcome_text = excluded.welcome_text,
      open_button_text = excluded.open_button_text,
      manager_button_text = excluded.manager_button_text,
      manager_url = excluded.manager_url,
      updated_by = excluded.updated_by,
      updated_at = now();
  exception when check_violation or not_null_violation then
    raise exception 'invalid_welcome' using errcode = 'P0001';
  end;
  return private.bot_settings_json(p_shop_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Webhook RPCs (service_role only; called by the telegram-webhook Edge Function)
-- ---------------------------------------------------------------------------

-- Authenticates one incoming update and claims its update_id. Returns null when the connection is unknown or the
-- secret does not match (nothing is revealed); {"duplicate": true} for an already processed update_id; otherwise
-- what is needed to answer: token, current storefront data and the welcome settings.
create or replace function public.bot_webhook_begin(p_connection_id uuid, p_secret_hash text, p_update_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_claimed integer;
begin
  if p_connection_id is null or p_secret_hash is null or p_update_id is null or p_secret_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select c.shop_id, c.connection_id, c.bot_id, c.bot_username, c.webhook_secret_hash, c.menu_button_url, c.menu_button_text,
         d.decrypted_secret as bot_token, sh.slug, sh.name, sh.status
    into v_row
  from private.shop_bot_connections c
  join vault.decrypted_secrets d on d.id = c.bot_token_secret_id
  join public.shops sh on sh.id = c.shop_id
  where c.connection_id = p_connection_id;
  if not found or v_row.webhook_secret_hash <> p_secret_hash then
    return null;
  end if;

  insert into private.bot_updates (connection_id, update_id) values (p_connection_id, p_update_id)
  on conflict do nothing;
  get diagnostics v_claimed = row_count;
  -- Housekeeping: Telegram re-delivers for at most 24 hours.
  delete from private.bot_updates where received_at < now() - interval '3 days';
  if v_claimed = 0 then
    return jsonb_build_object('duplicate', true);
  end if;

  return jsonb_build_object(
    'duplicate', false,
    'bot_token', v_row.bot_token,
    'bot_id', v_row.bot_id,
    'bot_username', v_row.bot_username,
    'menu_button_url', v_row.menu_button_url,
    'menu_button_text', v_row.menu_button_text,
    'shop', jsonb_build_object('id', v_row.shop_id, 'slug', v_row.slug, 'name', v_row.name, 'status', v_row.status),
    'welcome', private.bot_welcome_json(v_row.shop_id)
  );
end;
$$;

-- Releases a claimed update_id after a transient failure, so Telegram's re-delivery is processed.
create or replace function public.bot_webhook_release(p_connection_id uuid, p_update_id bigint)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.bot_updates where connection_id = p_connection_id and update_id = p_update_id;
$$;

-- Records a Menu Button re-sync done while answering an update (the storefront URL changed since the last sync).
create or replace function public.bot_webhook_record_menu(p_connection_id uuid, p_menu_button_url text, p_menu_button_text text)
returns void
language sql
security definer
set search_path = ''
as $$
  update private.shop_bot_connections
    set menu_button_url = p_menu_button_url, menu_button_text = p_menu_button_text, updated_at = now()
    where connection_id = p_connection_id;
$$;

-- ---------------------------------------------------------------------------
-- 5. Mini App initData of a shop's own bot (checkout / my-orders Edge Functions)
-- ---------------------------------------------------------------------------

-- A Mini App opened from the shop's bot carries initData signed with THAT bot's token. The checkout / my-orders
-- functions accept such initData only for the shop the bot is connected to; this returns the token for that check.
create or replace function public.bot_initdata_token(p_shop_slug text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select d.decrypted_secret
  from public.shops sh
  join private.shop_bot_connections c on c.shop_id = sh.id
  join vault.decrypted_secrets d on d.id = c.bot_token_secret_id
  where sh.slug = p_shop_slug and sh.status = 'active';
$$;

-- ---------------------------------------------------------------------------
-- 6. EXECUTE: service_role only (anon / authenticated / PUBLIC get nothing)
-- ---------------------------------------------------------------------------

revoke all on function public.bot_get_settings(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bot_register_connect_attempt(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bot_assert_available(uuid, uuid, bigint) from public, anon, authenticated;
revoke all on function public.bot_get_credentials(uuid, uuid) from public, anon, authenticated;
revoke all on function public.bot_save_connection(uuid, uuid, text, bigint, text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.bot_record_sync(uuid, uuid, boolean, text, text, text) from public, anon, authenticated;
revoke all on function public.bot_delete_connection(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.bot_save_welcome(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.bot_webhook_begin(uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.bot_webhook_release(uuid, bigint) from public, anon, authenticated;
revoke all on function public.bot_webhook_record_menu(uuid, text, text) from public, anon, authenticated;
revoke all on function public.bot_initdata_token(text) from public, anon, authenticated;

grant execute on function public.bot_get_settings(uuid, uuid) to service_role;
grant execute on function public.bot_register_connect_attempt(uuid, uuid) to service_role;
grant execute on function public.bot_assert_available(uuid, uuid, bigint) to service_role;
grant execute on function public.bot_get_credentials(uuid, uuid) to service_role;
grant execute on function public.bot_save_connection(uuid, uuid, text, bigint, text, uuid, text, text, text, text) to service_role;
grant execute on function public.bot_record_sync(uuid, uuid, boolean, text, text, text) to service_role;
grant execute on function public.bot_delete_connection(uuid, uuid, uuid) to service_role;
grant execute on function public.bot_save_welcome(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.bot_webhook_begin(uuid, text, bigint) to service_role;
grant execute on function public.bot_webhook_release(uuid, bigint) to service_role;
grant execute on function public.bot_webhook_record_menu(uuid, text, text) to service_role;
grant execute on function public.bot_initdata_token(text) to service_role;
