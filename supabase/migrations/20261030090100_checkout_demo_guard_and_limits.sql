-- Checkout hardening (audit stage 3A: F-03, F-04).
--
-- F-03  The old checkout contract ({ contact }) reached public.create_order, which never checked is_demo: DEMO
--       shops stored orders, lost stock and sent notifications. The storefront has used only the fulfillment
--       contract (create_order_v2) since 20261026090000, and the checkout Edge Function no longer accepts the old
--       body. Now:
--         * public.create_order keeps its signature and grants (older migrations and the privilege replay test refer
--           to it) but never creates an order: it raises contract_removed;
--         * a BEFORE INSERT trigger on public.orders refuses every order of a DEMO shop, whatever the path or role
--           (RPC, service role, SQL) — one rule, no function can forget it.
--
-- F-04  One Telegram user could empty a shop: a single checkout held up to 50 × 99 = 4 950 units and nothing limited
--       how many orders a user places. create_order_v2 now enforces, atomically and per tenant (shop):
--         * max units per order                         (default 200)
--         * max orders per user and shop in 10 minutes  (default 3)
--         * max orders per user and shop in 24 hours    (default 10)
--         * max unprocessed ('new') orders per user and shop (default 3)
--         * max orders per user across ALL shops per hour (default 20) — one initData string works in every shop
--       Counting happens under transaction-scoped advisory locks on (shop, Telegram user) and (Telegram user), so
--       concurrent requests of one user serialize and cannot overshoot; the counters are the orders themselves (no
--       process memory, shared by every Edge Function instance). An idempotent replay is answered before any limit
--       (it creates nothing). The Telegram user id comes only from verified initData.
--       Defaults live in private.checkout_limit_defaults(); a shop can get its own values in private.checkout_limits
--       (platform operator, SQL) without a migration. The commercial values are the project owner's decision.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. DEMO shops never store an order (any path)
-- ---------------------------------------------------------------------------

create or replace function private.orders_refuse_demo_shop()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.shops s where s.id = new.shop_id and s.is_demo) then
    raise exception 'shop_demo' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger orders_refuse_demo_shop
  before insert on public.orders
  for each row execute function private.orders_refuse_demo_shop();

-- ---------------------------------------------------------------------------
-- 2. The old contract is gone
-- ---------------------------------------------------------------------------

create or replace function public.create_order(
  p_shop_slug text,
  p_customer_tg_id bigint,
  p_customer_snapshot jsonb,
  p_items jsonb,
  p_idempotency_key uuid,
  p_request_hash text,
  p_contact_name text,
  p_contact_phone text,
  p_comment text,
  p_expected_currency text,
  p_expected_total_minor bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Removed in 20261030090100 (F-03). Orders are created only by create_order_v2.
  raise exception 'contract_removed' using errcode = 'P0001';
end;
$$;

revoke all on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Checkout limits
-- ---------------------------------------------------------------------------

create table private.checkout_limits (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  max_units_per_order integer check (max_units_per_order between 1 and 4950),
  max_orders_per_10min integer check (max_orders_per_10min between 1 and 1000),
  max_orders_per_day integer check (max_orders_per_day between 1 and 10000),
  max_open_orders integer check (max_open_orders between 1 and 1000),
  note text check (note is null or char_length(note) <= 300),
  updated_at timestamptz not null default now()
);
revoke all on private.checkout_limits from public, anon, authenticated;

create or replace function private.checkout_limit_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'max_units_per_order', 200,
    'max_orders_per_10min', 3,
    'max_orders_per_day', 10,
    'max_open_orders', 3,
    'max_orders_per_user_hour', 20
  );
$$;

