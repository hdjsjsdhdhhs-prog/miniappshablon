// Stage-2 security PoC: concurrency between admin_delete_* / stock changes and checkout. LOCAL ONLY.
// Deterministic interleavings: one transaction is held open in the local DB container (psqlAsync + pg_sleep) while
// the competing request runs over HTTP; readiness is detected through pg_stat_activity, not by timers alone.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, callFunction, checkoutBody, createOwner, createTestShop, initDataFor, newTelegramUserId, stockOf, type Db, type TestShop } from '../helpers';
import { cleanupSecurity, psqlAsync, sleep } from './sec-helpers';

let owner: { client: Db; userId: string };
let S: TestShop;

beforeAll(async () => {
  S = await createTestShop({ variants: [{ flavor: 'Mint', stock: 100 }] });
  owner = await createOwner(S.id);
});
afterAll(cleanupSecurity);

const asOwner = (sql: string) =>
  `begin;\nselect set_config('request.jwt.claims', '{"sub":"${owner.userId}","role":"authenticated"}', true);\nset local role authenticated;\n${sql}\ncommit;`;

async function waitForSleeper(marker: string, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await psqlAsync(`select count(*) from pg_stat_activity where query like '%${marker}%' and query not like '%pg_stat_activity%' and state = 'active';`);
    if (r.out === '1') return;
    await sleep(100);
  }
  throw new Error(`holder ${marker} did not start`);
}

async function newProduct(stock = 10) {
  const { data: p } = await admin.from('products').insert({ shop_id: S.id, category_id: S.categoryId, name: `P${randomUUID().slice(0, 4)}`, base_price_minor: 100, is_published: true }).select('id').single();
  const { data: v } = await admin.from('product_variants').insert({ shop_id: S.id, product_id: p!.id, flavor: 'x', stock_quantity: stock }).select('id').single();
  return { productId: p!.id, variantId: v!.id };
}

const buy = async (variantId: string, quantity = 1, tg = newTelegramUserId()) =>
  callFunction('checkout', await initDataFor(tg), checkoutBody(S, [{ variantId, quantity }]));

describe('admin_delete_product vs checkout', () => {
  it('delete holds the variant lock → a concurrent checkout waits and then gets item_unavailable (409), no 500, no order', async () => {
    const { productId, variantId } = await newProduct();
    const marker = `hold_${randomUUID().slice(0, 8)}`;
    const holder = psqlAsync(asOwner(`select public.admin_delete_product('${productId}');\nselect pg_sleep(2) /* ${marker} */;`));
    await waitForSleeper(marker);
    const t0 = Date.now();
    const res = await buy(variantId);
    const waited = Date.now() - t0;
    const h = await holder;
    expect(h.code, h.err).toBe(0);
    expect(waited).toBeGreaterThan(800);
    expect(res.status).toBe(409);
    expect((res.body!.error as { code: string }).code).toBe('item_unavailable');
    expect((await admin.from('products').select('id').eq('id', productId)).data).toEqual([]);
  });

  it('checkout holds the variant lock → a concurrent delete waits and then refuses with product_has_orders', async () => {
    const { productId, variantId } = await newProduct();
    const marker = `hold_${randomUUID().slice(0, 8)}`;
    const holder = psqlAsync(`begin;
      select public.create_order_v2('${S.slug}', ${newTelegramUserId()}, '{}'::jsonb, '[{"variant_id":"${variantId}","quantity":1}]'::jsonb,
        '${randomUUID()}', 'h', 'pickup', null, '', 'RUB', null);
      select pg_sleep(2) /* ${marker} */;
      commit;`);
    await waitForSleeper(marker);
    const del = await owner.client.rpc('admin_delete_product', { p_product_id: productId });
    const h = await holder;
    expect(h.code, h.err).toBe(0);
    expect(del.error?.message).toBe('product_has_orders');
    expect((await admin.from('products').select('id').eq('id', productId)).data).toHaveLength(1);
  });

  it('10 uncontrolled rounds of checkout ‖ delete: never a 500, never an order line without its product', async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { productId, variantId } = await newProduct();
      const [co, del] = await Promise.all([buy(variantId), owner.client.rpc('admin_delete_product', { p_product_id: productId })]);
      const productLeft = ((await admin.from('products').select('id').eq('id', productId)).data ?? []).length === 1;
      outcomes.push(`${co.status}/${del.error?.message ?? 'deleted'}`);
      expect(co.status).not.toBe(500);
      if (co.status === 201) expect(productLeft).toBe(true);
      if (!del.error) expect(co.status).not.toBe(201);
    }
    console.log('[race product]', outcomes.join(' '));
  });
});

