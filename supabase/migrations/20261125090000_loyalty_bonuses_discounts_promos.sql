-- Stage 4D (Expand): bonus program, automatic order-total discounts and promo codes — per shop, all OFF by default.
-- Backward compatible with the deployed frontend and Edge Functions: new private tables, new nullable / defaulted columns
-- on public.orders, new service-role RPCs. create_order_v2 keeps its signature and behaviour; a shop that never turns a
-- feature on is served by exactly the same code path as before (create_order_v3 delegates to create_order_v2).
--
-- THE PRICE RULE (one order of operations, always computed here, never taken from a request):
--   1. items_total  = Σ line totals at the price the line is charged today (variant override, else the product discount
--                     price of stage 4B, else the list price). Product discounts are therefore already inside it.
--   2. discount     = ONE of: the automatic discount of the best matching threshold (highest percent among rules whose
--                     minimum is reached) or an applied promo code. They never add up: the promo code is applied only
--                     when it is strictly better for the buyer; otherwise the threshold discount stays and the promo is
--                     NOT used up. Percent discounts are rounded DOWN in minor units; a fixed promo is capped at items_total.
--   3. bonuses      = whole bonuses spent by the buyer. 1 bonus = 1 whole currency unit = 100 minor units (every supported
--                     currency has exponent 2, public.is_supported_currency). At most the balance and at most the whole
--                     units left after step 2.
--   total_minor     = items_total − discount − 100 × bonuses  (never negative; enforced by a CHECK on orders).
--
-- BONUS ACCRUAL: only when an administrator moves the order to «confirmed» (admin_set_order_status), only while the
-- program is on, once per order (ledger operation key), from the ELIGIBLE amount = the order's total_minor, i.e. what the
-- buyer actually pays after discounts and after spending bonuses. bonuses = floor(total_minor × percent / 100 / 100) —
-- 3 000 ₽ at 5 % → 150 bonuses; fractions are always dropped. A cancellation refunds the spent bonuses and takes back the
-- accrued ones (never more than the balance: a balance can not become negative).
--
-- PROMO CODES: an activation is RESERVED atomically when the order is created (the promo row is locked and counted in the
-- same statement that checks the limit, so a limit of N can never be exceeded), becomes REDEEMED when the order is
-- confirmed and is RELEASED (the activation is free again) when the order is cancelled.
--
-- Isolation: every new row carries shop_id; cross references are composite (shop_id, …) foreign keys; every new table is
-- in schema `private` (no grants to anon / authenticated); every new function in `public` is EXECUTE-able by service_role
-- only, admin RPCs re-check the actor (private.assert_can_manage_shop / private.assert_shop_member_actor), and nothing in
-- a request body chooses another shop's data.

select set_config('lock_timeout', '5s', true);

-- ---------------------------------------------------------------------------
-- 1. Order snapshot of the price breakdown
-- ---------------------------------------------------------------------------

-- All NULL / 0 for every existing order and for every order of a shop without these features.
alter table public.orders
  add column items_total_minor bigint
    constraint orders_items_total_check check (items_total_minor is null or items_total_minor >= 0),
  add column discount_type text
    constraint orders_discount_type_check check (discount_type is null or discount_type in ('threshold', 'promo')),
  add column discount_minor bigint not null default 0
    constraint orders_discount_minor_check check (discount_minor >= 0),
  -- threshold: { percent, min_total_minor }; promo: { code, kind: percent|fixed, percent, fixed_minor }
  add column discount_info jsonb
    constraint orders_discount_info_check check (discount_info is null or jsonb_typeof(discount_info) = 'object'),
  add column bonus_spent integer not null default 0
    constraint orders_bonus_spent_check check (bonus_spent >= 0),
  -- Bonuses credited when the order was confirmed (NULL: none were credited).
  add column bonus_accrued integer
    constraint orders_bonus_accrued_check check (bonus_accrued is null or bonus_accrued >= 0),
  add constraint orders_total_breakdown_check check (
    items_total_minor is null
    or total_minor = items_total_minor - discount_minor - bonus_spent::bigint * 100
  );

-- ---------------------------------------------------------------------------
-- 2. Tables (schema private)
-- ---------------------------------------------------------------------------

-- One row per shop, created by the first save. No row = everything off.
create table private.shop_loyalty_settings (
  shop_id uuid primary key references public.shops (id) on delete cascade,
  bonus_enabled boolean not null default false,
  bonus_percent numeric(5, 2) not null default 5 check (bonus_percent > 0 and bonus_percent <= 100),
  discount_enabled boolean not null default false,
  promo_enabled boolean not null default false,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table private.shop_discount_rules (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  min_total_minor bigint not null check (min_total_minor > 0 and min_total_minor <= 100000000000),
  percent smallint not null check (percent between 1 and 90),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id),
  unique (shop_id, min_total_minor)
);

create table private.shop_promo_codes (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops (id) on delete cascade,
  -- Always stored upper-case (private.normalize_promo_code); unique inside one shop.
  code text not null check (code ~ '^[A-Z0-9_-]{3,32}$'),
  discount_type text not null check (discount_type in ('percent', 'fixed')),
  percent smallint check (percent between 1 and 90),
  fixed_minor bigint check (fixed_minor > 0 and fixed_minor <= 100000000000),
  max_activations integer not null check (max_activations between 1 and 1000000),
  -- Activations that count against the limit: reserved + redeemed redemptions (maintained under the row lock).
  used_count integer not null default 0,
  is_active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, id),
  unique (shop_id, code),
  constraint promo_value_matches_type check (
    (discount_type = 'percent' and percent is not null and fixed_minor is null)
    or (discount_type = 'fixed' and fixed_minor is not null and percent is null)
  ),
  constraint promo_used_within_limit check (used_count >= 0 and used_count <= max_activations)
);

-- History of use: one row per order that used a code (an order carries at most one).
create table private.promo_redemptions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  promo_id uuid not null,
  order_id uuid not null,
  customer_tg_id bigint not null,
  code text not null,
  discount_minor bigint not null check (discount_minor > 0),
  status text not null default 'reserved' check (status in ('reserved', 'redeemed', 'released')),
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (order_id),
  foreign key (shop_id, promo_id) references private.shop_promo_codes (shop_id, id) on delete cascade,
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade
);
create index promo_redemptions_promo_idx on private.promo_redemptions (shop_id, promo_id, created_at desc);

-- Balance of one buyer in one shop (never shared between shops).
create table private.customer_bonus_accounts (
  shop_id uuid not null references public.shops (id) on delete cascade,
  customer_tg_id bigint not null check (customer_tg_id > 0),
  balance integer not null default 0 check (balance >= 0),
  earned_total integer not null default 0 check (earned_total >= 0),
  spent_total integer not null default 0 check (spent_total >= 0),
  updated_at timestamptz not null default now(),
  primary key (shop_id, customer_tg_id)
);

-- Append-only history of every balance change. amount is signed; the operation key makes each operation happen once.
create table private.bonus_ledger (
  id bigint generated always as identity primary key,
  shop_id uuid not null,
  customer_tg_id bigint not null,
  order_id uuid not null,
  kind text not null check (kind in ('accrual', 'spend', 'accrual_reversal', 'spend_refund')),
  amount integer not null,
  balance_after integer not null check (balance_after >= 0),
  operation_key text not null,
  created_at timestamptz not null default now(),
  unique (shop_id, operation_key),
  constraint bonus_ledger_sign check (
    (kind in ('accrual', 'spend_refund') and amount > 0) or (kind in ('spend', 'accrual_reversal') and amount < 0)
  ),
  foreign key (shop_id, customer_tg_id) references private.customer_bonus_accounts (shop_id, customer_tg_id) on delete cascade,
  foreign key (shop_id, order_id) references public.orders (shop_id, id) on delete cascade
);
create index bonus_ledger_customer_idx on private.bonus_ledger (shop_id, customer_tg_id, id desc);
create index bonus_ledger_order_idx on private.bonus_ledger (shop_id, order_id);

