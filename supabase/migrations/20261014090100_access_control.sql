-- Row Level Security, GRANTs and access helpers.
-- Principle: anon/authenticated get only the privileges listed here; everything else is denied.

-- ---------------------------------------------------------------------------
-- Access helpers (SECURITY DEFINER so policies do not recurse into RLS)
-- ---------------------------------------------------------------------------

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa where pa.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_shop_member(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and (
    exists (
      select 1 from public.shop_memberships m
      where m.shop_id = p_shop_id and m.user_id = (select auth.uid())
    )
    or public.is_platform_admin()
  );
$$;

create or replace function public.shop_is_public(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.shops s
    where s.id = p_shop_id and s.status = 'active' and s.mode = 'live'
  );
$$;

-- A product is publicly visible when its shop is live and it is published, not archived,
-- and its category is active.
create or replace function public.product_is_public(p_product_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.products p
    join public.categories c on c.shop_id = p.shop_id and c.id = p.category_id
    join public.shops s on s.id = p.shop_id
    where p.id = p_product_id
      and p.is_published and p.archived_at is null
      and c.is_active and c.archived_at is null
      and s.status = 'active' and s.mode = 'live'
  );
$$;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_shop_member(uuid) from public;
revoke all on function public.shop_is_public(uuid) from public;
revoke all on function public.product_is_public(uuid) from public;
grant execute on function public.is_platform_admin() to anon, authenticated, service_role;
grant execute on function public.is_shop_member(uuid) to anon, authenticated, service_role;
grant execute on function public.shop_is_public(uuid) to anon, authenticated, service_role;
grant execute on function public.product_is_public(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Baseline: remove any implicit privileges (hosted projects grant broadly by default)
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.shops enable row level security;
alter table public.platform_admins enable row level security;
alter table public.shop_memberships enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.product_images enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.shop_order_counters enable row level security;
alter table public.inventory_movements enable row level security;

-- ---------------------------------------------------------------------------
-- shops
-- ---------------------------------------------------------------------------

grant select on public.shops to anon, authenticated;
-- Owners may edit presentation only. slug/status/mode/is_demo/currency are changed by the platform pipeline.
grant update (name, description, logo_path, cover_path, theme_config, info, settings, legal_notice)
  on public.shops to authenticated;

create policy shops_public_read on public.shops
  for select to anon, authenticated
  using (status = 'active' and mode = 'live');

create policy shops_member_read on public.shops
  for select to authenticated
  using (public.is_shop_member(id));

create policy shops_member_update on public.shops
  for update to authenticated
  using (public.is_shop_member(id))
  with check (public.is_shop_member(id));

-- ---------------------------------------------------------------------------
-- platform_admins / memberships: never visible to anon
-- ---------------------------------------------------------------------------

grant select on public.platform_admins to authenticated;
create policy platform_admins_self_read on public.platform_admins
  for select to authenticated
  using (user_id = (select auth.uid()));

grant select on public.shop_memberships to authenticated;
create policy memberships_self_read on public.shop_memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------------------

grant select on public.categories to anon, authenticated;
grant insert (shop_id, name, slug, image_path, sort_order, is_active)
  on public.categories to authenticated;
grant update (name, slug, image_path, sort_order, is_active, archived_at)
  on public.categories to authenticated;

create policy categories_public_read on public.categories
  for select to anon, authenticated
  using (is_active and archived_at is null and public.shop_is_public(shop_id));

create policy categories_member_read on public.categories
  for select to authenticated
  using (public.is_shop_member(shop_id));

create policy categories_member_insert on public.categories
  for insert to authenticated
  with check (public.is_shop_member(shop_id));

create policy categories_member_update on public.categories
  for update to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

-- ---------------------------------------------------------------------------
-- products (archive instead of delete: no DELETE grant)
-- ---------------------------------------------------------------------------

grant select on public.products to anon, authenticated;
grant insert (shop_id, category_id, name, description, base_price_minor, is_published, is_featured, sort_order)
  on public.products to authenticated;
grant update (category_id, name, description, base_price_minor, is_published, is_featured, sort_order, archived_at)
  on public.products to authenticated;

create policy products_public_read on public.products
  for select to anon, authenticated
  using (public.product_is_public(id));

create policy products_member_read on public.products
  for select to authenticated
  using (public.is_shop_member(shop_id));

create policy products_member_insert on public.products
  for insert to authenticated
  with check (public.is_shop_member(shop_id));

create policy products_member_update on public.products
  for update to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

-- ---------------------------------------------------------------------------
-- product_variants: stock_quantity is NOT writable directly (admin_set_variant_stock RPC only)
-- ---------------------------------------------------------------------------

grant select on public.product_variants to anon, authenticated;
grant insert (shop_id, product_id, flavor, color, sku, price_override_minor, is_active, sort_order)
  on public.product_variants to authenticated;
grant update (flavor, color, sku, price_override_minor, is_active, sort_order)
  on public.product_variants to authenticated;

create policy variants_public_read on public.product_variants
  for select to anon, authenticated
  using (is_active and public.product_is_public(product_id));

create policy variants_member_read on public.product_variants
  for select to authenticated
  using (public.is_shop_member(shop_id));

create policy variants_member_insert on public.product_variants
  for insert to authenticated
  with check (public.is_shop_member(shop_id));

create policy variants_member_update on public.product_variants
  for update to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

-- ---------------------------------------------------------------------------
-- product_images
-- ---------------------------------------------------------------------------

grant select on public.product_images to anon, authenticated;
grant insert (shop_id, product_id, storage_path, sort_order, is_primary, alt_text)
  on public.product_images to authenticated;
grant update (storage_path, sort_order, is_primary, alt_text)
  on public.product_images to authenticated;
grant delete on public.product_images to authenticated;

create policy images_public_read on public.product_images
  for select to anon, authenticated
  using (public.product_is_public(product_id));

create policy images_member_read on public.product_images
  for select to authenticated
  using (public.is_shop_member(shop_id));

create policy images_member_insert on public.product_images
  for insert to authenticated
  with check (public.is_shop_member(shop_id));

create policy images_member_update on public.product_images
  for update to authenticated
  using (public.is_shop_member(shop_id))
  with check (public.is_shop_member(shop_id));

create policy images_member_delete on public.product_images
  for delete to authenticated
  using (public.is_shop_member(shop_id));

-- ---------------------------------------------------------------------------
-- orders / order_items / inventory: owners read; writes only through RPCs.
-- anon has no privileges at all.
-- ---------------------------------------------------------------------------

grant select on public.orders to authenticated;
create policy orders_member_read on public.orders
  for select to authenticated
  using (public.is_shop_member(shop_id));

grant select on public.order_items to authenticated;
create policy order_items_member_read on public.order_items
  for select to authenticated
  using (public.is_shop_member(shop_id));

grant select on public.inventory_movements to authenticated;
create policy inventory_member_read on public.inventory_movements
  for select to authenticated
  using (public.is_shop_member(shop_id));

-- shop_order_counters: no policies, no grants (service functions only).
