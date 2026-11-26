import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { BONUS_UNIT_MINOR, formatBonuses } from '@/domain/loyalty';
import { formatMoney } from '@/domain/money';
import { isOrderStatus, ORDER_STATUS_LABELS, ORDER_TRANSITIONS, type OrderStatus } from '@/domain/order-status';
import { queryKeys } from '@/domain/query-keys';
import { cn } from '@/lib/utils';
import { useAdminShop } from '../admin-context';
import { fetchAdminOrders, setOrderStatus, type AdminOrder } from '../api';
import { loyaltyApi } from '../functions-api';

const FILTERS: Array<{ value: OrderStatus | 'active' | 'all'; label: string }> = [
  { value: 'active', label: 'В работе' },
  { value: 'new', label: 'Новые' },
  { value: 'confirmed', label: 'Подтверждённые' },
  { value: 'ready', label: 'Готовы' },
  { value: 'completed', label: 'Завершённые' },
  { value: 'cancelled', label: 'Отменённые' },
  { value: 'all', label: 'Все' },
];

const ACTION_LABELS: Record<OrderStatus, string> = {
  new: 'Новый',
  confirmed: 'Подтвердить',
  ready: 'Готов к выдаче',
  completed: 'Завершить',
  cancelled: 'Отменить',
};

/** What the discount of an order was: «Скидка за сумму заказа 5% (от 3 000 ₽)» / «Промокод WELCOME300». */
function discountTitle(order: AdminOrder): string {
  const info = (order.discount_info ?? {}) as { percent?: number | null; min_total_minor?: number; code?: string; kind?: string; fixed_minor?: number | null };
  if (order.discount_type === 'promo') {
    const value = info.kind === 'percent' ? `${info.percent}%` : formatMoney(info.fixed_minor ?? 0, order.currency);
    return `Промокод ${info.code ?? ''} (${value})`;
  }
  return `Скидка за сумму заказа ${info.percent ?? ''}%${info.min_total_minor ? ` (от ${formatMoney(info.min_total_minor, order.currency)})` : ''}`;
}

/** Every discount and the bonuses spent / credited, so the administrator sees how the total was formed. Nothing for a plain order. */
function OrderPriceBreakdown({ order }: { order: AdminOrder }) {
  const hasBreakdown = order.items_total_minor != null && (order.discount_minor > 0 || order.bonus_spent > 0);
  if (!hasBreakdown && order.bonus_accrued == null) return null;
  return (
    <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm" data-testid="admin-order-breakdown">
      {hasBreakdown && (
        <>
          <p className="flex justify-between gap-2">
            <span className="text-muted-foreground">Сумма товаров</span>
            <span className="tabular-nums">{formatMoney(order.items_total_minor!, order.currency)}</span>
          </p>
          {order.discount_minor > 0 && (
            <p className="flex justify-between gap-2" data-testid="admin-order-discount">
              <span>{discountTitle(order)}</span>
              <span className="tabular-nums">−{formatMoney(order.discount_minor, order.currency)}</span>
            </p>
          )}
          {order.bonus_spent > 0 && (
            <p className="flex justify-between gap-2" data-testid="admin-order-bonus-spent">
              <span>Оплачено бонусами ({formatBonuses(order.bonus_spent)})</span>
              <span className="tabular-nums">−{formatMoney(order.bonus_spent * BONUS_UNIT_MINOR, order.currency)}</span>
            </p>
          )}
        </>
      )}
      {order.bonus_accrued != null && (
        <p className="text-emerald-500" data-testid="admin-order-bonus-accrued">
          Покупателю начислено {formatBonuses(order.bonus_accrued)}
        </p>
      )}
    </div>
  );
}