-- «🎁 За ваш заказ начислено …»: outbox next to private.customer_order_notifications. One row per order, ever, so a
-- repeated confirmation or a retry can never send the message twice. A row exists only when the buyer started the shop's
-- connected bot (the only chat id we may write to); without it the bonuses are still credited, only no message is sent.
create table private.bonus_notifications (
  id bigint generated always as identity primary key,
  shop_id uuid not null references public.shops (id) on delete cascade,
  order_id uuid not null unique references public.orders (id) on delete cascade,
  bot_id bigint not null check (bot_id > 0),
  tg_user_id bigint not null,
  chat_id bigint not null,
  amount integer not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  telegram_message_id bigint,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index bonus_notifications_due_idx on private.bonus_notifications (shop_id, status, next_attempt_at);

create trigger shop_loyalty_settings_updated_at before update on private.shop_loyalty_settings
  for each row execute function public.set_updated_at();
create trigger shop_discount_rules_updated_at before update on private.shop_discount_rules
  for each row execute function public.set_updated_at();
create trigger shop_promo_codes_updated_at before update on private.shop_promo_codes
  for each row execute function public.set_updated_at();

revoke all on private.shop_loyalty_settings, private.shop_discount_rules, private.shop_promo_codes,
  private.promo_redemptions, private.customer_bonus_accounts, private.bonus_ledger, private.bonus_notifications
  from public, anon, authenticated;
revoke all on sequence private.bonus_ledger_id_seq, private.bonus_notifications_id_seq from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- "WELCOME300", " welcome300 " → 'WELCOME300'. Only Latin letters, digits, _ and - are accepted (checked by the table).
create or replace function private.normalize_promo_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$ select upper(btrim(coalesce(p_code, ''))) $$;

-- The bonus unit in minor currency units: 1 bonus = 1 whole currency unit.
create or replace function private.bonus_unit_minor()
returns bigint
language sql
immutable
set search_path = ''
as $$ select 100::bigint $$;

-- Bonuses earned for an eligible amount. floor(total × percent / 100) minor units → whole bonuses (÷ 100), fractions dropped.
-- Exact in numeric: 300000 minor × 5.00 % → 150.
create or replace function private.bonus_for(p_eligible_minor bigint, p_percent numeric)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_eligible_minor is null or p_eligible_minor <= 0 or p_percent is null or p_percent <= 0 then 0
    else floor((p_eligible_minor::numeric * p_percent) / (100 * 100))::bigint
  end;
$$;

-- Percent of an amount in minor units, rounded down.
create or replace function private.percent_of(p_minor bigint, p_percent integer)
returns bigint
language sql
immutable
set search_path = ''
as $$ select (greatest(p_minor, 0) * greatest(p_percent, 0)) / 100 $$;

-- Rights of a shop member (owner or manager) or an aal2 platform admin — for the actions a manager may take too (confirming
-- an order and what follows from it).
create or replace function private.assert_shop_member_actor(p_shop_id uuid, p_actor uuid)
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
  if not exists (select 1 from public.shop_memberships m where m.shop_id = p_shop_id and m.user_id = p_actor) then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function private.loyalty_settings_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'bonus_enabled', coalesce(s.bonus_enabled, false),
    'bonus_percent', coalesce(s.bonus_percent, 5),
    'discount_enabled', coalesce(s.discount_enabled, false),
    'promo_enabled', coalesce(s.promo_enabled, false),
    'configured', s.shop_id is not null,
    'updated_at', s.updated_at
  )
  from (select p_shop_id as id) x
  left join private.shop_loyalty_settings s on s.shop_id = x.id;
$$;

