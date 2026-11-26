// «🎁 Отличные новости! За ваш заказ №104 начислено 150 бонусов.» — the buyer's message about credited bonuses, sent
// through the SHOP'S OWN connected bot (never the platform bot). Runtime-agnostic (the RPC and fetch are injected).
// Outbox: private.bonus_notifications (one row per order, ever, written inside admin_set_order_status when the order is
// confirmed — and only when the buyer started that bot; without it the bonuses are credited and nothing is sent).
//
// Called after the confirmation committed (admin panel → `loyalty` function, action `dispatch`; checkout as an
// opportunistic retry) and never throws: the confirmation exists whatever happens here. Delivery is at-most-once from the
// buyer's point of view — a job is re-validated right before sendMessage, a failed send is retried with backoff, and a send
// whose outcome is unknown (the worker died) is not repeated (bonus_notify_claim).
import { BotApiError, redactToken, TelegramBotApi } from './telegram-bot-api.ts';

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/** "1 бонус", "2 бонуса", "5 бонусов", "11 бонусов", "21 бонус". */
export function bonusWord(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'бонусов';
  if (last === 1) return 'бонус';
  if (last >= 2 && last <= 4) return 'бонуса';
  return 'бонусов';
}

const group = (n: number) => new Intl.NumberFormat('ru-RU').format(n).replace(/\u00a0|\u202f/g, ' ');

/** The amount and the balance are always the real numbers of that order and that buyer (never a template constant). */
export function formatBonusMessage(input: { orderNumber: number; amount: number; balance: number }): string {
  const { orderNumber, amount, balance } = input;
  return [
    `🎁 Отличные новости! За ваш заказ №${orderNumber} начислено ${group(amount)} ${bonusWord(amount)}.`,
    `Теперь ваш бонусный баланс составляет ${group(balance)} ${bonusWord(balance)}. Используйте их при следующем заказе!`,
  ].join('\n');
}

export interface BonusNotificationJob {
  notification_id: number;
  attempt: number;
  /** The bot the buyer started; re-validated right before sending. */
  bot_id: number;
  shop_name: string;
  chat_id: number;
  bot_token: string;
  order_number: number;
  amount: number;
  /** The buyer's balance at claim time. */
  balance: number;
}

export interface BonusDispatchOptions {
  /** Verified admin user (the admin panel); null for the trusted checkout function. */
  actor?: string | null;
  orderId?: string | null;
  shopId?: string | null;
  limit?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /** Receives only ids and error codes — never tokens or message text. */
  log?: (message: string) => void;
}

export interface BonusDispatchResult {
  sent: number;
  failed: number;
  /** Claimed, but not sent: the shop's bot changed, the buyer blocked it or the order was cancelled meanwhile. */
  skipped: number;
  /** The claim RPC refused (e.g. forbidden): the admin function turns it into the HTTP answer. */
  error?: string;
}

export async function dispatchBonusNotifications(rpc: Rpc, options: BonusDispatchOptions = {}): Promise<BonusDispatchResult> {
  const log = options.log ?? ((m: string) => console.warn(m));
  const result: BonusDispatchResult = { sent: 0, failed: 0, skipped: 0 };
  let jobs: BonusNotificationJob[];
  try {
    const { data, error } = await rpc('bonus_notify_claim', {
      p_actor: options.actor ?? null,
      p_shop_id: options.shopId ?? null,
      p_order_id: options.orderId ?? null,
      p_limit: options.limit ?? 5,
    });
    if (error) {
      log(`bonus_notify_claim failed: ${error.message}`);
      return { ...result, error: error.message };
    }
    jobs = (data as BonusNotificationJob[] | null) ?? [];
  } catch (err) {
    log(`bonus_notify_claim threw: ${(err as Error)?.name ?? 'error'}`);
    return result;
  }

  for (const job of jobs) {
    if (!job) continue;
    // Fails closed: any doubt → nothing is sent and nothing is completed (the claim expires as "interrupted").
    let maySend: boolean;
    try {
      const { data, error } = await rpc('bonus_notify_begin_send', {
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
      log(`bonus notification ${job.notification_id} not sent: bot changed, blocked or order cancelled`);
      continue;
    }

    let ok = false;
    let blocked = false;
    let messageId: number | null = null;
    let errorText: string | null = null;
    try {
      const api = new TelegramBotApi(job.bot_token, { baseUrl: options.apiBase, fetchImpl: options.fetchImpl });
      const sent = await api.sendText(String(job.chat_id), {
        text: formatBonusMessage({ orderNumber: job.order_number, amount: job.amount, balance: job.balance }),
      });
      ok = true;
      messageId = sent.message_id;
    } catch (err) {
      blocked = err instanceof BotApiError && err.recipientGone;
      errorText =
        err instanceof BotApiError
          ? `${err.code}: ${err.description}`
          : redactToken(`internal: ${(err as Error)?.message ?? String(err)}`, job.bot_token);
      log(`bonus notification ${job.notification_id} attempt ${job.attempt} failed: ${err instanceof BotApiError ? err.code : 'internal'}`);
    }
    try {
      const { error } = await rpc('bonus_notify_complete', {
        p_notification_id: job.notification_id,
        p_ok: ok,
        p_message_id: messageId,
        p_error: errorText ? redactToken(errorText, job.bot_token).slice(0, 300) : null,
        p_blocked: blocked,
      });
      if (error) log(`bonus_notify_complete failed for ${job.notification_id}: ${error.message}`);
    } catch {
      log(`bonus_notify_complete threw for ${job.notification_id}`);
    }
    if (ok) result.sent += 1;
    else result.failed += 1;
  }
  return result;
}
