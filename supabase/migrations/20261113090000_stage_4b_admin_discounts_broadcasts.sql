-- Stage 4B (Expand): admin, discounts and Telegram communications. Backward compatible with the deployed frontend and
-- Edge Functions: every table / column is new, every existing RPC keeps its signature, grants and behaviour for the
-- callers that exist today.
--
--   1. Discount price of a product     products.discount_price_minor (optional, > 0 and < base price). create_order_v2
--                                      charges it and stores the list price next to the charged one in the order line.
--   2. Bot audience                    who started the shop's OWN bot (webhook): Telegram user id → chat id, per shop
--                                      and bot. The only source of recipients for broadcasts and buyer notifications.
--   3. Premium (custom) emoji          optional icon_custom_emoji_id of both welcome buttons.
--   4. Broadcasts («Рассылка»)         queue per broadcast, one active broadcast per shop, worker lease, Telegram
--                                      retry_after, at-most-once delivery, owner-triggered retry of failed sends.
--   5. Buyer order notification        outbox next to the admin one (one row per order, ever); sent through the shop's
--                                      own bot and only to a buyer who started that bot.
--   6. Deletion of LIVE shops          same state machine as the DEMO deletion (20261102090200) plus a step-up MFA
--                                      confirmation bound to the shop; the DEMO path keeps its contract. The shared
--                                      purge now also covers the bot connection (a DEMO shop with a connected bot could
--                                      not be deleted since 20261107090000: deletion_verification_failed).
--
-- Security model (unchanged): everything new lives in schema `private`; every new function in `public` is
-- EXECUTE-able by service_role only; admin RPCs re-check the actor (private.assert_can_manage_shop /
-- private.assert_platform_admin); nothing from a request body chooses another shop's data. Bot tokens stay in Vault.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Discount price
-- ---------------------------------------------------------------------------

-- NULL = no discount (every existing product). The list price stays in base_price_minor.
alter table public.products
  add column discount_price_minor bigint
    constraint products_discount_price_check
      check (discount_price_minor is null or (discount_price_minor > 0 and discount_price_minor < base_price_minor));

grant insert (discount_price_minor) on public.products to authenticated;
grant update (discount_price_minor) on public.products to authenticated;

-- List price of a line that was sold with a discount (NULL: sold at the list price, and every older order).
alter table public.order_items
  add column original_unit_price_minor bigint
    constraint order_items_original_price_check
      check (original_unit_price_minor is null or original_unit_price_minor > unit_price_minor);

-- Same as 20261026090000 plus original_unit_price_minor of every item.
create or replace function public.order_to_json(p_order_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id,
    'shop_id', o.shop_id,
    'order_number', o.order_number,
    'status', o.status,
    'currency', o.currency,
    'total_minor', o.total_minor,
    'contact_name', o.contact_name,
    'contact_phone', o.contact_phone,
    'comment', o.comment,
    'fulfillment_method', o.fulfillment_method,
    'delivery_address', o.delivery_address,
    'is_test', o.is_test,
    'created_at', o.created_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', i.id,
        'product_id', i.product_id,
        'variant_id', i.variant_id,
        'product_name', i.product_name,
        'variant_label', i.variant_label,
        'flavor', i.flavor,
        'color', i.color,
        'unit_price_minor', i.unit_price_minor,
        'original_unit_price_minor', i.original_unit_price_minor,
        'quantity', i.quantity,
        'line_total_minor', i.line_total_minor
      ) order by i.created_at, i.id)
      from public.order_items i where i.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where o.id = p_order_id;
$$;

