import { InfoIcon, PackageIcon, TelegramLogoIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/domain/money';
import { isOrderStatus, ORDER_STATUS_LABELS } from '@/domain/order-status';
import { queryKeys } from '@/domain/query-keys';
import { ApiError, fetchMyOrders } from '@/features/cart/checkout-api';
import { FULFILLMENT_LABELS } from '@/features/cart/checkout-schema';
import { unverifiedTelegramUser } from '@/features/telegram/init-data-user';
import { getTelegramEnv } from '@/features/telegram/telegram';
import { ShopLogo } from '../components/ShopLogo';
import { buildDemoOrder, shouldShowDemoProfile } from '../demo-profile';
import { useProducts } from '../hooks';
import { useShop } from '../shop-context';

/* Shared building blocks: the demo mock-up and the real profile render the same header and order cards. */

function ProfileHeader({ avatar, name, children }: { avatar: ReactNode; name: string; children?: ReactNode }) {
  return (
    <header className="glass-panel flex items-center gap-3 rounded-2xl p-4">
      {avatar}
      <div className="min-w-0">
        <h1 className="truncate font-semibold">{name}</h1>
        {children}
      </div>
    </header>
  );
}

interface OrderLineView {
  key: string;
  name: string;
  variantLabel: string;
  quantity: number;
  lineTotalMinor: number;
}

function OrderCard({
  title,
  status,
  meta,
  lines,
  totalMinor,
  currency,
  testId,
}: {
  title: string;
  status: string;
  meta: ReactNode;
  lines: readonly OrderLineView[];
  totalMinor: number;
  currency: string;
  testId: string;
}) {
  return (
    <li className="glass-card space-y-2 rounded-xl p-4" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{title}</span>
        <Badge variant={status === 'cancelled' ? 'destructive' : 'secondary'}>
          {isOrderStatus(status) ? ORDER_STATUS_LABELS[status] : status}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{meta}</p>
      <ul className="space-y-1 text-sm">
        {lines.map((i) => (
          <li key={i.key} className="flex justify-between gap-2">
            <span className="min-w-0">
              {i.name}
              {i.variantLabel && <span className="text-muted-foreground"> · {i.variantLabel}</span>} × {i.quantity}
            </span>
            <span className="tabular-nums">{formatMoney(i.lineTotalMinor, currency)}</span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between border-t pt-2 font-semibold">
        <span>Итого</span>
        <span className="tabular-nums">{formatMoney(totalMinor, currency)}</span>
      </p>
    </li>
  );
}

/**
 * DEMO shop (plain link or inside Telegram): a visual mock-up of the signed-in profile with the current shop's
 * logo and name and one in-memory "Тестовый заказ". It performs no sign-in and sends no write, checkout or
 * my-orders request — the only data it reads is the public catalog listing of this shop.
 */
function DemoProfile() {
  const shop = useShop();
  const products = useProducts(shop.id, { categoryId: null, search: '' });
  if (products.isPending) return <PageSpinner />;
  // Without a listing (error / empty shop) the order falls back to generic test lines.
  const order = buildDemoOrder(products.data?.pages[0]?.items ?? [], shop.currency);

  return (
    <main className="space-y-5 px-4 pt-4 pb-6" data-testid="demo-profile">
      <ProfileHeader
        name={shop.name}
        avatar={<ShopLogo name={shop.name} path={shop.logoPath} className="size-12 shrink-0 rounded-full ring-1 ring-(--glass-edge-strong)" />}
      >
        <Badge variant="outline" className="mt-1" data-testid="demo-profile-badge">
          Демо-профиль
        </Badge>
      </ProfileHeader>

      <div role="note" className="glass-card flex gap-3 rounded-xl p-3 text-sm text-muted-foreground">
        <InfoIcon aria-hidden weight="fill" className="mt-0.5 size-5 shrink-0 text-(--telegram-blue)" />
        <p>
          Это демонстрация: так будет выглядеть профиль покупателя после входа через Telegram. Вход не выполнен, аккаунт
          не создан, заказ ниже — пример и нигде не сохраняется.
        </p>
      </div>

      <section aria-labelledby="orders-title" className="space-y-3">
        <h2 id="orders-title" className="text-lg font-semibold">
          Мои заказы
        </h2>
        <ul className="space-y-3">
          <OrderCard
            testId="demo-order"
            title={order.title}
            status={order.status}
            meta="Пример заказа · не сохраняется"
            lines={order.lines}
            totalMinor={order.totalMinor}
            currency={order.currency}
          />
        </ul>
      </section>
    </main>
  );
}

export function ProfilePage() {
  const shop = useShop();
  return shouldShowDemoProfile(shop) ? <DemoProfile /> : <TelegramProfile />;
}

/** Real buyer profile: orders come from the my-orders Edge Function, which verifies the Telegram initData. */
function TelegramProfile() {
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
      <ProfileHeader
        name={user.first_name ?? 'Покупатель'}
        avatar={
          <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-lg font-bold text-primary-foreground" aria-hidden>
            {(user.first_name ?? '?').slice(0, 1).toUpperCase()}
          </span>
        }
      >
        {user.username && <p className="text-sm text-muted-foreground">@{user.username}</p>}
      </ProfileHeader>

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
              <OrderCard
                key={o.id}
                testId="my-order"
                title={`Заказ №${o.order_number}`}
                status={o.status}
                meta={
                  <>
                    {new Date(o.created_at).toLocaleString('ru-RU')}
                    {o.fulfillment_method && ` · ${FULFILLMENT_LABELS[o.fulfillment_method]}`}
                  </>
                }
                lines={o.items.map((i) => ({
                  key: i.id,
                  name: i.product_name,
                  variantLabel: i.variant_label,
                  quantity: i.quantity,
                  lineTotalMinor: i.line_total_minor,
                }))}
                totalMinor={o.total_minor}
                currency={o.currency}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
