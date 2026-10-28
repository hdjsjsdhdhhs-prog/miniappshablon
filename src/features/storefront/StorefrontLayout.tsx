import { Outlet, ScrollRestoration, useParams } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { useCart } from '@/features/cart/useCart';
import { useTelegramBackButton } from '@/features/telegram/useTelegramBackButton';
import { ThemeScope } from '@/features/theme/ThemeScope';
import { NotFoundError, type Shop } from './api';
import { BottomNav } from './components/BottomNav';
import { DemoBannerText } from './components/DemoBannerText';
import { useShopQuery } from './hooks';
import { ShopContext } from './shop-context';

function ShopFrame({ shop }: { shop: Shop }) {
  const cart = useCart(shop.id);
  return (
    <div className="pb-nav mx-auto min-h-dvh max-w-3xl">
      {(shop.isDemo || shop.mode === 'preview') && (
        // Fixed 32 px, one line, never wider than the screen: the text can not grow the bar or the page.
        // Compact padding / gap: the DEMO text budget (see DemoBannerText) counts on 298 px inside a 320 px screen.
        <div
          className="glass-bar sticky top-0 z-30 flex h-8 items-center justify-center gap-1 overflow-hidden border-x-0 border-t-0 border-b-[color:var(--glass-accent-edge)] px-1.5 text-xs font-medium whitespace-nowrap text-foreground"
          data-testid="demo-banner"
        >
          {shop.mode === 'preview' ? (
            <>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_var(--glass-accent-glow)]" />
              <span className="min-w-0 truncate">Предпросмотр: магазин не опубликован, заказы отключены</span>
            </>
          ) : (
            <>
              {/* Reddish glowing "live" dot, left of the text start. */}
              <span
                aria-hidden
                data-testid="demo-banner-dot"
                className="size-1.5 shrink-0 rounded-full bg-[#ff5a5f] shadow-[0_0_6px_1px_rgba(255,90,95,0.85),0_0_0_3px_rgba(255,90,95,0.18)]"
              />
              <DemoBannerText />
            </>
          )}
        </div>
      )}
      <Outlet />
      {/* New pages open at the top; going back (product → catalog) restores the previous scroll position. */}
      <ScrollRestoration />
      <BottomNav slug={shop.slug} cartCount={cart.count} />
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
