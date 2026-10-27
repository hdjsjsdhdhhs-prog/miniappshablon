import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  admin,
  anon,
  callFunction,
  checkoutBody,
  cleanup,
  createOwner,
  createTestShop,
  initDataFor,
  localSql,
  localSqlRolledBack,
  newTelegramUserId,
  stockOf,
  type Db,
  type TestShop,
} from './helpers';

// EXECUTE privileges on public functions, checked directly per PostgreSQL role and through the
// real API (PostgREST / Edge Functions). Background: hosted Supabase grants EXECUTE on new
// functions to anon/authenticated via default privileges; see
// supabase/migrations/20261017090000_harden_function_privileges.sql.

const FIX_MIGRATION = new URL('../../supabase/migrations/20261017090000_harden_function_privileges.sql', import.meta.url);

type Roles = { anon: boolean; authenticated: boolean; service_role: boolean; public: boolean };
const r = (anon: boolean, authenticated: boolean, service_role: boolean): Roles => ({ anon, authenticated, service_role, public: false });

/** The reviewed allowlist. Every function in schema public must be listed here. */
const EXPECTED: Record<string, Roles> = {
  'public.shop_is_public(uuid)': r(true, true, true),
  'public.product_is_public(uuid)': r(true, true, true),
  'public.is_platform_admin()': r(false, true, true),
  'public.is_shop_member(uuid)': r(false, true, true),
  'public.storage_object_shop_id(text)': r(false, true, true),
  'public.admin_set_order_status(uuid,text)': r(false, true, true),
  'public.admin_set_variant_stock(uuid,integer)': r(false, true, true),
  // Catalog deletes (20261026100000): owner admin through PostgREST, shop membership re-checked inside.
  'public.admin_delete_product(uuid)': r(false, true, true),
  'public.admin_delete_variant(uuid)': r(false, true, true),
  'public.admin_delete_category(uuid,uuid)': r(false, true, true),
  'public.is_valid_theme(jsonb)': r(false, true, true),
  'public.is_supported_currency(text)': r(false, true, true),
  'public.order_status_transition_allowed(text,text)': r(false, false, true),
  'public.order_to_json(uuid)': r(false, false, true),
  'public.create_order(text,bigint,jsonb,jsonb,uuid,text,text,text,text,text,bigint)': r(false, false, true),
  // Fulfillment checkout (20261026090000), next to the unchanged create_order of the old contract.
  'public.create_order_v2(text,bigint,jsonb,jsonb,uuid,text,text,text,text,text,bigint)': r(false, false, true),
  'public.get_customer_orders(text,bigint,uuid,integer)': r(false, false, true),
  'public.set_updated_at()': r(false, false, false),
  // Telegram notifications and platform administration (20261025090000): Edge Functions only. The function
  // verifies the caller's JWT and passes the verified user id; the SQL re-checks that actor's rights.
  'public.notify_get_settings(uuid,uuid)': r(false, false, true),
  'public.notify_save_settings(uuid,uuid,text,text,jsonb)': r(false, false, true),
  'public.notify_get_credentials(uuid,uuid)': r(false, false, true),
  'public.notify_record_check(uuid,uuid,boolean,text)': r(false, false, true),
  'public.notify_set_enabled(uuid,uuid,boolean)': r(false, false, true),
  'public.notify_delete_settings(uuid,uuid)': r(false, false, true),
  'public.notify_claim(uuid,uuid,integer)': r(false, false, true),
  'public.notify_complete(bigint,boolean,bigint,text)': r(false, false, true),
  'public.notify_requeue_failed(uuid,uuid)': r(false, false, true),
  'public.platform_list_shops(uuid)': r(false, false, true),
  'public.platform_find_user(uuid,text)': r(false, false, true),
  'public.platform_transfer_shop(uuid,uuid,uuid)': r(false, false, true),
  // DEMO lifecycle (20261026090000): platform-admin Edge Function only, actor re-checked inside.
  'public.platform_create_demo_shop(uuid,uuid,text,text)': r(false, false, true),
  'public.platform_publish_demo_shop(uuid,uuid)': r(false, false, true),
  'public.platform_discard_demo_shop(uuid,uuid)': r(false, false, true),
  'public.platform_handover_check(uuid,uuid)': r(false, false, true),
  'public.platform_handover_shop(uuid,uuid,uuid,text)': r(false, false, true),
};

