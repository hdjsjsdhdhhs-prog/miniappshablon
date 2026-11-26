// «Сумма товаров / Скидка / Оплачено бонусами» in the order messages (20261125090000). A plain order's message stays exactly
// what it was; an order placed with discounts / bonuses shows how the total was formed.
import { describe, expect, it } from 'vitest';
import { formatCustomerOrderMessage } from './customer-notification';
import { formatMinor, formatOrderNotification, priceBreakdownLines, type NotificationOrder } from './order-notification';

const base: NotificationOrder = {
  order_number: 9,
  currency: 'RUB',
  total_minor: 285_000,
  fulfillment_method: 'pickup',
  created_at: '2026-11-25T09:00:00Z',
  items: [{ product_name: 'Liquid', variant_label: 'Mint', quantity: 6, unit_price_minor: 50_000, line_total_minor: 300_000 }],
};
const rub = (m: number) => formatMinor(m, 'RUB');

describe('priceBreakdownLines', () => {
  it('is empty for a plain order, an order without discount and bonuses, and an order of an older shape', () => {
    expect(priceBreakdownLines(base)).toEqual([]);
    expect(priceBreakdownLines({ ...base, items_total_minor: 300_000, discount_minor: 0, bonus_spent: 0 })).toEqual([]);
  });

  it('names the threshold discount, the promo code and the bonuses with their amounts', () => {
    expect(priceBreakdownLines({ ...base, items_total_minor: 300_000, discount_type: 'threshold', discount_minor: 15_000, discount_info: { percent: 5, min_total_minor: 300_000 } })).toEqual([
      `<b>Сумма товаров:</b> ${rub(300_000)}`,
      `<b>Скидка за сумму заказа 5%:</b> −${rub(15_000)}`,
    ]);
    expect(
      priceBreakdownLines({ ...base, items_total_minor: 300_000, discount_type: 'promo', discount_minor: 30_000, discount_info: { code: 'WELCOME300' }, bonus_spent: 50 }),
    ).toEqual([`<b>Сумма товаров:</b> ${rub(300_000)}`, `<b>Промокод WELCOME300:</b> −${rub(30_000)}`, `<b>Оплачено бонусами (50):</b> −${rub(5_000)}`]);
  });

  it('escapes the code', () => {
    expect(priceBreakdownLines({ ...base, items_total_minor: 100, discount_type: 'promo', discount_minor: 10, discount_info: { code: '<b>' } }).join('\n')).toContain('Промокод &lt;b&gt;');
  });
});

describe('order messages', () => {
  const discounted: NotificationOrder = { ...base, items_total_minor: 300_000, discount_type: 'threshold', discount_minor: 15_000, discount_info: { percent: 5 } };

  it('the buyer message shows the breakdown before the amount to pay; a plain order is unchanged', () => {
    const plain = formatCustomerOrderMessage(base).split('\n');
    expect(plain.some((l) => l.includes('Сумма товаров'))).toBe(false);
    const lines = formatCustomerOrderMessage(discounted).split('\n');
    const at = lines.findIndex((l) => l.startsWith('<b>Сумма товаров:</b>'));
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at, at + 3)).toEqual([`<b>Сумма товаров:</b> ${rub(300_000)}`, `<b>Скидка за сумму заказа 5%:</b> −${rub(15_000)}`, `<b>Сумма:</b> ${rub(285_000)}`]);
  });

  it('the admin message shows the same lines before «Итого»', () => {
    const text = formatOrderNotification({ shopName: 'Shop', order: discounted, customerTgId: 1, customer: null });
    expect(text).toContain(`<b>Скидка за сумму заказа 5%:</b> −${rub(15_000)}\n<b>Итого:</b> ${rub(285_000)}`);
    expect(formatOrderNotification({ shopName: 'Shop', order: base, customerTgId: 1, customer: null })).not.toContain('Сумма товаров');
  });
});
