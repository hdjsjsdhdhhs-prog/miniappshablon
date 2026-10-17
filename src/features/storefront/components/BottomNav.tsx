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
      className="glass-bar fixed inset-x-0 bottom-0 z-40 border-x-0 border-b-0 border-t-[color:var(--glass-edge-strong)] shadow-[inset_0_1px_0_var(--glass-highlight),var(--glass-shadow-bar)]"
      style={{ paddingBottom: 'var(--safe-bottom)' }}
    >
      <ul className="mx-auto grid h-(--bottom-nav-height) max-w-3xl grid-cols-3 px-2">
        {items.map(({ to, label, Icon, badge, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'glass-press relative flex h-full flex-col items-center justify-center gap-0.5 text-xs font-medium transition-[color,transform] duration-200',
                  isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative flex h-8 w-14 items-center justify-center">
                    {/* Active indicator: a small accent glass pill behind the icon (fixed size, fades in, no layout shift). */}
                    <span
                      aria-hidden
                      className={cn(
                        'absolute inset-0 rounded-full border border-[color:var(--glass-accent-edge)] bg-[color:var(--glass-accent-fill)] shadow-[inset_0_1px_0_var(--glass-highlight)] transition-[opacity,transform] duration-200 ease-(--ease-glass)',
                        isActive ? 'scale-100 opacity-100' : 'scale-75 opacity-0',
                      )}
                    />
                    <Icon aria-hidden weight={isActive ? 'fill' : 'regular'} className="relative size-6" />
                    {!!badge && (
                      <span
                        className="absolute -top-1 right-1.5 min-w-5 rounded-full bg-primary px-1 text-center text-[11px] leading-5 font-semibold text-primary-foreground shadow-[0_0_0_2px_var(--card)]"
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
