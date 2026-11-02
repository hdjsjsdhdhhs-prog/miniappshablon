-- Complete deletion of DEMO shops by an aal2 platform admin (platform-admin actions demo-delete-*).
--
-- What can be deleted: only a shop with is_demo = true (never decided by `mode`: a DEMO shop is usually live). A real
-- (handed-over / client) shop is refused (not_demo) on every path. Only an aal2 platform admin may call any of this
-- (private.assert_platform_admin, 20261102090000); owners, managers and buyers have no path to it.
--
-- PostgreSQL and Storage share no transaction, so the deletion is a small state machine:
--   1. platform_demo_delete_begin (one transaction, under shops FOR UPDATE): checks the confirmation (exact slug),
--      refuses while a hand-over request is in flight, writes the audit row private.shop_deletions (slug, initiator,
--      time), revokes the Telegram channel (settings row AND Vault secret, fail closed), deletes EVERY tenant-scoped
--      row of the shop (orders, items, catalog, stock journal, memberships, pending hand-over, reservation, invitation
--      log, notifications, limits, journals …) and marks the shop status = 'deleting'. From this commit on the shop is
--      gone from the storefront (public policies need status = 'active'), takes no orders and no member can reach it.
--      Before committing it verifies that no row with this shop_id is left in ANY table of public / private.
--   2. The Edge Function (service role) removes the Storage objects under the EXACT prefix "<shop_id>/" of bucket
--      shop-media, as listed by platform_demo_delete_objects (direct DELETE on storage.objects is blocked by Storage;
--      objects go through the Storage API). Retries per batch; a failure leaves the shop in 'deleting'.
--   3. platform_demo_delete_finalize: only when storage.objects has NO object under the prefix any more, deletes the
--      shops row and marks the audit row completed. Otherwise it records the attempt (and the error) and reports
--      'pending' with the number of remaining objects — success is never reported while files remain.
-- Every step is idempotent: begin on a shop already in 'deleting' just reports it; objects / finalize can be repeated
-- any time (the "Продолжить удаление" action), finalize of a completed deletion reports 'deleted'.
--
-- Global accounts (auth.users) are never touched: only the memberships of THIS shop are deleted, so a client keeps
-- the account and the memberships in other shops.
--
-- The slug of a deleted shop stays reserved forever (private.shop_deletions.slug is unique and a trigger refuses it
-- for any new or renamed shop): the old link shows "shop not found" and can never open another shop.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

alter table public.shops drop constraint shops_status_check;
alter table public.shops add constraint shops_status_check check (status in ('active', 'suspended', 'deleting'));

-- Minimal audit of a deletion + the slug reservation. No catalog, customer or owner data is kept.
create table private.shop_deletions (
  shop_id uuid primary key,
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300)
);
revoke all on private.shop_deletions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Guards
-- ---------------------------------------------------------------------------

-- A deleted shop's slug is never given to another shop (any path: platform RPC, scripts, service role, SQL).
create or replace function private.shops_refuse_deleted_slug()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from private.shop_deletions d where d.slug = new.slug and d.shop_id is distinct from new.id) then
    raise exception 'slug_taken' using errcode = 'P0001', detail = jsonb_build_object('reason', 'deleted_shop')::text;
  end if;
  return new;
end;
$$;

create trigger shops_refuse_deleted_slug
  before insert or update of slug on public.shops
  for each row execute function private.shops_refuse_deleted_slug();

-- 'deleting' is terminal: the shop never comes back to life (it can only disappear in finalize).
create or replace function private.shops_keep_deleting()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'deleting' and new.status is distinct from 'deleting' then
    raise exception 'shop_deleting' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger shops_keep_deleting
  before update of status on public.shops
  for each row execute function private.shops_keep_deleting();

-- Nobody becomes a member of a shop that is being deleted (transfer, hand-over, scripts).
create or replace function private.memberships_refuse_deleting_shop()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.shops s where s.id = new.shop_id and s.status = 'deleting') then
    raise exception 'shop_deleting' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger shop_memberships_refuse_deleting_shop
  before insert or update of shop_id on public.shop_memberships
  for each row execute function private.memberships_refuse_deleting_shop();

