// Text of the Telegram order notification (runtime-agnostic, HTML parse mode).
// Buyer identity comes ONLY from the order's server-side fields: customer_tg_id and customer_snapshot, which the
// checkout Edge Function fills from Telegram initData it verified itself. The contact name/phone typed into the
// checkout form are shown separately and labelled as entered by the buyer.

export interface NotificationOrderItem {
  product_name: string;
  variant_label: string;
  quantity: number;
  /** Price charged for one unit (the server's snapshot). */
  unit_price_minor: number;
  /** List price of the unit when it was sold with a discount; null / absent otherwise. */
  original_unit_price_minor?: number | null;
  line_total_minor: number;
}

export interface NotificationOrder {
  order_number: number;
  currency: string;
  total_minor: number;
  contact_name?: string | null;
  contact_phone?: string | null;
  comment?: string | null;
  fulfillment_method?: 'delivery' | 'pickup' | null;
  delivery_address?: string | null;
  is_test?: boolean;
  created_at: string;
  items: NotificationOrderItem[];
  /**
   * Price breakdown of an order placed with the bonus program / discounts / promo codes (20261125090000); absent for every
   * other order: total_minor = items_total_minor − discount_minor − bonus_spent × 100.
   */
  items_total_minor?: number | null;
  discount_type?: 'threshold' | 'promo' | null;
  discount_minor?: number | null;
  discount_info?: { percent?: number | null; min_total_minor?: number; code?: string } | null;
  bonus_spent?: number | null;
}

/** 1 bonus = 1 whole currency unit = 100 minor units (private.bonus_unit_minor). */
const BONUS_UNIT_MINOR = 100;

/**
 * «Сумма товаров / Скидка / Оплачено бонусами» lines, only for an order that has a discount or spent bonuses — a plain order
 * produces none, so its message stays exactly what it was.
 */
export function priceBreakdownLines(order: NotificationOrder): string[] {
  const discount = order.discount_minor ?? 0;
  const spent = order.bonus_spent ?? 0;
  if (order.items_total_minor == null || (discount <= 0 && spent <= 0)) return [];
  const lines = [`<b>Сумма товаров:</b> ${formatMinor(order.items_total_minor, order.currency)}`];
  if (discount > 0) {
    const info = order.discount_info ?? {};
    const title =
      order.discount_type === 'promo'
        ? `Промокод ${escapeHtml(String(info.code ?? ''))}`
        : `Скидка за сумму заказа${info.percent ? ` ${info.percent}%` : ''}`;
    lines.push(`<b>${title}:</b> −${formatMinor(discount, order.currency)}`);
  }
  if (spent > 0) lines.push(`<b>Оплачено бонусами (${spent}):</b> −${formatMinor(spent * BONUS_UNIT_MINOR, order.currency)}`);
  return lines;
}

export interface VerifiedCustomer {
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

export interface OrderNotificationInput {
  shopName: string;
  order: NotificationOrder;
  customerTgId: number | string;
  customer: VerifiedCustomer | null | undefined;
  /** IANA zone for the order time. Shops have no own zone yet; the platform default is Moscow. */
  timeZone?: string;
}

export const NOTIFICATION_TIME_ZONE = 'Europe/Moscow';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();
export function formatMinor(minor: number, currency: string): string {
  let f = moneyFormatters.get(currency);
  if (!f) {
    f = new Intl.NumberFormat('ru-RU', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 });
    moneyFormatters.set(currency, f);
  }
  return f.format(minor / 100);
}

export function formatOrderTime(iso: string, timeZone = NOTIFICATION_TIME_ZONE): string {
  const date = new Date(iso);
  const text = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return timeZone === 'Europe/Moscow' ? `${text} (МСК)` : `${text} (${timeZone})`;
}

/** "@username", otherwise the verified name, otherwise only the Telegram ID. Always with the ID. */
export function describeCustomer(customerTgId: number | string, customer: VerifiedCustomer | null | undefined): string {
  const username = customer?.username?.trim();
  const name = [customer?.first_name, customer?.last_name].map((s) => s?.trim()).filter(Boolean).join(' ');
  const who = username ? `@${username}` : name || null;
  return who ? `${who} (Telegram ID ${customerTgId})` : `Telegram ID ${customerTgId}`;
}

export function formatOrderNotification(input: OrderNotificationInput): string {
  const { order } = input;
  const e = escapeHtml;
  const lines: string[] = [];
  lines.push(`🛒 <b>Новый заказ №${order.order_number}</b> — ${e(input.shopName)}`);
  if (order.is_test) lines.push('<i>Тестовый заказ (DEMO-магазин)</i>');
  lines.push('');
  lines.push(`<b>Покупатель:</b> ${e(describeCustomer(input.customerTgId, input.customer))}`);
  const contact = [order.contact_name?.trim(), order.contact_phone?.trim()].filter(Boolean).join(', ');
  if (contact) lines.push(`<b>Контакт из формы:</b> ${e(contact)}`);
  if (order.fulfillment_method === 'delivery') {
    lines.push(`<b>Получение:</b> доставка`);
    if (order.delivery_address?.trim()) lines.push(`<b>Адрес доставки:</b> ${e(order.delivery_address.trim())}`);
  } else if (order.fulfillment_method === 'pickup') {
    lines.push(`<b>Получение:</b> самовывоз`);
  }
  if (order.comment?.trim()) lines.push(`<b>Комментарий:</b> ${e(order.comment.trim())}`);
  lines.push('');
  lines.push('<b>Товары:</b>');
  order.items.forEach((item, i) => {
    const variant = item.variant_label?.trim() ? ` · ${e(item.variant_label.trim())}` : '';
    // A discounted line shows the list price struck through before the price actually charged.
    const old =
      typeof item.original_unit_price_minor === 'number' && item.original_unit_price_minor > item.unit_price_minor
        ? `<s>${formatMinor(item.original_unit_price_minor, order.currency)}</s> `
        : '';
    lines.push(
      `${i + 1}. ${e(item.product_name)}${variant} — ${item.quantity} × ${old}${formatMinor(item.unit_price_minor, order.currency)} = ${formatMinor(item.line_total_minor, order.currency)}`,
    );
  });
  lines.push('');
  lines.push(...priceBreakdownLines(order));
  lines.push(`<b>Итого:</b> ${formatMinor(order.total_minor, order.currency)}`);
  lines.push(`<b>Дата:</b> ${formatOrderTime(order.created_at, input.timeZone)}`);
  return lines.join('\n');
}

export function formatTestMessage(shopName: string, now = new Date()): string {
  return [
    `✅ <b>${escapeHtml(shopName)}</b>: уведомления о заказах подключены.`,
    `Проверка связи · ${formatOrderTime(now.toISOString())}`,
  ].join('\n');
}