-- Moves a balance by p_amount (signed) and records it in the ledger — the ONLY writer of balances. Row-locks the account, so
-- concurrent operations of one buyer are serialised; refuses to go below zero (insufficient_bonus); the operation key makes
-- the operation happen at most once (returns NULL when it already happened, otherwise the new balance).
create or replace function private.bonus_apply(
  p_shop_id uuid,
  p_customer bigint,
  p_order_id uuid,
  p_kind text,
  p_amount integer,
  p_key text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_inserted integer;
begin
  if p_amount is null or p_amount = 0 then
    return null;
  end if;
  insert into private.customer_bonus_accounts (shop_id, customer_tg_id)
  values (p_shop_id, p_customer)
  on conflict (shop_id, customer_tg_id) do nothing;
  select a.balance into v_balance
  from private.customer_bonus_accounts a
  where a.shop_id = p_shop_id and a.customer_tg_id = p_customer
  for update;
  if v_balance + p_amount < 0 then
    raise exception 'insufficient_bonus' using errcode = 'P0001', detail = jsonb_build_object('balance', v_balance)::text;
  end if;
  insert into private.bonus_ledger (shop_id, customer_tg_id, order_id, kind, amount, balance_after, operation_key)
  values (p_shop_id, p_customer, p_order_id, p_kind, p_amount, v_balance + p_amount, p_key)
  on conflict (shop_id, operation_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return null;
  end if;
  update private.customer_bonus_accounts a
    set balance = a.balance + p_amount,
        earned_total = a.earned_total + case when p_kind in ('accrual', 'accrual_reversal') then p_amount else 0 end,
        spent_total = a.spent_total - case when p_kind in ('spend', 'spend_refund') then p_amount else 0 end,
        updated_at = now()
    where a.shop_id = p_shop_id and a.customer_tg_id = p_customer;
  return v_balance + p_amount;
end;
$$;

-- Subtotal of a cart as checkout would charge it (read-only, nothing is locked). Raises like checkout: invalid_items,
-- invalid_quantity, item_unavailable (DETAIL: the variant ids).
create or replace function private.loyalty_cart_subtotal(p_shop_id uuid, p_items jsonb)
returns bigint
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_lines integer;
  v_min integer;
  v_max integer;
  v_total bigint;
  v_bad jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_items' using errcode = 'P0001';
  end if;
  begin
    with req as (
      select (e ->> 'variant_id')::uuid as variant_id, sum((e ->> 'quantity')::integer) as qty
      from jsonb_array_elements(p_items) e
      group by (e ->> 'variant_id')::uuid
    ), priced as (
      select r.variant_id, r.qty,
             coalesce(v.price_override_minor, p.discount_price_minor, p.base_price_minor) as unit,
             coalesce(v.is_active and p.is_published and p.archived_at is null and c.is_active and c.archived_at is null, false) as sellable
      from req r
      left join public.product_variants v on v.id = r.variant_id and v.shop_id = p_shop_id
      left join public.products p on p.id = v.product_id and p.shop_id = p_shop_id
      left join public.categories c on c.shop_id = p.shop_id and c.id = p.category_id
    )
    select count(*), min(qty), max(qty), sum(unit * qty) filter (where sellable),
           (select coalesce(jsonb_agg(x.variant_id), '[]'::jsonb) from priced x where not x.sellable)
      into v_lines, v_min, v_max, v_total, v_bad
    from priced;
  exception when invalid_text_representation or numeric_value_out_of_range or not_null_violation then
    raise exception 'invalid_items' using errcode = 'P0001';
  end;
  if v_lines is null or v_lines = 0 or v_min is null or v_min < 1 or v_max > 99 then
    raise exception 'invalid_quantity' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_bad) > 0 then
    raise exception 'item_unavailable' using errcode = 'P0001', detail = v_bad::text;
  end if;
  return coalesce(v_total, 0);
end;
$$;

-- The single calculation of the price rule (see the header). Used by the cart preview (p_lock = false: nothing is locked,
-- the buyer's request is clamped) and by checkout (p_lock = true: the promo row and the balance are locked and a request that
-- can not be honoured raises promo_invalid / bonus_unavailable / insufficient_bonus / bonus_exceeds_order instead).
create or replace function private.loyalty_calc(
  p_shop_id uuid,
  p_customer bigint,
  p_subtotal bigint,
  p_promo_code text,
  p_bonus_spend integer,
  p_lock boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set private.shop_loyalty_settings%rowtype;
  v_bonus_on boolean;
  v_discount_on boolean;
  v_promo_on boolean;
  v_rule private.shop_discount_rules%rowtype;
  v_next private.shop_discount_rules%rowtype;
  v_threshold bigint := 0;
  v_promo private.shop_promo_codes%rowtype;
  v_code text := private.normalize_promo_code(p_promo_code);
  v_promo_status text;
  v_promo_reason text;
  v_promo_minor bigint := 0;
  v_promo_applied boolean := false;
  v_type text;
  v_discount bigint := 0;
  v_info jsonb;
  v_after bigint;
  v_balance integer := 0;
  v_req integer := coalesce(p_bonus_spend, 0);
  v_cap integer := 0;
  v_apply integer := 0;
  v_total bigint;
begin
  if p_subtotal is null or p_subtotal < 0 then
    raise exception 'invalid_items' using errcode = 'P0001';
  end if;
  if v_req < 0 or v_req > 1000000 then
    raise exception 'invalid_bonus' using errcode = 'P0001';
  end if;

  select * into v_set from private.shop_loyalty_settings s where s.shop_id = p_shop_id;
  v_bonus_on := coalesce(v_set.bonus_enabled, false);
  v_discount_on := coalesce(v_set.discount_enabled, false);
  v_promo_on := coalesce(v_set.promo_enabled, false);

  -- Step 2a: the best automatic threshold (highest percent among the reached ones) and the next worthwhile one.
  if v_discount_on then
    select * into v_rule
    from private.shop_discount_rules r
    where r.shop_id = p_shop_id and r.min_total_minor <= p_subtotal
    order by r.percent desc, r.min_total_minor desc
    limit 1;
    if found then
      v_threshold := private.percent_of(p_subtotal, v_rule.percent);
    end if;
    select * into v_next
    from private.shop_discount_rules r
    where r.shop_id = p_shop_id and r.min_total_minor > p_subtotal and r.percent > coalesce(v_rule.percent, 0)
    order by r.min_total_minor
    limit 1;
  end if;

  -- Step 2b: the promo code, only of THIS shop (the lookup is by (shop_id, code)).
  if v_code <> '' then
    if not v_promo_on then
      v_promo_status := 'invalid';
      v_promo_reason := 'disabled';
    else
      if p_lock then
        select * into v_promo from private.shop_promo_codes c where c.shop_id = p_shop_id and c.code = v_code for update;
      else
        select * into v_promo from private.shop_promo_codes c where c.shop_id = p_shop_id and c.code = v_code;
      end if;
      if not found then
        v_promo_status := 'invalid';
        v_promo_reason := 'not_found';
      elsif not v_promo.is_active then
        v_promo_status := 'invalid';
        v_promo_reason := 'inactive';
      elsif v_promo.used_count >= v_promo.max_activations then
        v_promo_status := 'invalid';
        v_promo_reason := 'exhausted';
      else
        v_promo_minor := case v_promo.discount_type
          when 'percent' then private.percent_of(p_subtotal, v_promo.percent)
          else least(v_promo.fixed_minor, p_subtotal)
        end;
        if v_promo_minor <= 0 then
          v_promo_status := 'not_applied';
          v_promo_reason := 'no_effect';
        elsif v_threshold >= v_promo_minor then
          -- Discounts never add up: the automatic one is at least as good, the code is left unused.
          v_promo_status := 'not_applied';
          v_promo_reason := 'better_discount';
        else
          v_promo_status := 'applied';
          v_promo_applied := true;
        end if;
      end if;
    end if;
    if p_lock and v_promo_status = 'invalid' then
      raise exception 'promo_invalid' using errcode = 'P0001', detail = jsonb_build_object('reason', v_promo_reason)::text;
    end if;
  end if;

  if v_promo_applied then
    v_type := 'promo';
    v_discount := v_promo_minor;
    v_info := jsonb_build_object('code', v_promo.code, 'kind', v_promo.discount_type, 'percent', v_promo.percent, 'fixed_minor', v_promo.fixed_minor);
  elsif v_threshold > 0 then
    v_type := 'threshold';
    v_discount := v_threshold;
    v_info := jsonb_build_object('percent', v_rule.percent, 'min_total_minor', v_rule.min_total_minor);
  end if;
  v_after := p_subtotal - v_discount;

  -- Step 3: bonuses.
  if p_lock and v_req > 0 and not v_bonus_on then
    raise exception 'bonus_unavailable' using errcode = 'P0001';
  end if;
  if v_bonus_on then
    if p_lock and p_customer is not null then
      insert into private.customer_bonus_accounts (shop_id, customer_tg_id)
      values (p_shop_id, p_customer)
      on conflict (shop_id, customer_tg_id) do nothing;
      select a.balance into v_balance
      from private.customer_bonus_accounts a
      where a.shop_id = p_shop_id and a.customer_tg_id = p_customer
      for update;
    elsif p_customer is not null then
      select coalesce(max(a.balance), 0) into v_balance
      from private.customer_bonus_accounts a
      where a.shop_id = p_shop_id and a.customer_tg_id = p_customer;
    end if;
    v_cap := least(v_balance::bigint, v_after / private.bonus_unit_minor())::integer;
    if p_lock then
      if v_req > v_balance then
        raise exception 'insufficient_bonus' using errcode = 'P0001', detail = jsonb_build_object('balance', v_balance)::text;
      end if;
      if v_req > v_cap then
        raise exception 'bonus_exceeds_order' using errcode = 'P0001', detail = jsonb_build_object('max_spend', v_cap)::text;
      end if;
      v_apply := v_req;
    else
      v_apply := least(v_req, v_cap);
    end if;
  end if;
  v_total := v_after - v_apply::bigint * private.bonus_unit_minor();

  return jsonb_build_object(
    'features', jsonb_build_object('bonus', v_bonus_on, 'discount', v_discount_on, 'promo', v_promo_on),
    'subtotal_minor', p_subtotal,
    'threshold', case when v_threshold > 0 then
      jsonb_build_object('percent', v_rule.percent, 'min_total_minor', v_rule.min_total_minor, 'discount_minor', v_threshold) end,
    'next_threshold', case when v_next.id is not null then
      jsonb_build_object('percent', v_next.percent, 'min_total_minor', v_next.min_total_minor, 'remaining_minor', v_next.min_total_minor - p_subtotal) end,
    'promo', case when v_code <> '' then jsonb_build_object(
      'code', v_code,
      'status', v_promo_status,
      'reason', v_promo_reason,
      'discount_minor', case when v_promo_applied then v_promo_minor else 0 end,
      'kind', case when v_promo.id is not null then v_promo.discount_type end,
      'percent', case when v_promo.id is not null then v_promo.percent end,
      'fixed_minor', case when v_promo.id is not null then v_promo.fixed_minor end) end,
    'discount', jsonb_build_object('type', v_type, 'minor', v_discount, 'info', v_info),
    'after_discount_minor', v_after,
    'bonus', jsonb_build_object(
      'enabled', v_bonus_on,
      'percent', case when v_bonus_on then v_set.bonus_percent end,
      'balance', v_balance,
      'requested', v_req,
      'applied', v_apply,
      'max_spend', v_cap,
      'spend_minor', v_apply::bigint * private.bonus_unit_minor(),
      'unit_minor', private.bonus_unit_minor()),
    'total_minor', v_total,
    'accrual_preview', case when v_bonus_on then private.bonus_for(v_total, v_set.bonus_percent) else 0 end,
    '_promo_id', case when v_promo_applied then v_promo.id end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Orders: price breakdown in the JSON the buyer, the admin and the notifications get
-- ---------------------------------------------------------------------------

-- Same as 20261113090000 plus the breakdown (only when there is one, so the JSON of every other order is unchanged).
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
        'original_unit_price_minor', i.original_unit_price_minor,
        'quantity', i.quantity,
        'line_total_minor', i.line_total_minor
      ) order by i.created_at, i.id)
      from public.order_items i where i.order_id = o.id
    ), '[]'::jsonb)
  )
  || case when o.items_total_minor is not null then jsonb_build_object(
       'items_total_minor', o.items_total_minor,
       'discount_type', o.discount_type,
       'discount_minor', o.discount_minor,
       'discount_info', o.discount_info,
       'bonus_spent', o.bonus_spent
     ) else '{}'::jsonb end
  || case when o.bonus_accrued is not null then jsonb_build_object('bonus_accrued', o.bonus_accrued) else '{}'::jsonb end
  from public.orders o
  where o.id = p_order_id;