/** Functions that existed on the hosted project when the hardening migration was written (17.10.2026). */
const HARDENED_FUNCTIONS = [
  'public.is_supported_currency(text)',
  'public.is_valid_theme(jsonb)',
  'public.set_updated_at()',
  'public.is_platform_admin()',
  'public.is_shop_member(uuid)',
  'public.shop_is_public(uuid)',
  'public.product_is_public(uuid)',
  'public.storage_object_shop_id(text)',
  'public.order_status_transition_allowed(text,text)',
  'public.order_to_json(uuid)',
  'public.create_order(text,bigint,jsonb,jsonb,uuid,text,text,text,text,text,bigint)',
  'public.get_customer_orders(text,bigint,uuid,integer)',
  'public.admin_set_order_status(uuid,text)',
  'public.admin_set_variant_stock(uuid,integer)',
];

/**
 * Functions added AFTER the hardening migration that later migrations deliberately grant to authenticated. The
 * hardening migration's own assertion only knows its 17.10.2026 allowlist, so the replay below takes these grants
 * away before running it and gives them back afterwards — exactly the state the later migrations produce.
 */
const LATER_AUTHENTICATED_FUNCTIONS = Object.entries(EXPECTED)
  .filter(([sig, roles]) => roles.authenticated && !HARDENED_FUNCTIONS.includes(sig))
  .map(([sig]) => sig);

/** jsonb: { "<schema>.<name>(<argtypes>)": { anon, authenticated, service_role, public } } for public functions. */
const MATRIX_SQL = `(
  select jsonb_object_agg(
    format('%s.%s(%s)', n.nspname, p.proname, replace(oidvectortypes(p.proargtypes), ' ', '')),
    jsonb_build_object(
      'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
      'public', exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      )
    )
  )
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
)`;

/** Creates a function, a table and its identity sequence as the migration role and reads their ACLs. */
const NEW_OBJECTS_PROBE = `
  execute $it_new$
    create function public.__it_probe_fn() returns integer language sql security definer set search_path = '' as $f$ select 1 $f$;
    create table public.__it_probe_tbl (id bigint generated always as identity primary key);
  $it_new$;
  result := jsonb_build_object(
    'owner', (select pg_get_userbyid(proowner) from pg_proc where oid = 'public.__it_probe_fn()'::regprocedure),
    'fn_anon', has_function_privilege('anon', 'public.__it_probe_fn()', 'EXECUTE'),
    'fn_authenticated', has_function_privilege('authenticated', 'public.__it_probe_fn()', 'EXECUTE'),
    'fn_public', exists (
      select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where p.oid = 'public.__it_probe_fn()'::regprocedure and a.grantee = 0 and a.privilege_type = 'EXECUTE'
    ),
    'tbl_anon', has_table_privilege('anon', 'public.__it_probe_tbl', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    'tbl_authenticated', has_table_privilege('authenticated', 'public.__it_probe_tbl', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    'seq_anon', has_sequence_privilege('anon', pg_get_serial_sequence('public.__it_probe_tbl', 'id'), 'USAGE,SELECT,UPDATE'),
    'seq_authenticated', has_sequence_privilege('authenticated', pg_get_serial_sequence('public.__it_probe_tbl', 'id'), 'USAGE,SELECT,UPDATE')
  );
`;

const NOTHING_EXPOSED = {
  fn_anon: false,
  fn_authenticated: false,
  fn_public: false,
  tbl_anon: false,
  tbl_authenticated: false,
  seq_anon: false,
  seq_authenticated: false,
};

