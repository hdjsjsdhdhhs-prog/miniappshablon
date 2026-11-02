// Stock status projection, Expand step 3B (20261102090100). LOCAL ONLY.
// Expand: the frontend released before 3B (main, 741d478) and the new frontend must BOTH work on this schema, so the
// exact PostgREST queries of both are sent here with the real anon / authenticated roles. stock_quantity stays
// readable through PostgREST until the separate Contract step (3C, not part of this release).
// Privacy that 3B does add is checked as before: admin_variant_stock (members of that very shop only), the checkout
// and my-orders JSON (success and insufficient_stock) never carry the number, and the probing guard. Roles: anon, a
// plain signed-in user, the owner of another shop, the owner / manager of the shop, platform admins at aal1 and aal2.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admin,
  anon,
  callFunction,
  checkoutBody,
  createMember,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  initDataFor,
  newTelegramUserId,
  stockOf,
  track,
  type Db,
  type PlatformAdmin,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, psqlAsync } from './sec-helpers';

const errCode = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;
const errDetails = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { details?: unknown } | undefined)?.details;

let S: TestShop; // variants with stock 0, 1, 2, 3
let T: TestShop; // another shop
let ownerS: Db;
let managerS: Db;
let ownerT: Db;
let plain: Db;
let pa: PlatformAdmin;
let paAal1: PlatformAdmin;