$$;

-- ---------------------------------------------------------------------------
-- 5. create_order_v3: checkout with discounts, a promo code and bonuses
-- ---------------------------------------------------------------------------

-- Wraps create_order_v2 inside one transaction: the order, its lines and the stock are created exactly as before, then the
-- price rule is applied to the new order. Any failure afterwards raises and rolls back the WHOLE order (stock included).
-- p_expected_total_minor is the amount the buyer saw (after discounts and bonuses). A shop with every feature off, and a
-- request without a code and bonuses, is delegated to create_order_v2 untouched.
create or replace function public.create_order_v3(
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
  p_expected_total_minor bigint,
  p_promo_code text,
  p_bonus_spend integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop_id uuid;
  v_set private.shop_loyalty_settings%rowtype;
  v_any boolean := false;
  v_result jsonb;
  v_order_id uuid;
  v_subtotal bigint;
  v_calc jsonb;
  v_type text;
  v_discount bigint;
  v_spend integer;
  v_total bigint;
  v_promo_id uuid;
  v_updated integer;
begin
  select s.id into v_shop_id from public.shops s where s.slug = p_shop_slug;
  if v_shop_id is not null then
    select * into v_set from private.shop_loyalty_settings s where s.shop_id = v_shop_id;
    v_any := found and coalesce(v_set.bonus_enabled or v_set.discount_enabled or v_set.promo_enabled, false);
  end if;

  if not v_any and private.normalize_promo_code(p_promo_code) = '' and coalesce(p_bonus_spend, 0) = 0 then
    return public.create_order_v2(
      p_shop_slug, p_customer_tg_id, p_customer_snapshot, p_items, p_idempotency_key, p_request_hash,
      p_fulfillment_method, p_delivery_address, p_comment, p_expected_currency, p_expected_total_minor
    );
  end if;

  -- Everything create_order_v2 checks (shop, idempotency, stock, limits) happens there; its own price check is skipped
  -- because the amount the buyer expects is the one after discounts, which is only known below.
  v_result := public.create_order_v2(
    p_shop_slug, p_customer_tg_id, p_customer_snapshot, p_items, p_idempotency_key, p_request_hash,
    p_fulfillment_method, p_delivery_address, p_comment, p_expected_currency, null
  );
  if (v_result ->> 'replayed')::boolean then
    return v_result;
  end if;

  v_order_id := (v_result -> 'order' ->> 'id')::uuid;
  select coalesce(sum(i.line_total_minor), 0) into v_subtotal from public.order_items i where i.order_id = v_order_id;

  v_calc := private.loyalty_calc(v_shop_id, p_customer_tg_id, v_subtotal, p_promo_code, p_bonus_spend, true);
  v_type := v_calc -> 'discount' ->> 'type';
  v_discount := (v_calc -> 'discount' ->> 'minor')::bigint;
  v_spend := (v_calc -> 'bonus' ->> 'applied')::integer;
  v_total := (v_calc ->> 'total_minor')::bigint;
  v_promo_id := (v_calc ->> '_promo_id')::uuid;

  if p_expected_total_minor is not null and p_expected_total_minor <> v_total then
    raise exception 'price_changed' using errcode = 'P0001',
      detail = jsonb_build_object(
        'total_minor', v_total,
        'prices', (select coalesce(jsonb_agg(jsonb_build_object(
                     'variant_id', i.variant_id,
                     'unit_price_minor', i.unit_price_minor,
                     'original_unit_price_minor', i.original_unit_price_minor)), '[]'::jsonb)
                   from public.order_items i where i.order_id = v_order_id and i.variant_id is not null)
      )::text;
  end if;

  update public.orders
    set items_total_minor = v_subtotal,
        discount_type = v_type,
        discount_minor = v_discount,
        discount_info = nullif(v_calc -> 'discount' -> 'info', 'null'::jsonb),
        bonus_spent = v_spend,
        total_minor = v_total
    where id = v_order_id;

  if v_promo_id is not null then
    -- The check and the count are one statement under the row lock taken by loyalty_calc: the limit can not be exceeded.
    update private.shop_promo_codes c
      set used_count = c.used_count + 1
      where c.id = v_promo_id and c.shop_id = v_shop_id and c.is_active and c.used_count < c.max_activations;
    get diagnostics v_updated = row_count;
    if v_updated <> 1 then
      raise exception 'promo_invalid' using errcode = 'P0001', detail = jsonb_build_object('reason', 'exhausted')::text;
    end if;
    insert into private.promo_redemptions (shop_id, promo_id, order_id, customer_tg_id, code, discount_minor)
    values (v_shop_id, v_promo_id, v_order_id, p_customer_tg_id, v_calc -> 'discount' -> 'info' ->> 'code', v_discount);
  end if;

  if v_spend > 0 then
    perform private.bonus_apply(v_shop_id, p_customer_tg_id, v_order_id, 'spend', -v_spend, 'spend:' || v_order_id::text);
  end if;

  return jsonb_build_object('replayed', false, 'order', public.order_to_json(v_order_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Order life cycle: confirmation credits bonuses, cancellation gives everything back
-- ---------------------------------------------------------------------------

-- Called inside admin_set_order_status when an order becomes «confirmed».
create or replace function private.loyalty_on_confirm(p_order public.orders)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set private.shop_loyalty_settings%rowtype;
  v_amount integer;
  v_balance integer;
begin
  -- A promo activation that was only reserved is now final.
  update private.promo_redemptions r
    set status = 'redeemed', redeemed_at = now(), updated_at = now()
    where r.order_id = p_order.id and r.status = 'reserved';

  select * into v_set from private.shop_loyalty_settings s where s.shop_id = p_order.shop_id;
  if not found or not v_set.bonus_enabled or p_order.bonus_accrued is not null then
    return;
  end if;
  v_amount := private.bonus_for(p_order.total_minor, v_set.bonus_percent)::integer;
  if v_amount <= 0 then
    return;
  end if;
  v_balance := private.bonus_apply(p_order.shop_id, p_order.customer_tg_id, p_order.id, 'accrual', v_amount, 'accrual:' || p_order.id::text);
  if v_balance is null then
    return;
  end if;
  update public.orders set bonus_accrued = v_amount where id = p_order.id;

  -- The message is only queued, and only for a buyer who started the shop's bot; it must never fail the confirmation.
  begin
    insert into private.bonus_notifications (shop_id, order_id, bot_id, tg_user_id, chat_id, amount)
    select p_order.shop_id, p_order.id, c.bot_id, s.tg_user_id, s.chat_id, v_amount
    from private.shop_bot_connections c
    join private.bot_subscribers s
      on s.shop_id = c.shop_id and s.bot_id = c.bot_id and s.tg_user_id = p_order.customer_tg_id and s.status <> 'blocked'
    where c.shop_id = p_order.shop_id
    on conflict (order_id) do nothing;
  exception when others then
    raise warning 'bonus notification not enqueued for order %: %', p_order.id, sqlstate;
  end;
end;
$$;

-- Called inside admin_set_order_status when an order is cancelled (from any open status).
create or replace function private.loyalty_on_cancel(p_order public.orders)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  -- The activation of a promo code is free again.
  with released as (
    update private.promo_redemptions r
      set status = 'released', released_at = now(), updated_at = now()
      where r.order_id = p_order.id and r.status in ('reserved', 'redeemed')
      returning r.promo_id, r.shop_id
  )
  update private.shop_promo_codes c
    set used_count = greatest(c.used_count - 1, 0)
    from released x
    where c.id = x.promo_id and c.shop_id = x.shop_id;

  -- Bonuses the buyer spent on this order come back (also for an order that was never confirmed).
  if p_order.bonus_spent > 0 then
    perform private.bonus_apply(p_order.shop_id, p_order.customer_tg_id, p_order.id, 'spend_refund', p_order.bonus_spent, 'refund:' || p_order.id::text);
  end if;

  -- Bonuses credited for this order are taken back, but never below zero: what the buyer already spent stays spent.
  if coalesce(p_order.bonus_accrued, 0) > 0 then
    select a.balance into v_balance
    from private.customer_bonus_accounts a
    where a.shop_id = p_order.shop_id and a.customer_tg_id = p_order.customer_tg_id
    for update;
    if coalesce(v_balance, 0) > 0 then
      perform private.bonus_apply(
        p_order.shop_id, p_order.customer_tg_id, p_order.id, 'accrual_reversal',
        -least(p_order.bonus_accrued, v_balance), 'reversal:' || p_order.id::text
      );
    end if;
  end if;
  -- A notification that was not sent yet is moot.
  update private.bonus_notifications n
    set status = 'dead', last_error = 'order_cancelled', locked_until = null, updated_at = now()
    where n.order_id = p_order.id and n.status in ('pending', 'failed');
end;
$$;

-- Same as 20261014090200 plus the two hooks above (same signature, same grants, same transitions).
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

  if p_status = 'cancelled' then
    perform private.loyalty_on_cancel(v_order);
  end if;

  update public.orders set status = p_status where id = v_order.id;

  if p_status = 'confirmed' then
    perform private.loyalty_on_confirm(v_order);
  end if;
  return public.order_to_json(v_order.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Buyer: cart preview and profile (service role; the Telegram user is verified by the Edge Function)
-- ---------------------------------------------------------------------------

create or replace function public.loyalty_quote(
  p_shop_slug text,
  p_customer_tg_id bigint,
  p_items jsonb,
  p_promo_code text,
  p_bonus_spend integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_subtotal bigint;
begin
  if p_customer_tg_id is null or p_customer_tg_id <= 0 then
    raise exception 'invalid_customer' using errcode = 'P0001';
  end if;
  select * into v_shop from public.shops s where s.slug = p_shop_slug;
  if not found or v_shop.status <> 'active' then
    raise exception 'shop_unavailable' using errcode = 'P0001';
  end if;
  v_subtotal := private.loyalty_cart_subtotal(v_shop.id, p_items);
  return (private.loyalty_calc(v_shop.id, p_customer_tg_id, v_subtotal, p_promo_code, p_bonus_spend, false) - '_promo_id')
    || jsonb_build_object('currency', v_shop.currency);
end;
$$;

-- NULL when the shop has no bonus program and the buyer never had a balance: the profile shows nothing then.
create or replace function public.loyalty_customer_profile(p_shop_slug text, p_customer_tg_id bigint, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_shop public.shops%rowtype;
  v_set private.shop_loyalty_settings%rowtype;
  v_acc private.customer_bonus_accounts%rowtype;
  v_has_acc boolean;
begin
  select * into v_shop from public.shops s where s.slug = p_shop_slug and s.status = 'active';
  if not found or p_customer_tg_id is null or p_customer_tg_id <= 0 then
    return null;
  end if;
  select * into v_set from private.shop_loyalty_settings s where s.shop_id = v_shop.id;
  select * into v_acc from private.customer_bonus_accounts a where a.shop_id = v_shop.id and a.customer_tg_id = p_customer_tg_id;
  v_has_acc := found;
  if not coalesce(v_set.bonus_enabled, false) and not v_has_acc then
    return null;
  end if;
  return jsonb_build_object(
    'enabled', coalesce(v_set.bonus_enabled, false),
    'percent', case when coalesce(v_set.bonus_enabled, false) then v_set.bonus_percent end,
    'balance', coalesce(v_acc.balance, 0),
    'earned_total', coalesce(v_acc.earned_total, 0),
    'spent_total', coalesce(v_acc.spent_total, 0),
    'unit_minor', private.bonus_unit_minor(),
    'currency', v_shop.currency,
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id,
        'kind', h.kind,
        'amount', h.amount,
        'balance_after', h.balance_after,
        'order_id', h.order_id,
        'order_number', o.order_number,
        'created_at', h.created_at
      ) order by h.id desc)
      from (
        select l.* from private.bonus_ledger l
        where l.shop_id = v_shop.id and l.customer_tg_id = p_customer_tg_id
        order by l.id desc
        limit least(greatest(coalesce(p_limit, 30), 1), 100)
      ) h
      join public.orders o on o.shop_id = h.shop_id and o.id = h.order_id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Admin («Бонусы и промокоды»): service role + verified actor
-- ---------------------------------------------------------------------------

create or replace function private.loyalty_rules_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'min_total_minor', r.min_total_minor, 'percent', r.percent
  ) order by r.min_total_minor), '[]'::jsonb)
  from private.shop_discount_rules r
  where r.shop_id = p_shop_id;
$$;

create or replace function private.loyalty_promo_json(p_promo_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', c.id,
    'code', c.code,
    'discount_type', c.discount_type,
    'percent', c.percent,
    'fixed_minor', c.fixed_minor,
    'max_activations', c.max_activations,
    'used_count', c.used_count,
    'pending_count', (select count(*) from private.promo_redemptions r where r.promo_id = c.id and r.status = 'reserved'),
    'is_active', c.is_active,
    'status', case when not c.is_active then 'disabled' when c.used_count >= c.max_activations then 'finished' else 'active' end,
    'created_at', c.created_at
  )
  from private.shop_promo_codes c
  where c.id = p_promo_id;
$$;

create or replace function private.loyalty_promos_json(p_shop_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(private.loyalty_promo_json(c.id) order by c.created_at desc), '[]'::jsonb)
  from private.shop_promo_codes c
  where c.shop_id = p_shop_id;
$$;

create or replace function public.loyalty_get_overview(p_shop_id uuid, p_actor uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  return (
    select jsonb_build_object(
      'shop', jsonb_build_object('id', s.id, 'slug', s.slug, 'currency', s.currency),
      'settings', private.loyalty_settings_json(s.id),
      'rules', private.loyalty_rules_json(s.id),
      'promos', private.loyalty_promos_json(s.id),
      'stats', jsonb_build_object(
        'customers', (select count(*) from private.customer_bonus_accounts a where a.shop_id = s.id),
        'balance_total', (select coalesce(sum(a.balance), 0) from private.customer_bonus_accounts a where a.shop_id = s.id),
        'earned_total', (select coalesce(sum(a.earned_total), 0) from private.customer_bonus_accounts a where a.shop_id = s.id),
        'spent_total', (select coalesce(sum(a.spent_total), 0) from private.customer_bonus_accounts a where a.shop_id = s.id),
        'notifications', (
          select jsonb_build_object(
            'pending', count(*) filter (where n.status in ('pending', 'sending', 'failed')),
            'sent', count(*) filter (where n.status = 'sent'),
            'dead', count(*) filter (where n.status = 'dead'))
          from private.bonus_notifications n where n.shop_id = s.id)
      ),
      'recent', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', h.id,
          'kind', h.kind,
          'amount', h.amount,
          'order_number', o.order_number,
          'customer', coalesce(nullif(btrim(coalesce(o.customer_snapshot ->> 'first_name', '') || ' ' || coalesce(o.customer_snapshot ->> 'last_name', '')), ''),
                               'Покупатель'),
          'username', o.customer_snapshot ->> 'username',
          'created_at', h.created_at
        ) order by h.id desc)
        from (select l.* from private.bonus_ledger l where l.shop_id = s.id order by l.id desc limit 20) h
        join public.orders o on o.shop_id = h.shop_id and o.id = h.order_id
      ), '[]'::jsonb)
    )
    from public.shops s
    where s.id = p_shop_id
  );
