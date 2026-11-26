// «Бонусы и промокоды» (20261125090000): bonus program, automatic discounts by order total and promo codes — end to end through
// the local Edge Runtime and PostgreSQL. LOCAL ONLY; every Telegram call goes to the local mock Bot API (global-setup refuses to
// run otherwise); only fake tokens. Covers: everything OFF by default (the shop behaves as before), the price rule and its
// rounding (the SQL against src/domain/loyalty.ts), accrual only on confirmation and only once, spending, refunds and
// reversals without a negative balance, concurrent spending and concurrent use of the last promo activation, promo code
// lifecycle (reserve → redeem → release), the buyer notification through the shop's own bot, and isolation between shops.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockFailNext, mockMessages } from '../../scripts/lib/telegram-mock.ts';
import { bonusFor, percentOf, priceBreakdown, type CartQuote } from '../../src/domain/loyalty.ts';
import { formatBonusMessage } from '../../supabase/functions/_shared/bonus-notification.ts';
import { admin, anon, callAdminFunction, callFunction, checkoutBody, createOwner, initDataFor, newTelegramUserId, stockOf, waitFor, type Db, type TestShop } from './helpers';
import { botIdOf, shopWithBot, sql, starter, type BotShop } from './security/bot-helpers';
import { cleanupSecurity, svcRpc } from './security/sec-helpers';

/**
 * A shop with its owner and a connected bot, with the per-buyer order limits (3 per 10 minutes, 3 open) of checkout raised: the
 * scenarios below place many orders for one buyer on purpose. The limits themselves are covered by checkout-limits.test.ts.
 */
async function newShop(opts: Parameters<typeof shopWithBot>[0] = {}): Promise<BotShop> {
  const s = await shopWithBot(opts);
  await sql(`insert into private.checkout_limits (shop_id, max_orders_per_10min, max_orders_per_day, max_open_orders) values ('${s.shop.id}', 500, 5000, 500);`);
  return s;
}

const PRICE = 100_000; // 1 000 ₽ per unit, so 3 units = 3 000 ₽
const spec = { basePrice: PRICE, variants: [{ flavor: 'A', stock: 5_000 }] };
const run = randomBytes(3).toString('hex');

type Json = Record<string, unknown>;
interface OrderJson {
  id: string;
  order_number: number;
  status: string;
  total_minor: number;
  items_total_minor?: number;
  discount_type?: string | null;
  discount_minor?: number;
  discount_info?: Json | null;
  bonus_spent?: number;
  bonus_accrued?: number;
}

// ---- helpers ------------------------------------------------------------------------------------------------------------

async function rows<T = Json>(query: string): Promise<T[]> {
  return JSON.parse(await sql(`select coalesce(json_agg(t), '[]'::json)::text from (${query}) t;`)) as T[];
}
const balanceOf = async (shop: TestShop, buyer: number) =>
  Number(await sql(`select coalesce((select balance from private.customer_bonus_accounts where shop_id = '${shop.id}' and customer_tg_id = ${buyer}), 0);`));
const ledgerOf = (shop: TestShop, buyer: number) =>
  rows<{ kind: string; amount: number; balance_after: number; order_id: string }>(
    `select kind, amount, balance_after, order_id from private.bonus_ledger where shop_id = '${shop.id}' and customer_tg_id = ${buyer} order by id`,
  );
const promoRow = async (shop: TestShop, code: string) =>
  (await rows<{ id: string; used_count: number; max_activations: number; is_active: boolean }>(
    `select id, used_count, max_activations, is_active from private.shop_promo_codes where shop_id = '${shop.id}' and code = '${code}'`,
  ))[0]!;
const redemptionOf = async (orderId: string) =>
  (await rows<{ status: string; code: string; discount_minor: number }>(`select status, code, discount_minor from private.promo_redemptions where order_id = '${orderId}'`))[0] ?? null;
const setPrice = async (shop: TestShop, minor: number) => {
  const { error } = await admin.from('product_variants').update({ price_override_minor: minor }).eq('id', shop.variants[0]!.id);
  if (error) throw error;
};

const L = (owner: { client: Db | null }, shop: TestShop, body: Json) => callAdminFunction('loyalty', owner.client, { shopId: shop.id, ...body });
const errorCode = (r: { body: Json | null }) => (r.body?.error as { code?: string } | undefined)?.code;
const detailsOf = (r: { body: Json | null }) => (r.body?.error as { details?: Json } | undefined)?.details;
const overviewOf = (r: { body: Json | null }) => r.body?.overview as {
  settings: { bonus_enabled: boolean; bonus_percent: number; discount_enabled: boolean; promo_enabled: boolean; configured: boolean };
  rules: Array<{ id: string; min_total_minor: number; percent: number }>;
  promos: Array<{ id: string; code: string; used_count: number; max_activations: number; status: string; pending_count: number; discount_type: string; percent: number | null; fixed_minor: number | null }>;
  stats: { customers: number; balance_total: number; earned_total: number; spent_total: number };
  recent: Array<{ amount: number; order_number: number }>;
};

async function settings(S: BotShop, patch: Json) {
  const r = await L(S.owner, S.shop, { action: 'save-settings', ...patch });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return overviewOf(r);
}
async function addRule(S: BotShop, minRub: number, percent: number) {
  const r = await L(S.owner, S.shop, { action: 'rule-save', minTotalMinor: minRub * 100, percent });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return overviewOf(r).rules;
}
async function addPromo(S: BotShop, code: string, type: 'percent' | 'fixed', value: number, max: number, extra: Json = {}) {
  return L(S.owner, S.shop, { action: 'promo-save', code, discountType: type, value, maxActivations: max, ...extra });
}

async function quote(shop: TestShop, buyer: number, qty: number, extra: Json = {}) {
  const r = await callFunction('cart-quote', await initDataFor(buyer), { shopSlug: shop.slug, items: [{ variantId: shop.variants[0]!.id, quantity: qty }], ...extra });
  return { status: r.status, q: r.body?.quote as CartQuote | undefined, body: r.body };
}
async function place(shop: TestShop, buyer: number, qty: number, extra: Json = {}) {
  const body = checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: qty }], extra);
  const r = await callFunction('checkout', await initDataFor(buyer), body);
  return { status: r.status, order: r.body?.order as OrderJson | undefined, code: errorCode(r), details: detailsOf(r), body: r.body, key: body.idempotencyKey as string };
}
async function ok(shop: TestShop, buyer: number, qty: number, extra: Json = {}) {
  const r = await place(shop, buyer, qty, extra);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.order!;
}
/**
 * An order created by create_order_v3 directly (service role), NOT through the `checkout` Edge Function. Checkout starts a
 * background shop-wide sweep for due «начислено» messages right after it answers, and that sweep may legitimately send a
 * message the moment an order is confirmed. A scenario that asserts what is (not) sent at an exact moment must therefore
 * not have a checkout in flight for its shop: this helper is the same order, minus that concurrent sender. The sweep itself
 * is covered, deterministically, by «checkout also retries the due messages of its own shop».
 */
async function placeQuiet(shop: TestShop, buyer: number, qty: number): Promise<OrderJson> {
  const r = await svcRpc('create_order_v3', {
    p_shop_slug: shop.slug,
    p_customer_tg_id: buyer,
    p_customer_snapshot: {},
    p_items: [{ variant_id: shop.variants[0]!.id, quantity: qty }],
    p_idempotency_key: randomUUID(),
    p_request_hash: `quiet-${randomUUID()}`,
    p_fulfillment_method: 'pickup',
    p_delivery_address: null,
    p_comment: '',
    p_expected_currency: 'RUB',
    p_expected_total_minor: null,
    p_promo_code: null,
    p_bonus_spend: 0,
  });
  expect(r.error, JSON.stringify(r.error)).toBeNull();
  return (r.data as { order: OrderJson }).order;
}
const setStatus = (S: BotShop, orderId: string, status: string) => S.owner.client.rpc('admin_set_order_status', { p_order_id: orderId, p_status: status });
async function confirm(S: BotShop, orderId: string) {
  const r = await setStatus(S, orderId, 'confirmed');
  expect(r.error, JSON.stringify(r.error)).toBeNull();
  return r.data as unknown as OrderJson;
}
const profile = async (shop: TestShop, buyer: number) => {
  const r = await callFunction('my-orders', await initDataFor(buyer), { shopSlug: shop.slug });
  expect(r.status).toBe(200);
  return r.body as { loyalty: null | { enabled: boolean; balance: number; earned_total: number; spent_total: number; history: Array<{ kind: string; amount: number; order_number: number; balance_after: number }> }; orders: OrderJson[] };
};
const bonusMessages = async (buyer: number) => (await mockMessages(String(buyer))).filter((m) => m.text.includes('Отличные новости'));
const dispatch = (S: BotShop) => L(S.owner, S.shop, { action: 'dispatch' });
const outbox = async (orderId: string) =>
  (await rows<{ status: string; attempts: number; amount: number; bot_id: number; chat_id: number; last_error: string | null }>(
    `select status, attempts, amount, bot_id, chat_id, last_error from private.bonus_notifications where order_id = '${orderId}'`,
  ))[0] ?? null;

