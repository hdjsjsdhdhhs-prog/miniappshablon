import { ShoppingCartIcon, SquaresFourIcon, UserCircleIcon } from '@phosphor-icons/react';
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { cn } from '@/lib/utils';

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable;
}

/**
 * True while a text field is focused on a touch device, i.e. while the on-screen keyboard is up.
 * The floating nav steps aside then: on Android the WebView shrinks and a fixed nav would ride on top
 * of the keyboard, covering the field being typed into (checkout form, search).
 *
 * The nav comes back only once the tap that closed the keyboard is over (after its `click`, or shortly after
 * the finger is lifted if there is no click). Bringing it back on blur would slide it under the finger: a tap on
 * a button low on the screen (e.g. "Оформить заказ" right after typing the address) would be released on a nav
 * link and lost.
 */
const NAV_RETURN_FALLBACK_MS = 300;

function useSoftKeyboardOpen(): boolean {
  const [field, setField] = useState<HTMLElement | null>(null);
  // Re-render on navigation: a focused field removed with the old page fires no focusout, and the
  // `isConnected` check below then releases the nav.
  useLocation();
  useEffect(() => {
    const coarse = window.matchMedia?.('(pointer: coarse)');
    let pressed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      pending = false;
      clearTimeout(timer);
    };
    const releaseSoon = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pending) return;
        pending = false;
        setField(null);
      }, ms);
    };
    const scheduleRelease = () => {
      if (pending) return;
      pending = true;
      if (!pressed) releaseSoon(NAV_RETURN_FALLBACK_MS);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (coarse?.matches && isTextEntry(e.target)) {
        cancel();
        setField(e.target as HTMLElement);
      } else scheduleRelease();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!isTextEntry(e.relatedTarget)) scheduleRelease();
    };
    const onPointerDown = () => {
      pressed = true;
      clearTimeout(timer);
    };
    const onPointerUp = () => {
      pressed = false;
      if (pending) releaseSoon(NAV_RETURN_FALLBACK_MS);
    };
    // The tap has been delivered to its real target: the nav may come back now.
    const onClick = () => {
      if (pending && !pressed) releaseSoon(0);
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('click', onClick, true);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
      document.removeEventListener('click', onClick, true);
    };
  }, []);
  return !!field?.isConnected;
}

/**
 * Places the shared selected-item surface under the link NavLink marked `aria-current="page"`, so the
 * highlight always follows the router's own active decision (incl. reloads and back/forward), never the
 * last tap. No item is current (e.g. product page) → the surface fades out. Written straight to the DOM
 * before paint: no extra render, no flash at the wrong slot.
 */
function useNavIndicator(listRef: RefObject<HTMLUListElement | null>, indicatorRef: RefObject<HTMLLIElement | null>) {
  const { pathname } = useLocation();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = indicatorRef.current;
    if (!list || !el) return;
    const first = !mounted.current;
    mounted.current = true;
    const links = [...list.querySelectorAll('a')];
    const index = links.findIndex((a) => a.getAttribute('aria-current') === 'page');
    if (index < 0) {
      delete el.dataset.visible; // keep the last slot, just fade out
      return;
    }
    if (el.dataset.visible === undefined) {
      // Appearing: jump into place without sliding. On first mount (reload) it is shown at once;
      // coming back from a page without a tab it then fades in.
      el.style.transition = 'none';
      el.style.setProperty('--nav-index', String(index));
      if (first) el.dataset.visible = '';
      void el.offsetWidth; // commit before transitions come back
      el.style.transition = '';
    } else {
      el.style.setProperty('--nav-index', String(index));
    }
    el.dataset.visible = '';
  }, [pathname, listRef, indicatorRef]);
}

export function BottomNav({ slug, cartCount }: { slug: string; cartCount: number }) {
  // The catalog is the shop home (`end`: not "active" on cart/profile/product pages).
  const items = [
    { to: `/s/${slug}/`, label: 'Каталог', Icon: SquaresFourIcon, end: true },
    { to: `/s/${slug}/cart`, label: 'Корзина', Icon: ShoppingCartIcon, badge: cartCount },
    { to: `/s/${slug}/profile`, label: 'Профиль', Icon: UserCircleIcon },
  ];
  const keyboardOpen = useSoftKeyboardOpen();
  const listRef = useRef<HTMLUListElement>(null);
  const indicatorRef = useRef<HTMLLIElement>(null);
  useNavIndicator(listRef, indicatorRef);
  return (
    // Outer layer only positions the dock (side + bottom insets incl. safe area) and lets taps through the margins.
    <nav
      aria-label="Основная навигация"
      inert={keyboardOpen}
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-0 z-40 px-4 transition-[translate,opacity] duration-200 ease-(--ease-glass)',
        keyboardOpen && 'translate-y-[calc(100%+var(--bottom-nav-gap))] opacity-0',
      )}
      style={{ paddingBottom: 'calc(var(--bottom-nav-gap) + var(--safe-bottom))' }}
      data-testid="bottom-nav"
    >
      <ul
        ref={listRef}
        className="glass-bar glass-dock pointer-events-auto mx-auto grid h-(--bottom-nav-height) max-w-md grid-cols-3 p-(--nav-inset)"
        style={{ '--nav-count': items.length } as CSSProperties}
      >
        {/* Shared selected-item surface (positioned by useNavIndicator); first, so the links paint over it. */}
        <li ref={indicatorRef} aria-hidden className="glass-nav-indicator" data-testid="bottom-nav-indicator">
          <span className="glass-nav-pill" />
        </li>
        {items.map(({ to, label, Icon, badge, end }) => (
          // Each item fills an equal third; its padding matches the pill's, so the tap/focus area is the pill.
          <li key={to} className="px-0.5">
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'glass-press relative flex h-full flex-col items-center justify-center rounded-(--nav-item-radius) text-xs font-medium transition-[color,transform] duration-200 ease-(--ease-glass) focus-visible:-outline-offset-2',
                  isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span className="relative flex h-7 w-14 items-center justify-center">
                    <Icon aria-hidden weight={isActive ? 'fill' : 'regular'} className="size-6" />
                    {!!badge && (
                      <span
                        className="absolute top-0 right-1.5 min-w-5 rounded-full bg-primary px-1 text-center text-[11px] leading-5 font-semibold text-primary-foreground shadow-[0_0_0_2px_var(--card)]"
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