beforeAll(async () => {
  S = await createTestShop({
    variants: [
      { flavor: 'Zero', stock: 0 },
      { flavor: 'One', stock: 1 },
      { flavor: 'Two', stock: 2 },
      { flavor: 'Three', stock: 3 },
    ],
  });
  T = await createTestShop({ variants: [{ flavor: 'Mint', stock: 7 }] });
  ownerS = (await createOwner(S.id)).client;
  managerS = (await createMember(S.id, 'manager')).client;
  ownerT = (await createOwner(T.id)).client;
  const email = `plain-${randomBytes(4).toString('hex')}@it.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  track('user', data.user.id);
  plain = anon();
  const { error: se } = await plain.auth.signInWithPassword({ email, password });
  if (se) throw se;
  pa = await createPlatformAdmin();
  paAal1 = await createPlatformAdmin({ mfa: false });
});
afterAll(cleanupSecurity);

const ids = () => S.variants.map((v) => v.id);
const byFlavor = (rows: Array<{ id: string; stock_status: string | null }>) =>
  Object.fromEntries(rows.map((r) => [S.variants.find((v) => v.id === r.id)!.flavor, r.stock_status]));

describe('public projection: status only', () => {
  it('boundaries 0 / 1 / 2 / 3 → out_of_stock / low_stock / low_stock / in_stock, for every reader', async () => {
    for (const [who, db] of [['anon', anon()], ['plain', plain], ['owner of another shop', ownerT], ['owner', ownerS]] as const) {
      const { data, error } = await db.from('product_variants').select('id, stock_status').in('id', ids());
      expect(error, who).toBeNull();
      expect(byFlavor(data!), who).toEqual({ Zero: 'out_of_stock', One: 'low_stock', Two: 'low_stock', Three: 'in_stock' });
    }
  });

  it('the status follows the stock (generated column)', async () => {
    const v = S.variants[3]!.id;
    for (const [qty, status] of [[0, 'out_of_stock'], [1, 'low_stock'], [2, 'low_stock'], [3, 'in_stock'], [50, 'in_stock']] as const) {
      expect((await ownerS.rpc('admin_set_variant_stock', { p_variant_id: v, p_quantity: qty })).error).toBeNull();
      const { data } = await anon().from('product_variants').select('stock_status').eq('id', v).single();
      expect(data!.stock_status, String(qty)).toBe(status);
    }
    expect((await ownerS.rpc('admin_set_variant_stock', { p_variant_id: v, p_quantity: 3 })).error).toBeNull();
  });

  it('Expand: anon / authenticated keep the table SELECT they had before 3B; no column-level narrowing (that is 3C)', async () => {
    const acl = await psqlAsync(`select relacl::text from pg_class where oid = 'public.product_variants'::regclass;`);
    expect(acl.code, acl.err).toBe(0);
    expect(acl.out).toContain('anon=r/postgres');
    expect(acl.out).toContain('authenticated=r/postgres');
    const cols = await psqlAsync(`select a.attname || ' ' || a.attacl::text from pg_attribute a
      where a.attrelid = 'public.product_variants'::regclass and a.attacl is not null
        and exists (select 1 from aclexplode(a.attacl) x where x.privilege_type = 'SELECT');`);
    expect(cols.code, cols.err).toBe(0);
    expect(cols.out, 'column-level SELECT grants would mean the Contract step was applied').toBe('');
  });

  it('GraphQL exposes stock_status (pg_graphql as enabled on hosted projects, rolled back)', async () => {
    // Hosted Supabase projects usually have pg_graphql enabled; locally it is not. Enable it inside a transaction that
    // is rolled back and ask as anon.
    const q = (gql: string) => `select graphql.resolve($gql$${gql}$gql$);`;
    const installedBefore = (await psqlAsync(`select count(*) from pg_extension where extname = 'pg_graphql';`)).out;
    const r = await psqlAsync(`begin;
      create extension if not exists pg_graphql;
      set local role anon;
      ${q(`{ product_variantsCollection(first: 5, filter: { id: { eq: "${S.variants[2]!.id}" } }) { edges { node { id stock_status } } } }`)}
      rollback;`);
    expect(r.code, r.err).toBe(0);
    const [status] = r.out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as unknown);
    expect(status).toEqual({ data: { product_variantsCollection: { edges: [{ node: { id: S.variants[2]!.id, stock_status: 'low_stock' } }] } } });
    // Rolled back: the stack is left as it was.
    expect((await psqlAsync(`select count(*) from pg_extension where extname = 'pg_graphql';`)).out).toBe(installedBefore);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Old and new frontend on the same (Expand) schema. Query strings are copied verbatim from the code.
// ---------------------------------------------------------------------------------------------------------------

/** main 741d478, src/features/storefront/api.ts: PRODUCT_COLUMNS / LIST_COLUMNS. */
const OLD_PRODUCT_COLUMNS =
  'id, name, base_price_minor, category_id, description, ' +
  'categories!inner(name, slug, is_active, archived_at), ' +
  'product_variants(id, flavor, color, stock_quantity, is_active, sort_order), ' +
  'product_images(id, storage_path, is_primary, sort_order, alt_text)';
const OLD_LIST_COLUMNS = `${OLD_PRODUCT_COLUMNS}, in_stock:product_variants!inner(id)`;
/** This branch, src/features/storefront/api.ts: PRODUCT_COLUMNS / LIST_COLUMNS. */
const NEW_PRODUCT_COLUMNS =
  'id, name, base_price_minor, category_id, description, ' +
  'categories!inner(name, slug, is_active, archived_at), ' +
  'product_variants(id, flavor, color, stock_status, is_active, sort_order), ' +
  'product_images(id, storage_path, is_primary, sort_order, alt_text)';
const NEW_LIST_COLUMNS = `${NEW_PRODUCT_COLUMNS}, in_stock:product_variants!inner(id)`;
/** This branch, src/features/admin/api.ts: VARIANT_COLUMNS. */
const NEW_ADMIN_VARIANT_COLUMNS =
  'id, shop_id, product_id, flavor, color, sku, price_override_minor, stock_status, is_active, sort_order, seed_key, created_at, updated_at';

/** publicProductsQuery() — identical in main 741d478 and this branch. */
const publicProductsQuery = (db: Db, shopId: string, columns: string) =>
  db
    .from('products')
    .select(columns)
    .eq('shop_id', shopId)
    .eq('is_published', true)
    .is('archived_at', null)
    .eq('categories.is_active', true)
    .is('categories.archived_at', null);

type Row = Record<string, unknown> & { id: string; product_variants: Array<Record<string, unknown> & { id: string }> };
const variantsBy = (row: Row, key: string) => Object.fromEntries(row.product_variants.map((v) => [v.id, v[key]]));

describe('Expand: the frontend before this release (main 741d478) keeps working', () => {
  let soldOut: TestShop; // a live shop whose only variant has stock 0
  beforeAll(async () => {
    soldOut = await createTestShop({ variants: [{ flavor: 'Gone', stock: 0 }] });
  });

  it('storefront listing as anon: the stock_quantity embed and the filter in_stock.stock_quantity > 0 (fetchProductsPage)', async () => {
    const listing = (shopId: string) =>
      publicProductsQuery(anon(), shopId, OLD_LIST_COLUMNS)
        .gt('in_stock.stock_quantity', 0)
        .eq('in_stock.is_active', true)
        .order('sort_order')
        .order('created_at')
        .order('id')
        .range(0, 19);
    const { data, error } = await listing(S.id);
    expect(error).toBeNull();
    const rows = data as unknown as Row[];
    expect(rows.map((r) => r.id)).toEqual([S.productId]);
    expect(variantsBy(rows[0]!, 'stock_quantity')).toEqual(Object.fromEntries(S.variants.map((v) => [v.id, v.stock])));
    // The filter really filters: a product with no variant in stock is not listed.
    const none = await listing(soldOut.id);
    expect(none.error).toBeNull();
    expect(none.data).toEqual([]);
  });

  it('product page as anon (fetchProduct) and as a signed-in buyer', async () => {
    for (const [who, db] of [['anon', anon()], ['plain', plain]] as const) {
      const { data, error } = await publicProductsQuery(db, S.id, OLD_PRODUCT_COLUMNS).eq('id', S.productId).maybeSingle();
      expect(error, who).toBeNull();
      expect(variantsBy(data as unknown as Row, 'stock_quantity'), who).toEqual(Object.fromEntries(S.variants.map((v) => [v.id, v.stock])));
    }
  });

  it('admin as owner and manager: select(*) of products / variants, insert and update RETURNING *, dashboard on stock_quantity = 0', async () => {
    const W = await createTestShop({ variants: [{ flavor: 'Five', stock: 5 }, { flavor: 'Empty', stock: 0 }] });
    const owner = (await createOwner(W.id)).client;
    const manager = (await createMember(W.id, 'manager')).client;
    // Exact stock / status per variant id; variants created below (stock 0) are added as they appear.
    const qty: Record<string, number> = { [W.variants[0]!.id]: 5, [W.variants[1]!.id]: 0 };
    const status: Record<string, string> = { [W.variants[0]!.id]: 'in_stock', [W.variants[1]!.id]: 'out_of_stock' };
    for (const [who, db] of [['owner', owner], ['manager', manager]] as const) {
      // fetchAdminProducts / fetchAdminProduct
      const list = await db.from('products').select('*, product_variants(*), product_images(*)').eq('shop_id', W.id).order('sort_order').order('created_at');
      expect(list.error, who).toBeNull();
      const rows = list.data as unknown as Row[];
      expect(rows.map((r) => r.id), who).toEqual([W.productId]);
      expect(variantsBy(rows[0]!, 'stock_quantity'), who).toEqual(qty);
      expect(variantsBy(rows[0]!, 'stock_status'), who).toEqual(status);
      const one = await db.from('products').select('*, product_variants(*), product_images(*)').eq('shop_id', W.id).eq('id', W.productId).maybeSingle();
      expect(one.error, who).toBeNull();
      expect(variantsBy(one.data as unknown as Row, 'stock_quantity'), who).toEqual(qty);
      // createVariant: insert … select('*').single()
      const created = await db
        .from('product_variants')
        .insert({ shop_id: W.id, product_id: W.productId, flavor: `New ${who}`, color: null, sku: null, is_active: true, price_override_minor: null })
        .select('*')
        .single();
      expect(created.error, who).toBeNull();
      expect(created.data).toMatchObject({ flavor: `New ${who}`, stock_quantity: 0, stock_status: 'out_of_stock' });
      qty[created.data!.id] = 0;
      status[created.data!.id] = 'out_of_stock';
      // updateVariant: update … select('*').single()
      const updated = await db.from('product_variants').update({ sku: `SKU-${who}` }).eq('id', W.variants[0]!.id).select('*').single();
      expect(updated.error, who).toBeNull();
      expect(updated.data).toMatchObject({ id: W.variants[0]!.id, sku: `SKU-${who}`, stock_quantity: 5 });
      // fetchDashboardStats: out of stock via stock_quantity = 0
      const out = await db
        .from('product_variants')
        .select('id, flavor, color, products!inner(id, name, archived_at)')
        .eq('shop_id', W.id)
        .eq('is_active', true)
        .eq('stock_quantity', 0)
        .is('products.archived_at', null)
        .limit(20);
      expect(out.error, who).toBeNull();
      expect((out.data ?? []).map((r) => r.id), who).toContain(W.variants[1]!.id);
      expect((out.data ?? []).map((r) => r.id), who).not.toContain(W.variants[0]!.id);
    }
    // Stock is still changed only through the journaled RPC, never by a direct column write.
    const direct = await owner.from('product_variants').update({ stock_quantity: 99 } as never).eq('id', W.variants[0]!.id).select('id');
    expect(direct.error?.message).toMatch(/permission denied/i);
    expect(await stockOf(W.variants[0]!.id)).toBe(5);
  });
});

describe('Expand: the new frontend works on the same schema', () => {
  it('storefront listing and product page as anon: stock_status embed and filter neq out_of_stock', async () => {
    const { data, error } = await publicProductsQuery(anon(), S.id, NEW_LIST_COLUMNS)
      .neq('in_stock.stock_status', 'out_of_stock')
      .eq('in_stock.is_active', true)
      .order('sort_order')
      .order('created_at')
      .order('id')
      .range(0, 19);
    expect(error).toBeNull();
    const rows = data as unknown as Row[];
    expect(rows.map((r) => r.id)).toEqual([S.productId]);
    expect(byFlavor(rows[0]!.product_variants as Array<{ id: string; stock_status: string }>)).toEqual({
      Zero: 'out_of_stock',
      One: 'low_stock',
      Two: 'low_stock',
      Three: 'in_stock',
    });
    // The new storefront requests no exact number.
    expect(JSON.stringify(rows)).not.toContain('stock_quantity');
    const page = await publicProductsQuery(anon(), S.id, NEW_PRODUCT_COLUMNS).eq('id', S.productId).maybeSingle();
    expect(page.error).toBeNull();
    expect(JSON.stringify(page.data)).not.toContain('stock_quantity');
  });

  it('admin as owner: explicit variant columns + exact stock from admin_variant_stock; dashboard on stock_status', async () => {
    const list = await ownerS.from('products').select(`*, product_variants(${NEW_ADMIN_VARIANT_COLUMNS}), product_images(*)`).eq('shop_id', S.id);
    expect(list.error).toBeNull();
    expect(JSON.stringify(list.data)).not.toContain('stock_quantity');
    const stock = await ownerS.rpc('admin_variant_stock', { p_shop_id: S.id });
    expect(stock.error).toBeNull();
    expect(Object.fromEntries(stock.data!.map((r) => [r.variant_id, r.stock_quantity]))).toEqual(Object.fromEntries(S.variants.map((v) => [v.id, v.stock])));
    const out = await ownerS
      .from('product_variants')
      .select('id, flavor, color, products!inner(id, name, archived_at)')
      .eq('shop_id', S.id)
      .eq('is_active', true)
      .eq('stock_status', 'out_of_stock')
      .is('products.archived_at', null)
      .limit(20);
    expect(out.error).toBeNull();
    expect((out.data ?? []).map((r) => r.id)).toEqual([S.variants[0]!.id]);
  });
});

describe('exact stock: admin_variant_stock, members of that very shop only', () => {
  const exact = async (db: Db, shopId: string) => {
    const r = await db.rpc('admin_variant_stock', { p_shop_id: shopId });
    if (r.error) return r.error.message;
    return Object.fromEntries((r.data ?? []).map((x) => [x.variant_id, x.stock_quantity]));
  };
  const expected = () => Object.fromEntries(S.variants.map((v) => [v.id, v.stock]));

  it('owner and manager of the shop get the exact integers', async () => {
    expect(await exact(ownerS, S.id)).toEqual(expected());
    expect(await exact(managerS, S.id)).toEqual(expected());
  });

  it('anon, a plain user and the owner of another shop do not', async () => {
    expect(await exact(anon(), S.id)).toMatch(/permission denied/i);
    expect(await exact(plain, S.id)).toBe('shop_not_found');
    expect(await exact(ownerT, S.id)).toBe('shop_not_found');
    // ... and the owner of S gets nothing of T.
    expect(await exact(ownerS, T.id)).toBe('shop_not_found');
  });

  it('a platform admin only at aal2', async () => {
    expect(await exact(paAal1.client, S.id)).toBe('shop_not_found');
    expect(await exact(pa.client, S.id)).toEqual(expected());
  });
});

describe('checkout and my-orders never carry the number', () => {
  it('a low-stock variant (1–2) can be bought; the success JSON has no stock field', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Two', stock: 2 }] });
    const buyer = newTelegramUserId();
    const res = await callFunction('checkout', await initDataFor(buyer), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 2 }]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/stock_quantity|"available"|remaining/);
    expect(await stockOf(shop.variants[0]!.id)).toBe(0);
    const mine = await callFunction('my-orders', await initDataFor(buyer), { shopSlug: shop.slug });
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toMatch(/stock_quantity|stock_status|"available"/);
  });

  it('insufficient_stock answers with the status only, never the remaining quantity', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'One', stock: 1 }, { flavor: 'Three', stock: 3 }, { flavor: 'Zero', stock: 0 }] });
    const [one, three, zero] = shop.variants;
    for (const [v, qty, status] of [[one!, 2, 'low_stock'], [three!, 4, 'in_stock'], [zero!, 1, 'out_of_stock']] as const) {
      const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: v.id, quantity: qty }]));
      expect(res.status).toBe(409);
      expect(errCode(res)).toBe('insufficient_stock');
      expect(errDetails(res)).toEqual([{ variant_id: v.id, stock_status: status }]);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/available|stock_quantity|requested|remaining/);
    }
    expect([await stockOf(one!.id), await stockOf(three!.id), await stockOf(zero!.id)]).toEqual([1, 3, 0]);
  });

  it('probing guard: after 5 refused quantities in an hour the buyer gets stock_check_limited before any attempt', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Three', stock: 3 }] });
    const v = shop.variants[0]!.id;
    const init = await initDataFor(newTelegramUserId());
    for (let i = 0; i < 5; i += 1) {
      const res = await callFunction('checkout', init, checkoutBody(shop, [{ variantId: v, quantity: 10 + i }]));
      expect(errCode(res), String(i)).toBe('insufficient_stock');
    }
    // A quantity that WOULD fit gets the same answer as one that would not: nothing to learn any more.
    for (const qty of [1, 50]) {
      const res = await callFunction('checkout', init, checkoutBody(shop, [{ variantId: v, quantity: qty }]));
      expect(res.status, String(qty)).toBe(429);
      expect(errCode(res)).toBe('stock_check_limited');
    }
    expect(await stockOf(v)).toBe(3);
    expect((await admin.from('orders').select('id').eq('shop_id', shop.id)).data).toEqual([]);
    // Another buyer is not affected.
    const other = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: v, quantity: 1 }]));
    expect(other.status, JSON.stringify(other.body)).toBe(201);
  });

  it('concurrent buyers of a low-stock variant: exactly the stock is sold, never negative', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Two', stock: 2 }] });
    const res = await Promise.all(
      Array.from({ length: 6 }, async () =>
        callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }])),
      ),
    );
    const summary = JSON.stringify(res.map((r) => [r.status, errCode(r) ?? 'ok']));
    expect(res.filter((r) => r.status === 201), summary).toHaveLength(2);
    expect(res.filter((r) => errCode(r) === 'insufficient_stock'), summary).toHaveLength(4);
    for (const r of res.filter((x) => x.status !== 201)) expect(errDetails(r)).toEqual([{ variant_id: shop.variants[0]!.id, stock_status: 'out_of_stock' }]);
    expect(await stockOf(shop.variants[0]!.id)).toBe(0);
  });
});