let S: BotShop; // main shop (bot connected, owner)
let T: BotShop; // a second shop: isolation

beforeAll(async () => {
  S = await newShop({ shop: spec });
  T = await newShop({ shop: spec });
});
afterAll(cleanupSecurity);

// ---- 1. Everything is OFF by default --------------------------------------------------------------------------------------

describe('off by default: a shop that never opens «Бонусы и промокоды» works exactly as before', () => {
  it('the admin overview is empty and every switch is off', async () => {
    const r = await L(S.owner, S.shop, { action: 'get' });
    expect(r.status).toBe(200);
    const o = overviewOf(r);
    expect(o.settings).toMatchObject({ bonus_enabled: false, discount_enabled: false, promo_enabled: false, configured: false });
    expect(o.rules).toEqual([]);
    expect(o.promos).toEqual([]);
    expect(o.stats).toMatchObject({ customers: 0, balance_total: 0 });
  });

  it('the cart quote reports no features and the total is the plain sum; checkout stores no breakdown; confirmation credits nothing', async () => {
    const buyer = await starter(S.token);
    const quoted = await quote(S.shop, buyer, 3);
    expect(quoted.status).toBe(200);
    expect(quoted.q).toMatchObject({ features: { bonus: false, discount: false, promo: false }, subtotal_minor: 300_000, total_minor: 300_000, threshold: null, promo: null });
    expect(quoted.q!.discount).toMatchObject({ type: null, minor: 0 });

    const order = await ok(S.shop, buyer, 3, { expectedTotalMinor: 300_000 });
    expect(order.total_minor).toBe(300_000);
    // The order JSON is exactly what it always was: no loyalty keys.
    for (const key of ['items_total_minor', 'discount_type', 'discount_minor', 'bonus_spent', 'bonus_accrued']) expect(order, key).not.toHaveProperty(key);
    const row = (await admin.from('orders').select('items_total_minor, discount_minor, bonus_spent, bonus_accrued, total_minor').eq('id', order.id).single()).data!;
    expect(row).toEqual({ items_total_minor: null, discount_minor: 0, bonus_spent: 0, bonus_accrued: null, total_minor: 300_000 });

    const confirmed = await confirm(S, order.id);
    expect(confirmed).not.toHaveProperty('bonus_accrued');
    expect(await ledgerOf(S.shop, buyer)).toEqual([]);
    expect(await balanceOf(S.shop, buyer)).toBe(0);
    expect((await profile(S.shop, buyer)).loyalty).toBeNull();
    expect(await outbox(order.id)).toBeNull();
  });

  it('a promo code or bonuses sent to a shop that has the features off are refused, not silently ignored', async () => {
    const buyer = newTelegramUserId();
    const code = await place(S.shop, buyer, 1, { promoCode: 'ANYCODE' });
    expect([code.status, code.code, code.details]).toEqual([409, 'promo_invalid', { reason: 'disabled' }]);
    const bonus = await place(S.shop, buyer, 1, { bonusSpend: 10 });
    expect([bonus.status, bonus.code]).toEqual([409, 'bonus_unavailable']);
    // Both refusals rolled the whole order back (stock included).
    expect(await rows(`select 1 from orders where shop_id = '${S.shop.id}' and customer_tg_id = ${buyer}`)).toEqual([]);
  });
});

// ---- 2. Settings and access ----------------------------------------------------------------------------------------------

describe('settings: validation, persistence and access', () => {
  it('rejects a percent outside (0, 100] or with more than two decimals; stores a valid one; each switch is independent', async () => {
    for (const bad of [0, -5, 100.01, 101, 2.555]) {
      const r = await L(S.owner, S.shop, { action: 'save-settings', bonusPercent: bad });
      expect([r.status, errorCode(r)], String(bad)).toEqual([400, expect.stringMatching(/^(invalid_percent|invalid_body)$/)]);
    }
    const o = await settings(S, { bonusEnabled: true, bonusPercent: 5 });
    expect(o.settings).toMatchObject({ bonus_enabled: true, bonus_percent: 5, discount_enabled: false, promo_enabled: false, configured: true });
    expect((await settings(S, { bonusPercent: 7.5 })).settings).toMatchObject({ bonus_enabled: true, bonus_percent: 7.5 });
    expect((await settings(S, { bonusPercent: 5 })).settings).toMatchObject({ bonus_percent: 5 });
    expect((await settings(S, { discountEnabled: true })).settings).toMatchObject({ bonus_enabled: true, bonus_percent: 5, discount_enabled: true, promo_enabled: false });
    expect((await settings(S, { discountEnabled: false })).settings.discount_enabled).toBe(false);
  });

  it('only the owner of THAT shop may read or change it; no token, a stranger and the other shop’s owner are refused', async () => {
    const stranger = await createOwner(T.shop.id);
    expect((await L({ client: null }, S.shop, { action: 'get' })).status).toBe(401);
    const forbidden = await L({ client: stranger.client }, S.shop, { action: 'get' });
    expect([forbidden.status, errorCode(forbidden)]).toEqual([403, 'forbidden']);
    expect(errorCode(await L({ client: stranger.client }, S.shop, { action: 'save-settings', bonusEnabled: false }))).toBe('forbidden');
    expect(errorCode(await L({ client: stranger.client }, S.shop, { action: 'dispatch' }))).toBe('forbidden');
    // T's owner changed nothing in S.
    expect(overviewOf(await L(S.owner, S.shop, { action: 'get' })).settings.bonus_enabled).toBe(true);
  });

  it('the database functions cannot be called by anon or by an authenticated owner directly', async () => {
    const args = { p_shop_slug: S.shop.slug, p_customer_tg_id: 7, p_items: [{ variant_id: S.shop.variants[0]!.id, quantity: 1 }], p_promo_code: null, p_bonus_spend: 0 };
    for (const client of [anon(), S.owner.client]) {
      expect((await client.rpc('loyalty_quote' as never, args as never)).error?.message).toMatch(/permission denied/i);
      expect((await client.rpc('loyalty_get_overview' as never, { p_shop_id: S.shop.id, p_actor: S.owner.userId } as never)).error?.message).toMatch(/permission denied/i);
      expect((await client.rpc('bonus_notify_claim' as never, { p_actor: null, p_shop_id: S.shop.id, p_order_id: null, p_limit: 5 } as never)).error?.message).toMatch(/permission denied/i);
    }
    // The tables live in schema private: not reachable through the Data API at all.
    expect((await anon().from('bonus_ledger' as never).select('*')).error).not.toBeNull();
    expect((await S.owner.client.from('customer_bonus_accounts' as never).select('*')).error).not.toBeNull();
  });
});

// ---- 3. The price rule: SQL against src/domain/loyalty.ts -----------------------------------------------------------------