-- Same as 20261102090000 plus: a shop being deleted has no members any more, not even an aal2 platform admin
-- (RLS on every tenant table, admin_* RPCs and the Storage policies all go through this function).
create or replace function public.is_shop_member(p_shop_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and exists (select 1 from public.shops s where s.id = p_shop_id and s.status <> 'deleting')
    and (
      (
        not private.is_platform_admin_user((select auth.uid()))
        and exists (
          select 1 from public.shop_memberships m
          where m.shop_id = p_shop_id and m.user_id = (select auth.uid())
        )
      )
      or public.is_platform_admin()
    );
$$;

-- Same as 20261102090000 plus: nothing is managed (notification settings, Vault) for a shop being deleted.
create or replace function private.assert_can_manage_shop(p_shop_id uuid, p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_actor is null or p_shop_id is null then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.shops s where s.id = p_shop_id and s.status <> 'deleting') then
    raise exception 'shop_not_found' using errcode = 'P0001';
  end if;
  if private.is_platform_admin_user(p_actor) then
    if private.platform_admin_authorized(p_actor) then
      return;
    end if;
    raise exception 'mfa_required' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.shop_memberships m
    where m.shop_id = p_shop_id and m.user_id = p_actor and m.role = 'owner'
  ) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- Exact Storage prefix of a shop: "<uuid>/" (hex and dashes only, so no LIKE wildcard can ever widen it).
create or replace function private.shop_media_prefix(p_shop_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$ select p_shop_id::text || '/' $$;

create or replace function private.shop_media_count(p_shop_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer from storage.objects o
  where o.bucket_id = 'shop-media' and starts_with(o.name, private.shop_media_prefix(p_shop_id));
$$;

-- Rows still referencing the shop, per table: every table of public / private with a shop_id column (so a table
-- added later is covered without touching this function). The audit table is the only intended survivor.
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
  if exists (select 1 from vault.secrets s where s.name like 'shop_tg_notify:' || p_shop_id::text || ':%') then
    v_left := v_left || jsonb_build_object('vault.secrets', (
      select count(*) from vault.secrets s where s.name like 'shop_tg_notify:' || p_shop_id::text || ':%'));
  end if;
  return v_left;
end;
$$;

-- Telegram channel of the shop: settings row + its Vault secret (fail closed) + any other notify secret of the shop.
create or replace function private.purge_shop_notifications(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.revoke_shop_notifications(p_shop_id, 'shop_deleted');
  delete from vault.secrets s where s.name like 'shop_tg_notify:' || p_shop_id::text || ':%';
  if exists (select 1 from vault.secrets s where s.name like 'shop_tg_notify:' || p_shop_id::text || ':%') then
    raise exception 'notification_cleanup_failed' using errcode = 'P0001';
  end if;
  delete from private.order_notifications where shop_id = p_shop_id;
end;
$$;

create or replace function private.shop_deletion_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'slug', d.slug, 'requested_by', d.requested_by, 'requested_at', d.requested_at, 'completed_at', d.completed_at,
    'attempts', d.attempts, 'last_attempt_at', d.last_attempt_at, 'last_error', d.last_error
  )
  from private.shop_deletions d
  where d.shop_id = p_shop_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Platform RPCs (service_role only; aal2 platform admin re-checked inside)
-- ---------------------------------------------------------------------------

-- What the confirmation dialog shows. Never changes anything.
create or replace function public.platform_demo_delete_preview(p_actor uuid, p_shop_id uuid)
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
    'status', case when v_shop.status = 'deleting' then 'deleting' when v_shop.is_demo then 'ready' else 'not_demo' end,
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
      'members', jsonb_array_length(v_members)
    ),
    'members', v_members,
    'has_owner', exists (select 1 from public.shop_memberships m where m.shop_id = v_shop.id and m.role = 'owner'),
    'notifications', exists (select 1 from private.shop_notification_settings n where n.shop_id = v_shop.id),
    'pending_handover', private.pending_handover_json(v_shop.id),
    'reservation', private.handover_reservation_json(v_shop.id),
    'deletion', private.shop_deletion_json(v_shop.id)
  );
end;
$$;

