import { describe, expect, it } from 'vitest';
import { describeCustomer, escapeHtml, formatMinor, formatOrderNotification, formatOrderTime, formatTestMessage } from './order-notification';

const order = {
  order_number: 42,
  currency: 'RUB',
  total_minor: 69_000 * 2 + 189_000,
  contact_name: 'Ирина',
  contact_phone: '+79990001122',
  comment: 'Позвоните <за час> & не опаздывайте',
  is_test: false,
  created_at: '2026-10-25T09:05:00Z',
  items: [
    { product_name: 'Noir Salt 30 мл', variant_label: 'Черника', quantity: 2, unit_price_minor: 69_000, line_total_minor: 138_000 },
    { product_name: 'Obsidian Kit', variant_label: '', quantity: 1, unit_price_minor: 189_000, line_total_minor: 189_000 },
  ],
};

describe('formatOrderNotification', () => {
  it('contains shop, order number, verified buyer, every line with quantity and price, total and time', () => {
    const text = formatOrderNotification({ shopName: 'Noir Vapor', order, customerTgId: 777, customer: { username: 'irina_tg', first_name: 'Ира' } });
    expect(text).toContain('Новый заказ №42</b> — Noir Vapor');
    expect(text).toContain('<b>Покупатель:</b> @irina_tg (Telegram ID 777)');
    expect(text).toContain(`1. Noir Salt 30 мл · Черника — 2 × ${formatMinor(69_000, 'RUB')} = ${formatMinor(138_000, 'RUB')}`);
    expect(text).toContain(`2. Obsidian Kit — 1 × ${formatMinor(189_000, 'RUB')} = ${formatMinor(189_000, 'RUB')}`);
    expect(text).toContain(`<b>Итого:</b> ${formatMinor(327_000, 'RUB')}`);
    // 09:05 UTC = 12:05 Moscow.
    expect(text).toContain('<b>Дата:</b> 25.10.2026, 12:05 (МСК)');
    expect(text).not.toContain('Тестовый заказ');
  });

  it('labels the form contact as entered by the buyer and escapes HTML in every user-provided field', () => {
    const text = formatOrderNotification({
      shopName: 'A&B <Shop>',
      order: { ...order, items: [{ ...order.items[0]!, product_name: '<b>x</b>' }] },
      customerTgId: 1,
      customer: { first_name: '<script>' },
    });
    expect(text).toContain('A&amp;B &lt;Shop&gt;');
    expect(text).toContain('<b>Контакт из формы:</b> Ирина, +79990001122');
    expect(text).toContain('Позвоните &lt;за час&gt; &amp; не опаздывайте');
    expect(text).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(text).toContain('&lt;script&gt; (Telegram ID 1)');
    expect(text).not.toMatch(/<script>|<Shop>/);
  });

  it('shows the fulfillment: delivery with the escaped address, pickup without any address; no empty contact line', () => {
    const base = { ...order, contact_name: null, contact_phone: null };
    const delivery = formatOrderNotification({
      shopName: 'S',
      order: { ...base, fulfillment_method: 'delivery', delivery_address: 'ул. <Ленина> & 1' },
      customerTgId: 1,
      customer: { username: 'buyer' },
    });
    expect(delivery).toContain('<b>Получение:</b> доставка');
    expect(delivery).toContain('<b>Адрес доставки:</b> ул. &lt;Ленина&gt; &amp; 1');
    expect(delivery).not.toContain('Контакт из формы');
    const pickup = formatOrderNotification({ shopName: 'S', order: { ...base, fulfillment_method: 'pickup', delivery_address: null }, customerTgId: 1, customer: null });
    expect(pickup).toContain('<b>Получение:</b> самовывоз');
    expect(pickup).not.toContain('Адрес доставки');
  });

  it('marks DEMO test orders', () => {
    expect(formatOrderNotification({ shopName: 'S', order: { ...order, is_test: true }, customerTgId: 1, customer: null })).toContain(
      'Тестовый заказ (DEMO-магазин)',
    );
  });
});

describe('describeCustomer (verified identity only)', () => {
  it('prefers @username, then the name, then only the ID', () => {
    expect(describeCustomer(5, { username: 'neo', first_name: 'Thomas' })).toBe('@neo (Telegram ID 5)');
    expect(describeCustomer(5, { username: '', first_name: 'Thomas', last_name: 'Anderson' })).toBe('Thomas Anderson (Telegram ID 5)');
    expect(describeCustomer(5, null)).toBe('Telegram ID 5');
    expect(describeCustomer(5, { first_name: '  ' })).toBe('Telegram ID 5');
  });
});

describe('helpers', () => {
  it('escapes, formats time zones and builds the test message', () => {
    expect(escapeHtml('<a&b>')).toBe('&lt;a&amp;b&gt;');
    expect(formatOrderTime('2026-01-01T00:00:00Z', 'UTC')).toBe('01.01.2026, 00:00 (UTC)');
    expect(formatTestMessage('Mint <Lab>', new Date('2026-10-25T09:05:00Z'))).toContain('<b>Mint &lt;Lab&gt;</b>: уведомления о заказах подключены.');
  });
});
