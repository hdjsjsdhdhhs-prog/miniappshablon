-- Core multi-tenant schema: shops, memberships, catalog, orders, inventory journal.
-- Every tenant-scoped table carries shop_id; cross-tenant links are prevented by composite FKs.

create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Validation helpers (immutable, used in CHECK constraints)
-- ---------------------------------------------------------------------------

create or replace function public.is_supported_currency(p_code text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  -- Only ISO 4217 currencies with exponent 2 are supported: all prices are stored in minor units (1/100).
  select p_code = any (array['RUB','USD','EUR','KZT','BYN','UAH','GEL','AMD','UZS','KGS','TRY']);
$$;

create or replace function public.is_valid_theme(p jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  color_keys constant text[] := array[
    'background','foreground','card','cardForeground','primary','primaryForeground',
    'accent','accentForeground','muted','mutedForeground','border'
  ];
  k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;
  -- No unknown keys.
  for k in select jsonb_object_keys(p) loop
    if not (k = any (color_keys) or k in ('mode','radius')) then
      return false;
    end if;
  end loop;
  foreach k in array color_keys loop
    if jsonb_typeof(p -> k) <> 'string' or (p ->> k) !~ '^#[0-9a-fA-F]{6}$' then
      return false;
    end if;
  end loop;
  if (p ->> 'mode') is null or (p ->> 'mode') not in ('dark','light') then
    return false;
  end if;
  if jsonb_typeof(p -> 'radius') <> 'number' or (p ->> 'radius')::numeric not between 0 and 28 then
    return false;
  end if;
  return true;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.shops (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 500),
  logo_path text,
  cover_path text,
  theme_config jsonb not null check (public.is_valid_theme(theme_config)),
  currency text not null check (public.is_supported_currency(currency)),
  status text not null default 'active' check (status in ('active','suspended')),
  mode text not null default 'preview' check (mode in ('preview','live')),
  is_demo boolean not null default false,
  age_restriction smallint not null default 18 check (age_restriction between 0 and 21),
  legal_notice text not null default '' check (char_length(legal_notice) <= 2000),
  -- Public shop information: address, hours, delivery/payment notes, contacts.
  info jsonb not null default '{}'::jsonb check (jsonb_typeof(info) = 'object'),
  -- Storefront presentation switches (which blocks are visible).
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- Public Telegram launch parameters (bot username, startapp). Never secrets.
  telegram jsonb not null default '{}'::jsonb check (jsonb_typeof(telegram) = 'object'),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shop_logo_path_scoped check (logo_path is null or logo_path like id::text || '/%'),
  constraint shop_cover_path_scoped check (cover_path is null or cover_path like id::text || '/%')
);

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.shop_memberships (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner','manager')),
  created_at timestamptz not null default now(),
  unique (shop_id, user_id)
);
create index shop_memberships_user_idx on public.shop_memberships (user_id);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'),
  image_path text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  archived_at timestamptz,
  -- Stable key from shop.config.json; lets re-seed skip rows that already exist.
  seed_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id),
  unique (shop_id, slug),
  unique (shop_id, seed_key),
  constraint category_image_scoped check (image_path is null or image_path like shop_id::text || '/%')
);
create index categories_shop_sort_idx on public.categories (shop_id, sort_order);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  category_id uuid not null,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 4000),
  base_price_minor bigint not null check (base_price_minor between 0 and 100000000000),
  is_published boolean not null default false,
  is_featured boolean not null default false,
  sort_order integer not null default 0,
  archived_at timestamptz,
  seed_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id),
  unique (shop_id, seed_key),
  -- Composite FK: a product can only reference a category of the same shop.
  foreign key (shop_id, category_id) references public.categories (shop_id, id)
);
create index products_shop_category_idx on public.products (shop_id, category_id, sort_order);
create index products_shop_featured_idx on public.products (shop_id) where is_featured;
create index products_name_trgm_idx on public.products using gin (name extensions.gin_trgm_ops);

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  flavor text check (flavor is null or char_length(flavor) between 1 and 60),
  color text check (color is null or char_length(color) between 1 and 60),
  sku text check (sku is null or char_length(sku) between 1 and 64),
  price_override_minor bigint check (price_override_minor is null or price_override_minor between 0 and 100000000000),
  stock_quantity integer not null default 0 check (stock_quantity >= 0),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  seed_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id),
  unique (shop_id, seed_key),
  foreign key (shop_id, product_id) references public.products (shop_id, id) on delete cascade
);
-- One sellable row per flavor/color combination; (null, null) is the default variant.
create unique index product_variants_combo_uidx
  on public.product_variants (product_id, coalesce(flavor, ''), coalesce(color, ''));
