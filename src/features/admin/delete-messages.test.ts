import { describe, expect, it } from 'vitest';
import { CatalogDeleteError } from './api';
import { explainDeleteError, ru } from './delete-messages';

describe('ru plural', () => {
  it.each([
    [1, 'заказ'],
    [2, 'заказа'],
    [5, 'заказов'],
    [11, 'заказов'],
    [12, 'заказов'],
    [21, 'заказ'],
    [22, 'заказа'],
    [111, 'заказов'],
  ])('%i → %s', (n, word) => expect(ru(n, 'заказ', 'заказа', 'заказов')).toBe(word));
});

describe('explainDeleteError', () => {
  it('product in orders: explains the history and suggests archiving', () => {
    const r = explainDeleteError(new CatalogDeleteError('product_has_orders', { orders: 2 }), 'product');
    expect(r).toMatchObject({ code: 'product_has_orders', suggest: 'archive', gone: false });
    expect(r.text).toContain('в 2 заказах');
    expect(r.text).toMatch(/истори/);
    expect(r.text).toMatch(/архив/);
  });

  it('variant in orders suggests deactivating; last variant suggests nothing', () => {
    expect(explainDeleteError(new CatalogDeleteError('variant_has_orders', { orders: 1 }), 'variant')).toMatchObject({ suggest: 'deactivate' });
    expect(explainDeleteError(new CatalogDeleteError('variant_has_orders', { orders: 1 }), 'variant').text).toContain('в 1 заказе');
    expect(explainDeleteError(new CatalogDeleteError('last_variant', {}), 'variant')).toMatchObject({ suggest: null, gone: false });
  });

  it('category with products asks for a target category', () => {
    const r = explainDeleteError(new CatalogDeleteError('category_has_products', { products: 3 }), 'category');
    expect(r).toMatchObject({ suggest: 'move' });
    expect(r.text).toContain('3 товара');
  });

  it('missing / foreign rows are reported as gone (list refresh), unknown errors get a generic text', () => {
    expect(explainDeleteError(new CatalogDeleteError('category_not_found', {}), 'category')).toMatchObject({ gone: true });
    expect(explainDeleteError(new CatalogDeleteError('category_not_found', {}), 'category').text).toMatch(/^Категория уже удалена/);
    expect(explainDeleteError(new CatalogDeleteError('product_not_found', {}), 'product').text).toMatch(/^Товар уже удалён/);
    expect(explainDeleteError(new Error('network'), 'product')).toMatchObject({ code: '', gone: false, suggest: null });
  });
});
