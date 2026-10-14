-- Server-side order and inventory operations.
-- create_order / get_customer_orders are callable by service_role only (Edge Functions that
-- verified Telegram initData). admin_* functions are callable by authenticated owners and check
-- membership themselves.

create or replace function public.order_status_transition_allowed(p_from text, p_to text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_from
    when 'new'       then p_to in ('confirmed','cancelled')
    when 'confirmed' then p_to in ('ready','cancelled')
    when 'ready'     then p_to in ('completed','cancelled')
    else false
  end;
$$;

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
        'quantity', i.quantity,
        'line_total_minor', i.line_total_minor
      ) order by i.created_at, i.id)
      from public.order_items i where i.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where o.id = p_order_id;
$$;

-- ---------------------------------------------------------------------------
-- create_order: atomic checkout
-- ---------------------------------------------------------------------------
-- p_items: [{"variant_id": uuid, "quantity": int}, ...]
-- Raises exceptions with SQLSTATE P0001 and a machine-readable message code; DETAIL carries JSON.
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

  -- Serialize identical idempotent requests; a replay returns the original order.
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
    -- Preview shops never accept real orders.
    raise exception 'shop_preview' using errcode = 'P0001';
  end if;

  if p_expected_currency is distinct from v_shop.currency then
    raise exception 'currency_mismatch' using errcode = 'P0001',
      detail = jsonb_build_object('currency', v_shop.currency)::text;
  end if;

  if coalesce(char_length(btrim(p_contact_name)), 0) = 0 then
    raise exception 'invalid_contact' using errcode = 'P0001';
  end if;

  -- Normalize requested lines: validate quantity, merge duplicate variants.
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

  -- Lock sellable rows in a deterministic order (by id) to avoid deadlocks between checkouts.
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

  insert into pg_temp.checkout_locked
  select v.id, p.id, p.name, v.flavor, v.color,
         coalesce(v.price_override_minor, p.base_price_minor),
         v.stock_quantity, l.quantity,
         (v.is_active and p.is_published and p.archived_at is null
           and c.is_active and c.archived_at is null)
  from (
    select v0.id
    from public.product_variants v0
    join pg_temp.checkout_lines l0 on l0.variant_id = v0.id
    where v0.shop_id = v_shop.id
    order by v0.id
    for update of v0
  ) locked
  join public.product_variants v on v.id = locked.id
  join pg_temp.checkout_lines l on l.variant_id = v.id
  join public.products p on p.shop_id = v.shop_id and p.id = v.product_id
  join public.categories c on c.shop_id = p.shop_id and c.id = p.category_id;

  select count(*) into v_found_count from pg_temp.checkout_locked;
  if v_found_count <> v_requested_count then
    -- Unknown variant or a variant of another shop.
    raise exception 'item_unavailable' using errcode = 'P0001',
      detail = (select coalesce(jsonb_agg(l.variant_id), '[]'::jsonb)::text
                from pg_temp.checkout_lines l
                where not exists (select 1 from pg_temp.checkout_locked k where k.variant_id = l.variant_id));
  end if;

  if exists (select 1 from pg_temp.checkout_locked where not sellable) then
    raise exception 'item_unavailable' using errcode = 'P0001',
      detail = (select jsonb_agg(variant_id)::text from pg_temp.checkout_locked where not sellable);
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
    insert into public.order_items (
      shop_id, order_id, product_id, variant_id, product_name, variant_label, flavor, color,
      unit_price_minor, quantity, line_total_minor
    ) values (
      v_shop.id, v_order_id, v_row.product_id, v_row.variant_id, v_row.product_name,
      concat_ws(' · ', v_row.flavor, v_row.color), v_row.flavor, v_row.color,
      v_row.unit_price_minor, v_row.quantity, v_row.unit_price_minor * v_row.quantity
    );

    update public.product_variants
      set stock_quantity = stock_quantity - v_row.quantity
      where id = v_row.variant_id;

    insert into public.inventory_movements (shop_id, variant_id, order_id, delta, reason, operation_key)
    values (v_shop.id, v_row.variant_id, v_order_id, -v_row.quantity, 'checkout',
            'checkout:' || v_order_id::text || ':' || v_row.variant_id::text);
  end loop;

  return jsonb_build_object('replayed', false, 'order', public.order_to_json(v_order_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- get_customer_orders: only the verified buyer's orders in one shop
-- ---------------------------------------------------------------------------
create or replace function public.get_customer_orders(
  p_shop_slug text,
  p_customer_tg_id bigint,
  p_order_id uuid default null,
  p_limit integer default 30
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(public.order_to_json(o.id) order by o.created_at desc), '[]'::jsonb)
  from (
    select o.id, o.created_at
    from public.orders o
    join public.shops s on s.id = o.shop_id
    where s.slug = p_shop_slug
      and o.customer_tg_id = p_customer_tg_id
      and (p_order_id is null or o.id = p_order_id)
    order by o.created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) o;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_order_status: validated transitions; cancel restores stock at most once
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_order_status(p_order_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_item record;
  v_inserted integer;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or not public.is_shop_member(v_order.shop_id) then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if v_order.status = p_status then
    return public.order_to_json(v_order.id);
  end if;

  if not public.order_status_transition_allowed(v_order.status, p_status) then
    raise exception 'invalid_transition' using errcode = 'P0001',
      detail = jsonb_build_object('from', v_order.status, 'to', p_status)::text;
  end if;

  if p_status = 'cancelled' and v_order.stock_state = 'deducted' then
    for v_item in
      select i.id, i.variant_id, i.quantity
      from public.order_items i
      where i.order_id = v_order.id and i.variant_id is not null
      order by i.variant_id
    loop
      insert into public.inventory_movements (shop_id, variant_id, order_id, delta, reason, operation_key, actor_user_id)
      values (v_order.shop_id, v_item.variant_id, v_order.id, v_item.quantity, 'cancel_restore',
              'cancel:' || v_order.id::text || ':' || v_item.id::text, (select auth.uid()))
      on conflict (shop_id, operation_key) do nothing;
      get diagnostics v_inserted = row_count;
      if v_inserted = 1 then
        update public.product_variants
          set stock_quantity = stock_quantity + v_item.quantity
          where id = v_item.variant_id;
      end if;
    end loop;
    update public.orders set stock_state = 'restored' where id = v_order.id;
  end if;

  update public.orders set status = p_status where id = v_order.id;
  return public.order_to_json(v_order.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- admin_set_variant_stock: the only way for owners to change stock
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_variant_stock(p_variant_id uuid, p_quantity integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variant public.product_variants%rowtype;
begin
  if p_quantity is null or p_quantity < 0 or p_quantity > 1000000 then
    raise exception 'invalid_quantity' using errcode = 'P0001';
  end if;

  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found or not public.is_shop_member(v_variant.shop_id) then
    raise exception 'variant_not_found' using errcode = 'P0001';
  end if;

  if v_variant.stock_quantity <> p_quantity then
    update public.product_variants set stock_quantity = p_quantity where id = v_variant.id;
    insert into public.inventory_movements (shop_id, variant_id, delta, reason, operation_key, actor_user_id)
    values (v_variant.shop_id, v_variant.id, p_quantity - v_variant.stock_quantity, 'admin_set',
            'admin:' || gen_random_uuid()::text, (select auth.uid()));
  end if;

  return jsonb_build_object('id', v_variant.id, 'stock_quantity', p_quantity);
end;
$$;

revoke all on function public.order_to_json(uuid) from public;
revoke all on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) from public;
revoke all on function public.get_customer_orders(text, bigint, uuid, integer) from public;
revoke all on function public.admin_set_order_status(uuid, text) from public;
revoke all on function public.admin_set_variant_stock(uuid, integer) from public;

grant execute on function public.order_status_transition_allowed(text, text) to anon, authenticated, service_role;
grant execute on function public.order_to_json(uuid) to service_role;
grant execute on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) to service_role;
grant execute on function public.get_customer_orders(text, bigint, uuid, integer) to service_role;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated, service_role;
grant execute on function public.admin_set_variant_stock(uuid, integer) to authenticated, service_role;