describe('the price rule: same numbers on the server and in the interface', () => {
  it('rounding and thresholds: the quote of the server equals priceBreakdown() for boundary totals', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', discountEnabled: true, bonusEnabled: true, bonusPercent: 5 });
    const rules = [
      { min_total_minor: 300_000, percent: 5 },
      { min_total_minor: 500_000, percent: 7 },
      { min_total_minor: 1_000_000, percent: 10 },
    ];
    for (const r of rules) await addRule(X, r.min_total_minor / 100, r.percent);
    const buyer = newTelegramUserId();
    // Unit prices chosen so that 3 × unit is just below / exactly on / just above the 3 000 ₽ threshold, and a few more.
    for (const [unit, qty] of [
      [99_999, 3], // 2 999.97 ₽ — below
      [100_000, 3], // 3 000 ₽ — exactly
      [100_001, 3], // just above
      [166_667, 3], // 5 000.01 ₽ — 7 %
      [33_333, 15], // 4 999.95 ₽ — 5 %
      [123_457, 9], // 11 111.13 ₽ — 10 %, odd kopecks
    ] as const) {
      await setPrice(X.shop, unit);
      const { q } = await quote(X.shop, buyer, qty);
      const mirror = priceBreakdown({ subtotalMinor: unit * qty, rules, bonusPercent: 5 });
      expect(q!.subtotal_minor, `${unit}×${qty}`).toBe(unit * qty);
      expect(q!.discount.minor, `${unit}×${qty}`).toBe(mirror.discountMinor);
      expect(q!.discount.type, `${unit}×${qty}`).toBe(mirror.discountType);
      expect(q!.total_minor, `${unit}×${qty}`).toBe(mirror.totalMinor);
      expect(q!.accrual_preview, `${unit}×${qty}`).toBe(mirror.bonusEarned);
    }
    // And the plain functions agree with the SQL helpers for awkward values.
    for (const [minor, percent] of [[99_999, 5], [1_999, 5], [333_300, 7.77], [10_000_000, 0.07], [100_000, 2.5], [1, 100]] as const) {
      const [row] = await rows<{ b: string; p: string }>(`select private.bonus_for(${minor}, ${percent})::text as b, private.percent_of(${minor}, ${Math.trunc(percent)})::text as p`);
      expect(Number(row!.b), `${minor} @ ${percent}%`).toBe(bonusFor(minor, percent));
      expect(Number(row!.p), `${minor} @ ${Math.trunc(percent)}%`).toBe(percentOf(minor, Math.trunc(percent)));
    }
  });

  it('a product discount price (stage 4B) is already inside the items total: the threshold sees the discounted sum and nothing is applied twice', async () => {
    const X = await newShop({ shop: { basePrice: 120_000, variants: [{ flavor: 'A', stock: 100 }] } });
    await L(X.owner, X.shop, { action: 'save-settings', discountEnabled: true });
    await addRule(X, 3_000, 5);
    const buyer = newTelegramUserId();
    // 3 × 1 200 ₽ = 3 600 ₽ at the list price → over 3 000 ₽; discounted to 900 ₽ each = 2 700 ₽ → below the threshold.
    expect((await quote(X.shop, buyer, 3)).q).toMatchObject({ subtotal_minor: 360_000, discount: { type: 'threshold', minor: 18_000 } });
    const { error } = await admin.from('products').update({ discount_price_minor: 90_000 }).eq('id', X.shop.productId);
    expect(error).toBeNull();
    const below = (await quote(X.shop, buyer, 3)).q!;
    expect(below).toMatchObject({ subtotal_minor: 270_000, total_minor: 270_000, threshold: null });
    expect(below.next_threshold).toMatchObject({ min_total_minor: 300_000, percent: 5, remaining_minor: 30_000 });
    // 4 × 900 ₽ = 3 600 ₽ discounted → 5 % of the DISCOUNTED sum.
    const over = (await quote(X.shop, buyer, 4)).q!;
    expect(over).toMatchObject({ subtotal_minor: 360_000, discount: { type: 'threshold', minor: 18_000 }, total_minor: 342_000 });
    const order = await ok(X.shop, buyer, 4, { expectedTotalMinor: 342_000 });
    expect(order).toMatchObject({ items_total_minor: 360_000, discount_type: 'threshold', discount_minor: 18_000, total_minor: 342_000, bonus_spent: 0 });
    expect(order.discount_info).toEqual({ percent: 5, min_total_minor: 300_000 });
    // The lines keep the product discount (price and list price); the order-level discount is a separate, visible line item.
    const [line] = await rows<{ unit_price_minor: number; original_unit_price_minor: number }>(`select unit_price_minor, original_unit_price_minor from order_items where order_id = '${order.id}'`);
    expect(line).toEqual({ unit_price_minor: 90_000, original_unit_price_minor: 120_000 });
  });

  it('the client can not dictate an amount: a wrong expected total is refused, extra fields are ignored, the order is rolled back', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', discountEnabled: true });
    await addRule(X, 3_000, 5);
    const buyer = newTelegramUserId();
    const stock = await stockOf(X.shop.variants[0]!.id);
    const wrong = await place(X.shop, buyer, 3, { expectedTotalMinor: 300_000 });
    expect([wrong.status, wrong.code]).toEqual([409, 'price_changed']);
    expect(wrong.details).toMatchObject({ total_minor: 285_000 });
    expect(await stockOf(X.shop.variants[0]!.id)).toBe(stock);
    expect(await rows(`select 1 from orders where shop_id = '${X.shop.id}' and customer_tg_id = ${buyer}`)).toEqual([]);
    const forged = await ok(X.shop, buyer, 3, { expectedTotalMinor: 285_000, discountMinor: 299_999, totalMinor: 1, discount: { type: 'promo' }, shopId: T.shop.id, bonusAccrued: 9_999 });
    expect(forged).toMatchObject({ total_minor: 285_000, discount_minor: 15_000, discount_type: 'threshold' });
    expect(forged).not.toHaveProperty('bonus_accrued');
  });
});

// ---- 4. Bonus program ----------------------------------------------------------------------------------------------------

describe('bonus program: accrual only after the administrator confirms the order', () => {
  it('3 000 ₽ at 5 % → 150 bonuses after confirmation; nothing before; the second confirmation / status changes add nothing', async () => {
    const buyer = await starter(S.token);
    await settings(S, { bonusEnabled: true, bonusPercent: 5 });
    const order = await ok(S.shop, buyer, 3);
    // Not at checkout, not in the cart, not while the order is new.
    expect(await balanceOf(S.shop, buyer)).toBe(0);
    expect(await ledgerOf(S.shop, buyer)).toEqual([]);
    expect((await profile(S.shop, buyer)).loyalty).toMatchObject({ enabled: true, balance: 0, history: [] });

    const confirmed = await confirm(S, order.id);
    expect(confirmed.bonus_accrued).toBe(150);
    expect(await balanceOf(S.shop, buyer)).toBe(150);
    expect(await ledgerOf(S.shop, buyer)).toEqual([{ kind: 'accrual', amount: 150, balance_after: 150, order_id: order.id }]);

    // Same status again, then the later statuses: still one accrual.
    expect((await setStatus(S, order.id, 'confirmed')).error).toBeNull();
    expect((await setStatus(S, order.id, 'ready')).error).toBeNull();
    expect((await setStatus(S, order.id, 'completed')).error).toBeNull();
    expect(await balanceOf(S.shop, buyer)).toBe(150);
    expect(await ledgerOf(S.shop, buyer)).toHaveLength(1);
    // Even the internal hook run again (a replayed confirmation) is a no-op: the ledger operation key is unique.
    await sql(`select private.loyalty_on_confirm(o) from public.orders o where o.id = '${order.id}';`);
    expect(await balanceOf(S.shop, buyer)).toBe(150);
    expect(await ledgerOf(S.shop, buyer)).toHaveLength(1);

    const p = await profile(S.shop, buyer);
    expect(p.loyalty).toMatchObject({ balance: 150, earned_total: 150, spent_total: 0 });
    expect(p.loyalty!.history).toEqual([expect.objectContaining({ kind: 'accrual', amount: 150, order_number: order.order_number, balance_after: 150 })]);
    expect(p.orders[0]).toMatchObject({ bonus_accrued: 150, status: 'completed' });
  });

  it('whole bonuses only: 999.99 ₽ at 5 % → 49, never rounded up; a change of the percent applies to the next confirmation', async () => {
    const X = await newShop({ shop: { basePrice: 99_999, variants: [{ flavor: 'A', stock: 100 }] } });
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: true, bonusPercent: 5 });
    const buyer = newTelegramUserId();
    const a = await ok(X.shop, buyer, 1);
    const b = await ok(X.shop, buyer, 1);
    expect((await confirm(X, a.id)).bonus_accrued).toBe(49);
    await L(X.owner, X.shop, { action: 'save-settings', bonusPercent: 10 });
    expect((await confirm(X, b.id)).bonus_accrued).toBe(99); // 99.999 → 99
    expect(await balanceOf(X.shop, buyer)).toBe(148);
  });

  it('no accrual when the program is off at confirmation, and none for an order that was not confirmed', async () => {
    const X = await newShop({ shop: spec });
    const buyer = newTelegramUserId();
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: true, bonusPercent: 5 });
    const a = await ok(X.shop, buyer, 3);
    const b = await ok(X.shop, buyer, 3);
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: false });
    expect(await confirm(X, a.id)).not.toHaveProperty('bonus_accrued');
    expect(await balanceOf(X.shop, buyer)).toBe(0);
    // Cancelled before confirmation: nothing now and nothing later.
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: true });
    expect((await setStatus(X, b.id, 'cancelled')).error).toBeNull();
    expect(await ledgerOf(X.shop, buyer)).toEqual([]);
    // The program being on again does not credit the order that was confirmed while it was off.
    expect((await setStatus(X, a.id, 'ready')).error).toBeNull();
    expect(await ledgerOf(X.shop, buyer)).toEqual([]);
  });

  it('the profile shows the balance and the history; a buyer who has nothing and a shop without a program show nothing', async () => {
    const buyer = await starter(S.token);
    expect((await profile(S.shop, buyer)).loyalty).toMatchObject({ enabled: true, balance: 0, earned_total: 0, history: [] });
    const Y = await newShop({ shop: spec });
    expect((await profile(Y.shop, buyer)).loyalty).toBeNull();
  });
});

