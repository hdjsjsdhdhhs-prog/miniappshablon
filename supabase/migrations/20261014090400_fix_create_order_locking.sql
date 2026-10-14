-- Fix: under concurrent checkout the stock check read a stale snapshot.
--
-- In READ COMMITTED, a statement waiting on FOR UPDATE re-reads only the LOCKED row version
-- (EvalPlanQual); other tables joined in the same statement keep the pre-wait snapshot. The
-- previous version locked `product_variants v0` but read stock from a second join on
-- `product_variants v`, so a waiting checkout saw the old stock (1) and the decrement hit the
-- CHECK (stock_quantity >= 0) constraint → HTTP 500 instead of "insufficient_stock".
-- Overselling was already impossible (CHECK constraint), but buyers got an internal error.
--
-- Now every variant column is taken from the locked row itself, and the decrement is guarded
-- with `stock_quantity >= quantity` + row-count check as a second line of defence.

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
declare
  v_shop public.shops%rowtype;
  v_existing public.orders%rowtype;
  v_order_id uuid;
  v_order_number integer;
  v_total bigint := 0;
  v_requested_count integer;
  v_found_count integer;
  v_updated integer;
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

  if coalesce(char_length(btrim(p_contact_name)), 0) = 0 then
    raise exception 'invalid_contact' using errcode = 'P0001';
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

  -- Step 1: lock variant rows in id order and capture their CURRENT values from the locked row.
  insert into pg_temp.checkout_locked (variant_id, product_id, product_name, flavor, color, unit_price_minor, stock_quantity, quantity, sellable)
  select v.id, v.product_id, '', v.flavor, v.color, coalesce(v.price_override_minor, -1),
         v.stock_quantity, l.quantity, v.is_active
  from public.product_variants v
  join pg_temp.checkout_lines l on l.variant_id = v.id
  where v.shop_id = v_shop.id
  order by v.id
  for update of v;

  -- Step 2: enrich with product/category data (read after the locks were granted).
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
    status, currency, total_minor, idempotency_key, request_hash, stock_state, is_test
  ) values (
    v_shop.id, v_order_number, p_customer_tg_id, coalesce(p_customer_snapshot, '{}'::jsonb),
    btrim(p_contact_name), nullif(btrim(coalesce(p_contact_phone, '')), ''), nullif(btrim(coalesce(p_comment, '')), ''),
    'new', v_shop.currency, v_total, p_idempotency_key, p_request_hash, 'deducted', v_shop.is_demo
  )
  returning id into v_order_id;

  for v_row in select * from pg_temp.checkout_locked order by variant_id loop
    update public.product_variants
      set stock_quantity = stock_quantity - v_row.quantity
      where id = v_row.variant_id and stock_quantity >= v_row.quantity;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      -- Unreachable while rows are locked; kept as a defensive guard (rolls back everything).
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

revoke all on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) from public;
grant execute on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) to service_role;
