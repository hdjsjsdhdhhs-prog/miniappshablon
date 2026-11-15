/// <reference types="vite/client" />
// (vite/client: the admin / storefront modules imported below read import.meta.env at type level.)
//
// Discount price of a product (20261113090000: products.discount_price_minor, order_items.original_unit_price_minor,
// create_order_v2, order_to_json, platform_create_demo_shop). LOCAL ONLY.
// The owner saves the discount through the real admin data layer (src/features/admin/api.ts, under RLS), the buyer
// reads it through the real storefront data layer (src/features/storefront/api.ts, anonymous) and checkout charges it
// in SQL — never a price from the request — and keeps the list price next to the charged one in the order line
// (snapshot: later price changes never rewrite an order).
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mockMessages } from '../../scripts/lib/telegram-mock.ts';
import { formatMinor } from '../../supabase/functions/_shared/order-notification.ts';
import type { Db } from './helpers';

const client: { current: Db | null } = { current: null };

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    if (!client.current) throw new Error('client not set by the test');
    return client.current;
  },
  publicImageUrl: (path: string | null | undefined) => path ?? null,
  functionsUrl: (name: string) => `/functions/v1/${name}`,
}));

const {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  cleanup,
  createOwner,
  createPlatformAdmin,
  createTestShop,
  env,
  fakeBotToken,
  initDataFor,
  newTelegramUserId,
  stockOf,
  track,
  waitFor,
} = await import('./helpers');
const { saveProductWithPrice, updateProduct, fetchAdminProduct } = await import('@/features/admin/api');
const { fetchProduct, fetchProductsPage } = await import('@/features/storefront/api');
const { productOldPriceMinor, productPriceMinor } = await import('@/domain/pricing');

if (!env.isLocal) throw new Error('discount integration tests run only against the local Supabase stack');

type TestShop = Awaited<ReturnType<typeof createTestShop>>;
interface OrderItem {
  variant_id: string;
  unit_price_minor: number;
  original_unit_price_minor: number | null;
  quantity: number;
  line_total_minor: number;
}
interface Order {
  id: string;
  order_number: number;
  total_minor: number;
  items: OrderItem[];
}

const run = randomBytes(3).toString('hex');
const rub = (minor: number) => formatMinor(minor, 'RUB');
const LIST = 69_000;
const SALE = 59_000;

afterAll(cleanup);

async function productInput(shop: TestShop) {
  const { data, error } = await admin.from('products').select('*').eq('id', shop.productId).single();
  if (error) throw error;
  return { name: data.name, description: data.description, category_id: data.category_id, base_price_minor: data.base_price_minor, is_published: data.is_published, sort_order: data.sort_order };
}
const prices = async (productId: string) => {
  const { data, error } = await admin.from('products').select('base_price_minor, discount_price_minor').eq('id', productId).single();
  if (error) throw error;
  return data;
};
const itemRows = async (orderId: string) => {
  const { data, error } = await admin.from('order_items').select('unit_price_minor, original_unit_price_minor, quantity, line_total_minor').eq('order_id', orderId).order('variant_id');
  if (error) throw error;
  return data;
};
/** A shop whose product is on sale, set by its owner through the admin data layer. */
async function shopOnSale(variants = [{ flavor: 'Mango', stock: 20 }, { flavor: 'Blueberry', stock: 20 }] as Array<{ flavor: string; stock: number; price?: number }>) {
  const shop = await createTestShop({ basePrice: LIST, variants });
  const owner = await createOwner(shop.id);
  client.current = owner.client;
  await saveProductWithPrice(shop.productId, { ...(await productInput(shop)), discount_price_minor: SALE });
  return { shop, owner };
}
const checkout = async (shop: TestShop, buyer: number, items: Array<{ variantId: string; quantity: number }>, extra: Record<string, unknown> = {}) => {
  const body = checkoutBody(shop, items, extra);
  const res = await callFunction('checkout', await initDataFor(buyer), body);
  return { res, body, order: res.body?.order as Order | undefined };
};