-- Step 1. p_confirm_slug must be exactly the shop's slug (the strong confirmation typed by the admin).
create or replace function public.platform_demo_delete_begin(p_actor uuid, p_shop_id uuid, p_confirm_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_left jsonb;
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
  -- A hand-over request inside Supabase Auth right now: let it finish (or expire) first.
  perform private.assert_no_live_handover_reservation(v_shop.id);

  insert into private.shop_deletions (shop_id, slug, requested_by)
  values (v_shop.id, v_shop.slug, p_actor);

  perform private.purge_shop_notifications(v_shop.id);

  -- Orders first: their items keep RESTRICT references to products / variants (20261026100000).
  delete from public.orders where shop_id = v_shop.id;
  delete from public.inventory_movements where shop_id = v_shop.id;
  delete from public.product_images where shop_id = v_shop.id;
  delete from public.product_variants where shop_id = v_shop.id;
  delete from public.products where shop_id = v_shop.id;
  delete from public.categories where shop_id = v_shop.id;
  delete from public.shop_order_counters where shop_id = v_shop.id;
  delete from public.shop_memberships where shop_id = v_shop.id;
  delete from private.shop_pending_handovers where shop_id = v_shop.id;
  delete from private.shop_handover_reservations where shop_id = v_shop.id;
  delete from private.handover_invitation_sends where shop_id = v_shop.id;
  delete from private.checkout_limits where shop_id = v_shop.id;
  delete from private.checkout_stock_refusals where shop_id = v_shop.id;
  delete from private.shop_transfers where shop_id = v_shop.id;
  delete from private.shop_lifecycle_events where shop_id = v_shop.id;

  update public.shops
    set status = 'deleting', mode = 'preview', logo_path = null, cover_path = null, published_at = null
    where id = v_shop.id;

  v_left := private.shop_leftover_rows(v_shop.id);
  if v_left <> '{}'::jsonb then
    raise exception 'deletion_verification_failed' using errcode = 'P0001', detail = v_left::text;
  end if;

  return jsonb_build_object(
    'status', 'pending',
    'shop', jsonb_build_object('id', v_shop.id, 'slug', v_shop.slug, 'name', v_shop.name),
    'deletion', private.shop_deletion_json(v_shop.id)
  );
end;
$$;

-- Step 2 (input for the Edge Function): names of the Storage objects still under the shop's exact prefix.
create or replace function public.platform_demo_delete_objects(p_actor uuid, p_shop_id uuid, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_platform_admin(p_actor);
  if not exists (select 1 from private.shop_deletions d where d.shop_id = p_shop_id and d.completed_at is null) then
    raise exception 'deletion_not_found' using errcode = 'P0001';
  end if;
  return (
    select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb)
    from (
      select s.name from storage.objects s
      where s.bucket_id = 'shop-media' and starts_with(s.name, private.shop_media_prefix(p_shop_id))
      order by s.name
      limit least(greatest(coalesce(p_limit, 100), 1), 1000)
    ) o
  );
end;
$$;

-- Step 3. Completes only when no object is left under the prefix; otherwise records the attempt.
create or replace function public.platform_demo_delete_finalize(p_actor uuid, p_shop_id uuid, p_error text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_del private.shop_deletions%rowtype;
  v_remaining integer;
  v_left jsonb;
begin
  perform private.assert_platform_admin(p_actor);
  select * into v_del from private.shop_deletions where shop_id = p_shop_id for update;
  if not found then
    raise exception 'deletion_not_found' using errcode = 'P0001';
  end if;
  if v_del.completed_at is not null then
    return jsonb_build_object('status', 'deleted', 'deletion', private.shop_deletion_json(p_shop_id));
  end if;
  perform 1 from public.shops where id = p_shop_id for update;

  v_remaining := private.shop_media_count(p_shop_id);
  if v_remaining > 0 then
    update private.shop_deletions
      set attempts = attempts + 1, last_attempt_at = now(),
          last_error = left(coalesce(nullif(btrim(p_error), ''), 'storage_objects_remaining'), 300)
      where shop_id = p_shop_id;
    return jsonb_build_object('status', 'pending', 'remaining', v_remaining, 'deletion', private.shop_deletion_json(p_shop_id));
  end if;

  -- Anything a service-role writer added after step 1 goes as well; the channel is purged once more (fail closed).
  perform private.purge_shop_notifications(p_shop_id);
  delete from public.orders where shop_id = p_shop_id;
  delete from public.shops where id = p_shop_id;

  v_left := private.shop_leftover_rows(p_shop_id);
  if v_left <> '{}'::jsonb then
    raise exception 'deletion_verification_failed' using errcode = 'P0001', detail = v_left::text;
  end if;

  update private.shop_deletions
    set completed_at = now(), attempts = attempts + 1, last_attempt_at = now(), last_error = null
    where shop_id = p_shop_id;
  return jsonb_build_object('status', 'deleted', 'deletion', private.shop_deletion_json(p_shop_id));
end;
$$;

-- Unchanged from 20261030090000 except the `deletion` key (shops in 'deleting' stay listed until finalize succeeds).
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
      ),
      'pending_handover', private.pending_handover_json(s.id),
      'deletion', private.shop_deletion_json(s.id)
    ) order by s.created_at desc, s.slug), '[]'::jsonb)
    from public.shops s
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. EXECUTE: service_role only
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.platform_demo_delete_preview(uuid, uuid) from public, anon, authenticated;
revoke all on function public.platform_demo_delete_begin(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.platform_demo_delete_objects(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.platform_demo_delete_finalize(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.platform_list_shops(uuid) from public, anon, authenticated;

grant execute on function public.platform_demo_delete_preview(uuid, uuid) to service_role;
grant execute on function public.platform_demo_delete_begin(uuid, uuid, text) to service_role;
grant execute on function public.platform_demo_delete_objects(uuid, uuid, integer) to service_role;
grant execute on function public.platform_demo_delete_finalize(uuid, uuid, text) to service_role;
grant execute on function public.platform_list_shops(uuid) to service_role;

revoke all on function public.is_shop_member(uuid) from public, anon;
grant execute on function public.is_shop_member(uuid) to authenticated, service_role;
