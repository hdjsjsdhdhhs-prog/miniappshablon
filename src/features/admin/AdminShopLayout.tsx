import { ArrowSquareOutIcon, SignOutIcon, StorefrontIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router';
import { EmptyState, ErrorState, PageSpinner } from '@/components/state-views';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { queryKeys } from '@/domain/query-keys';
import { cn } from '@/lib/utils';
import { AdminShopContext } from './admin-context';
import { fetchAdminShop } from './api';
import { signOut } from './auth';

const NAV = [
  { to: '', label: 'Обзор', end: true },
  { to: 'products', label: 'Товары' },
  { to: 'categories', label: 'Категории' },
  { to: 'orders', label: 'Заказы' },
  { to: 'settings', label: 'Оформление' },
  { to: 'notifications', label: 'Уведомления' },
];

export function AdminShopLayout() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const shop = useQuery({ queryKey: queryKeys.adminShop(slug), queryFn: () => fetchAdminShop(slug) });

  if (shop.isPending) return <PageSpinner />;
  if (shop.isError) return <ErrorState onRetry={() => void shop.refetch()} />;
  if (!shop.data) {
    return (
      <EmptyState
        className="min-h-dvh justify-center"
        title="Нет доступа к магазину"
        description="Магазин не найден или ваш аккаунт не является его владельцем."
        action={
          <Button asChild variant="outline">
            <Link to="/admin/shops">Мои магазины</Link>
          </Button>
        }
      />
    );
  }
  const s = shop.data;
  return (
    <AdminShopContext.Provider value={s}>
      <div className="mx-auto max-w-6xl px-4 pb-10">
        <header className="flex flex-wrap items-center gap-3 py-4">
          <Link to="/admin/shops" className="flex items-center gap-2 font-semibold" aria-label="Мои магазины">
            <StorefrontIcon aria-hidden className="size-6" />
          </Link>
          <h1 className="text-lg font-semibold">{s.name}</h1>
          <Badge variant={s.mode === 'live' ? 'default' : 'secondary'}>{s.mode === 'live' ? 'Опубликован' : 'Предпросмотр'}</Badge>
          {s.is_demo && <Badge variant="outline">DEMO</Badge>}
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={`/s/${s.slug}/`} target="_blank" rel="noreferrer">
                Витрина <ArrowSquareOutIcon aria-hidden />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await signOut();
                navigate('/admin', { replace: true });
              }}
            >
              <SignOutIcon aria-hidden /> Выйти
            </Button>
          </div>
        </header>
        <nav aria-label="Разделы магазина" className="scrollbar-none mb-6 flex gap-1 overflow-x-auto border-b">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap',
                  isActive ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <Outlet />
      </div>
    </AdminShopContext.Provider>
  );
}