create or replace function private.checkout_limits_for(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.checkout_limit_defaults() || coalesce((
    select jsonb_strip_nulls(jsonb_build_object(
      'max_units_per_order', l.max_units_per_order,
      'max_orders_per_10min', l.max_orders_per_10min,
      'max_orders_per_day', l.max_orders_per_day,
      'max_open_orders', l.max_open_orders
    ))
    from private.checkout_limits l where l.shop_id = p_shop_id
  ), '{}'::jsonb);
$$;

-- Platform-wide rate counting by Telegram user (all shops).
create index if not exists orders_customer_created_idx on public.orders (customer_tg_id, created_at desc);

-- Raises rate_limited / too_many_open_orders. Must run after the idempotency replay check and before any stock is
-- locked. Takes the per-(shop, user) and per-user advisory locks for the rest of the transaction: the counts below
-- see every order committed by a concurrent checkout of the same user (READ COMMITTED, statement snapshots).
create or replace function private.enforce_checkout_rate_limits(p_shop_id uuid, p_customer_tg_id bigint, p_limits jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_count integer;
  v_oldest timestamptz;
  v_limit integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('checkout-shop-user:' || p_shop_id::text || ':' || p_customer_tg_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('checkout-user:' || p_customer_tg_id::text, 0));
  v_now := clock_timestamp();

  v_limit := (p_limits ->> 'max_orders_per_10min')::integer;
  select count(*), min(o.created_at) into v_count, v_oldest
  from public.orders o
  where o.shop_id = p_shop_id and o.customer_tg_id = p_customer_tg_id and o.created_at > v_now - interval '10 minutes';
  if v_count >= v_limit then
    raise exception 'rate_limited' using errcode = 'P0001', detail = jsonb_build_object(
      'scope', 'shop', 'window_sec', 600, 'limit', v_limit,
      'retry_after_sec', greatest(1, ceil(extract(epoch from (v_oldest + interval '10 minutes' - v_now))))::integer
    )::text;
  end if;

  v_limit := (p_limits ->> 'max_orders_per_day')::integer;
  select count(*), min(o.created_at) into v_count, v_oldest
  from public.orders o
  where o.shop_id = p_shop_id and o.customer_tg_id = p_customer_tg_id and o.created_at > v_now - interval '24 hours';
  if v_count >= v_limit then
    raise exception 'rate_limited' using errcode = 'P0001', detail = jsonb_build_object(
      'scope', 'shop', 'window_sec', 86400, 'limit', v_limit,
      'retry_after_sec', greatest(1, ceil(extract(epoch from (v_oldest + interval '24 hours' - v_now))))::integer
    )::text;
  end if;

  v_limit := (p_limits ->> 'max_open_orders')::integer;
  select count(*) into v_count
  from public.orders o
  where o.shop_id = p_shop_id and o.customer_tg_id = p_customer_tg_id and o.status = 'new';
  if v_count >= v_limit then
    raise exception 'too_many_open_orders' using errcode = 'P0001',
      detail = jsonb_build_object('limit', v_limit, 'open', v_count)::text;
  end if;

  v_limit := (p_limits ->> 'max_orders_per_user_hour')::integer;
  select count(*), min(o.created_at) into v_count, v_oldest
  from public.orders o
  where o.customer_tg_id = p_customer_tg_id and o.created_at > v_now - interval '1 hour';
  if v_count >= v_limit then
    raise exception 'rate_limited' using errcode = 'P0001', detail = jsonb_build_object(
      'scope', 'platform', 'window_sec', 3600, 'limit', v_limit,
      'retry_after_sec', greatest(1, ceil(extract(epoch from (v_oldest + interval '1 hour' - v_now))))::integer
    )::text;
  end if;
end;
$$;

revoke all on function private.orders_refuse_demo_shop() from public, anon, authenticated;
revoke all on function private.checkout_limit_defaults() from public, anon, authenticated;
revoke all on function private.checkout_limits_for(uuid) from public, anon, authenticated;
revoke all on function private.enforce_checkout_rate_limits(uuid, bigint, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. create_order_v2 with the limits (otherwise unchanged, see 20261026090000)
-- ---------------------------------------------------------------------------

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

  create temporary table if not exists pg_temp.checkout_locked (
    variant_id uuid primary key,
    product_id uuid not null,
    product_name text not null,
    flavor text,
    color text,
    unit_price_minor bigint not null,
    stock_quantity integer not null,
    quantity integer not null,
    sellable boolean not null
  ) on commit drop;
  truncate pg_temp.checkout_locked;

  -- Lock variant rows in id order and take every value from the locked row (see 20261014090400).
  insert into pg_temp.checkout_locked (variant_id, product_id, product_name, flavor, color, unit_price_minor, stock_quantity, quantity, sellable)
  select v.id, v.product_id, '', v.flavor, v.color, coalesce(v.price_override_minor, -1),
         v.stock_quantity, l.quantity, v.is_active
  from public.product_variants v
  join pg_temp.checkout_lines l on l.variant_id = v.id
  where v.shop_id = v_shop.id
  order by v.id
  for update of v;

  update pg_temp.checkout_locked k
  set product_name = p.name,
      unit_price_minor = case when k.unit_price_minor >= 0 then k.unit_price_minor else p.base_price_minor end,
      sellable = k.sellable and p.is_published and p.archived_at is null and c.is_active and c.archived_at is null
  from public.products p
  join public.categories c on c.shop_id = p.shop_id and c.id = p.category_id
  where p.id = k.product_id and p.shop_id = v_shop.id;

  select count(*) into v_found_count from pg_temp.checkout_locked;
  if v_found_count <> v_requested_count then
    raise exception 'item_unavailable' using errcode = 'P0001',
      detail = (select coalesce(jsonb_agg(l.variant_id), '[]'::jsonb)::text
                from pg_temp.checkout_lines l
                where not exists (select 1 from pg_temp.checkout_locked k where k.variant_id = l.variant_id));
  end if;

  if exists (select 1 from pg_temp.checkout_locked where not sellable or product_name = '') then
    raise exception 'item_unavailable' using errcode = 'P0001',
      detail = (select jsonb_agg(variant_id)::text from pg_temp.checkout_locked where not sellable or product_name = '');
  end if;

  if exists (select 1 from pg_temp.checkout_locked where quantity > stock_quantity) then
    raise exception 'insufficient_stock' using errcode = 'P0001',
      detail = (select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'available', stock_quantity))::text
                from pg_temp.checkout_locked where quantity > stock_quantity);
  end if;

  select sum(unit_price_minor * quantity) into v_total from pg_temp.checkout_locked;

  if p_expected_total_minor is not null and p_expected_total_minor <> v_total then
    raise exception 'price_changed' using errcode = 'P0001',
      detail = jsonb_build_object(
        'total_minor', v_total,
        'prices', (select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'unit_price_minor', unit_price_minor))
                   from pg_temp.checkout_locked)
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

  for v_row in select * from pg_temp.checkout_locked order by variant_id loop
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
      unit_price_minor, quantity, line_total_minor
    ) values (
      v_shop.id, v_order_id, v_row.product_id, v_row.variant_id, v_row.product_name,
      concat_ws(' · ', v_row.flavor, v_row.color), v_row.flavor, v_row.color,
      v_row.unit_price_minor, v_row.quantity, v_row.unit_price_minor * v_row.quantity
    );

    insert into public.inventory_movements (shop_id, variant_id, order_id, delta, reason, operation_key)
    values (v_shop.id, v_row.variant_id, v_order_id, -v_row.quantity, 'checkout',
            'checkout:' || v_order_id::text || ':' || v_row.variant_id::text);
  end loop;

  return jsonb_build_object('replayed', false, 'order', public.order_to_json(v_order_id));
end;
$$;

revoke all on function public.create_order_v2(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.create_order_v2(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) to service_role;
