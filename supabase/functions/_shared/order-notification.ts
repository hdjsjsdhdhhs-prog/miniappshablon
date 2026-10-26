// Text of the Telegram order notification (runtime-agnostic, HTML parse mode).
// Buyer identity comes ONLY from the order's server-side fields: customer_tg_id and customer_snapshot, which the
// checkout Edge Function fills from Telegram initData it verified itself. The contact name/phone typed into the
// checkout form are shown separately and labelled as entered by the buyer.

export interface NotificationOrderItem {
  product_name: string;
  variant_label: string;
  quantity: number;
  unit_price_minor: number;
  line_total_minor: number;
}

export interface NotificationOrder {
  order_number: number;
  currency: string;
  total_minor: number;
  contact_name?: string | null;
  contact_phone?: string | null;
  comment?: string | null;
  is_test?: boolean;
  created_at: string;
  items: NotificationOrderItem[];
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
  if (order.comment?.trim()) lines.push(`<b>Комментарий:</b> ${e(order.comment.trim())}`);
  lines.push('');
  lines.push('<b>Товары:</b>');
  order.items.forEach((item, i) => {
    const variant = item.variant_label?.trim() ? ` · ${e(item.variant_label.trim())}` : '';
    lines.push(
      `${i + 1}. ${e(item.product_name)}${variant} — ${item.quantity} × ${formatMinor(item.unit_price_minor, order.currency)} = ${formatMinor(item.line_total_minor, order.currency)}`,
    );
  });
  lines.push('');
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
