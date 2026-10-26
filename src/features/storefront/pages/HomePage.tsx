import {
  ClockIcon,
  CreditCardIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  PackageIcon,
  PhoneIcon,
  TelegramLogoIcon,
  TruckIcon,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ErrorState, ProductGridSkeleton, StaleDataNotice } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { publicImageUrl } from '@/lib/supabase';
import { CategoryTiles } from '../components/CategoryTiles';
import type { ProductDetail } from '../api';
import { ProductCard } from '../components/ProductCard';
import { QuickAddSheet } from '../components/QuickAddSheet';
import { SearchBox } from '../components/SearchBox';
import { ShopLogo } from '../components/ShopLogo';
import { TelegramChannelButton } from '../components/TelegramChannelButton';
import { useCategories, useProducts } from '../hooks';
import { useShop } from '../shop-context';

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  if (!value) return null;
  return (
    <div className="flex gap-3">
      <span aria-hidden className="mt-0.5 text-primary [&_svg]:size-5">
        {icon}
      </span>
      <div>
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="text-sm">{value}</dd>
      </div>
    </div>
  );
}

/**
 * Shop home = category picker + product list. The selected category and the search query live in the
 * URL (`?category=<slug>&q=<text>`, replace-navigation) so they survive opening a product and going back,
 * and old `/catalog?category=…` deep links keep working through a redirect.
 */
