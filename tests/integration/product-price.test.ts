/// <reference types="vite/client" />
// (vite/client: the admin modules imported below read import.meta.env at type level.)
//
// One price per product: the owner saves the product price through the real admin data layer
// (src/features/admin/api.ts, under RLS with the owner's session) and every variant — including one
// that had its own price from earlier data — is then charged that same price by checkout (create_order).
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Db } from './helpers';

const client: { current: Db | null } = { current: null };

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    if (!client.current) throw new Error('admin client not set by the test');
    return client.current;
  },
  publicImageUrl: (path: string | null | undefined) => path ?? null,
  functionsUrl: (name: string) => `/functions/v1/${name}`,
}));

const { admin, callFunction, checkoutBody, cleanup, createOwner, createTestShop, env, initDataFor, newTelegramUserId, stockOf } = await import('./helpers');
const { saveProductWithPrice } = await import('@/features/admin/api');

if (!env.isLocal) throw new Error('product-price integration tests run only against the local Supabase stack');

afterAll(cleanup);

describe('one price per product', () => {
  it('saving the product price synchronizes every variant; checkout charges the same price for each', async () => {
    const shop = await createTestShop({
      basePrice: 69000,
      variants: [
        { flavor: 'Mango', stock: 5 },
        { flavor: 'Blueberry', stock: 5, price: 74000 },
      ],
    });
    const { client: owner } = await createOwner(shop.id);
    client.current = owner;
    const { data: product } = await admin.from('products').select('*').eq('id', shop.productId).single();

    await saveProductWithPrice(shop.productId, {
      name: product!.name,
      description: product!.description,
      category_id: product!.category_id,
      base_price_minor: 69000,
      is_published: product!.is_published,
      sort_order: product!.sort_order,
    });

    const { data: variants } = await admin.from('product_variants').select('flavor, price_override_minor').eq('product_id', shop.productId);
    expect(variants!.map((v) => v.price_override_minor)).toEqual([null, null]);

    const res = await callFunction(
      'checkout',
      await initDataFor(newTelegramUserId()),
      checkoutBody(shop, shop.variants.map((v) => ({ variantId: v.id, quantity: 1 })), { expectedTotalMinor: 2 * 69000 }),
    );
    expect(res.status).toBe(201);
    const order = res.body!.order as { total_minor: number; items: Array<{ unit_price_minor: number }> };
    expect(order.items.map((i) => i.unit_price_minor)).toEqual([69000, 69000]);
    expect(order.total_minor).toBe(2 * 69000);
  });

  it('a variant the owner adds in the admin has no own price and is charged the product price', async () => {
    const shop = await createTestShop({ basePrice: 249000, variants: [{ flavor: null, stock: 4 }] });
    const { client: owner } = await createOwner(shop.id);
    client.current = owner;
    const { createVariant } = await import('@/features/admin/api');
    const added = await createVariant(shop.id, shop.productId, { flavor: null, color: 'Золото', sku: null, is_active: true }, 2);
    expect(added.price_override_minor).toBeNull();
    const { data: row } = await admin.from('product_variants').select('price_override_minor, stock_quantity').eq('id', added.id).single();
    expect(row).toEqual({ price_override_minor: null, stock_quantity: 2 });

    const res = await callFunction(
      'checkout',
      await initDataFor(newTelegramUserId()),
      checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: 1 }, { variantId: added.id, quantity: 1 }], { expectedTotalMinor: 2 * 249000 }),
    );
    expect(res.status).toBe(201);
    const order = res.body!.order as { total_minor: number; items: Array<{ unit_price_minor: number }> };
    expect(order.items.map((i) => i.unit_price_minor)).toEqual([249000, 249000]);
    expect(await stockOf(added.id)).toBe(1); // stock still works for the new variant
  });

  it('the owner cannot touch variants of another shop through the price sync', async () => {
    const mine = await createTestShop({ variants: [{ flavor: 'Mint', stock: 1 }] });
    const other = await createTestShop({ variants: [{ flavor: 'Cherry', stock: 1, price: 99900 }] });
    const { client: owner } = await createOwner(mine.id);
    client.current = owner;
    const { syncVariantPricesToProduct } = await import('@/features/admin/api');
    expect(await syncVariantPricesToProduct(other.productId)).toEqual([]);
    const { data } = await admin.from('product_variants').select('price_override_minor').eq('product_id', other.productId).single();
    expect(data!.price_override_minor).toBe(99900);
  });
});
