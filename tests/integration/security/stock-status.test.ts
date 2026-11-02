// Exact stock is visible only to the shop's own admins; buyers get a status (20261102090100). LOCAL ONLY.
// Every public path is checked: PostgREST rows / filters / ordering / embeds / RETURNING, GraphQL, RPCs, the checkout
// and my-orders JSON (success and insufficient_stock), and the probing guard. Roles: anon, a plain signed-in user,
// the owner of another shop, the owner / manager of the shop, platform admins at aal1 and aal2.
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
  env,
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

  it('stock_quantity cannot be read, filtered, ordered, embedded or returned through PostgREST by anyone but the service role', async () => {
    for (const [who, db] of [['anon', anon()], ['plain', plain], ['owner of another shop', ownerT], ['owner', ownerS], ['manager', managerS], ['aal2 platform admin', pa.client]] as const) {
      const attempts = {
        column: await db.from('product_variants').select('stock_quantity').in('id', ids()),
        star: await db.from('product_variants').select('*').in('id', ids()),
        filterEq: await db.from('product_variants').select('id').eq('stock_quantity', 3).in('id', ids()),
        filterGt: await db.from('product_variants').select('id').gt('stock_quantity', 1).in('id', ids()),
        order: await db.from('product_variants').select('id').in('id', ids()).order('stock_quantity' as never),
        embed: await db.from('products').select('id, product_variants(stock_quantity)').eq('id', S.productId),
        embedFilter: await db.from('products').select('id, product_variants!inner(id)').eq('id', S.productId).gt('product_variants.stock_quantity' as never, 2),
      };
      for (const [how, res] of Object.entries(attempts)) {
        expect(res.error?.message, `${who}: ${how}`).toMatch(/permission denied/i);
        expect(JSON.stringify(res.data ?? null), `${who}: ${how}`).not.toContain('stock_quantity');
      }
    }
  });

  it('a write cannot hand the number back either (RETURNING of an owner update)', async () => {
    const res = await ownerS.from('product_variants').update({ sku: 'SKU-1' }).eq('id', S.variants[1]!.id).select('*');
    expect(res.error?.message).toMatch(/permission denied/i);
    const ok = await ownerS.from('product_variants').update({ sku: 'SKU-1' }).eq('id', S.variants[1]!.id).select('id, sku, stock_status');
    expect(ok.error).toBeNull();
    // SKU stays visible as before.
    expect(ok.data).toEqual([{ id: S.variants[1]!.id, sku: 'SKU-1', stock_status: 'low_stock' }]);
  });

  it('GraphQL exposes no stock number (endpoint here; pg_graphql as enabled on hosted projects, rolled back)', async () => {
    const res = await fetch(`${env.url}/graphql/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}` },
      body: JSON.stringify({ query: '{ product_variantsCollection(first: 50) { edges { node { id stock_quantity } } } }' }),
    });
    expect(await res.text()).not.toMatch(/"stock_quantity"\s*:\s*\d/);
    // Hosted Supabase projects usually have pg_graphql enabled; locally it is not. Enable it inside a transaction that
    // is rolled back and ask as anon / authenticated: the column privileges hide the field and refuse the filter.
    const q = (gql: string) => `select graphql.resolve($gql$${gql}$gql$);`;
    const installedBefore = (await psqlAsync(`select count(*) from pg_extension where extname = 'pg_graphql';`)).out;
    const r = await psqlAsync(`begin;
      create extension if not exists pg_graphql;
      set local role anon;
      ${q(`{ product_variantsCollection(first: 5) { edges { node { id stock_status stock_quantity } } } }`)}
      ${q(`{ product_variantsCollection(first: 5, filter: { stock_quantity: { gt: 1 } }) { edges { node { id } } } }`)}
      ${q(`{ product_variantsCollection(first: 5, orderBy: [{ stock_quantity: AscNullsLast }]) { edges { node { id } } } }`)}
      ${q(`{ product_variantsCollection(first: 5, filter: { id: { eq: "${S.variants[2]!.id}" } }) { edges { node { id stock_status } } } }`)}
      reset role;
      set local role authenticated;
      ${q(`{ product_variantsCollection(first: 5) { edges { node { id stock_quantity } } } }`)}
      rollback;`);
    expect(r.code, r.err).toBe(0);
    const [field, filter, order, status, authField] = r.out.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { data: unknown; errors?: Array<{ message: string }> });
    for (const [how, x] of [['field', field], ['filter', filter], ['order', order], ['authenticated field', authField]] as const) {
      expect(x!.data, how).toBeNull();
      expect(x!.errors?.[0]?.message, how).toMatch(/stock_quantity/);
    }
    // The status itself is available through GraphQL as well.
    expect(status).toEqual({ data: { product_variantsCollection: { edges: [{ node: { id: S.variants[2]!.id, stock_status: 'low_stock' } }] } } });
    // Rolled back: the stack is left as it was.
    expect((await psqlAsync(`select count(*) from pg_extension where extname = 'pg_graphql';`)).out).toBe(installedBefore);
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