describe('spending bonuses on the next order', () => {
  async function buyerWithBalance(shop: BotShop, bonuses: number): Promise<number> {
    const buyer = await starter(shop.token);
    // `bonuses` come from a real confirmed order: bonuses/5 % … at 5 % one unit of 1 000 ₽ gives 50.
    let left = bonuses;
    while (left > 0) {
      const units = Math.min(Math.ceil(left / 50), 20);
      const o = await ok(shop.shop, buyer, units);
      const got = (await confirm(shop, o.id)).bonus_accrued ?? 0;
      left -= got;
    }
    return buyer;
  }

  it('the quote clamps to the balance and to the cost of the order; checkout takes the bonuses off the total atomically', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: true, bonusPercent: 5 });
    const buyer = await buyerWithBalance(X, 150);
    expect(await balanceOf(X.shop, buyer)).toBe(150);

    const q = (await quote(X.shop, buyer, 1, { bonusSpend: 999 })).q!;
    expect(q.bonus).toMatchObject({ enabled: true, balance: 150, requested: 999, applied: 150, max_spend: 150, spend_minor: 15_000 });
    expect(q.total_minor).toBe(85_000);
    // A cheap order can not take more than it costs: 1 000 ₽ order, 150 bonuses = 150 ₽, fine; a 100 ₽ order caps at 100.
    await setPrice(X.shop, 10_000);
    const cheap = (await quote(X.shop, buyer, 1, { bonusSpend: 150 })).q!;
    expect(cheap.bonus).toMatchObject({ applied: 100, max_spend: 100 });
    expect(cheap.total_minor).toBe(0);
    await setPrice(X.shop, PRICE);

    const order = await ok(X.shop, buyer, 1, { bonusSpend: 100, expectedTotalMinor: 90_000 });
    expect(order).toMatchObject({ items_total_minor: 100_000, discount_minor: 0, bonus_spent: 100, total_minor: 90_000 });
    expect(await balanceOf(X.shop, buyer)).toBe(50);
    const ledger = await ledgerOf(X.shop, buyer);
    expect(ledger.at(-1)).toEqual({ kind: 'spend', amount: -100, balance_after: 50, order_id: order.id });
    // The bonuses are not credited for the part paid with bonuses: 900 ₽ paid at 5 % → 45.
    expect((await confirm(X, order.id)).bonus_accrued).toBe(45);
    expect(await balanceOf(X.shop, buyer)).toBe(95);
    const p = (await profile(X.shop, buyer)).loyalty!;
    expect(p).toMatchObject({ balance: 95, earned_total: 195, spent_total: 100 });
    expect(p.history.map((h) => [h.kind, h.amount])).toEqual([['accrual', 45], ['spend', -100], ['accrual', 150]]);
  });

  it('can not spend more than the balance or more than the order costs, and never goes negative', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: true, bonusPercent: 5 });
    const buyer = await buyerWithBalance(X, 50);
    const tooMuch = await place(X.shop, buyer, 1, { bonusSpend: 51 });
    expect([tooMuch.status, tooMuch.code, tooMuch.details]).toEqual([409, 'insufficient_bonus', { balance: 50 }]);
    await setPrice(X.shop, 1_000);
    const exceeds = await place(X.shop, buyer, 1, { bonusSpend: 50 }); // the order costs 10 ₽, 50 bonuses are 50 ₽
    expect([exceeds.status, exceeds.code, exceeds.details]).toEqual([409, 'bonus_exceeds_order', { max_spend: 10 }]);
    expect(await balanceOf(X.shop, buyer)).toBe(50);
    const bad = await place(X.shop, buyer, 1, { bonusSpend: -1 });
    expect(bad.status).toBe(400);
    // The database refuses a negative balance on its own as well.
    const direct = await sql(`update private.customer_bonus_accounts set balance = -1 where shop_id = '${X.shop.id}' and customer_tg_id = ${buyer};`).catch((e: Error) => e.message);
    expect(String(direct)).toMatch(/violates check constraint/);
  });

  it('two orders placed at the same moment can not spend the same bonuses', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: true, bonusPercent: 5 });
    const buyer = await buyerWithBalance(X, 100);
    expect(await balanceOf(X.shop, buyer)).toBe(100);
    const results = await Promise.all([place(X.shop, buyer, 1, { bonusSpend: 100 }), place(X.shop, buyer, 1, { bonusSpend: 100 }), place(X.shop, buyer, 1, { bonusSpend: 100 })]);
    const won = results.filter((r) => r.status === 201);
    expect(won).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect([r.status, r.code]).toEqual([409, 'insufficient_bonus']);
    expect(await balanceOf(X.shop, buyer)).toBe(0);
    expect((await ledgerOf(X.shop, buyer)).filter((l) => l.kind === 'spend')).toHaveLength(1);
    // The losers left no order and no reserved stock behind.
    expect(await rows(`select 1 from orders where shop_id = '${X.shop.id}' and customer_tg_id = ${buyer} and bonus_spent > 0`)).toHaveLength(1);
  });

  it('cancelling gives the spent bonuses back (also for an order never confirmed) and takes the accrued ones back without a negative balance', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', bonusEnabled: true, bonusPercent: 5 });
    const buyer = await buyerWithBalance(X, 100);
    const before = await balanceOf(X.shop, buyer);

    // (a) spent on an order that is cancelled while new → refund.
    const a = await ok(X.shop, buyer, 1, { bonusSpend: 100 });
    expect(await balanceOf(X.shop, buyer)).toBe(before - 100);
    expect((await setStatus(X, a.id, 'cancelled')).error).toBeNull();
    expect(await balanceOf(X.shop, buyer)).toBe(before);
    // Cancelling again (or any replay) does not refund twice.
    expect((await setStatus(X, a.id, 'cancelled')).error).toBeNull();
    await sql(`select private.loyalty_on_cancel(o) from public.orders o where o.id = '${a.id}';`);
    expect(await balanceOf(X.shop, buyer)).toBe(before);
    expect((await ledgerOf(X.shop, buyer)).filter((l) => l.kind === 'spend_refund')).toHaveLength(1);

    // (b) confirmed (accrual 50) and cancelled → the 50 are taken back.
    const b = await ok(X.shop, buyer, 1);
    expect((await confirm(X, b.id)).bonus_accrued).toBe(50);
    expect(await balanceOf(X.shop, buyer)).toBe(before + 50);
    expect((await setStatus(X, b.id, 'cancelled')).error).toBeNull();
    expect(await balanceOf(X.shop, buyer)).toBe(before);

    // (c) the accrued bonuses were already spent: the reversal takes only what is left, the balance stays ≥ 0.
    const c = await ok(X.shop, buyer, 1);
    expect((await confirm(X, c.id)).bonus_accrued).toBe(50);
    const bal = await balanceOf(X.shop, buyer);
    const spend = await ok(X.shop, buyer, 2, { bonusSpend: bal - 20 }); // leaves 20 on the balance
    expect(await balanceOf(X.shop, buyer)).toBe(20);
    expect((await setStatus(X, c.id, 'cancelled')).error).toBeNull();
    expect(await balanceOf(X.shop, buyer)).toBe(0);
    expect((await ledgerOf(X.shop, buyer)).find((l) => l.kind === 'accrual_reversal' && l.order_id === c.id)).toMatchObject({ amount: -20, balance_after: 0 });
    expect(spend.bonus_spent).toBe(bal - 20);
    for (const l of await ledgerOf(X.shop, buyer)) expect(l.balance_after).toBeGreaterThanOrEqual(0);
  });
});

// ---- 5. Automatic discounts ----------------------------------------------------------------------------------------------

