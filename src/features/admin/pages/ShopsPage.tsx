import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { queryKeys } from '@/domain/query-keys';
import { ShopLogo } from '@/features/storefront/components/ShopLogo';
import { fetchMyShops } from '../api';
import { useSession } from '../auth';
import { AdminTopBar } from '../components/AdminTopBar';
import { ShopSearchInput } from '../components/ShopSearchInput';
import { ShopModeBadge, ShopQuickLinks } from '../components/ShopQuickLinks';
import { matchesShopSearch, storefrontPath } from '../shop-search';

const ROLE_LABELS: Record<string, string> = { owner: 'Владелец', manager: 'Менеджер' };

/** "Мои магазины": only the shops the signed-in account is a member of. */
export function ShopsPage() {
  const { session } = useSession();
  const shops = useQuery({ queryKey: queryKeys.adminShops(session?.user.id ?? ''), queryFn: fetchMyShops, enabled: !!session });
  const [query, setQuery] = useState('');
  const visible = useMemo(
    () => (shops.data ?? []).filter(({ shop }) => matchesShopSearch(query, shop.name, shop.slug)),
    [shops.data, query],
  );

  return (
    <main className="mx-auto max-w-4xl space-y-5 p-4">
      <AdminTopBar />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Мои магазины</h1>
        <ShopSearchInput value={query} onChange={setQuery} />
      </div>
      {shops.isPending ? (
        <PageSpinner />
      ) : shops.isError ? (
        <ErrorState onRetry={() => void shops.refetch()} />
      ) : shops.data.length === 0 ? (
        <EmptyState
          title="Нет доступных магазинов"
          description="Магазин появится здесь, когда администратор платформы назначит вас владельцем."
        />
      ) : visible.length === 0 ? (
        <EmptyState title="Ничего не найдено" description={`Нет магазинов по запросу «${query.trim()}».`} />
      ) : (
        <ul className="space-y-3" data-testid="my-shops">
          {visible.map(({ shop, role }) => (
            <li key={shop.id} className="space-y-3 rounded-lg border bg-card p-4" data-testid="my-shop">
              <div className="flex items-start gap-3">
                <ShopLogo name={shop.name} path={shop.logo_path} className="size-10 shrink-0 rounded-lg text-sm" />
                <div className="min-w-0 flex-1">
                  <Link to={`/admin/shops/${shop.slug}`} className="block truncate font-medium hover:underline">
                    {shop.name}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground">
                    <span className="font-mono text-xs">{storefrontPath(shop.slug)}</span>
                  </p>
                </div>
                <span className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <ShopModeBadge mode={shop.mode} />
                  {shop.is_demo && <Badge variant="outline">DEMO</Badge>}
                  <Badge variant="outline">{ROLE_LABELS[role] ?? role}</Badge>
                </span>
              </div>
              <ShopQuickLinks slug={shop.slug} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
