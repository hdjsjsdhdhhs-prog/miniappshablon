import { PackageIcon, TelegramLogoIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/domain/money';
import { isOrderStatus, ORDER_STATUS_LABELS } from '@/domain/order-status';
import { queryKeys } from '@/domain/query-keys';
import { ApiError, fetchMyOrders } from '@/features/cart/checkout-api';
import { unverifiedTelegramUser } from '@/features/telegram/init-data-user';
import { getTelegramEnv } from '@/features/telegram/telegram';
import { useShop } from '../shop-context';

export function ProfilePage() {
  const shop = useShop();
  const tg = getTelegramEnv();
  const query = useQuery({
    queryKey: queryKeys.myOrders(shop.id, unverifiedTelegramUser(tg.rawInitData).id),
    queryFn: () => fetchMyOrders(tg.rawInitData ?? '', shop.slug),
    enabled: tg.inTelegram && !!tg.rawInitData,
    retry: (n, e) => !(e instanceof ApiError && e.status === 401) && n < 2,
  });

  if (!tg.inTelegram || !tg.rawInitData) {
    return (
      <main className="px-4 py-10">
        <EmptyState
          icon={<TelegramLogoIcon />}
          title="Профиль доступен в Telegram"
          description="Мы определяем покупателя по подтверждённому Telegram-аккаунту — без паролей и регистрации. Откройте магазин через бота."
        />
      </main>
    );
  }
  if (query.isPending) return <PageSpinner />;
  if (query.isError) {
    const authFailed = query.error instanceof ApiError && query.error.status === 401;
    return (
      <ErrorState
        title={authFailed ? 'Сессия Telegram устарела' : undefined}
        description={authFailed ? 'Закройте и снова откройте магазин в Telegram.' : undefined}
        onRetry={authFailed ? undefined : () => void query.refetch()}
      />
    );
  }

  const { user, orders } = query.data;
  return (
    <main className="space-y-5 px-4 pt-4 pb-6">
      <header className="flex items-center gap-3 rounded-lg border bg-card p-4">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground" aria-hidden>
          {(user.first_name ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <div>
          <h1 className="font-semibold">{user.first_name ?? 'Покупатель'}</h1>
          {user.username && <p className="text-sm text-muted-foreground">@{user.username}</p>}
        </div>
      </header>

      <section aria-labelledby="orders-title" className="space-y-3">
        <h2 id="orders-title" className="text-lg font-semibold">
          Мои заказы
        </h2>
        {orders.length === 0 ? (
          <EmptyState
            icon={<PackageIcon />}
            title="Заказов пока нет"
            action={
              <Button asChild variant="outline">
                <Link to={`/s/${shop.slug}/`}>В каталог</Link>
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {orders.map((o) => (
              <li key={o.id} className="space-y-2 rounded-lg border bg-card p-4" data-testid="my-order">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold">Заказ №{o.order_number}</span>
                  <Badge variant={o.status === 'cancelled' ? 'destructive' : 'secondary'}>
                    {isOrderStatus(o.status) ? ORDER_STATUS_LABELS[o.status] : o.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(o.created_at).toLocaleString('ru-RU')}
                  {o.is_test && ' · тестовый'}
                </p>
                <ul className="space-y-1 text-sm">
                  {o.items.map((i) => (
                    <li key={i.id} className="flex justify-between gap-2">
                      <span className="min-w-0">
                        {i.product_name}
                        {i.variant_label && <span className="text-muted-foreground"> · {i.variant_label}</span>} × {i.quantity}
                      </span>
                      <span className="tabular-nums">{formatMoney(i.line_total_minor, o.currency)}</span>
                    </li>
                  ))}
                </ul>
                <p className="flex justify-between border-t pt-2 font-semibold">
                  <span>Итого</span>
                  <span className="tabular-nums">{formatMoney(o.total_minor, o.currency)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
