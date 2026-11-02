-- Stock status projection — EXPAND step (stage 3B) of an Expand/Contract change.
--
-- Before: anon and authenticated had SELECT on every column of public.product_variants, so stock_quantity was
-- readable (and filterable / sortable, i.e. binary-searchable) through PostgREST, GraphQL and the storefront JSON,
-- and checkout answered insufficient_stock with the exact remaining quantity.
--
-- This migration (Expand) only ADDS; it changes no existing table privilege, so the frontend released before it
-- (main, 741d478: storefront embed / filter on stock_quantity, admin select('*')) keeps working while the new
-- frontend, which reads stock_status and admin_variant_stock only, is rolled out:
--   * stock_status — a STORED generated column, computed by PostgreSQL from stock_quantity, the public stock
--     projection of the new frontend:  0 → 'out_of_stock',  1–2 → 'low_stock',  ≥ 3 → 'in_stock'.
--   * Exact quantities for the new admin: public.admin_variant_stock(p_shop_id), members of that very shop only
--     (owner / manager, or an aal2 platform admin — public.is_shop_member, 20261102090000). The service role (Edge
--     Functions, scripts) keeps full access.
--   * Probing through checkout: insufficient_stock now carries only the status (checkout Edge Function), and a buyer
--     who keeps asking for more than is available is stopped: after 5 refused requests per shop within an hour
--     the checkout answers stock_check_limited (429) BEFORE trying, so it no longer tells "fits / does not fit".
-- create_order_v2 (locking, price check, stock deduction, non-negative stock) is NOT changed.
--
-- NOT here (Contract, a separate stage 3C, released only after the new frontend is deployed and observed): revoking
-- the table SELECT of anon / authenticated on product_variants and granting every column except stock_quantity.
-- Until 3C, stock_quantity stays readable through PostgREST exactly as before this migration.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Public projection: status (additive; existing table privileges unchanged)
-- ---------------------------------------------------------------------------

alter table public.product_variants
  add column stock_status text generated always as (
    case
      when stock_quantity <= 0 then 'out_of_stock'
      when stock_quantity <= 2 then 'low_stock'
      else 'in_stock'
    end
  ) stored;

comment on column public.product_variants.stock_status is
  'Public stock projection: out_of_stock (0) | low_stock (1–2) | in_stock (≥3). Members read exact stock through admin_variant_stock().';

-- ---------------------------------------------------------------------------
-- 2. Exact stock for the shop's own admins
-- ---------------------------------------------------------------------------

create or replace function public.admin_variant_stock(p_shop_id uuid)
returns table (variant_id uuid, product_id uuid, stock_quantity integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_shop_id is null or not public.is_shop_member(p_shop_id) then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  return query
    select v.id, v.product_id, v.stock_quantity
    from public.product_variants v
    where v.shop_id = p_shop_id
    order by v.product_id, v.sort_order, v.id;
end;
$$;

revoke all on function public.admin_variant_stock(uuid) from public, anon, authenticated;
grant execute on function public.admin_variant_stock(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Checkout: limit repeated "not enough stock" answers (probing)
-- ---------------------------------------------------------------------------

create table private.checkout_stock_refusals (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  customer_tg_id bigint not null,
  created_at timestamptz not null default now()
);
create index checkout_stock_refusals_key_idx on private.checkout_stock_refusals (shop_id, customer_tg_id, created_at desc);
revoke all on private.checkout_stock_refusals from public, anon, authenticated;
revoke all on sequence private.checkout_stock_refusals_id_seq from public, anon, authenticated;

create or replace function private.checkout_stock_probe_limits()
returns jsonb
language sql
immutable
set search_path = ''
as $$ select jsonb_build_object('max_refusals', 5, 'window_sec', 3600) $$;

-- Called by the checkout Edge Function BEFORE create_order_v2. Raises stock_check_limited while the buyer has used up
-- the refused attempts of this shop; the order is then not attempted at all, so the answer reveals nothing.
create or replace function public.checkout_stock_probe_guard(p_shop_slug text, p_customer_tg_id bigint)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limits jsonb := private.checkout_stock_probe_limits();
  v_window interval := make_interval(secs => (v_limits ->> 'window_sec')::integer);
  v_max integer := (v_limits ->> 'max_refusals')::integer;
  v_count integer;
  v_oldest timestamptz;
begin
  select count(*), min(r.created_at) into v_count, v_oldest
  from private.checkout_stock_refusals r
  join public.shops s on s.id = r.shop_id
  where s.slug = p_shop_slug and r.customer_tg_id = p_customer_tg_id and r.created_at > now() - v_window;
  if v_count >= v_max then
    raise exception 'stock_check_limited' using errcode = 'P0001', detail = jsonb_build_object(
      'limit', v_max, 'window_sec', (v_limits ->> 'window_sec')::integer,
      'retry_after_sec', greatest(1, ceil(extract(epoch from (v_oldest + v_window - now()))))::integer
    )::text;
  end if;
end;
$$;

-- Called by the checkout Edge Function after create_order_v2 refused with insufficient_stock.
create or replace function public.checkout_record_stock_refusal(p_shop_slug text, p_customer_tg_id bigint)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_window interval := make_interval(secs => (private.checkout_stock_probe_limits() ->> 'window_sec')::integer);
  v_shop uuid;
begin
  select s.id into v_shop from public.shops s where s.slug = p_shop_slug;
  if v_shop is null or p_customer_tg_id is null then
    return;
  end if;
  delete from private.checkout_stock_refusals r
  where r.shop_id = v_shop and r.customer_tg_id = p_customer_tg_id and r.created_at <= now() - v_window;
  insert into private.checkout_stock_refusals (shop_id, customer_tg_id) values (v_shop, p_customer_tg_id);
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.checkout_stock_probe_guard(text, bigint) from public, anon, authenticated;
revoke all on function public.checkout_record_stock_refusal(text, bigint) from public, anon, authenticated;
grant execute on function public.checkout_stock_probe_guard(text, bigint) to service_role;
grant execute on function public.checkout_record_stock_refusal(text, bigint) to service_role;
