import { SignOutIcon } from '@phosphor-icons/react';
import { NavLink, useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { signOut, useSession } from '../auth';
import { useIsPlatformAdmin } from '../use-platform-admin';

const tabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    '-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap',
    isActive ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
  );

export function AdminTopBar() {
  const navigate = useNavigate();
  const { session } = useSession();
  const isAdmin = useIsPlatformAdmin();
  return (
    <header className="space-y-3">
      <div className="flex items-center gap-3">
        <p className="min-w-0 truncate text-sm text-muted-foreground" data-testid="admin-user-email">
          {session?.user.email}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={async () => {
            await signOut();
            navigate('/admin', { replace: true });
          }}
        >
          <SignOutIcon aria-hidden /> Выйти
        </Button>
      </div>
      <nav aria-label="Разделы админки" className="scrollbar-none flex gap-1 overflow-x-auto border-b">
        <NavLink to="/admin/shops" end className={tabClass}>
          Мои магазины
        </NavLink>
        {isAdmin.data && (
          <NavLink to="/admin/platform" className={tabClass}>
            Все магазины платформы
          </NavLink>
        )}
      </nav>
    </header>
  );
}
