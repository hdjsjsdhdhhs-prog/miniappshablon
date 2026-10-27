-- Physical deletion of catalog entities from the owner admin: products, product variants (flavor/color rows) and
-- categories. Archiving / deactivating stays available and is what the admin offers when a delete is refused.
--
-- Rules
--   * Order history is never damaged. A product or a variant that appears in any order line (order_items) can not
--     be deleted: the RPC refuses with product_has_orders / variant_has_orders, and the foreign keys of
--     order_items are switched from ON DELETE SET NULL to ON DELETE RESTRICT, so even a direct service-role delete
--     can not silently cut an order line off the catalog. (Order lines keep their own snapshot of name, flavor,
--     color and price anyway; the link is what is protected here.)
--   * A product keeps at least one variant (every product needs a sellable row): deleting the last variant is
--     refused with last_variant — delete or archive the product instead.
--   * A category that still has products (archived ones included) is not deleted unless the caller names another
--     category of the same shop to move them to; the move and the delete happen in one transaction.
--   * Every function is SECURITY DEFINER, callable by authenticated, and re-checks public.is_shop_member() for the
--     row's own shop (owner / manager of that shop or a platform admin). Rows of another shop look exactly like
--     missing rows (*_not_found), so shop isolation does not leak existence.
--   * Storage files are not touched in SQL. Each function returns `unused_media`: paths of the deleted rows that no
--     row of the shop references any more (product images, category images, shop logo / cover). The admin removes
--     exactly those objects through the Storage API, where the shop-media member policies apply again.

-- ---------------------------------------------------------------------------
-- 1. Order lines can never lose their catalog link through a delete
-- ---------------------------------------------------------------------------

alter table public.order_items
  drop constraint order_items_product_id_fkey,
  add constraint order_items_product_id_fkey
    foreign key (product_id) references public.products (id) on delete restrict,
  drop constraint order_items_variant_id_fkey,
  add constraint order_items_variant_id_fkey
    foreign key (variant_id) references public.product_variants (id) on delete restrict;

-- The dependency checks below look order lines up by product / variant.
create index if not exists order_items_product_idx on public.order_items (product_id) where product_id is not null;
create index if not exists order_items_variant_idx on public.order_items (variant_id) where variant_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Media still referenced by the shop
-- ---------------------------------------------------------------------------

-- Of p_paths, returns those that belong to the shop's own folder and are no longer referenced by any row of that
-- shop. Media paths are shop-scoped by CHECK constraints ("<shop_id>/..."), so no other shop can reference them.
create or replace function private.unused_shop_media(p_shop_id uuid, p_paths text[])
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(distinct p order by p), '{}'::text[])
  from unnest(coalesce(p_paths, '{}'::text[])) as p
  where p is not null
    and p like p_shop_id::text || '/%'
    and not exists (select 1 from public.product_images i where i.shop_id = p_shop_id and i.storage_path = p)
    and not exists (select 1 from public.categories c where c.shop_id = p_shop_id and c.image_path = p)
    and not exists (
      select 1 from public.shops s where s.id = p_shop_id and (s.logo_path = p or s.cover_path = p)
    );
$$;

revoke all on function private.unused_shop_media(uuid, text[]) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. admin_delete_product
-- ---------------------------------------------------------------------------