let S: TestShop;
let T: TestShop;
let ownerS: Db;
let ownerT: Db;
let victimTgId: number;
let victimOrderId: string;

beforeAll(async () => {
  S = await createTestShop({ variants: [{ flavor: 'Mint', stock: 10 }] });
  T = await createTestShop();
  ownerS = (await createOwner(S.id)).client;
  ownerT = (await createOwner(T.id)).client;
  victimTgId = newTelegramUserId();
  const res = await callFunction(
    'checkout',
    await initDataFor(victimTgId),
    checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: 1 }], { fulfillment: { method: 'delivery', address: 'Victim Street 1, apt 2' } }),
  );
  expect(res.status).toBe(201);
  victimOrderId = (res.body!.order as { id: string }).id;
});

afterAll(cleanup);

/** Forged direct calls of both checkout RPCs: the old contract (create_order) and the new one (create_order_v2). */
const CREATE_ORDER_RPCS = ['create_order', 'create_order_v2'] as const;

function forgedCreateOrderArgs(tgId: number, fn: (typeof CREATE_ORDER_RPCS)[number] = 'create_order_v2') {
  const common = {
    p_shop_slug: S.slug,
    p_customer_tg_id: tgId,
    p_customer_snapshot: { first_name: 'Forged' },
    p_items: [{ variant_id: S.variants[0]!.id, quantity: 1 }],
    p_idempotency_key: randomUUID(),
    p_request_hash: 'forged',
    p_comment: '',
    p_expected_currency: 'RUB',
    p_expected_total_minor: 50000,
  };
  return fn === 'create_order'
    ? { ...common, p_contact_name: 'Forged', p_contact_phone: '' }
    : { ...common, p_fulfillment_method: 'pickup', p_delivery_address: '' };
}

async function ordersOf(tgId: number) {
  const { data, error } = await admin.from('orders').select('id').eq('customer_tg_id', tgId);
  if (error) throw error;
  return data;
}

describe('EXECUTE privileges per PostgreSQL role', () => {
  it('every public function matches the reviewed allowlist (no unlisted functions)', () => {
    const [row] = localSql<{ m: Record<string, Roles> }>(`select ${MATRIX_SQL} as m`);
    expect(row!.m).toEqual(EXPECTED);
  });

  it('new functions, tables and sequences of the migration role are not exposed by default privileges', () => {
    const probe = localSqlRolledBack<Record<string, unknown>>(NEW_OBJECTS_PROBE);
    expect(probe).toEqual({ owner: 'postgres', ...NOTHING_EXPOSED });
    // The probe ran in a rolled-back block: nothing is left behind.
    expect(localSql(`select to_regprocedure('public.__it_probe_fn()') is null as gone`)).toEqual([{ gone: true }]);
  });

  it('the migration fixes the hosted state (hosted default privileges + direct grants to anon/authenticated)', () => {
    const migration = readFileSync(FIX_MIGRATION, 'utf8');
    expect(migration).not.toContain('$it_mig$');
    // Reproduces what the remote dump of xcbugcjmddtubytpvffa showed on 17.10.2026, then applies the
    // fix migration on top of it. Everything is rolled back.
    const res = localSqlRolledBack<{ before: Record<string, boolean>; matrix: Record<string, Roles>; probe: Record<string, unknown> }>(`
      alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
      alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
      alter default privileges for role postgres grant execute on functions to public;
      grant all on function ${HARDENED_FUNCTIONS.join(', ')} to anon, authenticated, service_role;
      grant execute on function public.is_supported_currency(text), public.is_valid_theme(jsonb), public.set_updated_at(),
        public.order_status_transition_allowed(text, text) to public;
      result := jsonb_build_object('before', jsonb_build_object(
        'anon_create_order', has_function_privilege('anon', 'public.create_order(text,bigint,jsonb,jsonb,uuid,text,text,text,text,text,bigint)', 'EXECUTE'),
        'anon_get_customer_orders', has_function_privilege('anon', 'public.get_customer_orders(text,bigint,uuid,integer)', 'EXECUTE'),
        'authenticated_create_order', has_function_privilege('authenticated', 'public.create_order(text,bigint,jsonb,jsonb,uuid,text,text,text,text,text,bigint)', 'EXECUTE')
      ));
      ${LATER_AUTHENTICATED_FUNCTIONS.length ? `revoke execute on function ${LATER_AUTHENTICATED_FUNCTIONS.join(', ')} from authenticated;` : ''}
      execute $it_mig$${migration}$it_mig$;
      ${LATER_AUTHENTICATED_FUNCTIONS.length ? `grant execute on function ${LATER_AUTHENTICATED_FUNCTIONS.join(', ')} to authenticated;` : ''}
      result := result || jsonb_build_object('matrix', ${MATRIX_SQL});
      declare outer_result jsonb := result;
      begin
        ${NEW_OBJECTS_PROBE}
        result := outer_result || jsonb_build_object('probe', result);
      end;
    `);
    // The bug is reproduced before the fix ...
    expect(res.before).toEqual({ anon_create_order: true, anon_get_customer_orders: true, authenticated_create_order: true });
    // ... and gone after it.
    expect(res.matrix).toEqual(EXPECTED);
    expect(res.probe).toMatchObject(NOTHING_EXPOSED);
  });
});

