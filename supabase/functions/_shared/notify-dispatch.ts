// Outbox consumer for order notifications (runtime-agnostic: the RPC and fetch are injected).
// Called after the checkout transaction committed. It never throws: a Telegram failure is recorded on the
// outbox row (retried later with backoff) and can never undo or repeat the order.
import { formatOrderNotification, type NotificationOrder, type VerifiedCustomer } from './order-notification.ts';
import { BotApiError, redactToken, TelegramBotApi } from './telegram-bot-api.ts';

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export interface NotificationJob {
  notification_id: number;
  attempt: number;
  shop_name: string;
  chat_id: string;
  bot_token: string;
  customer_tg_id: number;
  customer: VerifiedCustomer | null;
  order: NotificationOrder;
}

export interface DispatchOptions {
  orderId?: string | null;
  shopId?: string | null;
  limit?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Receives only ids and error codes — never tokens or message text. */
  log?: (message: string) => void;
}

export interface DispatchResult {
  sent: number;
  failed: number;
}

export async function dispatchNotifications(rpc: Rpc, options: DispatchOptions = {}): Promise<DispatchResult> {
  const log = options.log ?? ((m: string) => console.warn(m));
  const result: DispatchResult = { sent: 0, failed: 0 };
  let jobs: NotificationJob[];
  try {
    const { data, error } = await rpc('notify_claim', {
      p_order_id: options.orderId ?? null,
      p_shop_id: options.shopId ?? null,
      p_limit: options.limit ?? 1,
    });
    if (error) {
      log(`notify_claim failed: ${error.message}`);
      return result;
    }
    jobs = (data as NotificationJob[] | null) ?? [];
  } catch (err) {
    log(`notify_claim threw: ${(err as Error)?.name ?? 'error'}`);
    return result;
  }

  for (const job of jobs) {
    if (!job) continue;
    let ok = false;
    let messageId: number | null = null;
    let errorText: string | null = null;
    try {
      const api = new TelegramBotApi(job.bot_token, { baseUrl: options.apiBase, fetchImpl: options.fetchImpl });
      const text = formatOrderNotification({
        shopName: job.shop_name,
        order: job.order,
        customerTgId: job.customer_tg_id,
        customer: job.customer,
      });
      const sent = await api.sendMessage(job.chat_id, text);
      ok = true;
      messageId = sent.message_id;
    } catch (err) {
      errorText =
        err instanceof BotApiError
          ? `${err.code}: ${err.description}`
          : redactToken(`internal: ${(err as Error)?.message ?? String(err)}`, job.bot_token);
      log(`order notification ${job.notification_id} attempt ${job.attempt} failed: ${err instanceof BotApiError ? err.code : 'internal'}`);
    }
    try {
      const { error } = await rpc('notify_complete', {
        p_notification_id: job.notification_id,
        p_ok: ok,
        p_message_id: messageId,
        p_error: errorText ? redactToken(errorText, job.bot_token).slice(0, 300) : null,
      });
      if (error) log(`notify_complete failed for ${job.notification_id}: ${error.message}`);
    } catch {
      log(`notify_complete threw for ${job.notification_id}`);
    }
    if (ok) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}
