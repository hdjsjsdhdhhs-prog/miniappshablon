import { beforeEach, describe, expect, it } from 'vitest';
import { cartStorageKey, cartStore } from './cart-store';
import { checkoutKeyFor } from './checkout-api';
import { describeCheckoutError } from './checkout-errors';
import { ApiError } from './checkout-api';

const line = (variantId: string, price = 1000, max = 5) => ({
  variantId,
  productId: 'p',
  name: 'Товар',
  variantLabel: '',
  unitPriceMinor: price,
  imagePath: null,
  maxQuantity: max,
});

describe('cart store', () => {
  beforeEach(() => cartStore._resetCache());

  it('keeps carts of different shops independent', () => {
    cartStore.add('shop-a', line('v1'), 2);
    cartStore.add('shop-b', line('v9'), 1);
    expect(cartStore.getLines('shop-a').map((l) => l.variantId)).toEqual(['v1']);
    expect(cartStore.getLines('shop-b').map((l) => l.variantId)).toEqual(['v9']);
    expect(localStorage.getItem(cartStorageKey('shop-a'))).toContain('v1');
    expect(localStorage.getItem(cartStorageKey('shop-a'))).not.toContain('v9');
  });

  it('merges same variant and caps by known stock and 99', () => {
    cartStore.add('s', line('v1', 1000, 3), 2);
    cartStore.add('s', line('v1', 1000, 3), 2);
    expect(cartStore.getLines('s')[0]!.quantity).toBe(3);
    cartStore.setQuantity('s', 'v1', 500);
    expect(cartStore.getLines('s')[0]!.quantity).toBe(3);
    cartStore.setQuantity('s', 'v1', 0);
    expect(cartStore.getLines('s')).toEqual([]);
  });

  it('applies server-confirmed prices and stock after a failed checkout', () => {
    cartStore.add('s', line('v1', 1000, 5), 4);
    cartStore.add('s', line('v2', 500, 5), 1);
    cartStore.reconcile('s', { prices: { v1: 1200 }, available: { v1: 2, v2: 0 } });
    expect(cartStore.getLines('s')).toEqual([expect.objectContaining({ variantId: 'v1', unitPriceMinor: 1200, quantity: 2, maxQuantity: 2 })]);
  });

  it('ignores corrupted storage', () => {
    localStorage.setItem(cartStorageKey('x'), '{not json');
    expect(cartStore.getLines('x')).toEqual([]);
    localStorage.setItem(cartStorageKey('y'), JSON.stringify([{ variantId: 1 }]));
    expect(cartStore.getLines('y')).toEqual([]);
  });
});

describe('checkout idempotency key', () => {
  const order = { fulfillment: { method: 'delivery', address: 'ул. Ленина, 1' } as const, comment: '' };
  it('is stable for the same cart+order (retries) and changes when the request changes', () => {
    const lines = [{ ...line('v1'), quantity: 1 }];
    const k1 = checkoutKeyFor('s', lines, order);
    expect(checkoutKeyFor('s', lines, order)).toBe(k1);
    expect(checkoutKeyFor('s', [{ ...line('v1'), quantity: 2 }], order)).not.toBe(k1);
    const k3 = checkoutKeyFor('s', lines, { ...order, fulfillment: { method: 'delivery', address: 'ул. Мира, 2' } });
    expect(k3).not.toBe(k1);
    const k4 = checkoutKeyFor('s', lines, { ...order, fulfillment: { method: 'pickup' } });
    expect(k4).not.toBe(k3);
    expect(checkoutKeyFor('s', lines, { ...order, fulfillment: { method: 'pickup' }, comment: 'позвоните' })).not.toBe(k4);
  });
});

describe('checkout error mapping', () => {
  it('maps stock and price errors to cart corrections', () => {
    const stock = describeCheckoutError(new ApiError(409, 'insufficient_stock', [{ variant_id: 'v1', available: 1 }]));
    expect(stock.reconcile).toEqual({ available: { v1: 1 } });
    const price = describeCheckoutError(new ApiError(409, 'price_changed', { total_minor: 1, prices: [{ variant_id: 'v1', unit_price_minor: 99 }] }));
    expect(price.reconcile).toEqual({ prices: { v1: 99 } });
    expect(describeCheckoutError(new ApiError(422, 'idempotency_conflict', null)).resetIdempotencyKey).toBe(true);
    expect(describeCheckoutError(new Error('x')).message).toBeTruthy();
  });
});
