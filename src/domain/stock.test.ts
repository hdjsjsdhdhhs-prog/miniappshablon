import { describe, expect, it } from 'vitest';
import { bestStockStatus, isAvailable, isStockStatus, STOCK_STATUS_LABELS, stockStatusOf } from './stock';

describe('stock status', () => {
  it.each([
    [0, 'out_of_stock', 'Нет в наличии', false],
    [1, 'low_stock', 'Осталось мало', true],
    [2, 'low_stock', 'Осталось мало', true],
    [3, 'in_stock', 'В наличии', true],
    [250, 'in_stock', 'В наличии', true],
  ] as const)('%i → %s («%s»), available: %s', (qty, status, label, available) => {
    expect(stockStatusOf(qty)).toBe(status);
    expect(STOCK_STATUS_LABELS[status]).toBe(label);
    expect(isAvailable(status)).toBe(available);
  });

  it('labels never contain a number', () => {
    for (const label of Object.values(STOCK_STATUS_LABELS)) expect(label).not.toMatch(/\d/);
  });

  it('picks the best status and validates values', () => {
    expect(bestStockStatus(['out_of_stock', 'low_stock'])).toBe('low_stock');
    expect(bestStockStatus(['low_stock', 'in_stock'])).toBe('in_stock');
    expect(bestStockStatus([])).toBe('out_of_stock');
    expect(isStockStatus('in_stock')).toBe(true);
    expect(isStockStatus(5)).toBe(false);
  });
});