describe('discount price: admin → storefront → checkout', () => {
  it('the owner sets it, the storefront shows both prices, checkout charges the discount and keeps the list price in the line', async () => {
    const { shop, owner } = await shopOnSale();
    expect(await prices(shop.productId)).toEqual({ base_price_minor: LIST, discount_price_minor: SALE });
    // The admin reads it back under the owner's session.
    expect((await fetchAdminProduct(shop.id, shop.productId))!.discount_price_minor).toBe(SALE);

    // Anonymous visitor, the exact queries of the storefront.
    client.current = anon();
    const detail = await fetchProduct(shop.id, shop.productId);
    expect(detail).toMatchObject({ basePriceMinor: LIST, discountPriceMinor: SALE });
    expect([productPriceMinor(detail), productOldPriceMinor(detail)]).toEqual([SALE, LIST]);
    const listed = (await fetchProductsPage(shop.id, { categoryId: null, search: '' }, 0)).items;
    expect(listed.map((p) => [p.basePriceMinor, p.discountPriceMinor])).toEqual([[LIST, SALE]]);

    // The cart was priced with what the storefront showed.
    const { res, order } = await checkout(shop, newTelegramUserId(), [{ variantId: shop.variants[0]!.id, quantity: 2 }, { variantId: shop.variants[1]!.id, quantity: 1 }], {
      expectedTotalMinor: 3 * SALE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(order!.total_minor).toBe(3 * SALE);
    expect(order!.items.map((i) => [i.unit_price_minor, i.original_unit_price_minor, i.quantity, i.line_total_minor]).sort()).toEqual(
      [[SALE, LIST, 2, 2 * SALE], [SALE, LIST, 1, SALE]].sort(),
    );
    expect((await itemRows(order!.id)).map((i) => [i.unit_price_minor, i.original_unit_price_minor, i.line_total_minor]).sort()).toEqual(
      [[SALE, LIST, 2 * SALE], [SALE, LIST, SALE]].sort(),
    );
    client.current = owner.client;
  });

  it('a price the browser claims is never trusted: a cart priced at another total gets price_changed with the current prices', async () => {
    const { shop } = await shopOnSale();
    const buyer = newTelegramUserId();
    const stale = await checkout(shop, buyer, [{ variantId: shop.variants[0]!.id, quantity: 2 }], { expectedTotalMinor: 2 * LIST });
    expect(stale.res.status).toBe(409);
    expect(stale.res.body!.error).toEqual({
      code: 'price_changed',
      details: { total_minor: 2 * SALE, prices: [{ variant_id: shop.variants[0]!.id, unit_price_minor: SALE, original_unit_price_minor: LIST }] },
    });
    // A buyer cannot name a lower price either.
    const cheap = await checkout(shop, buyer, [{ variantId: shop.variants[0]!.id, quantity: 2 }], { expectedTotalMinor: 2 });
    expect([cheap.res.status, (cheap.res.body!.error as { code: string }).code]).toEqual([409, 'price_changed']);
    expect((await admin.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id)).count).toBe(0);
    expect(await stockOf(shop.variants[0]!.id)).toBe(20);
    // With the reported total the same cart goes through.
    const ok = await checkout(shop, buyer, [{ variantId: shop.variants[0]!.id, quantity: 2 }], { expectedTotalMinor: 2 * SALE });
    expect(ok.res.status).toBe(201);
    expect(ok.order!.total_minor).toBe(2 * SALE);
  });

  it('snapshot: the order keeps the price it was charged and its list price, whatever happens to the product later', async () => {
    const { shop, owner } = await shopOnSale();
    const buyer = newTelegramUserId();
    const initData = await initDataFor(buyer);
    const first = await checkout(shop, buyer, [{ variantId: shop.variants[0]!.id, quantity: 2 }]);
    expect(first.res.status).toBe(201);

    // The owner ends the sale and raises the price.
    client.current = owner.client;
    await saveProductWithPrice(shop.productId, { ...(await productInput(shop)), base_price_minor: 79_000, discount_price_minor: null });
    expect(await prices(shop.productId)).toEqual({ base_price_minor: 79_000, discount_price_minor: null });

    const mine = await callFunction('my-orders', initData, { shopSlug: shop.slug });
    expect(mine.status).toBe(200);
    const [stored] = mine.body!.orders as Order[];
    expect(stored!.id).toBe(first.order!.id);
    expect(stored!.total_minor).toBe(2 * SALE);
    expect(stored!.items.map((i) => [i.unit_price_minor, i.original_unit_price_minor, i.line_total_minor])).toEqual([[SALE, LIST, 2 * SALE]]);
    // A replay of the same checkout returns that order, not a re-priced one.
    const replay = await callFunction('checkout', initData, first.body);
    expect([replay.status, replay.body!.replayed]).toEqual([200, true]);
    expect((replay.body!.order as Order).items.map((i) => [i.unit_price_minor, i.original_unit_price_minor])).toEqual([[SALE, LIST]]);
    expect((replay.body!.order as Order).total_minor).toBe(2 * SALE);

    // A new order is charged the new list price and has no struck price.
    const second = await checkout(shop, buyer, [{ variantId: shop.variants[0]!.id, quantity: 1 }]);
    expect(second.res.status).toBe(201);
    expect(second.order!.items.map((i) => [i.unit_price_minor, i.original_unit_price_minor])).toEqual([[79_000, null]]);
    expect(await itemRows(first.order!.id)).toEqual([{ unit_price_minor: SALE, original_unit_price_minor: LIST, quantity: 2, line_total_minor: 2 * SALE }]);
  });

  it('a variant with its own price (older data) is charged that price and shows no struck price', async () => {
    const shop = await createTestShop({ basePrice: LIST, variants: [{ flavor: 'Mango', stock: 5 }, { flavor: 'Blueberry', stock: 5, price: 74_000 }] });
    // Written by the service role: the admin page always clears variant prices (see product-price.test.ts).
    expect((await admin.from('products').update({ discount_price_minor: SALE }).eq('id', shop.productId)).error).toBeNull();
    const { res, order } = await checkout(shop, newTelegramUserId(), shop.variants.map((v) => ({ variantId: v.id, quantity: 1 })));
    expect(res.status).toBe(201);
    const byVariant = new Map(order!.items.map((i) => [i.variant_id, [i.unit_price_minor, i.original_unit_price_minor]]));
    expect(byVariant.get(shop.variants[0]!.id)).toEqual([SALE, LIST]);
    expect(byVariant.get(shop.variants[1]!.id)).toEqual([74_000, null]);
    expect(order!.total_minor).toBe(SALE + 74_000);
  });

  it('the shop’s order notification shows the list price struck through before the charged one', async () => {
    const { shop, owner } = await shopOnSale([{ flavor: 'Mango', stock: 20 }]);
    const chat = `@it_discount_${run}`;
    const saved = await callAdminFunction('notification-settings', owner.client, { action: 'save', shopId: shop.id, botToken: fakeBotToken(), chatId: chat });
    expect(saved.status, saved.text).toBe(200);
    const { res, order } = await checkout(shop, newTelegramUserId(), [{ variantId: shop.variants[0]!.id, quantity: 2 }]);
    expect(res.status).toBe(201);
    const title = `Новый заказ №${order!.order_number}</b>`;
    const messages = await waitFor(() => mockMessages(chat), (m) => m.some((x) => x.text.includes(title)));
    const text = messages.find((x) => x.text.includes(title))!.text;
    expect(text).toContain(`1. Liquid · Mango — 2 × <s>${rub(LIST)}</s> ${rub(SALE)} = ${rub(2 * SALE)}`);
  });
});

describe('the database guards the discount, whoever writes it', () => {
  it('it must be positive and lower than the list price; the list price cannot drop to or below it', async () => {
    const { shop, owner } = await shopOnSale();
    const input = await productInput(shop);
    for (const bad of [LIST, LIST + 1, 0, -100]) {
      const viaOwner = await owner.client.from('products').update({ discount_price_minor: bad }).eq('id', shop.productId).select('id');
      expect(viaOwner.error?.code, `owner ${bad}`).toBe('23514');
      const viaService = await admin.from('products').update({ discount_price_minor: bad }).eq('id', shop.productId).select('id');
      expect(viaService.error?.code, `service ${bad}`).toBe('23514');
    }
    // Through the admin data layer: the save fails as a whole.
    await expect(saveProductWithPrice(shop.productId, { ...input, base_price_minor: SALE, discount_price_minor: SALE })).rejects.toThrow(/products_discount_price_check/);
    await expect(updateProduct(shop.productId, { base_price_minor: SALE - 1 })).rejects.toThrow(/products_discount_price_check/);
    expect(await prices(shop.productId)).toEqual({ base_price_minor: LIST, discount_price_minor: SALE });
    // A new product cannot be created with an invalid pair either.
    const created = await owner.client
      .from('products')
      .insert({ shop_id: shop.id, category_id: shop.categoryId, name: 'Bad', base_price_minor: 1000, discount_price_minor: 1000 })
      .select('id');
    expect(created.error?.code).toBe('23514');
    // An order line can only carry a list price above the charged one.
    const { order } = await checkout(shop, newTelegramUserId(), [{ variantId: shop.variants[0]!.id, quantity: 1 }]);
    const line = await admin.from('order_items').update({ original_unit_price_minor: SALE }).eq('order_id', order!.id).select('id');
    expect(line.error?.code).toBe('23514');
  });

  it('a patch without the discount leaves it; null removes it', async () => {
    const { shop } = await shopOnSale();
    await updateProduct(shop.productId, { name: 'Renamed' });
    expect(await prices(shop.productId)).toEqual({ base_price_minor: LIST, discount_price_minor: SALE });
    await saveProductWithPrice(shop.productId, await productInput(shop));
    expect(await prices(shop.productId)).toEqual({ base_price_minor: LIST, discount_price_minor: SALE });
    await updateProduct(shop.productId, { discount_price_minor: null });
    expect(await prices(shop.productId)).toEqual({ base_price_minor: LIST, discount_price_minor: null });
    client.current = anon();
    const detail = await fetchProduct(shop.id, shop.productId);
    expect([productPriceMinor(detail), productOldPriceMinor(detail)]).toEqual([LIST, null]);
  });

  it('only the shop’s own team can change it: a visitor and the owner of another shop cannot', async () => {
    const { shop } = await shopOnSale();
    const other = await createTestShop();
    const stranger = await createOwner(other.id);
    const viaAnon = await anon().from('products').update({ discount_price_minor: 1 }).eq('id', shop.productId).select('id');
    // Refused outright (no UPDATE grant) or matches no row (RLS): either way nothing is updated.
    expect(viaAnon.data ?? []).toEqual([]);
    const viaStranger = await stranger.client.from('products').update({ discount_price_minor: 1 }).eq('id', shop.productId).select('id');
    expect(viaStranger.data ?? []).toEqual([]);
    expect(await prices(shop.productId)).toEqual({ base_price_minor: LIST, discount_price_minor: SALE });
  });
});

describe('DEMO clone', () => {
  it('a DEMO shop created from a template keeps the discount of every product', async () => {
    const template = await createTestShop({ isDemo: true, basePrice: LIST, variants: [{ flavor: 'Mint', stock: 3 }] });
    expect((await admin.from('products').update({ discount_price_minor: SALE }).eq('id', template.productId)).error).toBeNull();
    const pa = await createPlatformAdmin();
    const res = await callAdminFunction('platform-admin', pa.client, { action: 'create-demo', templateId: template.id, slug: `it-sale-${run}`, name: `Sale ${run}` });
    expect(res.status, res.text).toBe(201);
    const cloneId = (res.body!.shop as { id: string }).id;
    track('shop', cloneId);
    expect(cloneId).not.toBe(template.id);
    const { data } = await admin.from('products').select('base_price_minor, discount_price_minor').eq('shop_id', cloneId);
    expect(data).toEqual([{ base_price_minor: LIST, discount_price_minor: SALE }]);
  });
});
