import { ShoppingCartIcon, SquaresFourIcon, UserCircleIcon } from '@phosphor-icons/react';
import { NavLink } from 'react-router';
import { cn } from '@/lib/utils';

export function BottomNav({ slug, cartCount }: { slug: string; cartCount: number }) {
  // The catalog is the shop home (`end`: not "active" on cart/profile/product pages).
  const items = [
    { to: `/s/${slug}/`, label: 'Каталог', Icon: SquaresFourIcon, end: true },
    { to: `/s/${slug}/cart`, label: 'Корзина', Icon: ShoppingCartIcon, badge: cartCount },
    { to: `/s/${slug}/profile`, label: 'Профиль', Icon: UserCircleIcon },
  ];
  return (
    <nav
      aria-label="Основная навигация"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 backdrop-blur-sm"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <ul className="mx-auto grid h-(--bottom-nav-height) max-w-3xl grid-cols-3">
        {items.map(({ to, label, Icon, badge, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'relative flex h-full flex-col items-center justify-center gap-0.5 text-xs font-medium transition-colors',
                  isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative">
                    <Icon aria-hidden weight={isActive ? 'fill' : 'regular'} className="size-6" />
                    {!!badge && (
                      <span
                        className="absolute -top-1.5 -right-2.5 min-w-5 rounded-full bg-primary px-1 text-center text-[11px] leading-5 font-semibold text-primary-foreground"
                        data-testid="cart-count"
                      >
                        {badge > 99 ? '99+' : badge}
                      </span>
                    )}
                  </span>
                  <span>
                    {label}
                    {!!badge && <span className="sr-only">, товаров: {badge}</span>}
                  </span>
                  {isActive && <span className="sr-only">(текущий раздел)</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
