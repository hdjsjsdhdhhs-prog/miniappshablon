import type { HandoverProblem } from './functions-api';

/** Why a DEMO shop cannot be handed over yet (codes of private.shop_handover_problems), for the platform admin. */
export const HANDOVER_PROBLEMS: Record<HandoverProblem, string> = {
  shop_suspended: 'Магазин приостановлен (status ≠ active).',
  not_demo: 'Магазин уже не DEMO — для смены владельца используйте «Передать».',
  age_restriction: 'Возрастное ограничение должно быть не ниже 18+.',
  no_fulfillment: 'Не включён ни один способ получения (доставка / самовывоз) — включите в настройках магазина.',
  no_categories: 'Нет активных категорий.',
  no_products: 'Нет опубликованных товаров в наличии.',
};