export function HomePage() {
  const shop = useShop();
  const [params, setParams] = useSearchParams();
  const categorySlug = params.get('category');
  const search = params.get('q') ?? '';
  const showCategories = shop.settings.showCategories;
  const categories = useCategories(shop.id);
  const cover = publicImageUrl(shop.coverPath);
  const info = shop.info;
  // The channel link lives in the header, so it alone does not make the "О магазине" block appear.
  const hasInfo =
    shop.settings.showInfo && [info.address, info.hours, info.delivery, info.payment, info.phone, info.telegram].some(Boolean);

  // An unknown/archived slug in the URL falls back to "all products".
  const category = useMemo(
    () => (showCategories ? (categories.data?.find((c) => c.slug === categorySlug) ?? null) : null),
    [showCategories, categories.data, categorySlug],
  );
  // While categories load, a category filter from the URL cannot be resolved yet.
  const waitingForCategory = showCategories && !!categorySlug && categories.isPending;
  const products = useProducts(shop.id, { categoryId: category?.id ?? null, search });
  const items = products.data?.pages.flatMap((p) => p.items) ?? [];

  const update = useCallback(
    (next: { category?: string | null; q?: string }) => {
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next.category !== undefined) {
            if (next.category) p.set('category', next.category);
            else p.delete('category');
          }
          if (next.q !== undefined) {
            if (next.q) p.set('q', next.q);
            else p.delete('q');
          }
          return p;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );
  const onSearch = useCallback((q: string) => update({ q }), [update]);

  // Quick flavor picker over the catalog. `seq` remounts it on every open, so a previous choice never leaks;
  // the product stays set after closing so the sheet can play its exit animation.
  const [quickAdd, setQuickAdd] = useState<{ product: ProductDetail; seq: number } | null>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const openQuickAdd = useCallback((product: ProductDetail) => {
    setQuickAdd((prev) => ({ product, seq: (prev?.seq ?? 0) + 1 }));
    setQuickAddOpen(true);
  }, [setQuickAdd, setQuickAddOpen]);

  const listTitle = category?.name ?? 'Все товары';

  return (
    <main className="space-y-6 pb-6">
      <header className="relative">
        {cover && (
          <div aria-hidden className="relative h-40 overflow-hidden sm:h-52">
            <img src={cover} alt="" className="size-full object-cover" />
            {/* The cover melts into the scene so the brand panel can sit on it. */}
            <div className="absolute inset-0 bg-linear-to-b from-transparent from-35% to-background" />
          </div>
        )}
        {/* Brand panel: real glass over the cover (or over the scene light when there is no cover). */}
        <div className={cover ? 'relative -mt-16 px-4' : 'px-4 pt-5'}>
          <div className="glass-panel rounded-2xl p-4">
            <div className="flex items-center gap-3.5 sm:gap-4">
              <ShopLogo
                name={shop.name}
                path={shop.logoPath}
                className="size-16 shrink-0 rounded-2xl shadow-(--glass-shadow) ring-1 ring-(--glass-edge-strong) max-[359px]:size-14 sm:size-20"
              />
              {/* Title + channel link stack next to the logo; without a link the title stays centred on it.
                  Benzin is a wide display face (~0.67 em per letter): the size follows the viewport so that a
                  one-word name still fits the column on a 320 px phone, and is capped on wide screens. */}
              <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <h1 className="font-brand line-clamp-2 max-w-full text-[clamp(1.25rem,6.4vw,2rem)] leading-[1.1] font-semibold text-balance break-words">
                  {shop.name}
                </h1>
                <TelegramChannelButton url={info.telegramChannelUrl} label={info.telegramChannelLabel} />
              </div>
            </div>
            {shop.description && (
              <p className="mt-3 text-sm leading-relaxed text-pretty break-words text-muted-foreground">{shop.description}</p>
            )}
          </div>
        </div>
      </header>

      {/* Search and category tiles form one filter block: the same 12 px rhythm as the gap between tiles
          (no visible "Категории" heading — the tile list is labelled for assistive tech instead). */}
      <div className="space-y-3">
        <div className="px-4">
          <SearchBox value={search} onChange={onSearch} />
        </div>

        {showCategories &&
          (categories.isPending ? (
            <ProductGridSkeleton count={4} />
          ) : categories.isError && !categories.data ? (
            <ErrorState onRetry={() => void categories.refetch()} />
          ) : (
            <CategoryTiles
              categories={categories.data}
              selected={category?.slug ?? null}
              onSelect={(slug) => update({ category: slug })}
            />
          ))}
      </div>

      <section aria-labelledby="products-title" aria-busy={products.isFetching} className="space-y-3">
        <div className="flex min-h-10 items-center justify-between gap-3 px-4">
          <h2 id="products-title" className="flex min-w-0 items-center gap-2.5 text-xl font-semibold tracking-tight" data-testid="products-title">
            <span aria-hidden className="h-5 w-1 shrink-0 rounded-full bg-primary shadow-[0_0_10px_var(--glass-accent-glow)]" />
            <span className="truncate">{listTitle}</span>
          </h2>
          {category && (
            <button
              type="button"
              className="glass-panel glass-transition glass-press inline-flex h-10 shrink-0 items-center rounded-full px-4 text-sm font-medium text-primary hover:border-(--glass-accent-edge)"
              onClick={() => update({ category: null })}
            >
              Все товары
            </button>
          )}
        </div>

        {products.isError && products.data && <StaleDataNotice onRetry={() => void products.refetch()} />}

        {products.isPending || waitingForCategory ? (
          <ProductGridSkeleton count={4} />
        ) : products.isError && !products.data ? (
          <ErrorState onRetry={() => void products.refetch()} />
        ) : items.length === 0 ? (
          search ? (
            <EmptyState
              icon={<MagnifyingGlassIcon />}
              title={`Ничего не найдено по запросу «${search}»`}
              description={category ? `В категории «${category.name}» нет подходящих товаров в наличии.` : 'Попробуйте изменить запрос.'}
              action={
                <Button variant="outline" onClick={() => update({ q: '' })}>
                  Сбросить поиск
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<PackageIcon />}
              title={category ? `В категории «${category.name}» сейчас нет товаров в наличии` : 'Сейчас нет товаров в наличии'}
              description={category ? 'Загляните позже или выберите другую категорию.' : 'Загляните позже.'}
              action={
                category && (
                  <Button variant="outline" onClick={() => update({ category: null })}>
                    Показать все товары
                  </Button>
                )
              }
            />
          )
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3 lg:grid-cols-4" data-testid="product-grid">
              {items.map((p) => (
                <ProductCard key={p.id} product={p} slug={shop.slug} currency={shop.currency} onAddToCart={openQuickAdd} />
              ))}
            </div>
            {products.hasNextPage && (
              <div className="px-4">
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={products.isFetchingNextPage}
                  onClick={() => void products.fetchNextPage()}
                >
                  {products.isFetchingNextPage ? 'Загрузка…' : 'Показать ещё'}
                </Button>
              </div>
            )}
          </>
        )}
      </section>

      {hasInfo && (
        <section aria-labelledby="info-title" className="glass-panel mx-4 space-y-3 rounded-2xl p-4">
          <h2 id="info-title" className="font-semibold">
            О магазине
          </h2>
          <dl className="space-y-3">
            <InfoRow icon={<MapPinIcon />} label="Адрес" value={info.address} />
            <InfoRow icon={<ClockIcon />} label="Часы работы" value={info.hours} />
            <InfoRow icon={<TruckIcon />} label="Получение" value={info.delivery} />
            <InfoRow icon={<CreditCardIcon />} label="Оплата" value={info.payment} />
            <InfoRow icon={<PhoneIcon />} label="Телефон" value={info.phone} />
            <InfoRow icon={<TelegramLogoIcon />} label="Telegram" value={info.telegram} />
          </dl>
        </section>
      )}

      {/* shop.legalNotice / ageRestriction stay in the data and the admin; the storefront does not show an age
          notice or an age gate. */}
      {quickAdd && (
        <QuickAddSheet key={quickAdd.seq} product={quickAdd.product} open={quickAddOpen} onOpenChange={setQuickAddOpen} />
      )}
    </main>
  );
}
