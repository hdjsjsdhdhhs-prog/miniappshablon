import { describe, expect, it } from 'vitest';
import type { ProductSummary } from './api';
import { buildDemoOrder, DEMO_ORDER_TITLE, shouldShowDemoProfile } from './demo-profile';

const product = (id: string, name: string, price: number, variants: ProductSummary['variants']): ProductSummary => ({
  id,
  name,
  basePriceMinor: price,
  categoryId: 'c',
  images: [],
  variants,
});
const v = (id: string, flavor: string | null, color: string | null, stock: number) => ({
  id,
  flavor,
  color,
  stock_quantity: stock,
  is_active: true,
  sort_order: 0,
});

describe('shouldShowDemoProfile', () => {
  it('a DEMO shop always gets the mock-up — in a browser and inside Telegram (it never stores orders)', () => {
    expect(shouldShowDemoProfile({ isDemo: true })).toBe(true);
  });

  it('a regular shop (also a former DEMO after hand-over) never gets the mock-up', () => {
    expect(shouldShowDemoProfile({ isDemo: false })).toBe(false);
  });
});

describe('buildDemoOrder', () => {
  it('builds "Тестовый заказ" from the first products of the current shop with consistent totals', () => {
    const order = buildDemoOrder(
      [
        product('p1', 'Noir Salt 30 мл', 69_000, [v('a', 'Вишня', null, 0), v('b', 'Черника', null, 5)]),
        product('p2', 'Aurum Pod', 249_000, [v('g', null, 'Графит', 3)]),
        product('p3', 'Шнурок', 29_000, [v('d', null, null, 9)]),
        product('p4', 'Not used', 1, [v('x', null, null, 1)]),
      ],
      'RUB',
    );
    expect(order.title).toBe(DEMO_ORDER_TITLE);
    expect(order.title).toBe('Тестовый заказ');
    expect(order.currency).toBe('RUB');
    expect(order.lines).toEqual([
      // The first in-stock variant is shown (Вишня is sold out).
      { key: 'demo-p1', name: 'Noir Salt 30 мл', variantLabel: 'Черника', quantity: 2, unitPriceMinor: 69_000, lineTotalMinor: 138_000 },
      { key: 'demo-p2', name: 'Aurum Pod', variantLabel: 'Графит', quantity: 1, unitPriceMinor: 249_000, lineTotalMinor: 249_000 },
      { key: 'demo-p3', name: 'Шнурок', variantLabel: '', quantity: 1, unitPriceMinor: 29_000, lineTotalMinor: 29_000 },
    ]);
    expect(order.totalMinor).toBe(138_000 + 249_000 + 29_000);
  });

  it('falls back to generic test lines when the shop has nothing to show', () => {
    const order = buildDemoOrder([], 'USD');
    expect(order.currency).toBe('USD');
    expect(order.lines.length).toBeGreaterThan(0);
    for (const l of order.lines) {
      expect(l.name).toMatch(/^Тестов/);
      expect(l.lineTotalMinor).toBe(l.unitPriceMinor * l.quantity);
    }
    expect(order.totalMinor).toBe(order.lines.reduce((s, l) => s + l.lineTotalMinor, 0));
  });

  it('is a pure in-memory value: same input → equal output, never shared between shops', () => {
    const a = buildDemoOrder([product('a1', 'Shop A item', 100, [v('a', null, null, 1)])], 'RUB');
    const b = buildDemoOrder([product('b1', 'Shop B item', 200, [v('b', null, null, 1)])], 'RUB');
    expect(buildDemoOrder([product('a1', 'Shop A item', 100, [v('a', null, null, 1)])], 'RUB')).toEqual(a);
    expect(JSON.stringify(b)).not.toContain('Shop A');
  });
});
