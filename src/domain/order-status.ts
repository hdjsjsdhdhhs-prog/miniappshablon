/** Order lifecycle. Mirrors public.order_status_transition_allowed() in SQL. */
export const ORDER_STATUSES = ['new', 'confirmed', 'ready', 'completed', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  new: ['confirmed', 'cancelled'],
  confirmed: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export const ORDER_STATUS_LABELS: Readonly<Record<OrderStatus, string>> = {
  new: 'Новый',
  confirmed: 'Подтверждён',
  ready: 'Готов к выдаче',
  completed: 'Завершён',
  cancelled: 'Отменён',
};

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

export function isActiveStatus(s: OrderStatus): boolean {
  return s === 'new' || s === 'confirmed' || s === 'ready';
}