describe('admin_delete_variant vs checkout / each other', () => {
  it('two parallel deletes of the last two variants: exactly one succeeds, the other gets last_variant', async () => {
    const { productId, variantId } = await newProduct();
    const { data: v2 } = await admin.from('product_variants').insert({ shop_id: S.id, product_id: productId, flavor: 'y', stock_quantity: 1 }).select('id').single();
    const res = await Promise.all([variantId, v2!.id].map((id) => owner.client.rpc('admin_delete_variant', { p_variant_id: id })));
    expect(res.map((r) => r.error?.message ?? 'ok').sort()).toEqual(['last_variant', 'ok']);
    expect((await admin.from('product_variants').select('id').eq('product_id', productId)).data).toHaveLength(1);
  });
});

describe('admin_delete_category (move) vs checkout', () => {
  it('checkout during an uncommitted category delete+move succeeds; product ends in the target category', async () => {
    const { data: from } = await admin.from('categories').insert({ shop_id: S.id, name: 'From', slug: `from-${randomUUID().slice(0, 6)}` }).select('id').single();
    const { data: p } = await admin.from('products').insert({ shop_id: S.id, category_id: from!.id, name: 'Moved', base_price_minor: 100, is_published: true }).select('id').single();
    const { data: v } = await admin.from('product_variants').insert({ shop_id: S.id, product_id: p!.id, flavor: 'x', stock_quantity: 5 }).select('id').single();
    const marker = `hold_${randomUUID().slice(0, 8)}`;
    const holder = psqlAsync(asOwner(`select public.admin_delete_category('${from!.id}', '${S.categoryId}');\nselect pg_sleep(2) /* ${marker} */;`));
    await waitForSleeper(marker);
    const res = await buy(v!.id);
    const h = await holder;
    expect(h.code, h.err).toBe(0);
    expect([201, 409]).toContain(res.status);
    console.log('[race category] checkout during delete+move:', res.status, JSON.stringify(res.body?.error ?? null));
    const { data: after } = await admin.from('products').select('category_id').eq('id', p!.id).single();
    expect(after!.category_id).toBe(S.categoryId);
    expect((await admin.from('categories').select('id').eq('id', from!.id)).data).toEqual([]);
  });
});

describe('stock under concurrency', () => {
  it('12 parallel buyers on stock 3: exactly 3 orders, 9 × insufficient_stock, no 500, stock 0', async () => {
    const { variantId } = await newProduct(3);
    const res = await Promise.all(Array.from({ length: 12 }, () => buy(variantId)));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(9);
    expect(await stockOf(variantId)).toBe(0);
  });

  it('[INFO] admin_set_variant_stock is absolute: a checkout committed just before it is silently overwritten', async () => {
    const { variantId } = await newProduct(10);
    const marker = `hold_${randomUUID().slice(0, 8)}`;
    // Owner opened the editor when stock was 10 and types 10 → 12 ("received 2 more"), while a buyer takes 3.
    const holder = psqlAsync(`begin;
      select public.create_order_v2('${S.slug}', ${newTelegramUserId()}, '{}'::jsonb, '[{"variant_id":"${variantId}","quantity":3}]'::jsonb,
        '${randomUUID()}', 'h', 'pickup', null, '', 'RUB', null);
      select pg_sleep(1.5) /* ${marker} */;
      commit;`);
    await waitForSleeper(marker);
    const set = await owner.client.rpc('admin_set_variant_stock', { p_variant_id: variantId, p_quantity: 12 });
    await holder;
    expect(set.error).toBeNull();
    expect(await stockOf(variantId)).toBe(12); // the 3 sold units are back on sale (ledger records +5, not +2)
  });

  it('cancel ‖ confirm on the same order serialize: final state is consistent with the journal', async () => {
    const { variantId } = await newProduct(10);
    const res = await buy(variantId, 2);
    const id = (res.body!.order as { id: string }).id;
    const r = await Promise.all([
      owner.client.rpc('admin_set_order_status', { p_order_id: id, p_status: 'cancelled' }),
      owner.client.rpc('admin_set_order_status', { p_order_id: id, p_status: 'confirmed' }),
    ]);
    const { data: o } = await admin.from('orders').select('status, stock_state').eq('id', id).single();
    const stock = await stockOf(variantId);
    console.log('[race status]', r.map((x) => x.error?.message ?? 'ok').join(','), o!.status, o!.stock_state, stock);
    if (o!.status === 'cancelled') expect([o!.stock_state, stock]).toEqual(['restored', 10]);
    else expect([o!.stock_state, stock]).toEqual(['deducted', 8]);
  });
});
