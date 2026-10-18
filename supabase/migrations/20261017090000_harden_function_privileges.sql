-- Harden EXECUTE privileges on public functions and stop automatic exposure of new objects.
--
-- Root cause. Earlier migrations closed functions with `revoke all ... from public` only. Hosted
-- Supabase additionally has
--   ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--     GRANT ALL ON FUNCTIONS / TABLES / SEQUENCES TO anon, authenticated, service_role;
-- so every function created by `postgres` (the role `supabase db push` runs as) received direct
-- EXECUTE grants for anon and authenticated, which `revoke ... from public` does not remove.
-- Locally `auto_expose_new_tables = false` (supabase/config.toml) drops these defaults, so the
-- integration tests did not see the problem. On hosted, anon could call the SECURITY DEFINER
-- functions create_order / get_customer_orders through /rest/v1/rpc and bypass the Telegram
-- initData check done in the checkout / my-orders Edge Functions.
--
-- This migration:
--   1. changes the default privileges of the role running migrations, so functions, tables and
--      sequences created in public later are not exposed to PUBLIC / anon / authenticated;
--   2. resets EXECUTE on every existing public function to the owner plus an explicit allowlist;
--   3. asserts the result and aborts if anything outside the allowlist stays executable.
-- Table structure and data are not touched.
--
-- Allowlist (who calls what):
--   service_role  : create_order, get_customer_orders (Edge Functions after initData check),
--                   order_to_json, admin_* , validators and access helpers (scripts, seed, publish).
--   authenticated : admin_set_order_status, admin_set_variant_stock (owner admin, membership
--                   checked inside); is_shop_member (admin UI); is_platform_admin, shop_is_public,
--                   product_is_public, storage_object_shop_id (RLS / Storage policies for
--                   authenticated); is_valid_theme, is_supported_currency (CHECK constraints on
--                   owner updates of shops).
--   anon          : shop_is_public, product_is_public (public RLS policies of the storefront).
--   nobody        : set_updated_at (trigger function; EXECUTE is checked only at CREATE TRIGGER).
-- Functions called only from inside SECURITY DEFINER functions (order_to_json,
-- order_status_transition_allowed, is_platform_admin inside is_shop_member) run as the owner and
-- need no grant for client roles.

-- ---------------------------------------------------------------------------
-- 0. Guard: REVOKE/GRANT by a non-owner silently does nothing, so fail loudly instead.
-- ---------------------------------------------------------------------------
do $$
declare
  v_foreign text;
begin
  select string_agg(p.oid::regprocedure::text || ' owned by ' || pg_get_userbyid(p.proowner), ', ')
    into v_foreign
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proowner <> (select oid from pg_roles where rolname = current_user)
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e');
  if v_foreign is not null then
    raise exception 'harden_function_privileges: functions not owned by % (%): %', current_user, current_user, v_foreign;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. Default privileges of the migration role (postgres locally and on hosted)
-- ---------------------------------------------------------------------------
-- Without FOR ROLE these apply to current_user, i.e. the role that creates future objects.
-- Global default: PostgreSQL grants EXECUTE on new functions to PUBLIC.
alter default privileges revoke execute on functions from public;
-- Per-schema defaults added by hosted Supabase for public.
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
-- service_role defaults are intentionally kept: it is the trusted server role.

-- ---------------------------------------------------------------------------
-- 2. Reset EXECUTE on existing functions to owner + allowlist
-- ---------------------------------------------------------------------------
revoke all on function public.is_supported_currency(text) from public, anon, authenticated, service_role;
revoke all on function public.is_valid_theme(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function public.is_platform_admin() from public, anon, authenticated, service_role;
revoke all on function public.is_shop_member(uuid) from public, anon, authenticated, service_role;
revoke all on function public.shop_is_public(uuid) from public, anon, authenticated, service_role;
revoke all on function public.product_is_public(uuid) from public, anon, authenticated, service_role;
revoke all on function public.storage_object_shop_id(text) from public, anon, authenticated, service_role;
revoke all on function public.order_status_transition_allowed(text, text) from public, anon, authenticated, service_role;
revoke all on function public.order_to_json(uuid) from public, anon, authenticated, service_role;
revoke all on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.get_customer_orders(text, bigint, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_order_status(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.admin_set_variant_stock(uuid, integer) from public, anon, authenticated, service_role;

-- Storefront (anon) + RLS of authenticated.
grant execute on function public.shop_is_public(uuid) to anon, authenticated, service_role;
grant execute on function public.product_is_public(uuid) to anon, authenticated, service_role;

-- Owner admin (authenticated); membership is checked inside.
grant execute on function public.is_platform_admin() to authenticated, service_role;
grant execute on function public.is_shop_member(uuid) to authenticated, service_role;
grant execute on function public.storage_object_shop_id(text) to authenticated, service_role;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated, service_role;
grant execute on function public.admin_set_variant_stock(uuid, integer) to authenticated, service_role;

-- CHECK constraints on shops / orders: evaluated with the privileges of the writing role.
grant execute on function public.is_valid_theme(jsonb) to authenticated, service_role;
grant execute on function public.is_supported_currency(text) to authenticated, service_role;

-- Trusted server only (Edge Functions with the service role key, platform scripts).
grant execute on function public.order_status_transition_allowed(text, text) to service_role;
grant execute on function public.order_to_json(uuid) to service_role;
grant execute on function public.create_order(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint) to service_role;
grant execute on function public.get_customer_orders(text, bigint, uuid, integer) to service_role;

-- set_updated_at: no grants (trigger only).

-- ---------------------------------------------------------------------------
-- 3. Assert: no public function is executable by PUBLIC / anon / authenticated outside the
--    allowlist, and new objects of current_user get nothing for them by default.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  with allowed(fn, grantee) as (
    values
      ('shop_is_public', 'anon'), ('shop_is_public', 'authenticated'),
      ('product_is_public', 'anon'), ('product_is_public', 'authenticated'),
      ('is_platform_admin', 'authenticated'),
      ('is_shop_member', 'authenticated'),
      ('storage_object_shop_id', 'authenticated'),
      ('admin_set_order_status', 'authenticated'),
      ('admin_set_variant_stock', 'authenticated'),
      ('is_valid_theme', 'authenticated'),
      ('is_supported_currency', 'authenticated')
  ),
  actual as (
    select p.oid::regprocedure::text as sig, p.proname::text as fn, coalesce(r.rolname, 'PUBLIC') as grantee
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    left join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public'
      and a.privilege_type = 'EXECUTE'
      and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'))
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  )
  select string_agg(format('%s -> %s', a.sig, a.grantee), ', ' order by a.sig, a.grantee)
    into v_bad
  from actual a
  where not exists (select 1 from allowed w where w.fn = a.fn and w.grantee = a.grantee);
  if v_bad is not null then
    raise exception 'harden_function_privileges: unexpected EXECUTE grants: %', v_bad;
  end if;

  select string_agg(format('%s %s -> %s', coalesce(n.nspname, '<global>'), d.defaclobjtype, coalesce(r.rolname, 'PUBLIC')), ', ')
    into v_bad
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
  left join pg_roles r on r.oid = a.grantee
  where d.defaclrole = (select oid from pg_roles where rolname = current_user)
    and (d.defaclnamespace = 0 or n.nspname = 'public')
    and (a.grantee = 0 or r.rolname in ('anon', 'authenticated'));
  if v_bad is not null then
    raise exception 'harden_function_privileges: default privileges still expose new objects: %', v_bad;
  end if;
end;
$$;