-- Same as 20261030090100 except the price: a line is charged coalesce(variant override, product discount, product
-- price) — always computed here, never taken from the request — and the list price of a discounted line is stored in
-- order_items.original_unit_price_minor. price_changed also reports the list prices.
create or replace function public.create_order_v2(
  p_shop_slug text,
  p_customer_tg_id bigint,
  p_customer_snapshot jsonb,
  p_items jsonb,
  p_idempotency_key uuid,
  p_request_hash text,
  p_fulfillment_method text,
  p_delivery_address text,
  p_comment text,
  p_expected_currency text,
  p_expected_total_minor bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_existing public.orders%rowtype;
  v_order_id uuid;
  v_order_number integer;
  v_total bigint := 0;
  v_requested_count integer;
  v_found_count integer;
  v_updated integer;
  v_address text;
  v_limits jsonb;
  v_units integer;
  v_row record;
begin
  if p_customer_tg_id is null or p_customer_tg_id <= 0 then
    raise exception 'invalid_customer' using errcode = 'P0001';
  end if;
  if p_idempotency_key is null or coalesce(p_request_hash, '') = '' then
    raise exception 'invalid_idempotency_key' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items' using errcode = 'P0001';
  end if;

  select * into v_shop from public.shops where slug = p_shop_slug;
  if not found or v_shop.status <> 'active' then
    raise exception 'shop_unavailable' using errcode = 'P0001';
  end if;
  -- DEMO shops show a client-side test order only: nothing is stored, no stock moves (also enforced by the
  -- orders_refuse_demo_shop trigger for every other path).
  if v_shop.is_demo then
    raise exception 'shop_demo' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_shop.id::text || ':' || p_customer_tg_id::text || ':' || p_idempotency_key::text, 0)
  );

  select * into v_existing from public.orders
  where shop_id = v_shop.id
    and customer_tg_id = p_customer_tg_id
    and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash <> p_request_hash then
      raise exception 'idempotency_conflict' using errcode = 'P0001';
    end if;
    return jsonb_build_object('replayed', true, 'order', public.order_to_json(v_existing.id));
  end if;

  if v_shop.mode <> 'live' then
    raise exception 'shop_preview' using errcode = 'P0001';
  end if;

  if p_expected_currency is distinct from v_shop.currency then
    raise exception 'currency_mismatch' using errcode = 'P0001',
      detail = jsonb_build_object('currency', v_shop.currency)::text;
  end if;

  if p_fulfillment_method is null or p_fulfillment_method not in ('delivery', 'pickup') then
    raise exception 'invalid_fulfillment' using errcode = 'P0001';
  end if;
  if (p_fulfillment_method = 'delivery' and not v_shop.delivery_enabled)
     or (p_fulfillment_method = 'pickup' and not v_shop.pickup_enabled) then
    raise exception 'fulfillment_unavailable' using errcode = 'P0001',
      detail = jsonb_build_object('delivery', v_shop.delivery_enabled, 'pickup', v_shop.pickup_enabled)::text;
  end if;
  if p_fulfillment_method = 'delivery' then
    v_address := nullif(btrim(coalesce(p_delivery_address, '')), '');
    if v_address is null or char_length(v_address) > 300 then
      raise exception 'invalid_address' using errcode = 'P0001';
    end if;
  else
    v_address := null;
  end if;

  if p_comment is not null and char_length(btrim(p_comment)) > 500 then
    raise exception 'invalid_comment' using errcode = 'P0001';
  end if;

  create temporary table if not exists pg_temp.checkout_lines (
    variant_id uuid primary key,
    quantity integer not null
  ) on commit drop;
  truncate pg_temp.checkout_lines;

  begin
    insert into pg_temp.checkout_lines (variant_id, quantity)
    select (e ->> 'variant_id')::uuid, sum((e ->> 'quantity')::integer)
    from jsonb_array_elements(p_items) e
    group by (e ->> 'variant_id')::uuid;
  exception when invalid_text_representation or numeric_value_out_of_range or not_null_violation then
    raise exception 'invalid_items' using errcode = 'P0001';
  end;

  if exists (
    select 1 from pg_temp.checkout_lines
    where variant_id is null or quantity is null or quantity < 1 or quantity > 99
  ) then
    raise exception 'invalid_quantity' using errcode = 'P0001';
  end if;

  -- F-04: size of one order, then the rate limits (under the per-user locks), before any stock row is locked.
  v_limits := private.checkout_limits_for(v_shop.id);
  select coalesce(sum(quantity), 0) into v_units from pg_temp.checkout_lines;
  if v_units > (v_limits ->> 'max_units_per_order')::integer then
    raise exception 'order_too_large' using errcode = 'P0001',
      detail = jsonb_build_object('max_units', (v_limits ->> 'max_units_per_order')::integer, 'units', v_units)::text;
  end if;
  perform private.enforce_checkout_rate_limits(v_shop.id, p_customer_tg_id, v_limits);

  select count(*) into v_requested_count from pg_temp.checkout_lines;

  -- Own name (not checkout_locked): the table of the previous function version has another shape and may still
  -- exist in a transaction that called it.
  create temporary table if not exists pg_temp.checkout_priced (
    variant_id uuid primary key,
    product_id uuid not null,
    product_name text not null,
    flavor text,
    color text,
    unit_price_minor bigint not null,
    original_unit_price_minor bigint,
    stock_quantity integer not null,
    quantity integer not null,
    sellable boolean not null
  ) on commit drop;
  truncate pg_temp.checkout_priced;

  -- Lock variant rows in id order and take every value from the locked row (see 20261014090400).
  insert into pg_temp.checkout_priced (variant_id, product_id, product_name, flavor, color, unit_price_minor, stock_quantity, quantity, sellable)
  select v.id, v.product_id, '', v.flavor, v.color, coalesce(v.price_override_minor, -1),
         v.stock_quantity, l.quantity, v.is_active
  from public.product_variants v
  join pg_temp.checkout_lines l on l.variant_id = v.id
  where v.shop_id = v_shop.id
  order by v.id
  for update of v;

  -- The right-hand sides read the row as it was before this UPDATE (unit_price_minor = override or -1).
  update pg_temp.checkout_priced k
  set product_name = p.name,
      unit_price_minor = case
        when k.unit_price_minor >= 0 then k.unit_price_minor
        else coalesce(p.discount_price_minor, p.base_price_minor)
      end,
      original_unit_price_minor = case
        when k.unit_price_minor < 0 and p.discount_price_minor is not null and p.discount_price_minor < p.base_price_minor
          then p.base_price_minor
      end,
      sellable = k.sellable and p.is_published and p.archived_at is null and c.is_active and c.archived_at is null
  from public.products p
  join public.categories c on c.shop_id = p.shop_id and c.id = p.category_id
  where p.id = k.product_id and p.shop_id = v_shop.id;

  select count(*) into v_found_count from pg_temp.checkout_priced;
  if v_found_count <> v_requested_count then
    raise exception 'item_unavailable' using errcode = 'P0001',
      detail = (select coalesce(jsonb_agg(l.variant_id), '[]'::jsonb)::text
                from pg_temp.checkout_lines l
                where not exists (select 1 from pg_temp.checkout_priced k where k.variant_id = l.variant_id));
  end if;

  if exists (select 1 from pg_temp.checkout_priced where not sellable or product_name = '') then
    raise exception 'item_unavailable' using errcode = 'P0001',
      detail = (select jsonb_agg(variant_id)::text from pg_temp.checkout_priced where not sellable or product_name = '');
  end if;

  if exists (select 1 from pg_temp.checkout_priced where quantity > stock_quantity) then
    raise exception 'insufficient_stock' using errcode = 'P0001',
      detail = (select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'available', stock_quantity))::text
                from pg_temp.checkout_priced where quantity > stock_quantity);
  end if;

  select sum(unit_price_minor * quantity) into v_total from pg_temp.checkout_priced;

  if p_expected_total_minor is not null and p_expected_total_minor <> v_total then
    raise exception 'price_changed' using errcode = 'P0001',
      detail = jsonb_build_object(
        'total_minor', v_total,
        'prices', (select jsonb_agg(jsonb_build_object(
                     'variant_id', variant_id,
                     'unit_price_minor', unit_price_minor,
                     'original_unit_price_minor', original_unit_price_minor))
                   from pg_temp.checkout_priced)
      )::text;
  end if;

  insert into public.shop_order_counters as c (shop_id, last_number)
  values (v_shop.id, 1)
  on conflict (shop_id) do update set last_number = c.last_number + 1
  returning last_number into v_order_number;

  insert into public.orders (
    shop_id, order_number, customer_tg_id, customer_snapshot, contact_name, contact_phone, comment,
    fulfillment_method, delivery_address,
    status, currency, total_minor, idempotency_key, request_hash, stock_state, is_test
  ) values (
    v_shop.id, v_order_number, p_customer_tg_id, coalesce(p_customer_snapshot, '{}'::jsonb), null, null,
    nullif(btrim(coalesce(p_comment, '')), ''),
    p_fulfillment_method, v_address,
    'new', v_shop.currency, v_total, p_idempotency_key, p_request_hash, 'deducted', false
  )
  returning id into v_order_id;

  for v_row in select * from pg_temp.checkout_priced order by variant_id loop
    update public.product_variants
      set stock_quantity = stock_quantity - v_row.quantity
      where id = v_row.variant_id and stock_quantity >= v_row.quantity;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'insufficient_stock' using errcode = 'P0001',
        detail = jsonb_build_array(jsonb_build_object('variant_id', v_row.variant_id, 'available', 0))::text;
    end if;

    insert into public.order_items (
      shop_id, order_id, product_id, variant_id, product_name, variant_label, flavor, color,
      unit_price_minor, original_unit_price_minor, quantity, line_total_minor
    ) values (
      v_shop.id, v_order_id, v_row.product_id, v_row.variant_id, v_row.product_name,
      concat_ws(' · ', v_row.flavor, v_row.color), v_row.flavor, v_row.color,
      v_row.unit_price_minor, v_row.original_unit_price_minor, v_row.quantity, v_row.unit_price_minor * v_row.quantity
    );

    insert into public.inventory_movements (shop_id, variant_id, order_id, delta, reason, operation_key)
    values (v_shop.id, v_row.variant_id, v_order_id, -v_row.quantity, 'checkout',
            'checkout:' || v_order_id::text || ':' || v_row.variant_id::text);
  end loop;

  return jsonb_build_object('replayed', false, 'order', public.order_to_json(v_order_id));
end;
$$;

