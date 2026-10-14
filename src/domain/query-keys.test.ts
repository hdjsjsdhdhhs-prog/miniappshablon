import { describe, expect, it } from 'vitest';
import { keyBelongsToShop, queryKeys } from './query-keys';

describe('query keys', () => {
  it('scopes every tenant key by shop id/slug', () => {
    const a = 'shop-a';
    const keys = [
      queryKeys.shop(a),
      queryKeys.categories(a),
      queryKeys.products(a, { categoryId: null, search: '' }),
      queryKeys.featured(a),
      queryKeys.product(a, 'p1'),
      queryKeys.myOrders(a, 1),
      queryKeys.adminCategories(a),
      queryKeys.adminProducts(a),
      queryKeys.adminOrders(a, 'all'),
      queryKeys.adminStats(a),
    ];
    for (const k of keys) {
      expect(keyBelongsToShop(k, a)).toBe(true);
      expect(keyBelongsToShop(k, 'shop-b')).toBe(false);
    }
  });

  it('produces different keys for different shops and filters', () => {
    expect(queryKeys.products('a', { categoryId: null, search: '' })).not.toEqual(queryKeys.products('b', { categoryId: null, search: '' }));
    expect(queryKeys.products('a', { categoryId: 'c', search: '' })).not.toEqual(queryKeys.products('a', { categoryId: null, search: '' }));
    expect(queryKeys.myOrders('a', 1)).not.toEqual(queryKeys.myOrders('a', 2));
  });
});