create unique index product_variants_sku_uidx on public.product_variants (shop_id, sku) where sku is not null;
create index product_variants_product_idx on public.product_variants (shop_id, product_id);

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  product_id uuid not null,
  storage_path text not null,
  sort_order integer not null default 0,
  is_primary boolean not null default false,
  alt_text text not null default '' check (char_length(alt_text) <= 200),
  seed_key text,
  created_at timestamptz not null default now(),
  unique (shop_id, seed_key),
  foreign key (shop_id, product_id) references public.products (shop_id, id) on delete cascade,
  constraint product_image_scoped check (storage_path like shop_id::text || '/%')
);
create unique index product_images_primary_uidx on public.product_images (product_id) where is_primary;
create index product_images_product_idx on public.product_images (shop_id, product_id, sort_order);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete restrict,
  order_number integer not null,
  -- Verified Telegram identity (from server-side initData validation only).
  customer_tg_id bigint not null,
  customer_snapshot jsonb not null default '{}'::jsonb,
  contact_name text not null check (char_length(contact_name) between 1 and 80),
  contact_phone text check (contact_phone is null or char_length(contact_phone) <= 32),
  comment text check (comment is null or char_length(comment) <= 500),
  status text not null default 'new'
    check (status in ('new','confirmed','ready','completed','cancelled')),
  currency text not null check (public.is_supported_currency(currency)),
  total_minor bigint not null check (total_minor >= 0),
  idempotency_key uuid not null,
  request_hash text not null,
  stock_state text not null default 'deducted' check (stock_state in ('deducted','restored')),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id),
  unique (shop_id, order_number),
  unique (shop_id, customer_tg_id, idempotency_key)
);
create index orders_shop_created_idx on public.orders (shop_id, created_at desc);
create index orders_customer_idx on public.orders (shop_id, customer_tg_id, created_at desc);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  order_id uuid not null,
  product_id uuid references public.products (id) on delete set null,
  variant_id uuid references public.product_variants (id) on delete set null,
  -- Snapshot at order time: later catalog edits never change history.
  product_name text not null,
  variant_label text not null default '',
  flavor text,
  color text,
  unit_price_minor bigint not null check (unit_price_minor >= 0),
  quantity integer not null check (quantity between 1 and 99),
  line_total_minor bigint not null,
  created_at timestamptz not null default now(),
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade,
  constraint order_item_total_consistent check (line_total_minor = unit_price_minor * quantity)
);
create index order_items_order_idx on public.order_items (shop_id, order_id);

create table public.shop_order_counters (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  last_number integer not null default 0
);

create table public.inventory_movements (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete cascade,
  order_id uuid references public.orders (id) on delete set null,
  delta integer not null,
  reason text not null check (reason in ('checkout','cancel_restore','admin_set','seed')),
  -- Unique per shop: guarantees a given stock operation is applied at most once.
  operation_key text not null,
  actor_user_id uuid,
  created_at timestamptz not null default now(),
  unique (shop_id, operation_key)
);
create index inventory_movements_variant_idx on public.inventory_movements (shop_id, variant_id, created_at desc);

-- updated_at triggers
create trigger shops_updated_at before update on public.shops
  for each row execute function public.set_updated_at();
create trigger categories_updated_at before update on public.categories
  for each row execute function public.set_updated_at();
create trigger products_updated_at before update on public.products
  for each row execute function public.set_updated_at();
create trigger product_variants_updated_at before update on public.product_variants
  for each row execute function public.set_updated_at();
create trigger orders_updated_at before update on public.orders
  for each row execute function public.set_updated_at();