describe('automatic discounts by order total', () => {
  it('the rules are managed by the owner: add, edit, delete, uniqueness, limits, and the switch', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', discountEnabled: true });
    await addRule(X, 3_000, 5);
    const rules = await addRule(X, 5_000, 7);
    expect(rules.map((r) => [r.min_total_minor, r.percent])).toEqual([[300_000, 5], [500_000, 7]]);
    const dup = await L(X.owner, X.shop, { action: 'rule-save', minTotalMinor: 300_000, percent: 9 });
    expect([dup.status, errorCode(dup)]).toEqual([409, 'rule_exists']);
    for (const bad of [{ minTotalMinor: 0, percent: 5 }, { minTotalMinor: 100, percent: 0 }, { minTotalMinor: 100, percent: 91 }]) {
      expect((await L(X.owner, X.shop, { action: 'rule-save', ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    const edited = await L(X.owner, X.shop, { action: 'rule-save', ruleId: rules[0]!.id, minTotalMinor: 250_000, percent: 6 });
    expect(overviewOf(edited).rules.map((r) => [r.min_total_minor, r.percent])).toEqual([[250_000, 6], [500_000, 7]]);
    expect((await quote(X.shop, newTelegramUserId(), 3)).q!.discount).toMatchObject({ type: 'threshold', minor: 18_000 });
    const removed = await L(X.owner, X.shop, { action: 'rule-delete', ruleId: rules[1]!.id });
    expect(overviewOf(removed).rules).toHaveLength(1);
    expect(errorCode(await L(X.owner, X.shop, { action: 'rule-delete', ruleId: rules[1]!.id }))).toBe('rule_not_found');
    // Switch off: nothing applies any more, the rules are kept.
    await L(X.owner, X.shop, { action: 'save-settings', discountEnabled: false });
    const off = (await quote(X.shop, newTelegramUserId(), 3)).q!;
    expect(off.features.discount).toBe(false);
    expect(off.discount.minor).toBe(0);
    expect(overviewOf(await L(X.owner, X.shop, { action: 'get' })).rules).toHaveLength(1);
  });

  it('the best level is applied and levels never add up; the hint tells how much is missing for the next one', async () => {
    const X = await newShop({ shop: spec });
    await L(X.owner, X.shop, { action: 'save-settings', discountEnabled: true });
    for (const [min, pct] of [[3_000, 5], [5_000, 7], [10_000, 10]] as const) await addRule(X, min, pct);
    const buyer = newTelegramUserId();
    const q2 = (await quote(X.shop, buyer, 2)).q!;
    expect(q2.threshold).toBeNull();
    expect(q2.next_threshold).toEqual({ percent: 5, min_total_minor: 300_000, remaining_minor: 100_000 });
    const q3 = (await quote(X.shop, buyer, 3)).q!;
    expect(q3.threshold).toEqual({ percent: 5, min_total_minor: 300_000, discount_minor: 15_000 });
    expect(q3.next_threshold).toEqual({ percent: 7, min_total_minor: 500_000, remaining_minor: 200_000 });
    expect((await quote(X.shop, buyer, 5)).q!.discount.minor).toBe(35_000);
    const q10 = (await quote(X.shop, buyer, 10)).q!;
    expect([q10.discount.minor, q10.total_minor, q10.next_threshold]).toEqual([100_000, 900_000, null]);
    const order = await ok(X.shop, buyer, 10, { expectedTotalMinor: 900_000 });
    expect(order).toMatchObject({ discount_type: 'threshold', discount_minor: 100_000, total_minor: 900_000 });
    expect(order.discount_info).toEqual({ percent: 10, min_total_minor: 1_000_000 });
  });
});

// ---- 6. Promo codes ------------------------------------------------------------------------------------------------------

describe('promo codes: create, normalise, apply, reserve, redeem, release', () => {
  it('creates a percent and a fixed code, normalises the case, keeps a code unique inside ONE shop only', async () => {
    const X = await newShop({ shop: spec });
    const Y = await newShop({ shop: spec });
    const sale = await addPromo(X, `sale${run}`, 'percent', 10, 100);
    expect(sale.status, JSON.stringify(sale.body)).toBe(200);
    const created = overviewOf(sale).promos[0]!;
    expect(created).toMatchObject({ code: `SALE${run}`.toUpperCase(), discount_type: 'percent', percent: 10, fixed_minor: null, max_activations: 100, used_count: 0, status: 'active' });
    const fixed = overviewOf(await addPromo(X, ' welcome300 ', 'fixed', 30_000, 100)).promos.find((p) => p.code === 'WELCOME300')!;
    expect(fixed).toMatchObject({ discount_type: 'fixed', percent: null, fixed_minor: 30_000, status: 'active' });
    // Same code, any case → conflict; the same code in ANOTHER shop is fine.
    expect(errorCode(await addPromo(X, 'Welcome300', 'percent', 5, 5))).toBe('promo_exists');
    expect((await addPromo(Y, 'WELCOME300', 'fixed', 10_000, 5)).status).toBe(200);
    for (const bad of ['ab', 'with space', 'кириллица', 'a'.repeat(33), 'bad!code']) {
      const r = await addPromo(X, bad, 'percent', 5, 5);
      expect(r.status, bad).toBe(400);
      expect(['invalid_promo_code', 'invalid_body'], bad).toContain(errorCode(r));
    }
    for (const bad of [{ type: 'percent', value: 0 }, { type: 'percent', value: 91 }, { type: 'fixed', value: 0 }] as const) {
      expect((await addPromo(X, `BAD${randomBytes(2).toString('hex')}`, bad.type, bad.value, 5)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await addPromo(X, 'ZERO', 'percent', 5, 0)).status).toBe(400);
  });

  it('applies a valid code (any case), reserves the activation at checkout, makes it final at confirmation and frees it on cancellation', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { promoEnabled: true });
    await addPromo(X, 'WELCOME300', 'fixed', 30_000, 100);
    const buyer = newTelegramUserId();

    const q = await quote(X.shop, buyer, 3, { promoCode: 'welcome300' });
    expect(q.q!.promo).toMatchObject({ code: 'WELCOME300', status: 'applied', discount_minor: 30_000, kind: 'fixed' });
    expect(q.q).toMatchObject({ discount: { type: 'promo', minor: 30_000 }, total_minor: 270_000 });
    // Asking does not use anything up.
    expect((await promoRow(X.shop, 'WELCOME300')).used_count).toBe(0);

    const order = await ok(X.shop, buyer, 3, { promoCode: 'welcome300', expectedTotalMinor: 270_000 });
    expect(order).toMatchObject({ discount_type: 'promo', discount_minor: 30_000, total_minor: 270_000, items_total_minor: 300_000 });
    expect(order.discount_info).toMatchObject({ code: 'WELCOME300', kind: 'fixed', fixed_minor: 30_000 });
    expect(await redemptionOf(order.id)).toEqual({ status: 'reserved', code: 'WELCOME300', discount_minor: 30_000 });
    expect((await promoRow(X.shop, 'WELCOME300')).used_count).toBe(1);
    let listed = overviewOf(await L(X.owner, X.shop, { action: 'get' })).promos.find((p) => p.code === 'WELCOME300')!;
    expect(listed).toMatchObject({ used_count: 1, pending_count: 1, max_activations: 100, status: 'active' });

    await confirm(X, order.id);
    expect(await redemptionOf(order.id)).toMatchObject({ status: 'redeemed' });
    listed = overviewOf(await L(X.owner, X.shop, { action: 'get' })).promos.find((p) => p.code === 'WELCOME300')!;
    expect(listed).toMatchObject({ used_count: 1, pending_count: 0 });

    // Cancelled → the activation is free again (also after confirmation), and only once.
    expect((await setStatus(X, order.id, 'cancelled')).error).toBeNull();
    expect(await redemptionOf(order.id)).toMatchObject({ status: 'released' });
    expect((await promoRow(X.shop, 'WELCOME300')).used_count).toBe(0);
    await sql(`select private.loyalty_on_cancel(o) from public.orders o where o.id = '${order.id}';`);
    expect((await promoRow(X.shop, 'WELCOME300')).used_count).toBe(0);

    const history = await L(X.owner, X.shop, { action: 'promo-history', promoId: listed.id });
    expect(history.body!.history).toEqual([expect.objectContaining({ order_number: order.order_number, status: 'released', discount_minor: 30_000 })]);
  });

  it('percent code: rounded down; the checkout total, the admin order and the profile agree', async () => {
    const X = await newShop({ shop: { basePrice: 123_459, variants: [{ flavor: 'A', stock: 50 }] } });
    await settings(X, { promoEnabled: true });
    await addPromo(X, 'SALE10', 'percent', 10, 100);
    const buyer = newTelegramUserId();
    const order = await ok(X.shop, buyer, 1, { promoCode: 'SALE10', expectedTotalMinor: 123_459 - 12_345 });
    expect(order).toMatchObject({ discount_minor: 12_345, total_minor: 111_114 });
    expect((await profile(X.shop, buyer)).orders[0]).toMatchObject({ discount_type: 'promo', discount_minor: 12_345, items_total_minor: 123_459 });
  });

  it('refuses a wrong, switched-off and exhausted code with a clear reason, and an unknown one never creates an order', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { promoEnabled: true });
    await addPromo(X, 'ONLY2', 'percent', 10, 2);
    await addPromo(X, 'PAUSED', 'percent', 10, 5, { isActive: false });
    const buyer = newTelegramUserId();
    const stock = await stockOf(X.shop.variants[0]!.id);
    const reason = async (code: string) => (await quote(X.shop, buyer, 1, { promoCode: code })).q!.promo;
    expect(await reason('NOSUCH')).toMatchObject({ status: 'invalid', reason: 'not_found' });
    expect(await reason('PAUSED')).toMatchObject({ status: 'invalid', reason: 'inactive' });
    for (const [code, expected] of [['NOSUCH', 'not_found'], ['PAUSED', 'inactive']] as const) {
      const r = await place(X.shop, buyer, 1, { promoCode: code });
      expect([r.status, r.code, r.details]).toEqual([409, 'promo_invalid', { reason: expected }]);
    }
    expect(await stockOf(X.shop.variants[0]!.id)).toBe(stock);
    // Two activations, then it is finished and refuses by itself.
    const o1 = await ok(X.shop, newTelegramUserId(), 1, { promoCode: 'ONLY2' });
    await ok(X.shop, newTelegramUserId(), 1, { promoCode: 'ONLY2' });
    expect(overviewOf(await L(X.owner, X.shop, { action: 'get' })).promos.find((p) => p.code === 'ONLY2')).toMatchObject({ used_count: 2, status: 'finished' });
    expect(await reason('ONLY2')).toMatchObject({ status: 'invalid', reason: 'exhausted' });
    const third = await place(X.shop, buyer, 1, { promoCode: 'ONLY2' });
    expect([third.status, third.code, third.details]).toEqual([409, 'promo_invalid', { reason: 'exhausted' }]);
    // A cancelled order gives its activation back: the code works again.
    expect((await setStatus(X, o1.id, 'cancelled')).error).toBeNull();
    expect(await reason('ONLY2')).toMatchObject({ status: 'applied' });
    await ok(X.shop, buyer, 1, { promoCode: 'ONLY2' });
    // Turning the promo block off stops every code at once.
    await settings(X, { promoEnabled: false });
    expect((await quote(X.shop, buyer, 1, { promoCode: 'ONLY2' })).q!.promo).toMatchObject({ status: 'invalid', reason: 'disabled' });
  });

  it('the last activation goes to exactly one of several simultaneous buyers; the others get nothing and no stock is lost', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { promoEnabled: true });
    await addPromo(X, 'LAST1', 'percent', 10, 1);
    const stock = await stockOf(X.shop.variants[0]!.id);
    const buyers = Array.from({ length: 6 }, () => newTelegramUserId());
    const results = await Promise.all(buyers.map((b) => place(X.shop, b, 1, { promoCode: 'LAST1' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) expect([r.status, r.code, r.details]).toEqual([409, 'promo_invalid', { reason: 'exhausted' }]);
    const row = await promoRow(X.shop, 'LAST1');
    expect([row.used_count, row.max_activations]).toEqual([1, 1]);
    expect(await stockOf(X.shop.variants[0]!.id)).toBe(stock - 1);
    expect(await rows(`select 1 from private.promo_redemptions where promo_id = '${row.id}'`)).toHaveLength(1);
  });

  it('a code of another shop does not work here, and the same text in two shops are two independent codes', async () => {
    const X = await newShop({ shop: spec });
    const Y = await newShop({ shop: spec });
    await settings(X, { promoEnabled: true });
    await settings(Y, { promoEnabled: true });
    await addPromo(Y, 'ONLYY', 'percent', 50, 10);
    await addPromo(X, 'SHARED', 'percent', 10, 10);
    await addPromo(Y, 'SHARED', 'percent', 20, 10);
    const buyer = newTelegramUserId();
    expect((await quote(X.shop, buyer, 1, { promoCode: 'ONLYY' })).q!.promo).toMatchObject({ status: 'invalid', reason: 'not_found' });
    const r = await place(X.shop, buyer, 1, { promoCode: 'ONLYY' });
    expect([r.status, r.code]).toEqual([409, 'promo_invalid']);
    const a = await ok(X.shop, buyer, 1, { promoCode: 'SHARED' });
    const b = await ok(Y.shop, buyer, 1, { promoCode: 'SHARED' });
    expect([a.discount_minor, b.discount_minor]).toEqual([10_000, 20_000]);
    expect([(await promoRow(X.shop, 'SHARED')).used_count, (await promoRow(Y.shop, 'SHARED')).used_count]).toEqual([1, 1]);
    // The owner of X can neither see nor change the promo codes of Y by id (IDOR).
    const yId = (await promoRow(Y.shop, 'ONLYY')).id;
    for (const body of [
      { action: 'promo-set-active', promoId: yId, active: false },
      { action: 'promo-delete', promoId: yId },
      { action: 'promo-history', promoId: yId },
      { action: 'promo-save', promoId: yId, code: 'ONLYY', discountType: 'percent', value: 1, maxActivations: 1 },
    ]) {
      const res = await L(X.owner, X.shop, body);
      expect([res.status, errorCode(res)], body.action).toEqual([404, 'promo_not_found']);
    }
    expect(await promoRow(Y.shop, 'ONLYY')).toMatchObject({ is_active: true, max_activations: 10 });
    // Same for a discount rule.
    await settings(Y, { discountEnabled: true });
    const yRule = (await addRule(Y, 3_000, 5))[0]!;
    expect(errorCode(await L(X.owner, X.shop, { action: 'rule-delete', ruleId: yRule.id }))).toBe('rule_not_found');
    expect(errorCode(await L(X.owner, X.shop, { action: 'rule-save', ruleId: yRule.id, minTotalMinor: 100, percent: 1 }))).toBe('rule_not_found');
  });

  it('management: limit can not drop below the used activations, a used code can only be disabled, an unused one deleted', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { promoEnabled: true });
    const o = overviewOf(await addPromo(X, 'MANAGED', 'percent', 10, 5));
    const id = o.promos[0]!.id;
    await ok(X.shop, newTelegramUserId(), 1, { promoCode: 'MANAGED' });
    await ok(X.shop, newTelegramUserId(), 1, { promoCode: 'MANAGED' });
    const low = await addPromo(X, 'MANAGED', 'percent', 10, 1, { promoId: id });
    expect([low.status, errorCode(low), detailsOf(low)]).toEqual([409, 'limit_below_used', { used: 2 }]);
    const raised = overviewOf(await addPromo(X, 'MANAGED', 'fixed', 20_000, 2, { promoId: id }));
    expect(raised.promos[0]).toMatchObject({ discount_type: 'fixed', fixed_minor: 20_000, percent: null, max_activations: 2, status: 'finished' });
    expect(errorCode(await L(X.owner, X.shop, { action: 'promo-delete', promoId: id }))).toBe('promo_in_use');
    const off = overviewOf(await L(X.owner, X.shop, { action: 'promo-set-active', promoId: id, active: false }));
    expect(off.promos[0]).toMatchObject({ status: 'disabled' });
    expect((await quote(X.shop, newTelegramUserId(), 1, { promoCode: 'MANAGED' })).q!.promo).toMatchObject({ reason: 'inactive' });
    const fresh = overviewOf(await addPromo(X, 'UNUSED', 'percent', 5, 5)).promos.find((p) => p.code === 'UNUSED')!;
    expect(overviewOf(await L(X.owner, X.shop, { action: 'promo-delete', promoId: fresh.id })).promos.map((p) => p.code)).toEqual(['MANAGED']);
  });
});