function OrderCard({ order, onChange }: { order: AdminOrder; onChange: (s: OrderStatus) => void }) {
  const status = isOrderStatus(order.status) ? order.status : 'new';
  const snapshot = order.customer_snapshot as { username?: string | null; first_name?: string | null };
  return (
    <li className="space-y-3 rounded-lg border bg-card p-4" data-testid="admin-order">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Заказ №{order.order_number}</span>
        <Badge variant={status === 'cancelled' ? 'destructive' : 'secondary'}>{ORDER_STATUS_LABELS[status]}</Badge>
        {order.is_test && <Badge variant="outline">тестовый</Badge>}
        <span className="ml-auto text-sm text-muted-foreground">{new Date(order.created_at).toLocaleString('ru-RU')}</span>
      </div>
      <div className="space-y-1 text-sm">
        <p>
          {/* New orders: verified Telegram name only; legacy orders also carry the typed name/phone. */}
          {order.contact_name ?? snapshot.first_name ?? 'Покупатель'}
          {order.contact_phone && <> · <a className="underline" href={`tel:${order.contact_phone}`}>{order.contact_phone}</a></>}
          {snapshot.username && <> · <a className="underline" href={`https://t.me/${snapshot.username}`} target="_blank" rel="noreferrer">@{snapshot.username}</a></>}
        </p>
        {order.fulfillment_method === 'delivery' && (
          <p data-testid="admin-order-fulfillment">
            <span className="text-muted-foreground">Доставка:</span> <span className="break-words">{order.delivery_address}</span>
          </p>
        )}
        {order.fulfillment_method === 'pickup' && (
          <p data-testid="admin-order-fulfillment">
            <span className="text-muted-foreground">Получение:</span> самовывоз
          </p>
        )}
        {order.comment && <p className="text-muted-foreground">«{order.comment}»</p>}
      </div>
      <ul className="divide-y rounded-md border text-sm">
        {order.order_items.map((i) => (
          <li key={i.id} className="flex justify-between gap-2 px-3 py-2">
            <span>
              {i.product_name}
              {i.variant_label && <span className="text-muted-foreground"> · {i.variant_label}</span>}
              <span className="text-muted-foreground">
                {' · '}
                {/* The charged price is the snapshot taken at checkout; a discounted line also keeps its list price. */}
                {i.original_unit_price_minor != null && <s className="mr-1">{formatMoney(i.original_unit_price_minor, order.currency)}</s>}
                {formatMoney(i.unit_price_minor, order.currency)} × {i.quantity}
              </span>
            </span>
            <span className="tabular-nums">{formatMoney(i.line_total_minor, order.currency)}</span>
          </li>
        ))}
      </ul>
      <OrderPriceBreakdown order={order} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold tabular-nums">Итого {formatMoney(order.total_minor, order.currency)}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {ORDER_TRANSITIONS[status].map((to) => (
            <Button key={to} size="sm" variant={to === 'cancelled' ? 'outline' : 'default'} onClick={() => onChange(to)}>
              {ACTION_LABELS[to]}
            </Button>
          ))}
        </div>
      </div>
    </li>
  );
}

export function OrdersPage() {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get('status') ?? 'active';
  const filter = (FILTERS.find((f) => f.value === raw)?.value ?? 'active') as OrderStatus | 'active' | 'all';
  const orders = useQuery({ queryKey: queryKeys.adminOrders(shop.id, filter), queryFn: () => fetchAdminOrders(shop.id, filter), refetchInterval: 30_000 });
  const [confirmCancel, setConfirmCancel] = useState<AdminOrder | null>(null);

  const change = useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrderStatus }) => setOrderStatus(id, status),
    onSuccess: (order, { status }) => {
      // The bonuses are credited by the confirmation itself (in the database); the message to the buyer is sent right after.
      const accrued = (order as { bonus_accrued?: number | null } | null)?.bonus_accrued ?? 0;
      if (status === 'confirmed' && accrued > 0) {
        toast.success(`Статус обновлён. Покупателю начислено ${formatBonuses(accrued)}`);
        void loyaltyApi.dispatch(shop.id).catch(() => undefined);
      } else {
        toast.success('Статус обновлён');
      }
      void qc.invalidateQueries({ queryKey: ['admin', 'shop', shop.id] });
      void qc.invalidateQueries({ queryKey: ['shop', shop.id] });
    },
    onError: (e) => toast.error((e as Error).message === 'invalid_transition' ? 'Такой переход статуса недопустим' : (e as Error).message),
  });

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Фильтр заказов" className="scrollbar-none flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={filter === f.value}
            onClick={() => setParams({ status: f.value }, { replace: true })}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm whitespace-nowrap',
              filter === f.value ? 'border-foreground bg-foreground text-background' : 'bg-card',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      {orders.isPending ? (
        <PageSpinner />
      ) : orders.isError ? (
        <ErrorState onRetry={() => void orders.refetch()} />
      ) : orders.data.length === 0 ? (
        <EmptyState title="Заказов нет" />
      ) : (
        <ul className="space-y-3">
          {orders.data.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              onChange={(status) => (status === 'cancelled' ? setConfirmCancel(o) : change.mutate({ id: o.id, status }))}
            />
          ))}
        </ul>
      )}
      <Dialog open={!!confirmCancel} onOpenChange={(o) => !o && setConfirmCancel(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Отменить заказ №{confirmCancel?.order_number}?</DialogTitle>
            <DialogDescription>Товары вернутся на склад. Действие нельзя отменить.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmCancel(null)}>
              Назад
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmCancel) change.mutate({ id: confirmCancel.id, status: 'cancelled' });
                setConfirmCancel(null);
              }}
            >
              Отменить заказ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