create or replace function public.admin_delete_product(p_product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product public.products%rowtype;
  v_orders integer;
  v_variants integer;
  v_paths text[];
begin
  select * into v_product from public.products where id = p_product_id;
  if not found or not public.is_shop_member(v_product.shop_id) then
    raise exception 'product_not_found' using errcode = 'P0001';
  end if;

  -- Same lock order as checkout (variant rows by id): a checkout that already holds a variant finishes first and
  -- its order line is seen below; a later checkout waits and then finds the variant gone (item_unavailable).
  perform 1 from public.product_variants
    where shop_id = v_product.shop_id and product_id = v_product.id
    order by id
    for update;
  select count(*) into v_variants from public.product_variants where shop_id = v_product.shop_id and product_id = v_product.id;

  select count(distinct i.order_id) into v_orders
  from public.order_items i
  where i.shop_id = v_product.shop_id
    and (i.product_id = v_product.id
         or i.variant_id in (select v.id from public.product_variants v where v.product_id = v_product.id));
  if v_orders > 0 then
    raise exception 'product_has_orders' using errcode = 'P0001',
      detail = jsonb_build_object('orders', v_orders)::text;
  end if;

  select coalesce(array_agg(i.storage_path), '{}'::text[]) into v_paths
  from public.product_images i where i.shop_id = v_product.shop_id and i.product_id = v_product.id;

  begin
    -- Variants, images and the variants' stock journal go with the product (ON DELETE CASCADE).
    delete from public.products where id = v_product.id and shop_id = v_product.shop_id;
  exception when foreign_key_violation then
    raise exception 'product_has_orders' using errcode = 'P0001';
  end;

  return jsonb_build_object(
    'id', v_product.id,
    'deleted', true,
    'variants', v_variants,
    'images', coalesce(array_length(v_paths, 1), 0),
    'unused_media', to_jsonb(private.unused_shop_media(v_product.shop_id, v_paths))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. admin_delete_variant
-- ---------------------------------------------------------------------------

create or replace function public.admin_delete_variant(p_variant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_variant public.product_variants%rowtype;
  v_orders integer;
begin
  select * into v_variant from public.product_variants where id = p_variant_id;
  if not found or not public.is_shop_member(v_variant.shop_id) then
    raise exception 'variant_not_found' using errcode = 'P0001';
  end if;

  -- Lock every variant of the product in id order (checkout's order): two deletes of the last two variants can not
  -- both pass the "last variant" check, and a running checkout is waited for.
  perform 1 from public.product_variants
    where shop_id = v_variant.shop_id and product_id = v_variant.product_id
    order by id
    for update;
  select * into v_variant from public.product_variants where id = p_variant_id;
  if not found then
    raise exception 'variant_not_found' using errcode = 'P0001';
  end if;

  select count(distinct i.order_id) into v_orders
  from public.order_items i where i.shop_id = v_variant.shop_id and i.variant_id = v_variant.id;
  if v_orders > 0 then
    raise exception 'variant_has_orders' using errcode = 'P0001',
      detail = jsonb_build_object('orders', v_orders)::text;
  end if;

  if not exists (
    select 1 from public.product_variants v
    where v.shop_id = v_variant.shop_id and v.product_id = v_variant.product_id and v.id <> v_variant.id
  ) then
    raise exception 'last_variant' using errcode = 'P0001';
  end if;

  begin
    delete from public.product_variants where id = v_variant.id and shop_id = v_variant.shop_id;
  exception when foreign_key_violation then
    raise exception 'variant_has_orders' using errcode = 'P0001';
  end;

  return jsonb_build_object('id', v_variant.id, 'product_id', v_variant.product_id, 'deleted', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. admin_delete_category
-- ---------------------------------------------------------------------------

create or replace function public.admin_delete_category(p_category_id uuid, p_move_products_to uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cat public.categories%rowtype;
  v_target public.categories%rowtype;
  v_products integer;
  v_moved integer := 0;
begin
  select * into v_cat from public.categories where id = p_category_id;
  if not found or not public.is_shop_member(v_cat.shop_id) then
    raise exception 'category_not_found' using errcode = 'P0001';
  end if;
  if p_move_products_to = v_cat.id then
    raise exception 'invalid_target' using errcode = 'P0001';
  end if;

  -- Both categories locked in id order: concurrent "delete A → move to B" and "delete B → move to A" serialize.
  perform 1 from public.categories
    where shop_id = v_cat.shop_id and id in (v_cat.id, p_move_products_to)
    order by id
    for update;

  select count(*) into v_products from public.products where shop_id = v_cat.shop_id and category_id = v_cat.id;
  if v_products > 0 then
    if p_move_products_to is null then
      raise exception 'category_has_products' using errcode = 'P0001',
        detail = jsonb_build_object('products', v_products)::text;
    end if;
    -- Target must be a live category of the SAME shop (the composite FK would refuse another shop anyway).
    select * into v_target from public.categories
      where id = p_move_products_to and shop_id = v_cat.shop_id and archived_at is null;
    if not found then
      raise exception 'target_not_found' using errcode = 'P0001';
    end if;
    update public.products set category_id = v_target.id where shop_id = v_cat.shop_id and category_id = v_cat.id;
    get diagnostics v_moved = row_count;
  end if;

  begin
    delete from public.categories where id = v_cat.id and shop_id = v_cat.shop_id;
  exception when foreign_key_violation then
    -- A product was added to the category concurrently: nothing is deleted, the move is rolled back too.
    raise exception 'category_has_products' using errcode = 'P0001';
  end;

  return jsonb_build_object(
    'id', v_cat.id,
    'deleted', true,
    'moved_products', v_moved,
    'moved_to', case when v_moved > 0 then v_target.id end,
    'unused_media', to_jsonb(private.unused_shop_media(v_cat.shop_id, array[v_cat.image_path]))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges: owners call these through PostgREST; membership is checked inside.
-- ---------------------------------------------------------------------------

revoke all on function public.admin_delete_product(uuid) from public, anon, authenticated;
revoke all on function public.admin_delete_variant(uuid) from public, anon, authenticated;
revoke all on function public.admin_delete_category(uuid, uuid) from public, anon, authenticated;

grant execute on function public.admin_delete_product(uuid) to authenticated, service_role;
grant execute on function public.admin_delete_variant(uuid) to authenticated, service_role;
grant execute on function public.admin_delete_category(uuid, uuid) to authenticated, service_role;
