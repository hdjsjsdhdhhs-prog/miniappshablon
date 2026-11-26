// "Ваш заказ оформлен!" — the buyer's copy of a new order, sent through the SHOP'S OWN connected bot.
// Runtime-agnostic (the RPC and fetch are injected). Outbox: private.customer_order_notifications (one row per order,
// written by a trigger in the checkout transaction, and only when the buyer started that bot before ordering).
//
// Called after the checkout transaction committed, next to the admin notification (notify-dispatch.ts), and never
// throws: the order exists whatever happens here. Delivery is at-most-once from the buyer's point of view — a job is
// re-validated right before sendMessage, a failed send is retried with backoff, and a send whose outcome is unknown
// (the worker died) is not repeated (customer_notify_claim).
//
// The message carries only what the buyer already knows about the order: number, items, total and the way of
// receiving it. No address, no comment, no Telegram id, no name.
import { escapeHtml, formatMinor, priceBreakdownLines, type NotificationOrder } from './order-notification.ts';
import { BotApiError, redactToken, TelegramBotApi } from './telegram-bot-api.ts';

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** Telegram limit of a text message; the item list is shortened to stay below it. */
const MESSAGE_MAX = 4096;

export function formatCustomerOrderMessage(order: NotificationOrder): string {
  const e = escapeHtml;
  const head = ['✅ <b>Ваш заказ оформлен!</b>', '', `<b>Номер заказа:</b> №${order.order_number}`, '<b>Состав заказа:</b>'];
  const method = order.fulfillment_method === 'delivery' ? 'доставка' : order.fulfillment_method === 'pickup' ? 'самовывоз' : null;
  const tail = [
    ...priceBreakdownLines(order),
    `<b>Сумма:</b> ${formatMinor(order.total_minor, order.currency)}`,
    ...(method ? [`<b>Способ получения:</b> ${method}`] : []),
    '',
    'Ваш заказ оформлен. Скоро с вами свяжется менеджер для подтверждения заказа.',
  ];
  const items = order.items.map((item, i) => {
    const variant = item.variant_label?.trim() ? ` · ${e(item.variant_label.trim())}` : '';
    return `${i + 1}. ${e(item.product_name)}${variant} — ${item.quantity} × ${formatMinor(item.unit_price_minor, order.currency)} = ${formatMinor(item.line_total_minor, order.currency)}`;
  });
  const size = (lines: string[]) => lines.join('\n').length;
  const fixed = size(head) + size(tail) + 2;
  const shown: string[] = [];
  for (const line of items) {
    const rest = items.length - shown.length - 1;
    const more = rest > 0 ? `… и ещё ${rest} поз.` : '';
    if (fixed + size([...shown, line, more]) + 2 > MESSAGE_MAX) break;
    shown.push(line);
  }
  if (shown.length < items.length) shown.push(`… и ещё ${items.length - shown.length} поз.`);
  return [...head, ...shown, ...tail].join('\n');
}

export interface CustomerNotificationJob {
  notification_id: number;
  attempt: number;
  /** The bot the buyer started; re-validated right before sending. */
  bot_id: number;
  shop_name: string;
  chat_id: number;
  bot_token: string;
  order: NotificationOrder;
}

export interface CustomerDispatchOptions {
  orderId?: string | null;
  shopId?: string | null;
  limit?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Receives only ids and error codes — never tokens or message text. */
  log?: (message: string) => void;
}

export interface CustomerDispatchResult {
  sent: number;
  failed: number;
  /** Claimed, but not sent: the shop's bot changed or the buyer blocked it meanwhile. */
  skipped: number;
}

export async function dispatchCustomerNotifications(rpc: Rpc, options: CustomerDispatchOptions = {}): Promise<CustomerDispatchResult> {
  const log = options.log ?? ((m: string) => console.warn(m));
  const result: CustomerDispatchResult = { sent: 0, failed: 0, skipped: 0 };
  let jobs: CustomerNotificationJob[];
  try {
    const { data, error } = await rpc('customer_notify_claim', {
      p_order_id: options.orderId ?? null,
      p_shop_id: options.shopId ?? null,
      p_limit: options.limit ?? 1,
    });
    if (error) {
      log(`customer_notify_claim failed: ${error.message}`);
      return result;
    }
    jobs = (data as CustomerNotificationJob[] | null) ?? [];
  } catch (err) {
    log(`customer_notify_claim threw: ${(err as Error)?.name ?? 'error'}`);
    return result;
  }

  for (const job of jobs) {
    if (!job) continue;
    // Fails closed: any doubt → nothing is sent and nothing is completed (the claim expires as "interrupted").
    let maySend: boolean;
    try {
      const { data, error } = await rpc('customer_notify_begin_send', {
        p_notification_id: job.notification_id,
        p_attempt: job.attempt,
        p_bot_id: job.bot_id,
      });
      maySend = !error && data === true;
    } catch {
      maySend = false;
    }
    if (!maySend) {
      result.skipped += 1;
      log(`customer notification ${job.notification_id} not sent: bot changed or blocked`);
      continue;
    }

    let ok = false;
    let blocked = false;
    let messageId: number | null = null;
    let errorText: string | null = null;
    try {
      const api = new TelegramBotApi(job.bot_token, { baseUrl: options.apiBase, fetchImpl: options.fetchImpl });
      const sent = await api.sendMessage(String(job.chat_id), formatCustomerOrderMessage(job.order));
      ok = true;
      messageId = sent.message_id;
    } catch (err) {
      blocked = err instanceof BotApiError && err.recipientGone;
      errorText =
        err instanceof BotApiError
          ? `${err.code}: ${err.description}`
          : redactToken(`internal: ${(err as Error)?.message ?? String(err)}`, job.bot_token);
      log(`customer notification ${job.notification_id} attempt ${job.attempt} failed: ${err instanceof BotApiError ? err.code : 'internal'}`);
    }
    try {
      const { error } = await rpc('customer_notify_complete', {
        p_notification_id: job.notification_id,
        p_ok: ok,
        p_message_id: messageId,
        p_error: errorText ? redactToken(errorText, job.bot_token).slice(0, 300) : null,
        p_blocked: blocked,
      });
      if (error) log(`customer_notify_complete failed for ${job.notification_id}: ${error.message}`);
    } catch {
      log(`customer_notify_complete threw for ${job.notification_id}`);
    }
    if (ok) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}
