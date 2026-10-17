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
import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ErrorState, ProductGridSkeleton, StaleDataNotice } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { publicImageUrl } from '@/lib/supabase';
import { CategoryTiles } from '../components/CategoryTiles';
import { ProductCard } from '../components/ProductCard';
import { SearchBox } from '../components/SearchBox';
import { ShopLogo } from '../components/ShopLogo';
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
  const hasInfo = shop.settings.showInfo && Object.values(info).some(Boolean);

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

  const listTitle = category?.name ?? 'Все товары';

  return (
    <main className="space-y-6 pb-6">
      <header className="relative">
        {cover && <img src={cover} alt="" aria-hidden className="h-36 w-full object-cover sm:h-48" />}
        <div className={cover ? '-mt-8 px-4' : 'px-4 pt-6'}>
          <div className="flex items-end gap-3">
            <ShopLogo name={shop.name} path={shop.logoPath} className="size-16 border-4 border-background" />
            <div className="min-w-0 pb-1">
              <h1 className="truncate text-xl font-bold">{shop.name}</h1>
            </div>
          </div>
          {shop.description && <p className="mt-2 text-sm text-muted-foreground">{shop.description}</p>}
        </div>
      </header>

      <div className="px-4">
        <SearchBox value={search} onChange={onSearch} />
      </div>

      {showCategories && (
        <section aria-labelledby="cats-title" className="space-y-3">
          <h2 id="cats-title" className="px-4 text-lg font-semibold">
            Категории
          </h2>
          {categories.isPending ? (
            <ProductGridSkeleton count={4} />
          ) : categories.isError && !categories.data ? (
            <ErrorState onRetry={() => void categories.refetch()} />
          ) : (
            <CategoryTiles
              categories={categories.data}
              selected={category?.slug ?? null}
              onSelect={(slug) => update({ category: slug })}
            />
          )}
        </section>
      )}

      <section aria-labelledby="products-title" aria-busy={products.isFetching} className="space-y-3">
        <div className="flex min-h-9 items-center justify-between gap-3 px-4">
          <h2 id="products-title" className="truncate text-lg font-semibold" data-testid="products-title">
            {listTitle}
          </h2>
          {category && (
            <Button variant="ghost" size="sm" className="shrink-0 text-primary" onClick={() => update({ category: null })}>
              Все товары
            </Button>
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
                <ProductCard key={p.id} product={p} slug={shop.slug} currency={shop.currency} />
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
        <section aria-labelledby="info-title" className="mx-4 space-y-3 rounded-lg border bg-card p-4">
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

      {shop.legalNotice && <p className="px-4 text-xs text-muted-foreground">{shop.legalNotice}</p>}
    </main>
  );
}