describe('anon through PostgREST', () => {
  it.each(CREATE_ORDER_RPCS)('cannot call %s directly with a forged Telegram ID', async (fn) => {
    const forged = newTelegramUserId();
    const before = await stockOf(S.variants[0]!.id);
    const res = await anon().rpc(fn as never, forgedCreateOrderArgs(forged, fn) as never);
    expect(res.error?.message).toMatch(/permission denied/i);
    expect(res.data).toBeNull();
    expect(await ordersOf(forged)).toEqual([]);
    expect(await stockOf(S.variants[0]!.id)).toBe(before);
  });

  it("cannot read another buyer's orders and contacts via get_customer_orders / order_to_json", async () => {
    const db = anon();
    const list = await db.rpc('get_customer_orders', { p_shop_slug: S.slug, p_customer_tg_id: victimTgId, p_limit: 30 });
    expect(list.error?.message).toMatch(/permission denied/i);
    expect(JSON.stringify(list.data ?? null)).not.toContain('Victim Street');
    const one = await db.rpc('order_to_json', { p_order_id: victimOrderId });
    expect(one.error?.message).toMatch(/permission denied/i);
    expect(JSON.stringify(one.data ?? null)).not.toContain('Victim Street');
  });

  it('cannot change order status or stock via admin_* RPCs', async () => {
    const db = anon();
    const before = await stockOf(S.variants[0]!.id);
    const status = await db.rpc('admin_set_order_status', { p_order_id: victimOrderId, p_status: 'cancelled' });
    expect(status.error?.message).toMatch(/permission denied/i);
    const stock = await db.rpc('admin_set_variant_stock', { p_variant_id: S.variants[0]!.id, p_quantity: 999 });
    expect(stock.error?.message).toMatch(/permission denied/i);
    expect((await admin.from('orders').select('status').eq('id', victimOrderId).single()).data!.status).toBe('new');
    expect(await stockOf(S.variants[0]!.id)).toBe(before);
  });

  it('cannot call owner-only helpers; storefront helpers keep working', async () => {
    const db = anon();
    expect((await db.rpc('is_shop_member', { p_shop_id: S.id })).error?.message).toMatch(/permission denied/i);
    expect((await db.rpc('order_status_transition_allowed', { p_from: 'new', p_to: 'confirmed' })).error?.message).toMatch(/permission denied/i);
    expect((await db.rpc('shop_is_public', { p_shop_id: S.id })).data).toBe(true);
    // Public RLS (uses shop_is_public / product_is_public as anon) still serves the catalogue.
    expect((await db.from('products').select('id').eq('id', S.productId)).data).toHaveLength(1);
    expect((await db.from('product_variants').select('id').eq('id', S.variants[0]!.id)).data).toHaveLength(1);
  });
});