// ---- 7. Discounts, promo code and bonuses together --------------------------------------------------------------------------

describe('how discounts combine', () => {
  it('threshold and promo never add up: the better one wins, a code that gives nothing extra is NOT used up', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { discountEnabled: true, promoEnabled: true, bonusEnabled: true, bonusPercent: 5 });
    await addRule(X, 5_000, 7);
    await addPromo(X, 'FIX300', 'fixed', 30_000, 10); // 300 ₽
    await addPromo(X, 'BIG10', 'percent', 10, 10);
    const buyer = newTelegramUserId();
    // 6 000 ₽: threshold 7 % = 420 ₽ beats 300 ₽ → the code is left unused.
    const worse = (await quote(X.shop, buyer, 6, { promoCode: 'FIX300' })).q!;
    expect(worse.promo).toMatchObject({ status: 'not_applied', reason: 'better_discount', discount_minor: 0 });
    expect(worse.discount).toMatchObject({ type: 'threshold', minor: 42_000 });
    const noUse = await ok(X.shop, buyer, 6, { promoCode: 'FIX300', expectedTotalMinor: 558_000 });
    expect(noUse).toMatchObject({ discount_type: 'threshold', discount_minor: 42_000 });
    expect(await redemptionOf(noUse.id)).toBeNull();
    expect((await promoRow(X.shop, 'FIX300')).used_count).toBe(0);
    // 10 % = 600 ₽ beats 420 ₽ → the code is applied and the threshold is NOT added on top.
    const better = (await quote(X.shop, buyer, 6, { promoCode: 'BIG10' })).q!;
    expect(better.discount).toMatchObject({ type: 'promo', minor: 60_000 });
    expect(better.total_minor).toBe(540_000);
    const used = await ok(X.shop, buyer, 6, { promoCode: 'BIG10', expectedTotalMinor: 540_000 });
    expect(used).toMatchObject({ discount_type: 'promo', discount_minor: 60_000, total_minor: 540_000 });
    expect((await promoRow(X.shop, 'BIG10')).used_count).toBe(1);
  });

  it('order of operations: discount first, then bonuses; the total is never negative; bonuses earned come from what is actually paid', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { discountEnabled: true, promoEnabled: true, bonusEnabled: true, bonusPercent: 5 });
    await addPromo(X, 'TAKEALL', 'fixed', 99_999_900, 10); // far above any order: capped at the items total
    const buyer = await starter(X.token);
    // Capped fixed code: the order is free, never negative.
    const free = (await quote(X.shop, buyer, 2, { promoCode: 'TAKEALL' })).q!;
    expect(free).toMatchObject({ discount: { type: 'promo', minor: 200_000 }, total_minor: 0, accrual_preview: 0 });
    const freeOrder = await ok(X.shop, buyer, 2, { promoCode: 'TAKEALL', expectedTotalMinor: 0 });
    expect(freeOrder.total_minor).toBe(0);
    expect((await confirm(X, freeOrder.id)).bonus_accrued ?? 0).toBe(0);
    await addRule(X, 3_000, 5);
    // 3 000 ₽ → threshold 5 % (150 ₽) → 2 850 ₽; the buyer has no bonuses yet.
    const first = await ok(X.shop, buyer, 3);
    expect(first).toMatchObject({ items_total_minor: 300_000, discount_minor: 15_000, total_minor: 285_000 });
    // Accrual: 5 % of the 2 850 ₽ actually paid = 142.5 → 142.
    expect((await confirm(X, first.id)).bonus_accrued).toBe(142);
    // Next order: threshold 5 % and 100 bonuses → pay 2 750 ₽ → 137 bonuses.
    const second = await ok(X.shop, buyer, 3, { bonusSpend: 100, expectedTotalMinor: 275_000 });
    expect(second).toMatchObject({ discount_minor: 15_000, bonus_spent: 100, total_minor: 275_000 });
    const mirror = priceBreakdown({ subtotalMinor: 300_000, rules: [{ min_total_minor: 300_000, percent: 5 }], bonusPercent: 5, bonusBalance: 142, bonusRequested: 100 });
    expect([mirror.totalMinor, mirror.bonusEarned]).toEqual([275_000, 137]);
    expect((await confirm(X, second.id)).bonus_accrued).toBe(137);
    expect(await balanceOf(X.shop, buyer)).toBe(142 - 100 + 137);
  });

  it('a retried checkout (same idempotency key) returns the same order once, and nothing is used up twice', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { promoEnabled: true, bonusEnabled: true, bonusPercent: 5 });
    await addPromo(X, 'ONCE', 'percent', 10, 1);
    const buyer = await starter(X.token);
    const key = randomUUID();
    const body = { promoCode: 'ONCE', idempotencyKey: key };
    const first = await place(X.shop, buyer, 1, body);
    expect(first.status).toBe(201);
    const again = await place(X.shop, buyer, 1, body);
    expect([again.status, again.body!.replayed, again.order!.id]).toEqual([200, true, first.order!.id]);
    expect((await promoRow(X.shop, 'ONCE')).used_count).toBe(1);
    // The same key with another promo / bonus request is a different request: refused, not merged.
    const changed = await place(X.shop, buyer, 1, { promoCode: 'OTHER', idempotencyKey: key });
    expect([changed.status, changed.code]).toEqual([422, 'idempotency_conflict']);
  });
});

