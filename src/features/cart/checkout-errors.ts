import { ApiError } from './checkout-api';

export interface CheckoutErrorView {
  message: string;
  /** Server-confirmed updates to apply to the local cart. */
  reconcile?: { prices?: Record<string, number>; available?: Record<string, number> };
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
      const rows = Array.isArray(d) ? (d as Array<{ variant_id: string; available: number }>) : [];
      return {
        message: 'Часть товаров закончилась — количество в корзине уменьшено. Проверьте заказ.',
        reconcile: { available: Object.fromEntries(rows.map((r) => [r.variant_id, r.available])) },
      };
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
    case 'invalid_body':
    case 'invalid_comment':
      return { message: 'Проверьте поля формы.' };
    default:
      return { message: 'Не удалось оформить заказ. Попробуйте позже.' };
  }
}