describe('authenticated owners', () => {
  it('another shop owner cannot create orders, read buyers or touch shop S', async () => {
    const forged = newTelegramUserId();
    for (const fn of CREATE_ORDER_RPCS) {
      expect((await ownerT.rpc(fn as never, forgedCreateOrderArgs(forged, fn) as never)).error?.message, fn).toMatch(/permission denied/i);
    }
    expect(await ordersOf(forged)).toEqual([]);
    const list = await ownerT.rpc('get_customer_orders', { p_shop_slug: S.slug, p_customer_tg_id: victimTgId, p_limit: 30 });
    expect(list.error?.message).toMatch(/permission denied/i);
    expect((await ownerT.rpc('order_to_json', { p_order_id: victimOrderId })).error?.message).toMatch(/permission denied/i);
    expect((await ownerT.rpc('is_shop_member', { p_shop_id: S.id })).data).toBe(false);
    expect((await ownerT.from('orders').select('id').eq('id', victimOrderId)).data).toEqual([]);
    expect((await ownerT.rpc('admin_set_order_status', { p_order_id: victimOrderId, p_status: 'cancelled' })).error?.message).toBe('order_not_found');
    expect((await ownerT.rpc('admin_set_variant_stock', { p_variant_id: S.variants[0]!.id, p_quantity: 0 })).error?.message).toBe('variant_not_found');
    expect((await admin.from('orders').select('status').eq('id', victimOrderId).single()).data!.status).toBe('new');
  });

  it('the shop owner keeps the allowed admin actions', async () => {
    expect((await ownerS.rpc('is_shop_member', { p_shop_id: S.id })).data).toBe(true);
    const stock = await ownerS.rpc('admin_set_variant_stock', { p_variant_id: S.variants[0]!.id, p_quantity: 42 });
    expect(stock.error).toBeNull();
    expect(await stockOf(S.variants[0]!.id)).toBe(42);
    const status = await ownerS.rpc('admin_set_order_status', { p_order_id: victimOrderId, p_status: 'confirmed' });
    expect(status.error).toBeNull();
    expect((status.data as { status: string }).status).toBe('confirmed');
    expect((await ownerS.from('orders').select('id, delivery_address').eq('id', victimOrderId)).data).toEqual([{ id: victimOrderId, delivery_address: 'Victim Street 1, apt 2' }]);
    // shops CHECK constraints (is_valid_theme / is_supported_currency) and the updated_at trigger run as authenticated.
    const upd = await ownerS.from('shops').update({ name: 'Renamed by owner' }).eq('id', S.id).select('name');
    expect(upd.error).toBeNull();
    expect(upd.data).toEqual([{ name: 'Renamed by owner' }]);
    const prod = await ownerS.from('products').update({ name: 'Renamed product' }).eq('id', S.productId).select('name');
    expect(prod.error).toBeNull();
  });
});

describe('trusted server (Edge Functions with the service role)', () => {
  it('checkout and my-orders keep working', async () => {
    const buyer = newTelegramUserId();
    const init = await initDataFor(buyer);
    const created = await callFunction('checkout', init, checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: 1 }]));
    expect(created.status).toBe(201);
    const orderId = (created.body!.order as { id: string }).id;
    const mine = await callFunction('my-orders', init, { shopSlug: S.slug });
    expect(mine.status).toBe(200);
    expect((mine.body!.orders as Array<{ id: string }>).map((o) => o.id)).toEqual([orderId]);
    // The victim's order is not visible to this buyer even by id.
    const foreign = await callFunction('my-orders', init, { shopSlug: S.slug, orderId: victimOrderId });
    expect(foreign.body!.orders).toEqual([]);
  });
});
