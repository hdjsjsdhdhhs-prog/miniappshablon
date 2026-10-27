import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/domain/money';
import { isOrderStatus, ORDER_STATUS_LABELS } from '@/domain/order-status';
import { queryKeys } from '@/domain/query-keys';
import { variantLabel } from '@/domain/variants';
import { useAdminShop } from '../admin-context';
import { fetchDashboardStats } from '../api';

export function DashboardPage() {
  const shop = useAdminShop();
  const stats = useQuery({ queryKey: queryKeys.adminStats(shop.id), queryFn: () => fetchDashboardStats(shop.id) });
  if (stats.isPending) return <PageSpinner />;
  if (stats.isError) return <ErrorState onRetry={() => void stats.refetch()} />;
  const s = stats.data;
  const tiles = [
    { label: 'Новые заказы', value: s.newOrders, to: 'orders?status=new' },
    { label: 'В работе', value: s.active, to: 'orders?status=active' },
    { label: 'Завершённые', value: s.completed, to: 'orders?status=completed' },
    { label: 'Нет в наличии (вариантов)', value: s.outOfStock.length, to: 'products' },
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="rounded-lg border bg-card p-4 hover:border-foreground/40">
            <p className="text-sm text-muted-foreground">{t.label}</p>
            <p className="text-2xl font-semibold tabular-nums" data-testid={`stat-${t.label}`}>
              {t.value}
            </p>
          </Link>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Последние заказы</CardTitle>
          </CardHeader>
          <CardContent>
            {s.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">Заказов пока нет.</p>
            ) : (
              <ul className="divide-y">
                {s.recent.map((o) => (
                  <li key={o.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                    <span>
                      №{o.order_number} · {o.contact_name ?? (o.customer_snapshot as { first_name?: string | null }).first_name ?? 'Покупатель'}
                      {o.fulfillment_method && ` · ${o.fulfillment_method === 'delivery' ? 'доставка' : 'самовывоз'}`}
                      {o.is_test && <Badge variant="outline" className="ml-2">тест</Badge>}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular-nums">{formatMoney(o.total_minor, o.currency)}</span>
                      <Badge variant="secondary">{isOrderStatus(o.status) ? ORDER_STATUS_LABELS[o.status] : o.status}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Закончились</CardTitle>
          </CardHeader>
          <CardContent>
            {s.outOfStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">Все активные варианты в наличии.</p>
            ) : (
              <ul className="divide-y text-sm">
                {s.outOfStock.map((v) => (
                  <li key={v.id} className="py-2">
                    <Link to={`products/${v.products.id}`} className="hover:underline">
                      {v.products.name}
                      {variantLabel(v) && <span className="text-muted-foreground"> · {variantLabel(v)}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