// ---- 8. Telegram notification ------------------------------------------------------------------------------------------

describe('«🎁 начислено» message through the shop’s own bot', () => {
  it('is queued by the confirmation, sent once with the real numbers through THIS shop’s bot, and never repeated', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { bonusEnabled: true, bonusPercent: 5 });
    const buyer = await starter(X.token);
    const order = await placeQuiet(X.shop, buyer, 3);
    expect(await outbox(order.id)).toBeNull(); // nothing at checkout
    await confirm(X, order.id);
    expect(await outbox(order.id)).toMatchObject({ status: 'pending', amount: 150, bot_id: botIdOf(X.token), chat_id: buyer });
    // Not sent before the panel (or a retry) dispatches it: the confirmation does not depend on Telegram.
    expect(await bonusMessages(buyer)).toHaveLength(0);

    const sent = await dispatch(X);
    expect([sent.status, sent.body]).toEqual([200, { sent: 1, failed: 0, skipped: 0 }]);
    const [msg, ...rest] = await bonusMessages(buyer);
    expect(rest).toEqual([]);
    expect(msg!.bot_id).toBe(botIdOf(X.token)); // the shop's own bot, never the platform bot
    expect(msg!.text).toBe(formatBonusMessage({ orderNumber: order.order_number, amount: 150, balance: 150 }));
    expect(msg!.text).toContain(`№${order.order_number}`);
    expect(await outbox(order.id)).toMatchObject({ status: 'sent', attempts: 1 });

    // Dispatching again, confirming again and a later status change send nothing more.
    expect((await dispatch(X)).body).toEqual({ sent: 0, failed: 0, skipped: 0 });
    await setStatus(X, order.id, 'confirmed');
    await setStatus(X, order.id, 'ready');
    expect((await dispatch(X)).body).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(await bonusMessages(buyer)).toHaveLength(1);

    // The next order shows the balance at that moment (150 + 50 = 200).
    const next = await placeQuiet(X.shop, buyer, 1);
    await confirm(X, next.id);
    await dispatch(X);
    const texts = (await bonusMessages(buyer)).map((m) => m.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toBe(formatBonusMessage({ orderNumber: next.order_number, amount: 50, balance: 200 }));
  });

  it('a buyer who never started the shop’s bot gets the bonuses but no message and no queue row', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { bonusEnabled: true, bonusPercent: 5 });
    const buyer = newTelegramUserId(); // never pressed Start
    const order = await placeQuiet(X.shop, buyer, 3);
    expect((await confirm(X, order.id)).bonus_accrued).toBe(150);
    expect(await balanceOf(X.shop, buyer)).toBe(150);
    expect(await outbox(order.id)).toBeNull();
    expect((await dispatch(X)).body).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(await bonusMessages(buyer)).toHaveLength(0);
    expect((await profile(X.shop, buyer)).loyalty).toMatchObject({ balance: 150 });
    // A buyer who started ANOTHER shop's bot only is not reachable through this one either.
    const other = await newShop({ shop: spec });
    const wrongBot = await starter(other.token);
    const o2 = await placeQuiet(X.shop, wrongBot, 1);
    await confirm(X, o2.id);
    expect(await outbox(o2.id)).toBeNull();
    expect(await bonusMessages(wrongBot)).toHaveLength(0);
  });

  it('a failed send is retried later and delivered once; a cancelled order never gets its message', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { bonusEnabled: true, bonusPercent: 5 });
    const buyer = await starter(X.token);
    const order = await placeQuiet(X.shop, buyer, 3);
    await confirm(X, order.id);
    await mockFailNext(String(buyer), 1, 500);
    expect((await dispatch(X)).body).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(await outbox(order.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await bonusMessages(buyer)).toHaveLength(0);
    await sql(`update private.bonus_notifications set next_attempt_at = now() where order_id = '${order.id}';`);
    expect((await dispatch(X)).body).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(await bonusMessages(buyer)).toHaveLength(1);
    expect((await dispatch(X)).body).toEqual({ sent: 0, failed: 0, skipped: 0 });

    const buyer2 = await starter(X.token);
    const o2 = await placeQuiet(X.shop, buyer2, 3);
    // Confirmed, then cancelled before anything was sent (nothing but this test sends a message of this shop).
    await confirm(X, o2.id);
    expect(await outbox(o2.id)).toMatchObject({ status: 'pending' });
    expect((await setStatus(X, o2.id, 'cancelled')).error).toBeNull();
    expect(await outbox(o2.id)).toMatchObject({ status: 'dead', last_error: 'order_cancelled' });
    expect((await dispatch(X)).body).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(await bonusMessages(buyer2)).toHaveLength(0);
    expect(await balanceOf(X.shop, buyer2)).toBe(0); // credited and taken back
  });

  it('the dispatch of one shop never sends the messages of another shop', async () => {
    const X = await newShop({ shop: spec });
    const Y = await newShop({ shop: spec });
    await settings(X, { bonusEnabled: true, bonusPercent: 5 });
    await settings(Y, { bonusEnabled: true, bonusPercent: 5 });
    const bx = await starter(X.token);
    const by = await starter(Y.token);
    await confirm(X, (await placeQuiet(X.shop, bx, 1)).id);
    await confirm(Y, (await placeQuiet(Y.shop, by, 1)).id);
    expect((await dispatch(X)).body).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(await bonusMessages(bx)).toHaveLength(1);
    expect(await bonusMessages(by)).toHaveLength(0);
    expect((await dispatch(Y)).body).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect((await bonusMessages(by))[0]!.bot_id).toBe(botIdOf(Y.token));
  });

  it('checkout also retries the due messages of its own shop, and only of its own shop', async () => {
    const X = await newShop({ shop: spec });
    const Y = await newShop({ shop: spec });
    await settings(X, { bonusEnabled: true, bonusPercent: 5 });
    await settings(Y, { bonusEnabled: true, bonusPercent: 5 });
    const bx = await starter(X.token);
    const by = await starter(Y.token);
    await confirm(X, (await placeQuiet(X.shop, bx, 1)).id);
    const yOrder = await placeQuiet(Y.shop, by, 1);
    await confirm(Y, yOrder.id);
    expect(await bonusMessages(bx)).toHaveLength(0);
    expect(await bonusMessages(by)).toHaveLength(0);

    // An order placed through the real checkout of shop X makes it sweep the due messages of shop X in the background.
    await ok(X.shop, newTelegramUserId(), 1);
    const sent = await waitFor(() => bonusMessages(bx), (m) => m.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.bot_id).toBe(botIdOf(X.token));
    // Shop Y was not touched by it: its message is still waiting for its own dispatch.
    expect(await bonusMessages(by)).toHaveLength(0);
    expect(await outbox(yOrder.id)).toMatchObject({ status: 'pending' });
  });
});

