-- Fulfillment methods (delivery / pickup) for checkout, DEMO-shop lifecycle managed from the platform admin
-- (create from a template, hand over to a paying client) and retirement of the unused legal_notice field.
--
-- Security model (unchanged): every new function is EXECUTE-able by service_role only. The platform-admin
-- Edge Function verifies the caller's Supabase Auth JWT and passes the verified user id as p_actor; each
-- function re-checks that the actor is a platform admin (public.platform_admins) itself.
--
-- DEMO orders. A DEMO shop never accepts an order on the server any more (create_order raises shop_demo):
-- the storefront shows a client-side "Тестовый заказ" instead, so a demo order can not change stock, create a
-- row in public.orders or reach the owner's order history. Orders flagged is_test that were created before
-- this migration stay in the table (nothing is deleted) but are hidden from owners and buyers by RLS /
-- get_customer_orders.

-- ---------------------------------------------------------------------------
-- 1. Shop fulfillment settings (owner-editable)
-- ---------------------------------------------------------------------------

alter table public.shops
  add column delivery_enabled boolean not null default true,
  add column pickup_enabled boolean not null default true,
  add column pickup_instructions text not null default ''
    constraint shops_pickup_instructions_check check (char_length(pickup_instructions) <= 1000);

grant update (delivery_enabled, pickup_enabled, pickup_instructions) on public.shops to authenticated;

-- legal_notice is no longer shown anywhere (storefront, admin) and no longer required for publishing.
-- The column and its data are kept (no destructive change on production data), but owners cannot write it.
revoke update (legal_notice) on public.shops from authenticated;
comment on column public.shops.legal_notice is
  'DEPRECATED (20261026090000): not shown, not edited, not required for publishing. Kept only to preserve existing data.';

-- ---------------------------------------------------------------------------
-- 2. Orders: fulfillment method + delivery address; name/phone are no longer collected
-- ---------------------------------------------------------------------------

-- The buyer is identified by the verified Telegram identity (customer_tg_id + customer_snapshot). Existing
-- rows keep their typed name; new orders store NULL instead of a placeholder. The length CHECK stays.
alter table public.orders alter column contact_name drop not null;

alter table public.orders
  -- NULL only for orders created before this migration.
  add column fulfillment_method text
    constraint orders_fulfillment_method_check check (fulfillment_method in ('delivery', 'pickup')),
  add column delivery_address text
    constraint orders_delivery_address_check check (delivery_address is null or char_length(delivery_address) between 1 and 300),
  add constraint orders_fulfillment_consistent check (
    (fulfillment_method = 'delivery' and delivery_address is not null)
    or (fulfillment_method = 'pickup' and delivery_address is null)
    or (fulfillment_method is null and delivery_address is null)
  );

-- Owners never see test orders of a former DEMO shop (they are not real orders).
drop policy orders_member_read on public.orders;
create policy orders_member_read on public.orders
  for select to authenticated
  using (public.is_shop_member(shop_id) and not is_test);

-- Items follow the visibility of their order (the subquery runs with the caller's RLS on orders).
drop policy order_items_member_read on public.order_items;
create policy order_items_member_read on public.order_items
  for select to authenticated
  using (
    public.is_shop_member(shop_id)
    and exists (select 1 from public.orders o where o.shop_id = order_items.shop_id and o.id = order_items.order_id)
  );

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
        'quantity', i.quantity,
        'line_total_minor', i.line_total_minor
      ) order by i.created_at, i.id)
      from public.order_items i where i.order_id = o.id
    ), '[]'::jsonb)
  )
  from public.orders o
  where o.id = p_order_id;
$$;

revoke all on function public.order_to_json(uuid) from public, anon, authenticated;
grant execute on function public.order_to_json(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 3. create_order: fulfillment instead of name/phone; DEMO shops never create orders
-- ---------------------------------------------------------------------------
-- Same argument types as before, different names/meaning → drop and re-create (CREATE OR REPLACE cannot rename
-- parameters). Deploy order: migration, then the checkout Edge Function.
drop function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint);

create function public.create_order(
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
  -- DEMO shops show a client-side test order only: nothing is stored, no stock moves.
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

  -- Fulfillment: the method must exist AND be enabled for this shop right now.
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
    -- Pickup: an address is never stored as a delivery address.
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

  -- Stock is deducted only after the order row exists, in the same transaction (any failure rolls back both).
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

revoke all on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) to service_role;

-- Buyers never see test orders (legacy DEMO orders of a shop that became a real one).
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
      and not o.is_test
      and (p_order_id is null or o.id = p_order_id)
    order by o.created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) o;
$$;

revoke all on function public.get_customer_orders(text, bigint, uuid, integer) from public, anon, authenticated;
grant execute on function public.get_customer_orders(text, bigint, uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Shop lifecycle journal (private, never exposed)
-- ---------------------------------------------------------------------------

alter table private.shop_transfers
  add column kind text not null default 'transfer' check (kind in ('transfer', 'handover')),
  add column details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object');

create table private.shop_lifecycle_events (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  action text not null check (action in ('demo_created', 'demo_activated', 'handover')),
  actor uuid not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);
create index shop_lifecycle_events_shop_idx on private.shop_lifecycle_events (shop_id, created_at desc);

revoke all on private.shop_lifecycle_events from public, anon, authenticated;
revoke all on sequence private.shop_lifecycle_events_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Platform: create a DEMO shop from a DEMO template (catalog cloned in SQL; files copied by the function)
-- ---------------------------------------------------------------------------

-- Re-maps "<template_id>/rest" to "<new_id>/rest" (all shop media paths are prefixed with the shop id).
create or replace function private.rebase_media_path(p_path text, p_from uuid, p_to uuid)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_path is null then null
    when p_path like p_from::text || '/%' then p_to::text || substr(p_path, char_length(p_from::text) + 1)
    else null
  end;
$$;

revoke all on function private.rebase_media_path(text, uuid, uuid) from public, anon, authenticated;

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
        and c.is_active and c.archived_at is null and v.is_active and v.stock_quantity > 0
    ) then 'no_products' end)
  ) as t(p);
