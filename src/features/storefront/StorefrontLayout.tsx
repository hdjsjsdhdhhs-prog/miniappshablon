import { Outlet, useParams } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { useCart } from '@/features/cart/useCart';
import { useTelegramBackButton } from '@/features/telegram/useTelegramBackButton';
import { ThemeScope } from '@/features/theme/ThemeScope';
import { NotFoundError, type Shop } from './api';
import { AgeGate } from './components/AgeGate';
import { BottomNav } from './components/BottomNav';
import { useShopQuery } from './hooks';
import { ShopContext } from './shop-context';

function ShopFrame({ shop }: { shop: Shop }) {
  const cart = useCart(shop.id);
  return (
    <div className="pb-nav mx-auto min-h-dvh max-w-3xl">
      {(shop.isDemo || shop.mode === 'preview') && (
        <div
          className="glass-bar sticky top-0 z-30 flex items-center justify-center gap-2 border-x-0 border-t-0 border-b-[color:var(--glass-accent-edge)] px-4 py-1.5 text-center text-xs font-medium text-foreground"
          data-testid="demo-banner"
        >
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_var(--glass-accent-glow)]" />
          <span>
            {shop.mode === 'preview'
              ? 'Предпросмотр: магазин не опубликован, заказы отключены'
              : 'DEMO-витрина: товары вымышлены, заказы тестовые'}
          </span>
        </div>
      )}
      <Outlet />
      <BottomNav slug={shop.slug} cartCount={cart.count} />
      <AgeGate shopId={shop.id} age={shop.ageRestriction} legalNotice={shop.legalNotice} />
    </div>
  );
}

function StorefrontShell({ slug }: { slug: string }) {
  const shopQuery = useShopQuery(slug);
  useTelegramBackButton(`/s/${slug}/`);

  if (shopQuery.isPending) {
    return (
      <ThemeScope theme={DARK_PREMIUM_THEME}>
        <PageSpinner />
      </ThemeScope>
    );
  }
  if (!shopQuery.data) {
    return (
      <ThemeScope theme={DARK_PREMIUM_THEME}>
        {shopQuery.error instanceof NotFoundError ? (
          <EmptyState
            title="Магазин не найден"
            description="Проверьте ссылку или откройте магазин из Telegram."
            className="min-h-dvh justify-center"
          />
        ) : (
          <ErrorState onRetry={() => void shopQuery.refetch()} className="min-h-dvh justify-center" />
        )}
      </ThemeScope>
    );
  }
  const shop = shopQuery.data;
  return (
    <ShopContext.Provider value={shop}>
      <ThemeScope theme={shop.theme}>
        <ShopFrame shop={shop} />
      </ThemeScope>
    </ShopContext.Provider>
  );
}

export function StorefrontLayout() {
  const { slug = '' } = useParams();
  // `key` gives every shop a fresh subtree: no component state leaks between tenants.
  return <StorefrontShell key={slug} slug={slug} />;
}