-- Same as 20261026090000 except that the clone keeps the discount price of every product.
create or replace function public.platform_create_demo_shop(p_actor uuid, p_template_id uuid, p_slug text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tpl public.shops%rowtype;
  v_id uuid := gen_random_uuid();
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_name text := btrim(coalesce(p_name, ''));
  v_files jsonb;
begin
  perform private.assert_platform_admin(p_actor);
  if v_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$' then
    raise exception 'invalid_slug' using errcode = 'P0001';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = 'P0001';
  end if;
  select * into v_tpl from public.shops where id = p_template_id and is_demo and status = 'active';
  if not found then
    raise exception 'template_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.shops where slug = v_slug) then
    raise exception 'slug_taken' using errcode = 'P0001';
  end if;

  begin
    -- Created as preview: it becomes public (live) only after its media were copied (platform_publish_demo_shop).
    insert into public.shops (
      id, slug, name, description, logo_path, cover_path, theme_config, currency, status, mode, is_demo,
      age_restriction, info, settings, telegram, delivery_enabled, pickup_enabled, pickup_instructions
    ) values (
      v_id, v_slug, v_name, v_tpl.description,
      private.rebase_media_path(v_tpl.logo_path, v_tpl.id, v_id),
      private.rebase_media_path(v_tpl.cover_path, v_tpl.id, v_id),
      v_tpl.theme_config, v_tpl.currency, 'active', 'preview', true,
      v_tpl.age_restriction, v_tpl.info, v_tpl.settings, v_tpl.telegram,
      v_tpl.delivery_enabled, v_tpl.pickup_enabled, v_tpl.pickup_instructions
    );
  exception when unique_violation then
    raise exception 'slug_taken' using errcode = 'P0001';
  end;

  create temporary table if not exists pg_temp.demo_map (kind text not null, old_id uuid not null, new_id uuid not null, primary key (kind, old_id))
    on commit drop;
  truncate pg_temp.demo_map;

  insert into pg_temp.demo_map (kind, old_id, new_id)
  select 'category', c.id, gen_random_uuid() from public.categories c where c.shop_id = v_tpl.id and c.archived_at is null;
  insert into pg_temp.demo_map (kind, old_id, new_id)
  select 'product', p.id, gen_random_uuid()
  from public.products p
  join pg_temp.demo_map m on m.kind = 'category' and m.old_id = p.category_id
  where p.shop_id = v_tpl.id and p.archived_at is null;
  insert into pg_temp.demo_map (kind, old_id, new_id)
  select 'variant', v.id, gen_random_uuid()
  from public.product_variants v
  join pg_temp.demo_map m on m.kind = 'product' and m.old_id = v.product_id
  where v.shop_id = v_tpl.id;

  insert into public.categories (id, shop_id, name, slug, image_path, sort_order, is_active)
  select m.new_id, v_id, c.name, c.slug, private.rebase_media_path(c.image_path, v_tpl.id, v_id), c.sort_order, c.is_active
  from public.categories c join pg_temp.demo_map m on m.kind = 'category' and m.old_id = c.id;

  insert into public.products (id, shop_id, category_id, name, description, base_price_minor, discount_price_minor, is_published, is_featured, sort_order)
  select m.new_id, v_id, mc.new_id, p.name, p.description, p.base_price_minor, p.discount_price_minor, p.is_published, p.is_featured, p.sort_order
  from public.products p
  join pg_temp.demo_map m on m.kind = 'product' and m.old_id = p.id
  join pg_temp.demo_map mc on mc.kind = 'category' and mc.old_id = p.category_id;

  insert into public.product_variants (id, shop_id, product_id, flavor, color, sku, price_override_minor, stock_quantity, is_active, sort_order)
  select m.new_id, v_id, mp.new_id, v.flavor, v.color, v.sku, v.price_override_minor, v.stock_quantity, v.is_active, v.sort_order
  from public.product_variants v
  join pg_temp.demo_map m on m.kind = 'variant' and m.old_id = v.id
  join pg_temp.demo_map mp on mp.kind = 'product' and mp.old_id = v.product_id;

  insert into public.inventory_movements (shop_id, variant_id, delta, reason, operation_key, actor_user_id)
  select v_id, v.id, v.stock_quantity, 'seed', 'demo-clone:' || v.id::text, p_actor
  from public.product_variants v where v.shop_id = v_id and v.stock_quantity > 0;

  insert into public.product_images (shop_id, product_id, storage_path, sort_order, is_primary, alt_text)
  select v_id, m.new_id, private.rebase_media_path(i.storage_path, v_tpl.id, v_id), i.sort_order, i.is_primary, i.alt_text
  from public.product_images i
  join pg_temp.demo_map m on m.kind = 'product' and m.old_id = i.product_id
  where i.shop_id = v_tpl.id and private.rebase_media_path(i.storage_path, v_tpl.id, v_id) is not null;

  -- Every media object the clone references; the Edge Function copies them with the service role.
  select coalesce(jsonb_agg(distinct jsonb_build_object('from', f.path, 'to', private.rebase_media_path(f.path, v_tpl.id, v_id))), '[]'::jsonb)
    into v_files
  from (
    select v_tpl.logo_path as path
    union all select v_tpl.cover_path
    union all select c.image_path from public.categories c join pg_temp.demo_map m on m.kind = 'category' and m.old_id = c.id
    union all select i.storage_path from public.product_images i join pg_temp.demo_map m on m.kind = 'product' and m.old_id = i.product_id
  ) f
  where private.rebase_media_path(f.path, v_tpl.id, v_id) is not null;

  insert into private.shop_lifecycle_events (shop_id, action, actor, details)
  values (v_id, 'demo_created', p_actor, jsonb_build_object('template_id', v_tpl.id, 'template_slug', v_tpl.slug, 'files', jsonb_array_length(v_files)));

  return jsonb_build_object(
    'shop', jsonb_build_object('id', v_id, 'slug', v_slug, 'name', v_name, 'mode', 'preview', 'is_demo', true),
    'template', jsonb_build_object('id', v_tpl.id, 'slug', v_tpl.slug),
    'files', v_files
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Bot audience: who started the shop's own bot
-- ---------------------------------------------------------------------------

-- One row per (shop, bot, Telegram user). Written only by the telegram-webhook Edge Function for an update that was
-- authenticated for the shop's connection, so a row proves that this user opened a private chat with THIS bot. No
-- name / username is kept. A replaced bot (another bot_id) starts with an empty audience: Telegram does not let a
-- bot write to users of another bot.
create table private.bot_subscribers (
  shop_id uuid not null references public.shops (id) on delete cascade,
  bot_id bigint not null check (bot_id > 0),
  tg_user_id bigint not null check (tg_user_id > 0),
  -- Private chat id (= the user id in Telegram today; stored as received).
  chat_id bigint not null,
  -- active: receives broadcasts. unsubscribed: sent /stop (no broadcasts; order confirmations still arrive).
  -- blocked: Telegram refused a message (the user blocked the bot / deleted the account) — nothing is sent.
  status text not null default 'active' check (status in ('active', 'unsubscribed', 'blocked')),
  first_started_at timestamptz not null default now(),
  last_started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (shop_id, bot_id, tg_user_id)
);
create index bot_subscribers_status_idx on private.bot_subscribers (shop_id, bot_id, status);

revoke all on private.bot_subscribers from public, anon, authenticated;

-- Records what an authenticated update says about its sender. p_event:
--   start     /start                         → active (also after /stop or a block)
--   message   any other private message      → known; a blocked user who writes again is active
--   stop      /stop                          → unsubscribed
--   blocked   my_chat_member: kicked         → blocked
--   unblocked my_chat_member: member         → active again if it was blocked
-- Returns the resulting status (null: unknown connection or nothing recorded).
create or replace function public.bot_webhook_track(p_connection_id uuid, p_tg_user_id bigint, p_chat_id bigint, p_event text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop_id uuid;
  v_bot_id bigint;
  v_status text;
begin
  if p_connection_id is null or p_tg_user_id is null or p_tg_user_id <= 0 or p_chat_id is null
     or p_event is null or p_event not in ('start', 'message', 'stop', 'blocked', 'unblocked') then
    return null;
  end if;
  select c.shop_id, c.bot_id into v_shop_id, v_bot_id
  from private.shop_bot_connections c where c.connection_id = p_connection_id;
  if not found then
    return null;
  end if;

  if p_event in ('start', 'message', 'stop') then
    insert into private.bot_subscribers as s (shop_id, bot_id, tg_user_id, chat_id, status)
    values (v_shop_id, v_bot_id, p_tg_user_id, p_chat_id, case when p_event = 'stop' then 'unsubscribed' else 'active' end)
    on conflict (shop_id, bot_id, tg_user_id) do update set
      chat_id = excluded.chat_id,
      status = case
        when p_event = 'start' then 'active'
        when p_event = 'stop' then 'unsubscribed'
        when s.status = 'blocked' then 'active'
        else s.status
      end,
      last_started_at = case when p_event = 'start' then now() else s.last_started_at end,
      updated_at = now()
    returning s.status into v_status;
  else
    update private.bot_subscribers s
      set status = case when p_event = 'blocked' then 'blocked' else 'active' end, updated_at = now()
      where s.shop_id = v_shop_id and s.bot_id = v_bot_id and s.tg_user_id = p_tg_user_id
        and (p_event = 'blocked' or s.status = 'blocked')
      returning s.status into v_status;
  end if;
  return v_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Premium (custom) emoji on the welcome buttons
-- ---------------------------------------------------------------------------

-- icon_custom_emoji_id of the inline buttons (Bot API). In the welcome TEXT a custom emoji is written inline as
-- <tg-emoji emoji-id="…">🙂</tg-emoji> and needs no column.
alter table private.shop_bot_welcome
  add column open_button_emoji_id text
    constraint shop_bot_welcome_open_emoji_check check (open_button_emoji_id is null or open_button_emoji_id ~ '^[0-9]{5,25}$'),
  add column manager_button_emoji_id text
    constraint shop_bot_welcome_manager_emoji_check check (manager_button_emoji_id is null or manager_button_emoji_id ~ '^[0-9]{5,25}$');

-- Same as 20261107090000 plus the two emoji ids (null by default).
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
    'manager_url', null,
    'open_button_emoji_id', null,
    'manager_button_emoji_id', null
  );
$$;

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
      'open_button_emoji_id', w.open_button_emoji_id,
      'manager_button_emoji_id', w.manager_button_emoji_id,
      'customized', true,
      'updated_at', w.updated_at
    )
  end
  from (select p_shop_id as id) x
  left join private.shop_bot_welcome w on w.shop_id = x.id;
$$;

-- bot_save_welcome (20261107090000) stays for the deployed Edge Function and leaves the emoji ids untouched; the new
-- function saves them as well.
create or replace function public.bot_save_welcome_v2(
  p_shop_id uuid,
  p_actor uuid,
  p_welcome_text text,
  p_open_button_text text,
  p_manager_button_text text,
  p_manager_url text,
  p_open_button_emoji_id text,
  p_manager_button_emoji_id text
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
    insert into private.shop_bot_welcome as w (
      shop_id, welcome_text, open_button_text, manager_button_text, manager_url, open_button_emoji_id, manager_button_emoji_id, updated_by
    ) values (
      p_shop_id, p_welcome_text, btrim(p_open_button_text), btrim(p_manager_button_text), nullif(p_manager_url, ''),
      nullif(btrim(coalesce(p_open_button_emoji_id, '')), ''), nullif(btrim(coalesce(p_manager_button_emoji_id, '')), ''), p_actor
    )
    on conflict (shop_id) do update set
      welcome_text = excluded.welcome_text,
      open_button_text = excluded.open_button_text,
      manager_button_text = excluded.manager_button_text,
      manager_url = excluded.manager_url,
      open_button_emoji_id = excluded.open_button_emoji_id,
      manager_button_emoji_id = excluded.manager_button_emoji_id,
      updated_by = excluded.updated_by,
      updated_at = now();
  exception when check_violation or not_null_violation then
    raise exception 'invalid_welcome' using errcode = 'P0001';
  end;
  return private.bot_settings_json(p_shop_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Broadcasts («Рассылка»)
-- ---------------------------------------------------------------------------

create table private.shop_broadcasts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- The bot the recipients started. Sending stops when the shop's connected bot is another one.
  bot_id bigint not null check (bot_id > 0),
  -- Chosen by the admin page once per "send": a repeated request returns the same broadcast.
  idempotency_key uuid not null,
  -- Template as typed by the owner ({название_магазина}, <tg-emoji …>); rendered by the Edge Function.
  message_text text not null check (char_length(message_text) between 1 and 4096),
  photo_path text check (photo_path is null or photo_path like shop_id::text || '/broadcast/%'),
  -- Telegram file_id of the photo after its first upload (reused for every other recipient).
  photo_file_id text check (photo_file_id is null or char_length(photo_file_id) <= 300),
  button_text text check (button_text is null or char_length(btrim(button_text)) between 1 and 64),
  button_emoji_id text check (button_emoji_id is null or button_emoji_id ~ '^[0-9]{5,25}$'),
  status text not null default 'sending' check (status in ('sending', 'completed', 'cancelled')),
  total integer not null default 0 check (total >= 0),
  -- Telegram flood control (429 retry_after): nothing is sent before this time.
  resume_at timestamptz,
  -- Lease of the one worker that may send right now.
  worker_id uuid,
  worker_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (shop_id, idempotency_key)
);
create index shop_broadcasts_shop_idx on private.shop_broadcasts (shop_id, created_at desc);
-- One broadcast per shop at a time.
create unique index shop_broadcasts_one_active_uidx on private.shop_broadcasts (shop_id) where status = 'sending';

-- Snapshot of the audience at start: one row per recipient, so a user can never get the same broadcast twice.
create table private.broadcast_recipients (
  broadcast_id uuid not null references private.shop_broadcasts (id) on delete cascade,
  shop_id uuid not null references public.shops (id) on delete cascade,
  tg_user_id bigint not null,
  chat_id bigint not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'blocked', 'cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  telegram_message_id bigint,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  updated_at timestamptz not null default now(),
  primary key (broadcast_id, tg_user_id)
);
create index broadcast_recipients_due_idx on private.broadcast_recipients (broadcast_id, status, next_attempt_at);
create index broadcast_recipients_shop_idx on private.broadcast_recipients (shop_id);

revoke all on private.shop_broadcasts, private.broadcast_recipients from public, anon, authenticated;

-- What the owner sees of one broadcast (never a chat id or a user id).
create or replace function private.broadcast_json(p_broadcast_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', b.id,
    'status', b.status,
    'message_text', b.message_text,
    'photo_path', b.photo_path,
    'button_text', b.button_text,
    'button_emoji_id', b.button_emoji_id,
    'total', b.total,
    'counts', (
      select jsonb_build_object(
        'pending', count(*) filter (where r.status in ('pending', 'sending')),
        'sent', count(*) filter (where r.status = 'sent'),
        'failed', count(*) filter (where r.status = 'failed'),
        'blocked', count(*) filter (where r.status = 'blocked'),
        'cancelled', count(*) filter (where r.status = 'cancelled')
      )
      from private.broadcast_recipients r where r.broadcast_id = b.id
    ),
    'resume_at', case when b.status = 'sending' and b.resume_at > now() then b.resume_at end,
    'last_error', b.last_error,
    'created_at', b.created_at,
    'completed_at', b.completed_at
  )
  from private.shop_broadcasts b
  where b.id = p_broadcast_id;
$$;

-- Ends a broadcast. 'cancelled' also drops everything not sent yet.
create or replace function private.broadcast_finish(p_broadcast_id uuid, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_status = 'cancelled' then
    update private.broadcast_recipients
      set status = 'cancelled', locked_until = null, updated_at = now()
      where broadcast_id = p_broadcast_id and status = 'pending';
  end if;
  update private.shop_broadcasts
    set status = p_status, completed_at = now(), resume_at = null, worker_id = null, worker_until = null,
        last_error = left(p_error, 300), updated_at = now()
    where id = p_broadcast_id and status = 'sending';
end;
$$;

-- The «Рассылка» tab: connected bot, audience of that bot, the running broadcast and the latest ones.
create or replace function public.broadcast_overview(p_shop_id uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  return (
    select jsonb_build_object(
      'shop', jsonb_build_object('id', sh.id, 'slug', sh.slug, 'name', sh.name),
      'bot', (
        select jsonb_build_object('bot_username', c.bot_username, 'status', c.status)
        from private.shop_bot_connections c where c.shop_id = sh.id
      ),
      'audience', (
        select jsonb_build_object(
          'active', count(*) filter (where s.status = 'active'),
          'unsubscribed', count(*) filter (where s.status = 'unsubscribed'),
          'blocked', count(*) filter (where s.status = 'blocked')
        )
        from private.bot_subscribers s
        join private.shop_bot_connections c on c.shop_id = s.shop_id and c.bot_id = s.bot_id
        where s.shop_id = sh.id
      ),
      'active', (
        select private.broadcast_json(b.id) from private.shop_broadcasts b where b.shop_id = sh.id and b.status = 'sending'
      ),
      'history', (
        select coalesce(jsonb_agg(private.broadcast_json(b.id) order by b.created_at desc), '[]'::jsonb)
        from (
          select b.id, b.created_at from private.shop_broadcasts b
          where b.shop_id = sh.id order by b.created_at desc limit 10
        ) b
      )
    )
    from public.shops sh
    where sh.id = p_shop_id
  );
end;
$$;

-- Starts a broadcast to everyone who started the shop's CURRENT bot and did not unsubscribe / block it. The content
-- was validated by the Edge Function; the recipients are chosen here and nowhere else.
create or replace function public.broadcast_start(
  p_shop_id uuid,
  p_actor uuid,
  p_idempotency_key uuid,
  p_message_text text,
  p_photo_path text,
  p_button_text text,
  p_button_emoji_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing uuid;
  v_bot_id bigint;
  v_id uuid;
  v_total integer;
  v_photo text := nullif(btrim(coalesce(p_photo_path, '')), '');
  v_button text := nullif(btrim(coalesce(p_button_text, '')), '');
  v_emoji text := nullif(btrim(coalesce(p_button_emoji_id, '')), '');
  v_pruned jsonb;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  -- Serialises with an ownership change (shops FOR UPDATE) and with a parallel start for the same shop.
  perform 1 from public.shops where id = p_shop_id for share;
  perform pg_advisory_xact_lock(hashtextextended('broadcast:' || p_shop_id::text, 0));
  if p_idempotency_key is null then
    raise exception 'invalid_broadcast' using errcode = 'P0001';
  end if;

  select b.id into v_existing from private.shop_broadcasts b
  where b.shop_id = p_shop_id and b.idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('replayed', true, 'broadcast', private.broadcast_json(v_existing), 'pruned_photos', '[]'::jsonb);
  end if;

  select c.bot_id into v_bot_id from private.shop_bot_connections c where c.shop_id = p_shop_id;
  if not found then
    raise exception 'not_connected' using errcode = 'P0001';
  end if;
  if p_message_text is null or btrim(p_message_text) = '' or char_length(p_message_text) > 4096 then
    raise exception 'invalid_broadcast_text' using errcode = 'P0001';
  end if;
  if v_photo is not null and (
    v_photo !~ ('^' || p_shop_id::text || '/broadcast/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$')
    or not exists (select 1 from storage.objects o where o.bucket_id = 'shop-media' and o.name = v_photo)
  ) then
    raise exception 'invalid_broadcast_photo' using errcode = 'P0001';
  end if;
  if (v_button is not null and char_length(v_button) > 64)
     or (v_emoji is not null and (v_button is null or v_emoji !~ '^[0-9]{5,25}$')) then
    raise exception 'invalid_broadcast_button' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.shop_broadcasts b where b.shop_id = p_shop_id and b.status = 'sending') then
    raise exception 'broadcast_in_progress' using errcode = 'P0001';
  end if;
  if (select count(*) from private.shop_broadcasts b where b.shop_id = p_shop_id and b.created_at > now() - interval '24 hours') >= 10 then
    raise exception 'broadcast_rate_limited' using errcode = 'P0001';
  end if;

  insert into private.shop_broadcasts (shop_id, bot_id, idempotency_key, message_text, photo_path, button_text, button_emoji_id, created_by)
  values (p_shop_id, v_bot_id, p_idempotency_key, p_message_text, v_photo, v_button, v_emoji, p_actor)
  returning id into v_id;

  insert into private.broadcast_recipients (broadcast_id, shop_id, tg_user_id, chat_id)
  select v_id, s.shop_id, s.tg_user_id, s.chat_id
  from private.bot_subscribers s
  where s.shop_id = p_shop_id and s.bot_id = v_bot_id and s.status = 'active';
  get diagnostics v_total = row_count;
  if v_total = 0 then
    -- Rolls the broadcast row back as well.
    raise exception 'no_recipients' using errcode = 'P0001';
  end if;
  update private.shop_broadcasts set total = v_total where id = v_id;

  -- History is short: the 30 latest broadcasts of the shop. Photos of the removed ones are returned for cleanup.
  with removed as (
    delete from private.shop_broadcasts b
    where b.shop_id = p_shop_id
      and b.id in (select o.id from private.shop_broadcasts o where o.shop_id = p_shop_id order by o.created_at desc offset 30)
    returning b.photo_path
  )
  select coalesce(jsonb_agg(r.photo_path) filter (where r.photo_path is not null), '[]'::jsonb) into v_pruned from removed r;

  return jsonb_build_object('replayed', false, 'broadcast', private.broadcast_json(v_id), 'pruned_photos', v_pruned);
end;
$$;

-- One worker step: takes the lease and claims the next recipients. `state`:
--   send     recipients + content + the bot token (Edge Function only)
--   paused   Telegram asked to wait (resume_at)
--   waiting  only retries are left and none is due yet (next_attempt_at)
--   busy     another worker holds the lease
--   done     nothing left: the broadcast is completed / cancelled
-- A claim that was never reported (the worker died mid-send) is NOT sent again automatically: it becomes 'failed'
-- (interrupted) and only the owner can retry it — a buyer never gets the same broadcast twice by accident.
create or replace function public.broadcast_claim(p_shop_id uuid, p_actor uuid, p_broadcast_id uuid, p_worker_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b private.shop_broadcasts%rowtype;
  v_conn record;
  v_shop record;
  v_recipients jsonb;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  select * into v_b from private.shop_broadcasts where id = p_broadcast_id and shop_id = p_shop_id for update;
  if not found or p_worker_id is null then
    raise exception 'broadcast_not_found' using errcode = 'P0001';
  end if;
  if v_b.status <> 'sending' then
    return jsonb_build_object('state', 'done');
  end if;

  select c.bot_id, d.decrypted_secret as bot_token into v_conn
  from private.shop_bot_connections c
  join vault.decrypted_secrets d on d.id = c.bot_token_secret_id
  where c.shop_id = p_shop_id;
  if not found or v_conn.bot_id <> v_b.bot_id then
    perform private.broadcast_finish(v_b.id, 'cancelled', 'bot_changed');
    return jsonb_build_object('state', 'done');
  end if;
  if v_b.resume_at is not null and v_b.resume_at > now() then
    return jsonb_build_object('state', 'paused', 'resume_at', v_b.resume_at);
  end if;
  if v_b.worker_until is not null and v_b.worker_until > now() and v_b.worker_id is distinct from p_worker_id then
    return jsonb_build_object('state', 'busy');
  end if;

  update private.broadcast_recipients
    set status = 'failed', last_error = 'interrupted', locked_until = null, updated_at = now()
    where broadcast_id = v_b.id and status = 'sending' and locked_until < now();
  -- Left or blocked the bot since the broadcast started: not sent.
  update private.broadcast_recipients r
    set status = 'cancelled', last_error = 'unsubscribed', updated_at = now()
    where r.broadcast_id = v_b.id and r.status = 'pending'
      and not exists (
        select 1 from private.bot_subscribers s
        where s.shop_id = r.shop_id and s.bot_id = v_b.bot_id and s.tg_user_id = r.tg_user_id and s.status = 'active'
      );

  with picked as (
    select r.tg_user_id
    from private.broadcast_recipients r
    where r.broadcast_id = v_b.id and r.status = 'pending' and r.next_attempt_at <= now()
    order by r.next_attempt_at, r.tg_user_id
    limit least(greatest(coalesce(p_limit, 20), 1), 30)
    for update skip locked
  ), claimed as (
    update private.broadcast_recipients r
      set status = 'sending', attempts = r.attempts + 1, locked_until = now() + interval '3 minutes', updated_at = now()
      from picked
      where r.broadcast_id = v_b.id and r.tg_user_id = picked.tg_user_id
      returning r.tg_user_id, r.chat_id, r.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object('tg_user_id', c.tg_user_id, 'chat_id', c.chat_id, 'attempt', c.attempts) order by c.tg_user_id), '[]'::jsonb)
    into v_recipients
  from claimed c;

  if jsonb_array_length(v_recipients) = 0 then
    if not exists (select 1 from private.broadcast_recipients r where r.broadcast_id = v_b.id and r.status in ('pending', 'sending')) then
      perform private.broadcast_finish(v_b.id, 'completed', null);
      return jsonb_build_object('state', 'done');
    end if;
    return jsonb_build_object('state', 'waiting', 'next_attempt_at', (
      select min(r.next_attempt_at) from private.broadcast_recipients r where r.broadcast_id = v_b.id and r.status = 'pending'
    ));
  end if;

  update private.shop_broadcasts
    set worker_id = p_worker_id, worker_until = now() + interval '90 seconds', updated_at = now()
    where id = v_b.id;
  select sh.slug, sh.name into v_shop from public.shops sh where sh.id = p_shop_id;
  return jsonb_build_object(
    'state', 'send',
    'bot_token', v_conn.bot_token,
    'shop', jsonb_build_object('slug', v_shop.slug, 'name', v_shop.name),
    'broadcast', jsonb_build_object(
      'id', v_b.id,
      'message_text', v_b.message_text,
      'photo_path', v_b.photo_path,
      'photo_file_id', v_b.photo_file_id,
      'button_text', v_b.button_text,
      'button_emoji_id', v_b.button_emoji_id
    ),
    'recipients', v_recipients
  );
end;
$$;

-- Outcome of a claimed batch. p_results: [{ tg_user_id, outcome, message_id?, error? }], outcome:
--   sent     delivered
--   blocked  Telegram refused for good (403: blocked / deactivated) → the subscriber is marked blocked
--   failed   permanent error
--   retry    transient error → again later with backoff, at most 3 attempts
--   release  not attempted (flood control / time budget) → back to the queue, the attempt is not counted
-- p_retry_after: seconds Telegram asked to wait (429) — pauses the whole broadcast.
create or replace function public.broadcast_report(
  p_broadcast_id uuid,
  p_worker_id uuid,
  p_results jsonb,
  p_retry_after integer,
  p_photo_file_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b private.shop_broadcasts%rowtype;
  v_item jsonb;
  v_outcome text;
  v_user bigint;
begin
  select * into v_b from private.shop_broadcasts where id = p_broadcast_id for update;
  if not found then
    return null;
  end if;

  for v_item in select e.value from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) as e(value) loop
    v_outcome := v_item ->> 'outcome';
    v_user := (v_item ->> 'tg_user_id')::bigint;
    if v_outcome is null or v_outcome not in ('sent', 'blocked', 'failed', 'retry', 'release') then
      continue;
    end if;
    -- Only a row this batch still holds; anything else was already settled.
    update private.broadcast_recipients r
      set status = case v_outcome
            when 'sent' then 'sent'
            when 'blocked' then 'blocked'
            when 'failed' then 'failed'
            when 'retry' then case when r.attempts >= 3 then 'failed' else 'pending' end
            else 'pending'
          end,
          attempts = case when v_outcome = 'release' then greatest(r.attempts - 1, 0) else r.attempts end,
          next_attempt_at = case
            when v_outcome = 'retry' then now() + make_interval(secs => 20 * power(2, greatest(r.attempts - 1, 0)))
            else now()
          end,
          telegram_message_id = case when v_outcome = 'sent' then (v_item ->> 'message_id')::bigint else r.telegram_message_id end,
          last_error = case when v_outcome in ('sent', 'release') then null else left(coalesce(v_item ->> 'error', 'unknown_error'), 300) end,
          locked_until = null,
          updated_at = now()
      where r.broadcast_id = p_broadcast_id and r.tg_user_id = v_user and r.status = 'sending';
    if found and v_outcome = 'blocked' then
      update private.bot_subscribers s
        set status = 'blocked', updated_at = now()
        where s.shop_id = v_b.shop_id and s.bot_id = v_b.bot_id and s.tg_user_id = v_user and s.status <> 'blocked';
    end if;
  end loop;

  update private.shop_broadcasts
    set resume_at = case
          when p_retry_after is not null and p_retry_after > 0 then now() + make_interval(secs => least(p_retry_after, 3600) + 1)
          else resume_at
        end,
        photo_file_id = coalesce(photo_file_id, nullif(left(p_photo_file_id, 300), '')),
        worker_until = case when worker_id is not distinct from p_worker_id then null else worker_until end,
        updated_at = now()
    where id = p_broadcast_id;

  if v_b.status <> 'sending' then
    -- Cancelled meanwhile: what this batch gave back is not sent any more.
    update private.broadcast_recipients
      set status = 'cancelled', updated_at = now()
      where broadcast_id = p_broadcast_id and status = 'pending';
  elsif not exists (select 1 from private.broadcast_recipients r where r.broadcast_id = p_broadcast_id and r.status in ('pending', 'sending')) then
    perform private.broadcast_finish(p_broadcast_id, 'completed', null);
  end if;
  return private.broadcast_json(p_broadcast_id);
end;
$$;

-- «Остановить»: everything not sent yet is dropped; messages already in flight are still recorded. p_reason: set by
-- the worker when it has to stop the broadcast itself (e.g. the bot token was revoked); null for the owner.
create or replace function public.broadcast_cancel(p_shop_id uuid, p_actor uuid, p_broadcast_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  perform 1 from private.shop_broadcasts where id = p_broadcast_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'broadcast_not_found' using errcode = 'P0001';
  end if;
  perform private.broadcast_finish(p_broadcast_id, 'cancelled', nullif(btrim(coalesce(p_reason, '')), ''));
  return private.broadcast_json(p_broadcast_id);
end;
$$;

-- «Повторить неудачные»: failed sends of a recent broadcast go back to the queue (blocked users never do).
create or replace function public.broadcast_retry_failed(p_shop_id uuid, p_actor uuid, p_broadcast_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_b private.shop_broadcasts%rowtype;
  v_count integer;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  perform pg_advisory_xact_lock(hashtextextended('broadcast:' || p_shop_id::text, 0));
  select * into v_b from private.shop_broadcasts where id = p_broadcast_id and shop_id = p_shop_id for update;
  if not found then
    raise exception 'broadcast_not_found' using errcode = 'P0001';
  end if;
  if v_b.created_at < now() - interval '48 hours' then
    raise exception 'broadcast_expired' using errcode = 'P0001';
  end if;
  if v_b.status <> 'sending'
     and exists (select 1 from private.shop_broadcasts b where b.shop_id = p_shop_id and b.status = 'sending') then
    raise exception 'broadcast_in_progress' using errcode = 'P0001';
  end if;
  update private.broadcast_recipients
    set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null, locked_until = null, updated_at = now()
    where broadcast_id = p_broadcast_id and status = 'failed';
  get diagnostics v_count = row_count;
  if v_count > 0 and v_b.status <> 'sending' then
    update private.shop_broadcasts
      set status = 'sending', completed_at = null, last_error = null, resume_at = null, updated_at = now()
      where id = p_broadcast_id;
  end if;
  return jsonb_build_object('retried', v_count, 'broadcast', private.broadcast_json(p_broadcast_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Buyer notification about a created order
-- ---------------------------------------------------------------------------

-- Outbox next to private.order_notifications (which belongs to the admin channel): one row per order, ever, so an
-- idempotent checkout replay or a retry can never produce a second message. A row exists only when the buyer started
-- the shop's connected bot before ordering.
create table private.customer_order_notifications (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  order_id uuid not null unique references public.orders (id) on delete cascade,
  bot_id bigint not null check (bot_id > 0),
  tg_user_id bigint not null,
  chat_id bigint not null,
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
create index customer_order_notifications_due_idx on private.customer_order_notifications (shop_id, status, next_attempt_at);

revoke all on private.customer_order_notifications from public, anon, authenticated;
revoke all on sequence private.customer_order_notifications_id_seq from public, anon, authenticated;

-- Outbox producer, inside the checkout transaction. It must never fail an order: any error only skips the message.
create or replace function private.enqueue_customer_order_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into private.customer_order_notifications (shop_id, order_id, bot_id, tg_user_id, chat_id)
    select new.shop_id, new.id, c.bot_id, s.tg_user_id, s.chat_id
    from private.shop_bot_connections c
    join private.bot_subscribers s
      on s.shop_id = c.shop_id and s.bot_id = c.bot_id and s.tg_user_id = new.customer_tg_id and s.status <> 'blocked'
    where c.shop_id = new.shop_id and not new.is_test
    on conflict (order_id) do nothing;
  exception when others then
    raise warning 'customer order notification not enqueued for order %: %', new.id, sqlstate;
  end;
  return null;
end;
$$;

create trigger orders_enqueue_customer_notification
  after insert on public.orders
  for each row execute function private.enqueue_customer_order_notification();

-- Claims due buyer notifications (of one order / one shop). Like notify_claim, with two differences: the channel is
-- the shop's connected bot (a job whose bot is gone or was replaced is dropped), and a claim that was never completed
-- is not sent again (the outcome of that send is unknown; a buyer must not get the message twice).
create or replace function public.customer_notify_claim(p_order_id uuid, p_shop_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs jsonb := '[]'::jsonb;
  v_row record;
begin
  update private.customer_order_notifications n
    set status = 'dead', last_error = 'interrupted', locked_until = null, updated_at = now()
    where (p_order_id is null or n.order_id = p_order_id)
      and (p_shop_id is null or n.shop_id = p_shop_id)
      and n.status = 'sending' and n.locked_until < now();
  update private.customer_order_notifications n
    set status = 'dead', last_error = 'bot_changed', locked_until = null, updated_at = now()
    where (p_order_id is null or n.order_id = p_order_id)
      and (p_shop_id is null or n.shop_id = p_shop_id)
      and n.status in ('pending', 'failed')
      and not exists (select 1 from private.shop_bot_connections c where c.shop_id = n.shop_id and c.bot_id = n.bot_id);

  for v_row in
    with picked as (
      select n.id
      from private.customer_order_notifications n
      where (p_order_id is null or n.order_id = p_order_id)
        and (p_shop_id is null or n.shop_id = p_shop_id)
        and n.status in ('pending', 'failed')
        and n.next_attempt_at <= now()
        and n.created_at > now() - interval '24 hours'
      order by n.id
      limit least(greatest(coalesce(p_limit, 1), 1), 20)
      for update of n skip locked
    )
    update private.customer_order_notifications n
      set status = 'sending', attempts = n.attempts + 1, locked_until = now() + interval '2 minutes', updated_at = now()
      from picked
      where n.id = picked.id
      returning n.id, n.order_id, n.shop_id, n.bot_id, n.chat_id, n.attempts
  loop
    v_jobs := v_jobs || coalesce((
      select jsonb_build_array(jsonb_build_object(
        'notification_id', v_row.id,
        'attempt', v_row.attempts,
        'bot_id', v_row.bot_id,
        'shop_name', sh.name,
        'chat_id', v_row.chat_id,
        'bot_token', d.decrypted_secret,
        'order', public.order_to_json(v_row.order_id)
      ))
      from private.shop_bot_connections c
      join vault.decrypted_secrets d on d.id = c.bot_token_secret_id
      join public.shops sh on sh.id = c.shop_id
      where c.shop_id = v_row.shop_id and c.bot_id = v_row.bot_id
    ), '[]'::jsonb);
  end loop;
  return v_jobs;
end;
$$;

-- Right before sendMessage: true only while this attempt still holds the job, the shop's bot is still the one the
-- buyer started, and the buyer did not block it meanwhile.
create or replace function public.customer_notify_begin_send(p_notification_id bigint, p_attempt integer, p_bot_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.customer_order_notifications n
    join private.shop_bot_connections c on c.shop_id = n.shop_id and c.bot_id = n.bot_id
    join private.bot_subscribers s on s.shop_id = n.shop_id and s.bot_id = n.bot_id and s.tg_user_id = n.tg_user_id
    where n.id = p_notification_id
      and n.status = 'sending'
      and n.attempts = p_attempt
      and n.locked_until > now()
      and n.bot_id = p_bot_id
      and s.status <> 'blocked'
  );
$$;

-- p_blocked: Telegram refused for good (the buyer blocked the bot) — no retry, the subscriber is marked blocked.
create or replace function public.customer_notify_complete(p_notification_id bigint, p_ok boolean, p_message_id bigint, p_error text, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.customer_order_notifications%rowtype;
begin
  select * into v_row from private.customer_order_notifications where id = p_notification_id for update;
  if not found or v_row.status <> 'sending' then
    return;
  end if;
  if p_ok then
    update private.customer_order_notifications
      set status = 'sent', sent_at = now(), telegram_message_id = p_message_id, last_error = null,
          locked_until = null, updated_at = now()
      where id = p_notification_id;
  else
    update private.customer_order_notifications
      set status = case when coalesce(p_blocked, false) or v_row.attempts >= 5 then 'dead' else 'failed' end,
          next_attempt_at = now() + make_interval(secs => 30 * power(2, greatest(v_row.attempts - 1, 0))),
          last_error = left(coalesce(p_error, 'unknown_error'), 300),
          locked_until = null,
          updated_at = now()
      where id = p_notification_id;
    if coalesce(p_blocked, false) then
      update private.bot_subscribers s
        set status = 'blocked', updated_at = now()
        where s.shop_id = v_row.shop_id and s.bot_id = v_row.bot_id and s.tg_user_id = v_row.tg_user_id and s.status <> 'blocked';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Ownership change: the audience belongs to the former owner's bot
-- ---------------------------------------------------------------------------

-- Same rule as private.revoke_bot_connection_on_owner_change (20261107090000), in its own trigger: the bot connection
-- is removed there; here its audience, the broadcasts and the queued buyer notifications go with it.
create or replace function private.revoke_bot_audience_on_owner_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'handover' or coalesce(cardinality(new.from_user_ids), 0) > 0 then
    delete from private.shop_broadcasts where shop_id = new.shop_id;
    delete from private.bot_subscribers where shop_id = new.shop_id;
    update private.customer_order_notifications
      set status = 'dead', last_error = 'owner_changed', locked_until = null, updated_at = now()
      where shop_id = new.shop_id and status in ('pending', 'sending', 'failed');
  end if;
  return null;
end;
$$;

create trigger shop_transfers_revoke_bot_audience
  after insert on private.shop_transfers
  for each row execute function private.revoke_bot_audience_on_owner_change();

-- ---------------------------------------------------------------------------
-- 7. Deletion of LIVE shops (platform admin + step-up MFA)
-- ---------------------------------------------------------------------------

alter table private.shop_deletions
  -- What was deleted and how it was confirmed (NULL: deletions before this migration, all of them DEMO).
  add column was_demo boolean,
  add column step_up_at timestamptz;

-- "Удалить магазин" was opened for this shop by this admin in this session. The deletion is accepted only when the
-- same session verified a TOTP code AFTER this moment (auth.mfa_amr_claims), i.e. the admin typed a fresh code for
-- this very deletion — being signed in at aal2 is not enough.
create table private.shop_delete_challenges (
  shop_id uuid not null references public.shops (id) on delete cascade,
  actor uuid not null,
  session_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (shop_id, actor)
);
revoke all on private.shop_delete_challenges from public, anon, authenticated;

-- Time of the TOTP verification that confirms the deletion of p_shop_id by p_actor; raises mfa_step_up_required when
-- there is no challenge of this session younger than 5 minutes, or no TOTP verification after it. The 2 seconds allow
-- for a clock difference between the Auth server (which stamps the verification) and the database.
create or replace function private.shop_delete_step_up(p_actor uuid, p_shop_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_session uuid := private.request_session_for(p_actor);
  v_challenged timestamptz;
  v_verified timestamptz;
begin
  if v_session is not null then
    select c.created_at into v_challenged
    from private.shop_delete_challenges c
    where c.shop_id = p_shop_id and c.actor = p_actor and c.session_id = v_session
      and c.created_at > now() - interval '5 minutes';
    if v_challenged is not null then
      select max(a.updated_at) into v_verified
      from auth.mfa_amr_claims a
      where a.session_id = v_session and a.authentication_method = 'totp'
        and a.updated_at >= v_challenged - interval '2 seconds';
    end if;
  end if;
  if v_verified is null then
    raise exception 'mfa_step_up_required' using errcode = 'P0001';
  end if;
  return v_verified;
end;
$$;

-- Everything of the shop's own bot: connection (its Vault secret goes with it, by trigger), welcome, audience,
-- broadcasts, buyer notifications. Fails closed while a token of the shop is still stored.
create or replace function private.purge_shop_bot(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.shop_bot_connections where shop_id = p_shop_id;
  delete from vault.secrets s where s.name like 'shop_tg_bot:' || p_shop_id::text || ':%';
  if exists (select 1 from vault.secrets s where s.name like 'shop_tg_bot:' || p_shop_id::text || ':%') then
    raise exception 'bot_cleanup_failed' using errcode = 'P0001';
  end if;
  delete from private.shop_bot_welcome where shop_id = p_shop_id;
  delete from private.bot_connect_attempts where shop_id = p_shop_id;
  delete from private.shop_broadcasts where shop_id = p_shop_id;
  delete from private.broadcast_recipients where shop_id = p_shop_id;
  delete from private.bot_subscribers where shop_id = p_shop_id;
  delete from private.customer_order_notifications where shop_id = p_shop_id;
end;
$$;

-- Same as 20261102090200 plus the Vault secrets of the shop's own bot.
create or replace function private.shop_leftover_rows(p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tbl record;
  v_count bigint;
  v_left jsonb := '{}'::jsonb;
begin
  for v_tbl in
    select c.table_schema, c.table_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.column_name = 'shop_id' and c.table_schema in ('public', 'private') and t.table_type = 'BASE TABLE'
      and not (c.table_schema = 'private' and c.table_name = 'shop_deletions')
    order by 1, 2
  loop
    execute format('select count(*) from %I.%I where shop_id = $1', v_tbl.table_schema, v_tbl.table_name)
      into v_count using p_shop_id;
    if v_count > 0 then
      v_left := v_left || jsonb_build_object(v_tbl.table_schema || '.' || v_tbl.table_name, v_count);
    end if;
  end loop;
  select count(*) into v_count from vault.secrets s
  where s.name like 'shop_tg_notify:' || p_shop_id::text || ':%' or s.name like 'shop_tg_bot:' || p_shop_id::text || ':%';
  if v_count > 0 then
    v_left := v_left || jsonb_build_object('vault.secrets', v_count);
  end if;
  return v_left;
end;
$$;

-- Step 1 of every deletion, for a shop the caller authorised and holds FOR UPDATE: audit row, tenant data, 'deleting',
-- verification that nothing is left (the body of platform_demo_delete_begin of 20261102090200 plus the bot purge).
create or replace function private.shop_delete_begin(p_actor uuid, p_shop public.shops, p_step_up_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_left jsonb;
begin
  -- A hand-over request inside Supabase Auth right now: let it finish (or expire) first.
  perform private.assert_no_live_handover_reservation(p_shop.id);

  insert into private.shop_deletions (shop_id, slug, requested_by, was_demo, step_up_at)
  values (p_shop.id, p_shop.slug, p_actor, p_shop.is_demo, p_step_up_at);

  perform private.purge_shop_notifications(p_shop.id);
  perform private.purge_shop_bot(p_shop.id);

  -- Orders first: their items keep RESTRICT references to products / variants (20261026100000).
  delete from public.orders where shop_id = p_shop.id;
  delete from public.inventory_movements where shop_id = p_shop.id;
  delete from public.product_images where shop_id = p_shop.id;
  delete from public.product_variants where shop_id = p_shop.id;
  delete from public.products where shop_id = p_shop.id;
  delete from public.categories where shop_id = p_shop.id;
  delete from public.shop_order_counters where shop_id = p_shop.id;
  delete from public.shop_memberships where shop_id = p_shop.id;
  delete from private.shop_pending_handovers where shop_id = p_shop.id;
  delete from private.shop_handover_reservations where shop_id = p_shop.id;
  delete from private.handover_invitation_sends where shop_id = p_shop.id;
  delete from private.checkout_limits where shop_id = p_shop.id;
  delete from private.checkout_stock_refusals where shop_id = p_shop.id;
  delete from private.shop_transfers where shop_id = p_shop.id;
  delete from private.shop_lifecycle_events where shop_id = p_shop.id;
  delete from private.shop_delete_challenges where shop_id = p_shop.id;

  update public.shops
    set status = 'deleting', mode = 'preview', logo_path = null, cover_path = null, published_at = null
    where id = p_shop.id;

  v_left := private.shop_leftover_rows(p_shop.id);
  if v_left <> '{}'::jsonb then
    raise exception 'deletion_verification_failed' using errcode = 'P0001', detail = v_left::text;
  end if;

  return jsonb_build_object(
    'status', 'pending',
    'shop', jsonb_build_object('id', p_shop.id, 'slug', p_shop.slug, 'name', p_shop.name),
    'deletion', private.shop_deletion_json(p_shop.id)
  );
end;
$$;

-- Unchanged contract (DEMO only, exact slug, aal2 platform admin, no step-up); the data step is the shared one.
create or replace function public.platform_demo_delete_begin(p_actor uuid, p_shop_id uuid, p_confirm_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
begin
  perform private.assert_platform_admin(p_actor);
  -- The lock every ownership change, reservation and hand-over takes.
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    if exists (select 1 from private.shop_deletions d where d.shop_id = p_shop_id and d.completed_at is not null) then
      return jsonb_build_object('status', 'deleted', 'deletion', private.shop_deletion_json(p_shop_id));
    end if;
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  if v_shop.status = 'deleting' then
    -- Already started (repeat / double click): nothing to do here, continue with Storage + finalize.
    return jsonb_build_object(
      'status', 'pending',
      'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name),
      'deletion', private.shop_deletion_json(v_shop.id)
    );
  end if;
  if not v_shop.is_demo then
    raise exception 'not_demo' using errcode = 'P0001';
  end if;
  if p_confirm_slug is null or btrim(p_confirm_slug) <> v_shop.slug then
    raise exception 'confirmation_mismatch' using errcode = 'P0001';
  end if;
  return private.shop_delete_begin(p_actor, v_shop, null);
end;
$$;

-- What "Удалить магазин" shows for any shop (LIVE included). Never changes anything.
create or replace function public.platform_shop_delete_preview(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_members jsonb;
begin
  perform private.assert_platform_admin(p_actor);
  select * into v_shop from public.shops where id = p_shop_id;
  if not found then
    if exists (select 1 from private.shop_deletions d where d.shop_id = p_shop_id) then
      return jsonb_build_object('status', 'deleted', 'deletion', private.shop_deletion_json(p_shop_id));
    end if;
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  v_members := private.shop_members_json(v_shop.id);
  return jsonb_build_object(
    'status', case when v_shop.status = 'deleting' then 'deleting' else 'ready' end,
    'shop', jsonb_build_object(
      'id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'mode', v_shop.mode, 'status', v_shop.status,
      'is_demo', v_shop.is_demo, 'created_at', v_shop.created_at
    ),
    'counts', jsonb_build_object(
      'products', (select count(*) from public.products p where p.shop_id = v_shop.id),
      'categories', (select count(*) from public.categories c where c.shop_id = v_shop.id),
      'variants', (select count(*) from public.product_variants v where v.shop_id = v_shop.id),
      'images', (select count(*) from public.product_images i where i.shop_id = v_shop.id),
      'media_files', private.shop_media_count(v_shop.id),
      'orders', (select count(*) from public.orders o where o.shop_id = v_shop.id),
      'members', jsonb_array_length(v_members),
      'subscribers', (select count(*) from private.bot_subscribers s where s.shop_id = v_shop.id),
      'broadcasts', (select count(*) from private.shop_broadcasts b where b.shop_id = v_shop.id)
    ),
    'members', v_members,
    'has_owner', exists (select 1 from public.shop_memberships m where m.shop_id = v_shop.id and m.role = 'owner'),
    'notifications', exists (select 1 from private.shop_notification_settings n where n.shop_id = v_shop.id),
    'bot', (select c.bot_username from private.shop_bot_connections c where c.shop_id = v_shop.id),
    'pending_handover', private.pending_handover_json(v_shop.id),
    'reservation', private.handover_reservation_json(v_shop.id),
    'deletion', private.shop_deletion_json(v_shop.id)
  );
end;
$$;

-- Opens the step-up for one deletion: remembers when this admin, in this aal2 session, asked to delete this shop.
create or replace function public.platform_shop_delete_challenge(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_session uuid;
begin
  perform private.assert_platform_admin(p_actor);
  if not exists (select 1 from public.shops s where s.id = p_shop_id and s.status <> 'deleting') then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  v_session := private.request_session_for(p_actor);
  if v_session is null then
    raise exception 'mfa_required' using errcode = 'P0001';
  end if;
  insert into private.shop_delete_challenges as c (shop_id, actor, session_id, created_at)
  values (p_shop_id, p_actor, v_session, clock_timestamp())
  on conflict (shop_id, actor) do update set session_id = excluded.session_id, created_at = excluded.created_at;
  return jsonb_build_object('challenged', true, 'expires_in_sec', 300);
end;
$$;

-- Step 1 for ANY shop (LIVE or DEMO), always with the step-up: aal2 platform admin, a TOTP code verified for this
-- deletion, the exact slug. Storage cleanup and completion are the existing platform_demo_delete_objects /
-- platform_demo_delete_finalize (they work on the deletion, whatever kind of shop it was).
create or replace function public.platform_shop_delete_begin(p_actor uuid, p_shop_id uuid, p_confirm_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_step_up timestamptz;
begin
  perform private.assert_platform_admin(p_actor);
  select * into v_shop from public.shops where id = p_shop_id for update;
  if not found then
    if exists (select 1 from private.shop_deletions d where d.shop_id = p_shop_id and d.completed_at is not null) then
      return jsonb_build_object('status', 'deleted', 'deletion', private.shop_deletion_json(p_shop_id));
    end if;
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  if v_shop.status = 'deleting' then
    return jsonb_build_object(
      'status', 'pending',
      'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name),
      'deletion', private.shop_deletion_json(v_shop.id)
    );
  end if;
  v_step_up := private.shop_delete_step_up(p_actor, v_shop.id);
  if p_confirm_slug is null or btrim(p_confirm_slug) <> v_shop.slug then
    raise exception 'confirmation_mismatch' using errcode = 'P0001';
  end if;
  -- The challenge is consumed with the deletion (private.shop_delete_begin removes it).
  return private.shop_delete_begin(p_actor, v_shop, v_step_up);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. EXECUTE: service_role only (anon / authenticated / PUBLIC get nothing)
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.order_to_json(uuid) from public, anon, authenticated;
revoke all on function public.create_order_v2(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.platform_create_demo_shop(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.bot_webhook_track(uuid, bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.bot_save_welcome_v2(uuid, uuid, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.broadcast_overview(uuid, uuid) from public, anon, authenticated;
revoke all on function public.broadcast_start(uuid, uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function public.broadcast_claim(uuid, uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.broadcast_report(uuid, uuid, jsonb, integer, text) from public, anon, authenticated;
revoke all on function public.broadcast_cancel(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.broadcast_retry_failed(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.customer_notify_claim(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.customer_notify_begin_send(bigint, integer, bigint) from public, anon, authenticated;
revoke all on function public.customer_notify_complete(bigint, boolean, bigint, text, boolean) from public, anon, authenticated;
revoke all on function public.platform_demo_delete_begin(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.platform_shop_delete_preview(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_shop_delete_challenge(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_shop_delete_begin(uuid, uuid, text) from public, anon, authenticated;

grant execute on function public.order_to_json(uuid) to service_role;
grant execute on function public.create_order_v2(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) to service_role;
grant execute on function public.platform_create_demo_shop(uuid, uuid, text, text) to service_role;
grant execute on function public.bot_webhook_track(uuid, bigint, bigint, text) to service_role;
grant execute on function public.bot_save_welcome_v2(uuid, uuid, text, text, text, text, text, text) to service_role;
grant execute on function public.broadcast_overview(uuid, uuid) to service_role;
grant execute on function public.broadcast_start(uuid, uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.broadcast_claim(uuid, uuid, uuid, uuid, integer) to service_role;
grant execute on function public.broadcast_report(uuid, uuid, jsonb, integer, text) to service_role;
grant execute on function public.broadcast_cancel(uuid, uuid, uuid, text) to service_role;
grant execute on function public.broadcast_retry_failed(uuid, uuid, uuid) to service_role;
grant execute on function public.customer_notify_claim(uuid, uuid, integer) to service_role;
grant execute on function public.customer_notify_begin_send(bigint, integer, bigint) to service_role;
grant execute on function public.customer_notify_complete(bigint, boolean, bigint, text, boolean) to service_role;
grant execute on function public.platform_demo_delete_begin(uuid, uuid, text) to service_role;
grant execute on function public.platform_shop_delete_preview(uuid, uuid) to service_role;
grant execute on function public.platform_shop_delete_challenge(uuid, uuid) to service_role;
grant execute on function public.platform_shop_delete_begin(uuid, uuid, text) to service_role;