$$;

revoke all on function private.shop_handover_problems(public.shops) from public, anon, authenticated;

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

  insert into public.products (id, shop_id, category_id, name, description, base_price_minor, is_published, is_featured, sort_order)
  select m.new_id, v_id, mc.new_id, p.name, p.description, p.base_price_minor, p.is_published, p.is_featured, p.sort_order
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

-- Publishes a freshly created DEMO shop (preview → live) once its media are in place.
create or replace function public.platform_publish_demo_shop(p_actor uuid, p_shop_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
begin
  perform private.assert_platform_admin(p_actor);
  update public.shops
    set mode = 'live', published_at = coalesce(published_at, now())
    where id = p_shop_id and is_demo
    returning * into v_shop;
  if not found then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  return jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'mode', v_shop.mode, 'is_demo', v_shop.is_demo);
end;
$$;

-- Compensation when copying media failed: removes a DEMO shop that was created moments ago and never went live.
create or replace function public.platform_discard_demo_shop(p_actor uuid, p_shop_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor);
  delete from public.shops s
  where s.id = p_shop_id and s.is_demo and s.mode = 'preview' and s.created_at > now() - interval '1 hour'
    and not exists (select 1 from public.orders o where o.shop_id = s.id)
    and not exists (select 1 from public.shop_memberships m where m.shop_id = s.id);
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Platform: hand a paid DEMO shop over to its client
-- ---------------------------------------------------------------------------

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
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'mode', v_shop.mode, 'is_demo', v_shop.is_demo)
  );
end;
$$;

-- One transaction: re-check readiness, make p_new_owner the only owner, switch the shop to a real one
-- (is_demo=false, mode=live), keep slug and link, journal everything. Legacy test orders stay is_test (hidden).
create or replace function public.platform_handover_shop(p_actor uuid, p_shop_id uuid, p_new_owner uuid, p_invitation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_problems jsonb;
  v_removed jsonb;
  v_from uuid[];
  v_test_orders integer;
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
  if p_new_owner is null or not exists (select 1 from auth.users u where u.id = p_new_owner) then
    raise exception 'user_not_found' using errcode = 'P0001';
  end if;
  -- A client owns shops; it must never be (or become) a platform administrator.
  if private.is_platform_admin_user(p_new_owner) then
    raise exception 'owner_is_platform_admin' using errcode = 'P0001';
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

  update public.shops
    set is_demo = false, mode = 'live', published_at = coalesce(published_at, now())
    where id = p_shop_id
    returning * into v_shop;

  select count(*) into v_test_orders from public.orders where shop_id = p_shop_id and is_test;

  if (select count(*) from public.shop_memberships where shop_id = p_shop_id) <> 1
     or not exists (select 1 from public.shop_memberships where shop_id = p_shop_id and user_id = p_new_owner and role = 'owner')
     or v_shop.is_demo or v_shop.mode <> 'live' then
    raise exception 'transfer_verification_failed' using errcode = 'P0001';
  end if;

  insert into private.shop_transfers (shop_id, from_user_ids, to_user_id, transferred_by, kind, details)
  values (p_shop_id, v_from, p_new_owner, p_actor, 'handover',
          jsonb_build_object('invitation', p_invitation, 'legacy_test_orders', v_test_orders));
  insert into private.shop_lifecycle_events (shop_id, action, actor, details)
  values (p_shop_id, 'handover', p_actor,
          jsonb_build_object('to_user_id', p_new_owner, 'invitation', p_invitation, 'legacy_test_orders', v_test_orders));

  return jsonb_build_object(
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name, 'mode', v_shop.mode, 'is_demo', v_shop.is_demo),
    'owner', (select jsonb_build_object('user_id', u.id, 'email', u.email) from auth.users u where u.id = p_new_owner),
    'removed', v_removed,
    'members', private.shop_members_json(p_shop_id),
    'invitation', p_invitation,
    'legacy_test_orders', v_test_orders,
    'transferred_at', now()
  );
end;
$$;

-- List: the platform needs the fulfillment state and the last hand-over too.
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
      )
    ) order by s.created_at desc, s.slug), '[]'::jsonb)
    from public.shops s
  );
end;
$$;

revoke all on function public.platform_create_demo_shop(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.platform_publish_demo_shop(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_discard_demo_shop(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_handover_check(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_handover_shop(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.platform_list_shops(uuid) from public, anon, authenticated;

grant execute on function public.platform_create_demo_shop(uuid, uuid, text, text) to service_role;
grant execute on function public.platform_publish_demo_shop(uuid, uuid) to service_role;
grant execute on function public.platform_discard_demo_shop(uuid, uuid) to service_role;
grant execute on function public.platform_handover_check(uuid, uuid) to service_role;
grant execute on function public.platform_handover_shop(uuid, uuid, uuid, text) to service_role;
grant execute on function public.platform_list_shops(uuid) to service_role;