// ---- 9. Isolation between shops ----------------------------------------------------------------------------------------

describe('tenant isolation of balances, settings and orders', () => {
  it('bonuses of shop A are not visible or spendable in shop B; the settings of the two shops are independent', async () => {
    const A = await newShop({ shop: spec });
    const B = await newShop({ shop: spec });
    await settings(A, { bonusEnabled: true, bonusPercent: 5 });
    await settings(B, { bonusEnabled: true, bonusPercent: 10 });
    const buyer = await starter(A.token);
    await confirm(A, (await ok(A.shop, buyer, 3)).id);
    expect(await balanceOf(A.shop, buyer)).toBe(150);

    const inB = (await quote(B.shop, buyer, 1, { bonusSpend: 150 })).q!;
    expect(inB.bonus).toMatchObject({ enabled: true, percent: 10, balance: 0, applied: 0 });
    const spend = await place(B.shop, buyer, 1, { bonusSpend: 150 });
    expect([spend.status, spend.code, spend.details]).toEqual([409, 'insufficient_bonus', { balance: 0 }]);
    expect((await profile(B.shop, buyer)).loyalty).toMatchObject({ balance: 0, history: [] });
    expect(await balanceOf(A.shop, buyer)).toBe(150);
    // 5 % in A and 10 % in B for the same order.
    const orderB = await ok(B.shop, buyer, 3);
    expect((await confirm(B, orderB.id)).bonus_accrued).toBe(300);
    expect(await balanceOf(A.shop, buyer)).toBe(150);
    expect(await balanceOf(B.shop, buyer)).toBe(300);
    const stats = (shop: BotShop) => L(shop.owner, shop.shop, { action: 'get' }).then((r) => overviewOf(r).stats);
    expect(await stats(A)).toMatchObject({ customers: 1, balance_total: 150 });
    expect(await stats(B)).toMatchObject({ customers: 1, balance_total: 300 });
  });

  it('a buyer can not confirm, credit or spend through someone else’s order id or shop id', async () => {
    const A = await newShop({ shop: spec });
    const B = await newShop({ shop: spec });
    await settings(A, { bonusEnabled: true, bonusPercent: 5 });
    await settings(B, { bonusEnabled: true, bonusPercent: 5 });
    const victim = newTelegramUserId();
    const orderA = await ok(A.shop, victim, 3);
    // The owner of B can not confirm A's order (and so can not credit anything for it).
    const r = await setStatus(B, orderA.id, 'confirmed');
    expect(r.error?.message).toBe('order_not_found');
    expect(await balanceOf(A.shop, victim)).toBe(0);
    // Posting the order/shop ids of another shop in the checkout body changes nothing (unknown keys are dropped).
    const o = await ok(B.shop, newTelegramUserId(), 1, { orderId: orderA.id, shopId: A.shop.id, customerTgId: victim });
    expect(await ledgerOf(A.shop, victim)).toEqual([]);
    expect(o).not.toHaveProperty('bonus_accrued');
    // Direct RPCs with a forged customer are not callable by browsers (service role only).
    const forged = {
      p_shop_slug: A.shop.slug,
      p_customer_tg_id: victim,
      p_customer_snapshot: {},
      p_items: [{ variant_id: A.shop.variants[0]!.id, quantity: 1 }],
      p_idempotency_key: randomUUID(),
      p_request_hash: 'forged',
      p_fulfillment_method: 'pickup',
      p_delivery_address: null,
      p_comment: '',
      p_expected_currency: 'RUB',
      p_expected_total_minor: null,
      p_promo_code: null,
      p_bonus_spend: 0,
    };
    for (const client of [anon(), B.owner.client]) {
      expect((await client.rpc('create_order_v3' as never, forged as never)).error?.message).toMatch(/permission denied/i);
    }
    expect(await rows(`select 1 from orders where shop_id = '${A.shop.id}' and customer_tg_id = ${victim} and idempotency_key = '${forged.p_idempotency_key}'`)).toEqual([]);
  });

  it('deleting a shop removes its loyalty data (the deletion check covers every table with shop_id)', async () => {
    const X = await newShop({ shop: spec });
    await settings(X, { bonusEnabled: true, discountEnabled: true, promoEnabled: true });
    await addRule(X, 3_000, 5);
    await addPromo(X, 'GONE', 'percent', 10, 5);
    const buyer = await starter(X.token);
    await confirm(X, (await ok(X.shop, buyer, 3, { promoCode: 'GONE' })).id);
    const left = async () => JSON.parse(await sql(`select private.shop_leftover_rows('${X.shop.id}')::text;`)) as Record<string, number>;
    const before = await left();
    for (const t of ['shop_loyalty_settings', 'shop_discount_rules', 'shop_promo_codes', 'promo_redemptions', 'customer_bonus_accounts', 'bonus_ledger', 'bonus_notifications']) {
      expect(before[`private.${t}`], t).toBeGreaterThan(0);
    }
    await sql(`select private.purge_shop_loyalty('${X.shop.id}');`);
    const after = await left();
    for (const t of Object.keys(after)) expect(t, 'left after purge').not.toMatch(/shop_loyalty_settings|shop_discount_rules|shop_promo_codes|promo_redemptions|customer_bonus_accounts|bonus_ledger|bonus_notifications/);
  });
});

describe('the old checkout path is untouched', () => {
  it('create_order_v2 still exists with its signature, is not callable by browsers, and v3 for a feature-less shop returns what v2 would', async () => {
    const X = await newShop({ shop: spec });
    const buyer = newTelegramUserId();
    const args = {
      p_shop_slug: X.shop.slug,
      p_customer_tg_id: buyer,
      p_customer_snapshot: {},
      p_items: [{ variant_id: X.shop.variants[0]!.id, quantity: 2 }],
      p_idempotency_key: randomUUID(),
      p_request_hash: 'x',
      p_fulfillment_method: 'pickup',
      p_delivery_address: null,
      p_comment: '',
      p_expected_currency: 'RUB',
      p_expected_total_minor: 200_000,
    };
    const v3 = await svcRpc('create_order_v3', { ...args, p_promo_code: null, p_bonus_spend: 0 });
    expect(v3.error).toBeNull();
    const result = v3.data as { replayed: boolean; order: OrderJson };
    expect(result.replayed).toBe(false);
    expect(result.order.total_minor).toBe(200_000);
    expect(result.order).not.toHaveProperty('items_total_minor');
    // The same request through v2 is the replay of that very order: they share the idempotency.
    const v2 = await svcRpc('create_order_v2', args);
    expect((v2.data as { replayed: boolean; order: OrderJson }).replayed).toBe(true);
    expect((v2.data as { order: OrderJson }).order.id).toBe(result.order.id);
  });
});

