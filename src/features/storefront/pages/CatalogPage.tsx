import { MagnifyingGlassIcon } from '@phosphor-icons/react';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { EmptyState, ErrorState, ProductGridSkeleton, StaleDataNotice } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { CategoryChips } from '../components/CategoryChips';
import { ProductCard } from '../components/ProductCard';
import { SearchBox } from '../components/SearchBox';
import { useCategories, useProducts } from '../hooks';
import { useShop } from '../shop-context';

export function CatalogPage() {
  const shop = useShop();
  const [params, setParams] = useSearchParams();
  const categorySlug = params.get('category');
  const search = params.get('q') ?? '';
  const categories = useCategories(shop.id);

  const category = useMemo(
    () => categories.data?.find((c) => c.slug === categorySlug) ?? null,
    [categories.data, categorySlug],
  );
  const products = useProducts(shop.id, { categoryId: category?.id ?? null, search });

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
        { replace: true },
      );
    },
    [setParams],
  );
  const onSearch = useCallback((q: string) => update({ q }), [update]);

  const items = products.data?.pages.flatMap((p) => p.items) ?? [];
  // While categories load, a category filter from the URL cannot be resolved yet.
  const waitingForCategory = !!categorySlug && categories.isPending;

  return (
    <main className="space-y-3 pb-4">
      <div className="sticky top-0 z-20 space-y-3 bg-background/95 pt-4 pb-2 backdrop-blur-sm">
        <h1 className="px-4 text-xl font-bold">Каталог</h1>
        <div className="px-4">
          <SearchBox value={search} onChange={onSearch} />
        </div>
        {categories.data && categories.data.length > 0 && (
          <CategoryChips categories={categories.data} selected={category?.slug ?? null} onSelect={(slug) => update({ category: slug })} />
        )}
      </div>

      {products.isError && products.data && <StaleDataNotice onRetry={() => void products.refetch()} />}

      {products.isPending || waitingForCategory ? (
        <ProductGridSkeleton />
      ) : products.isError && !products.data ? (
        <ErrorState onRetry={() => void products.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<MagnifyingGlassIcon />}
          title={search ? `Ничего не найдено по запросу «${search}»` : 'В этой категории пока нет товаров'}
          action={
            (search || category) && (
              <Button variant="outline" onClick={() => update({ q: '', category: null })}>
                Сбросить фильтры
              </Button>
            )
          }
        />
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
    </main>
  );
}
