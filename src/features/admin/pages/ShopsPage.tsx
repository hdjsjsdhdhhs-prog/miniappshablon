import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/domain/query-keys';
import { fetchMyShops } from '../api';
import { signOut, useSession } from '../auth';

export function ShopsPage() {
  const { session } = useSession();
  const navigate = useNavigate();
  const shops = useQuery({ queryKey: queryKeys.adminShops(session?.user.id ?? ''), queryFn: fetchMyShops, enabled: !!session });

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Мои магазины</h1>
        <Button
          variant="ghost"
          onClick={async () => {
            await signOut();
            navigate('/admin', { replace: true });
          }}
        >
          Выйти
        </Button>
      </header>
      {shops.isPending ? (
        <PageSpinner />
      ) : shops.isError ? (
        <ErrorState onRetry={() => void shops.refetch()} />
      ) : shops.data.length === 0 ? (
        <EmptyState title="Нет доступных магазинов" description="Попросите администратора платформы выдать доступ (pnpm owner:add)." />
      ) : (
        <ul className="space-y-2">
          {shops.data.map(({ shop, role }) => (
            <li key={shop.id}>
              <Link to={`/admin/shops/${shop.slug}`} className="flex items-center gap-3 rounded-lg border bg-card p-4 hover:border-foreground/40">
                <span className="font-medium">{shop.name}</span>
                <span className="text-sm text-muted-foreground">/{shop.slug}</span>
                <span className="ml-auto flex gap-2">
                  {shop.is_demo && <Badge variant="outline">DEMO</Badge>}
                  <Badge variant={shop.mode === 'live' ? 'default' : 'secondary'}>{shop.mode}</Badge>
                  <Badge variant="outline">{role}</Badge>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
