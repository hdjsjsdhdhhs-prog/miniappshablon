import { isStockStatus, type StockStatus } from '@/domain/stock';
import { ApiError } from './checkout-api';

export interface CheckoutErrorView {
  message: string;
  /** Server-confirmed updates to apply to the local cart (stock: statuses only, never quantities). */
  reconcile?: { prices?: Record<string, number>; stock?: Record<string, StockStatus> };
  removeVariantIds?: string[];
  resetIdempotencyKey?: boolean;
}

/** Maps Edge Function error codes to user-facing messages and cart corrections. */
export function describeCheckoutError(err: unknown): CheckoutErrorView {
  if (!(err instanceof ApiError)) return { message: 'Что-то пошло не так. Попробуйте ещё раз.' };
  const d = err.details;
  switch (err.code) {
    case 'network_error':
      return { message: 'Нет связи с сервером. Повторите отправку — дубликат заказа не создастся.' };
    case 'telegram_auth_failed':
      return { message: 'Не удалось подтвердить ваш Telegram-аккаунт. Закройте и снова откройте магазин в Telegram.' };
    case 'shop_preview':
      return { message: 'Магазин в режиме предпросмотра — заказы пока не принимаются.' };
    case 'shop_demo':
      return { message: 'Это демонстрационный магазин: настоящие заказы в нём не оформляются.' };
    case 'fulfillment_unavailable':
      return { message: 'Выбранный способ получения больше недоступен. Обновите страницу и выберите другой.', resetIdempotencyKey: true };
    case 'invalid_address':
      return { message: 'Укажите адрес доставки.' };
    case 'invalid_fulfillment':
      return { message: 'Выберите способ получения.' };
    case 'shop_unavailable':
      return { message: 'Магазин временно не принимает заказы.' };
    case 'insufficient_stock': {
      // The server reports only the status of each refused line (20261102090100), never the remaining quantity.
      const rows = Array.isArray(d) ? (d as Array<{ variant_id?: unknown; stock_status?: unknown }>) : [];
      const stock = Object.fromEntries(
        rows.filter((r) => typeof r.variant_id === 'string' && isStockStatus(r.stock_status)).map((r) => [r.variant_id as string, r.stock_status as StockStatus]),
      );
      return {
        message: 'Столько нет в наличии — количество в корзине уменьшено, закончившиеся товары убраны. Проверьте заказ.',
        reconcile: { stock },
      };
    }
    case 'stock_check_limited': {
      const sec = Number((d as { retry_after_sec?: number } | null)?.retry_after_sec ?? 0);
      const wait = sec > 0 ? ` через ${Math.max(1, Math.ceil(sec / 60))} мин.` : ' позже.';
      return { message: `Слишком много попыток заказать больше, чем есть в наличии. Попробуйте ещё раз${wait}` };
    }
    case 'price_changed': {
      const prices = (d as { prices?: Array<{ variant_id: string; unit_price_minor: number }> } | null)?.prices ?? [];
      return {
        message: 'Цены изменились — корзина обновлена. Проверьте сумму и подтвердите заказ.',
        reconcile: { prices: Object.fromEntries(prices.map((p) => [p.variant_id, p.unit_price_minor])) },
      };
    }
    case 'item_unavailable':
      return {
        message: 'Некоторые товары больше недоступны и удалены из корзины.',
        removeVariantIds: Array.isArray(d) ? (d as string[]) : [],
      };
    case 'currency_mismatch':
      return { message: 'Валюта магазина изменилась. Обновите страницу.' };
    case 'idempotency_conflict':
      return { message: 'Данные заказа изменились. Нажмите «Оформить» ещё раз.', resetIdempotencyKey: true };
    case 'rate_limited': {
      const sec = Number((d as { retry_after_sec?: number } | null)?.retry_after_sec ?? 0);
      const wait = sec > 0 ? ` через ${Math.max(1, Math.ceil(sec / 60))} мин.` : ' позже.';
      return { message: `Слишком много заказов за короткое время. Попробуйте ещё раз${wait}` };
    }
    case 'too_many_open_orders':
      return { message: 'У вас уже есть несколько необработанных заказов в этом магазине. Дождитесь, пока продавец их подтвердит.' };
    case 'order_too_large': {
      const max = Number((d as { max_units?: number } | null)?.max_units ?? 0);
      return {
        message: max > 0
          ? `Слишком большой заказ: не более ${max} шт. в одном заказе. Для крупной покупки свяжитесь с магазином.`
          : 'Слишком большой заказ. Для крупной покупки свяжитесь с магазином.',
      };
    }
    case 'invalid_body':
    case 'invalid_comment':
      return { message: 'Проверьте поля формы.' };
    default:
      return { message: 'Не удалось оформить заказ. Попробуйте позже.' };
  }
}