end;
$$;

-- NULL = leave unchanged. Turning the bonus program on needs a percent (the stored one, 5 by default, is used otherwise).
create or replace function public.loyalty_save_settings(
  p_shop_id uuid,
  p_actor uuid,
  p_bonus_enabled boolean,
  p_bonus_percent numeric,
  p_discount_enabled boolean,
  p_promo_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  perform 1 from public.shops where id = p_shop_id for share;
  if p_bonus_percent is not null and (p_bonus_percent <= 0 or p_bonus_percent > 100 or p_bonus_percent <> round(p_bonus_percent, 2)) then
    raise exception 'invalid_percent' using errcode = 'P0001';
  end if;
  insert into private.shop_loyalty_settings as s (shop_id, bonus_enabled, bonus_percent, discount_enabled, promo_enabled, updated_by)
  values (p_shop_id, coalesce(p_bonus_enabled, false), coalesce(p_bonus_percent, 5), coalesce(p_discount_enabled, false), coalesce(p_promo_enabled, false), p_actor)
  on conflict (shop_id) do update set
    bonus_enabled = coalesce(p_bonus_enabled, s.bonus_enabled),
    bonus_percent = coalesce(p_bonus_percent, s.bonus_percent),
    discount_enabled = coalesce(p_discount_enabled, s.discount_enabled),
    promo_enabled = coalesce(p_promo_enabled, s.promo_enabled),
    updated_by = p_actor;
  return private.loyalty_settings_json(p_shop_id);
end;
$$;

-- p_rule_id NULL creates a rule, otherwise it edits that rule of THIS shop.
create or replace function public.loyalty_save_rule(
  p_shop_id uuid,
  p_actor uuid,
  p_rule_id uuid,
  p_min_total_minor bigint,
  p_percent integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  perform 1 from public.shops where id = p_shop_id for share;
  if p_min_total_minor is null or p_min_total_minor <= 0 or p_min_total_minor > 100000000000
     or p_percent is null or p_percent < 1 or p_percent > 90 then
    raise exception 'invalid_rule' using errcode = 'P0001';
  end if;
  begin
    if p_rule_id is null then
      if (select count(*) from private.shop_discount_rules r where r.shop_id = p_shop_id) >= 20 then
        raise exception 'too_many_rules' using errcode = 'P0001';
      end if;
      insert into private.shop_discount_rules (shop_id, min_total_minor, percent) values (p_shop_id, p_min_total_minor, p_percent);
    else
      update private.shop_discount_rules r
        set min_total_minor = p_min_total_minor, percent = p_percent
        where r.id = p_rule_id and r.shop_id = p_shop_id;
      if not found then
        raise exception 'rule_not_found' using errcode = 'P0001';
      end if;
    end if;
  exception when unique_violation then
    raise exception 'rule_exists' using errcode = 'P0001';
  end;
  return private.loyalty_rules_json(p_shop_id);
end;
$$;

create or replace function public.loyalty_delete_rule(p_shop_id uuid, p_actor uuid, p_rule_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  delete from private.shop_discount_rules r where r.id = p_rule_id and r.shop_id = p_shop_id;
  if not found then
    raise exception 'rule_not_found' using errcode = 'P0001';
  end if;
  return private.loyalty_rules_json(p_shop_id);
end;
$$;

-- Creates (p_promo_id NULL) or edits a promo code. p_value: percent (1..90) or the fixed amount in minor units. The code of an
-- existing promo never changes (its history refers to it); the limit can not drop below the activations already used.
create or replace function public.loyalty_save_promo(
  p_shop_id uuid,
  p_actor uuid,
  p_promo_id uuid,
  p_code text,
  p_discount_type text,
  p_value bigint,
  p_max_activations integer,
  p_is_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := private.normalize_promo_code(p_code);
  v_id uuid;
  v_used integer;
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  perform 1 from public.shops where id = p_shop_id for share;
  if p_discount_type is null or p_discount_type not in ('percent', 'fixed')
     or p_value is null or p_value <= 0
     or (p_discount_type = 'percent' and p_value > 90)
     or (p_discount_type = 'fixed' and p_value > 100000000000)
     or p_max_activations is null or p_max_activations < 1 or p_max_activations > 1000000 then
    raise exception 'invalid_promo' using errcode = 'P0001';
  end if;
  begin
    if p_promo_id is null then
      if v_code !~ '^[A-Z0-9_-]{3,32}$' then
        raise exception 'invalid_promo_code' using errcode = 'P0001';
      end if;
      if (select count(*) from private.shop_promo_codes c where c.shop_id = p_shop_id) >= 200 then
        raise exception 'too_many_promos' using errcode = 'P0001';
      end if;
      insert into private.shop_promo_codes (shop_id, code, discount_type, percent, fixed_minor, max_activations, is_active, created_by)
      values (
        p_shop_id, v_code, p_discount_type,
        case when p_discount_type = 'percent' then p_value::smallint end,
        case when p_discount_type = 'fixed' then p_value end,
        p_max_activations, coalesce(p_is_active, true), p_actor
      )
      returning id into v_id;
    else
      select c.used_count into v_used from private.shop_promo_codes c where c.id = p_promo_id and c.shop_id = p_shop_id for update;
      if not found then
        raise exception 'promo_not_found' using errcode = 'P0001';
      end if;
      if p_max_activations < v_used then
        raise exception 'limit_below_used' using errcode = 'P0001', detail = jsonb_build_object('used', v_used)::text;
      end if;
      update private.shop_promo_codes c
        set discount_type = p_discount_type,
            percent = case when p_discount_type = 'percent' then p_value::smallint end,
            fixed_minor = case when p_discount_type = 'fixed' then p_value end,
            max_activations = p_max_activations,
            is_active = coalesce(p_is_active, c.is_active)
        where c.id = p_promo_id and c.shop_id = p_shop_id;
      v_id := p_promo_id;
    end if;
  exception when unique_violation then
    raise exception 'promo_exists' using errcode = 'P0001';
  end;
  return jsonb_build_object('promo', private.loyalty_promo_json(v_id), 'promos', private.loyalty_promos_json(p_shop_id));
end;
$$;

create or replace function public.loyalty_set_promo_active(p_shop_id uuid, p_actor uuid, p_promo_id uuid, p_active boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  update private.shop_promo_codes c set is_active = coalesce(p_active, false) where c.id = p_promo_id and c.shop_id = p_shop_id;
  if not found then
    raise exception 'promo_not_found' using errcode = 'P0001';
  end if;
  return jsonb_build_object('promo', private.loyalty_promo_json(p_promo_id), 'promos', private.loyalty_promos_json(p_shop_id));
end;
$$;

-- Only a code that was never used can be deleted; otherwise it is switched off (its history stays).
create or replace function public.loyalty_delete_promo(p_shop_id uuid, p_actor uuid, p_promo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  perform 1 from private.shop_promo_codes c where c.id = p_promo_id and c.shop_id = p_shop_id for update;
  if not found then
    raise exception 'promo_not_found' using errcode = 'P0001';
  end if;
  if exists (select 1 from private.promo_redemptions r where r.promo_id = p_promo_id) then
    raise exception 'promo_in_use' using errcode = 'P0001';
  end if;
  delete from private.shop_promo_codes c where c.id = p_promo_id and c.shop_id = p_shop_id;
  return jsonb_build_object('promos', private.loyalty_promos_json(p_shop_id));
end;
$$;

-- Where a code was used: the order, its status and the amount. No chat or user ids.
create or replace function public.loyalty_promo_history(p_shop_id uuid, p_actor uuid, p_promo_id uuid, p_limit integer)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_can_manage_shop(p_shop_id, p_actor);
  if not exists (select 1 from private.shop_promo_codes c where c.id = p_promo_id and c.shop_id = p_shop_id) then
    raise exception 'promo_not_found' using errcode = 'P0001';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'order_number', o.order_number,
      'order_status', o.status,
      'status', h.status,
      'discount_minor', h.discount_minor,
      'created_at', h.created_at,
      'redeemed_at', h.redeemed_at,
      'released_at', h.released_at
    ) order by h.created_at desc)
    from (
      select r.* from private.promo_redemptions r
      where r.shop_id = p_shop_id and r.promo_id = p_promo_id
      order by r.created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) h
    join public.orders o on o.shop_id = h.shop_id and o.id = h.order_id
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. «🎁 За ваш заказ начислено …»: claim / re-check / complete (same protocol as the buyer's order notification)
-- ---------------------------------------------------------------------------

-- Claims due notifications of one order / one shop. p_actor: a shop member (admin panel); NULL for the trusted checkout
-- function (opportunistic retry). A claim that was never completed is not sent again (its outcome is unknown).
create or replace function public.bonus_notify_claim(p_actor uuid, p_shop_id uuid, p_order_id uuid, p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs jsonb := '[]'::jsonb;
  v_row record;
begin
  if p_actor is not null then
    perform private.assert_shop_member_actor(p_shop_id, p_actor);
  end if;

  update private.bonus_notifications n
    set status = 'dead', last_error = 'interrupted', locked_until = null, updated_at = now()
    where (p_order_id is null or n.order_id = p_order_id)
      and (p_shop_id is null or n.shop_id = p_shop_id)
      and n.status = 'sending' and n.locked_until < now();
  update private.bonus_notifications n
    set status = 'dead', last_error = 'bot_changed', locked_until = null, updated_at = now()
    where (p_order_id is null or n.order_id = p_order_id)
      and (p_shop_id is null or n.shop_id = p_shop_id)
      and n.status in ('pending', 'failed')
      and not exists (select 1 from private.shop_bot_connections c where c.shop_id = n.shop_id and c.bot_id = n.bot_id);

  for v_row in
    with picked as (
      select n.id
      from private.bonus_notifications n
      where (p_order_id is null or n.order_id = p_order_id)
        and (p_shop_id is null or n.shop_id = p_shop_id)
        and n.status in ('pending', 'failed')
        and n.next_attempt_at <= now()
        and n.created_at > now() - interval '24 hours'
      order by n.id
      limit least(greatest(coalesce(p_limit, 1), 1), 20)
      for update of n skip locked
    )
    update private.bonus_notifications n
      set status = 'sending', attempts = n.attempts + 1, locked_until = now() + interval '2 minutes', updated_at = now()
      from picked
      where n.id = picked.id
      returning n.id, n.order_id, n.shop_id, n.bot_id, n.tg_user_id, n.chat_id, n.attempts, n.amount
  loop
    v_jobs := v_jobs || coalesce((
      select jsonb_build_array(jsonb_build_object(
        'notification_id', v_row.id,
        'attempt', v_row.attempts,
        'bot_id', v_row.bot_id,
        'shop_name', sh.name,
        'chat_id', v_row.chat_id,
        'bot_token', d.decrypted_secret,
        'order_number', o.order_number,
        'amount', v_row.amount,
        'balance', coalesce((
          select a.balance from private.customer_bonus_accounts a
          where a.shop_id = v_row.shop_id and a.customer_tg_id = v_row.tg_user_id), 0)
      ))
      from private.shop_bot_connections c
      join vault.decrypted_secrets d on d.id = c.bot_token_secret_id
      join public.shops sh on sh.id = c.shop_id
      join public.orders o on o.id = v_row.order_id
      where c.shop_id = v_row.shop_id and c.bot_id = v_row.bot_id
    ), '[]'::jsonb);
  end loop;
  return v_jobs;
end;
$$;

-- Right before sendMessage: true only while this attempt still holds the job, the shop's bot is still the one the buyer
-- started, the buyer did not block it, and the order was not cancelled meanwhile.
create or replace function public.bonus_notify_begin_send(p_notification_id bigint, p_attempt integer, p_bot_id bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from private.bonus_notifications n
    join private.shop_bot_connections c on c.shop_id = n.shop_id and c.bot_id = n.bot_id
    join private.bot_subscribers s on s.shop_id = n.shop_id and s.bot_id = n.bot_id and s.tg_user_id = n.tg_user_id
    join public.orders o on o.id = n.order_id
    where n.id = p_notification_id
      and n.status = 'sending'
      and n.attempts = p_attempt
      and n.locked_until > now()
      and n.bot_id = p_bot_id
      and s.status <> 'blocked'
      and o.status <> 'cancelled'
  );
$$;

create or replace function public.bonus_notify_complete(p_notification_id bigint, p_ok boolean, p_message_id bigint, p_error text, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.bonus_notifications%rowtype;
begin
  select * into v_row from private.bonus_notifications where id = p_notification_id for update;
  if not found or v_row.status <> 'sending' then
    return;
  end if;
  if p_ok then
    update private.bonus_notifications
      set status = 'sent', sent_at = now(), telegram_message_id = p_message_id, last_error = null,
          locked_until = null, updated_at = now()
      where id = p_notification_id;
  else
    update private.bonus_notifications
      set status = case when coalesce(p_blocked, false) or v_row.attempts >= 5 then 'dead' else 'failed' end,
          next_attempt_at = now() + make_interval(secs => 30 * power(2, greatest(v_row.attempts - 1, 0))),
          last_error = left(coalesce(p_error, 'unknown_error'), 300),
          locked_until = null,
          updated_at = now()
      where id = p_notification_id;
    if coalesce(p_blocked, false) then
      update private.bot_subscribers s
        set status = 'blocked', updated_at = now()
        where s.shop_id = v_row.shop_id and s.bot_id = v_row.bot_id and s.tg_user_id = v_row.tg_user_id and s.status <> 'blocked';
    end if;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Deleting a shop: its loyalty data goes first
-- ---------------------------------------------------------------------------

create or replace function private.purge_shop_loyalty(p_shop_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from private.bonus_notifications where shop_id = p_shop_id;
  delete from private.bonus_ledger where shop_id = p_shop_id;
  delete from private.customer_bonus_accounts where shop_id = p_shop_id;
  delete from private.promo_redemptions where shop_id = p_shop_id;
  delete from private.shop_promo_codes where shop_id = p_shop_id;
  delete from private.shop_discount_rules where shop_id = p_shop_id;
  delete from private.shop_loyalty_settings where shop_id = p_shop_id;
end;
$$;

-- Same as 20261113090000 plus private.purge_shop_loyalty (the verification of leftover rows covers every table with shop_id).
create or replace function private.shop_delete_begin(p_actor uuid, p_shop public.shops, p_step_up_at timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_left jsonb;
begin
  -- A hand-over request inside Supabase Auth right now: let it finish (or expire) first.
  perform private.assert_no_live_handover_reservation(p_shop.id);

  insert into private.shop_deletions (shop_id, slug, requested_by, was_demo, step_up_at)
  values (p_shop.id, p_shop.slug, p_actor, p_shop.is_demo, p_step_up_at);

  perform private.purge_shop_notifications(p_shop.id);
  perform private.purge_shop_bot(p_shop.id);
  perform private.purge_shop_loyalty(p_shop.id);

  -- Orders first: their items keep RESTRICT references to products / variants (20261026100000).
  delete from public.orders where shop_id = p_shop.id;
  delete from public.inventory_movements where shop_id = p_shop.id;
  delete from public.product_images where shop_id = p_shop.id;
  delete from public.product_variants where shop_id = p_shop.id;
  delete from public.products where shop_id = p_shop.id;
  delete from public.categories where shop_id = p_shop.id;
  delete from public.shop_order_counters where shop_id = p_shop.id;
  delete from public.shop_memberships where shop_id = p_shop.id;
  delete from private.shop_pending_handovers where shop_id = p_shop.id;
  delete from private.shop_handover_reservations where shop_id = p_shop.id;
  delete from private.handover_invitation_sends where shop_id = p_shop.id;
  delete from private.checkout_limits where shop_id = p_shop.id;
  delete from private.checkout_stock_refusals where shop_id = p_shop.id;
  delete from private.shop_transfers where shop_id = p_shop.id;
  delete from private.shop_lifecycle_events where shop_id = p_shop.id;
  delete from private.shop_delete_challenges where shop_id = p_shop.id;

  update public.shops
    set status = 'deleting', mode = 'preview', logo_path = null, cover_path = null, published_at = null
    where id = p_shop.id;

  v_left := private.shop_leftover_rows(p_shop.id);
  if v_left <> '{}'::jsonb then
    raise exception 'deletion_verification_failed' using errcode = 'P0001', detail = v_left::text;
  end if;

  return jsonb_build_object(
    'status', 'pending',
    'shop', jsonb_build_object('id', p_shop.id, 'slug', p_shop.slug, 'name', p_shop.name),
    'deletion', private.shop_deletion_json(p_shop.id)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. EXECUTE: service_role only (the existing admin RPCs keep authenticated)
-- ---------------------------------------------------------------------------

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.order_to_json(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_order_status(uuid, text) from public, anon;
revoke all on function public.create_order_v3(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint, text, integer) from public, anon, authenticated;
revoke all on function public.loyalty_quote(text, bigint, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.loyalty_customer_profile(text, bigint, integer) from public, anon, authenticated;
revoke all on function public.loyalty_get_overview(uuid, uuid) from public, anon, authenticated;
revoke all on function public.loyalty_save_settings(uuid, uuid, boolean, numeric, boolean, boolean) from public, anon, authenticated;
revoke all on function public.loyalty_save_rule(uuid, uuid, uuid, bigint, integer) from public, anon, authenticated;
revoke all on function public.loyalty_delete_rule(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.loyalty_save_promo(uuid, uuid, uuid, text, text, bigint, integer, boolean) from public, anon, authenticated;
revoke all on function public.loyalty_set_promo_active(uuid, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.loyalty_delete_promo(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.loyalty_promo_history(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.bonus_notify_claim(uuid, uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.bonus_notify_begin_send(bigint, integer, bigint) from public, anon, authenticated;
revoke all on function public.bonus_notify_complete(bigint, boolean, bigint, text, boolean) from public, anon, authenticated;

grant execute on function public.order_to_json(uuid) to service_role;
grant execute on function public.admin_set_order_status(uuid, text) to authenticated, service_role;
grant execute on function public.create_order_v3(text, bigint, jsonb, jsonb, uuid, text, text, text, text, text, bigint, text, integer) to service_role;
grant execute on function public.loyalty_quote(text, bigint, jsonb, text, integer) to service_role;
grant execute on function public.loyalty_customer_profile(text, bigint, integer) to service_role;
grant execute on function public.loyalty_get_overview(uuid, uuid) to service_role;
grant execute on function public.loyalty_save_settings(uuid, uuid, boolean, numeric, boolean, boolean) to service_role;
grant execute on function public.loyalty_save_rule(uuid, uuid, uuid, bigint, integer) to service_role;
grant execute on function public.loyalty_delete_rule(uuid, uuid, uuid) to service_role;
grant execute on function public.loyalty_save_promo(uuid, uuid, uuid, text, text, bigint, integer, boolean) to service_role;
grant execute on function public.loyalty_set_promo_active(uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.loyalty_delete_promo(uuid, uuid, uuid) to service_role;
grant execute on function public.loyalty_promo_history(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.bonus_notify_claim(uuid, uuid, uuid, integer) to service_role;
grant execute on function public.bonus_notify_begin_send(bigint, integer, bigint) to service_role;
grant execute on function public.bonus_notify_complete(bigint, boolean, bigint, text, boolean) to service_role;
