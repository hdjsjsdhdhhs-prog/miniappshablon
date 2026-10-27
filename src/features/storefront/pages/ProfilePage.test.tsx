import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatMoney } from '@/domain/money';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import type * as CheckoutApi from '@/features/cart/checkout-api';
import type { TelegramEnv } from '@/features/telegram/telegram';
import type { ProductDetail, Shop } from '../api';
import { ShopContext } from '../shop-context';
import { ProfilePage } from './ProfilePage';

// --- Telegram environment (what initTelegram() detected) ---
let tgEnv: TelegramEnv = { inTelegram: false, rawInitData: null, startParam: null, platform: null };
vi.mock('@/features/telegram/telegram', () => ({
  getTelegramEnv: () => tgEnv,
  openTelegramUrl: () => false,
}));

// --- Private buyer API (Edge Functions): must stay untouched by the demo mock-up ---
const api = vi.hoisted(() => ({ fetchMyOrders: vi.fn(), submitCheckout: vi.fn() }));
vi.mock('@/features/cart/checkout-api', async (importOriginal) => ({
  ...(await importOriginal<typeof CheckoutApi>()),
  fetchMyOrders: api.fetchMyOrders,
  submitCheckout: api.submitCheckout,
}));

// --- Supabase client: every auth / write / RPC entry point is a spy ---
const sb = vi.hoisted(() => {
  const write = { insert: vi.fn(), update: vi.fn(), upsert: vi.fn(), delete: vi.fn() };
  return {
    write,
    auth: {
      signInWithPassword: vi.fn(),
      signInAnonymously: vi.fn(),
      signInWithOtp: vi.fn(),
      signInWithIdToken: vi.fn(),
      signUp: vi.fn(),
    },
    rpc: vi.fn(),
    from: vi.fn(() => write),
  };
});
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: sb.auth, rpc: sb.rpc, from: sb.from },
  publicImageUrl: (path: string | null | undefined) => (path ? `https://cdn.test/${path}` : null),
  functionsUrl: (name: string) => `https://fn.test/${name}`,
}));

// --- Public catalog listing (read-only), per shop ---
const item = (id: string, name: string, price: number, flavor: string | null): ProductDetail => ({
  id,
  name,
  description: '',
  basePriceMinor: price,
  categoryId: 'c',
  categoryName: '',
  categorySlug: '',
  images: [],
  variants: [{ id: `${id}-v`, flavor, color: null, stock_quantity: 4, is_active: true, sort_order: 0 }],
});
const catalogs: Record<string, ProductDetail[]> = {
  'shop-noir': [item('n1', 'Noir Salt 30 мл', 69_000, 'Черника'), item('n2', 'Obsidian Kit', 189_000, null)],
  'shop-mint': [item('m1', 'Clear Mint 30 мл', 59_000, 'Мята')],
  'shop-ru': [],
};
const productsCalls: string[] = [];
vi.mock('../hooks', () => ({
  useProducts: (shopId: string) => {
    productsCalls.push(shopId);
    return { isPending: false, isError: false, data: { pages: [{ items: catalogs[shopId] ?? [], nextPage: null }] } };
  },
}));

const baseShop: Shop = {
  id: 'shop-noir',
  slug: 'noir-vapor',
  name: 'Noir Vapor',
  description: '',
  logoPath: 'shop-noir/logo/a.webp',
  coverPath: null,
  theme: DARK_PREMIUM_THEME,
  currency: 'RUB',
  mode: 'live',
  isDemo: true,
  ageRestriction: 18,
  fulfillment: { delivery: true, pickup: true, pickupInstructions: '' },
  info: { address: '', hours: '', delivery: '', payment: '', phone: '', telegram: '', telegramChannelUrl: '', telegramChannelLabel: '' },
  settings: { showFeatured: true, showInfo: true, showCategories: true },
  telegram: { botUsername: null, miniAppShortName: null },
};
const mint: Shop = { ...baseShop, id: 'shop-mint', slug: 'mint-lab', name: 'Mint Lab', logoPath: 'shop-mint/logo/b.webp' };
const russian: Shop = { ...baseShop, id: 'shop-ru', slug: 'lavka', name: 'Лавка Мяты', logoPath: null };

function ui(shop: Shop) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <ShopContext.Provider value={shop}>
        <MemoryRouter>
          {/* Like StorefrontLayout: every shop gets a fresh subtree. */}
          <ProfilePage key={shop.slug} />
        </MemoryRouter>
      </ShopContext.Provider>
    </QueryClientProvider>
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  tgEnv = { inTelegram: false, rawInitData: null, startParam: null, platform: null };
  productsCalls.length = 0;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network is not allowed in this test'));
});
afterEach(() => {
  vi.clearAllMocks();
  fetchSpy.mockRestore();
});

function expectNoAuthNoWrites() {
  for (const fn of Object.values(sb.auth)) expect(fn).not.toHaveBeenCalled();
  for (const fn of Object.values(sb.write)) expect(fn).not.toHaveBeenCalled();
  expect(sb.rpc).not.toHaveBeenCalled();
  expect(sb.from).not.toHaveBeenCalled();
  expect(api.fetchMyOrders).not.toHaveBeenCalled();
  expect(api.submitCheckout).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe('ProfilePage — demo shop opened outside Telegram', () => {
  it('shows a profile mock-up with the shop logo and name and a client-only "Тестовый заказ"', () => {
    render(ui(baseShop));
    const profile = screen.getByTestId('demo-profile');
    expect(within(profile).getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeInTheDocument();
    expect(within(profile).getByRole('img', { name: 'Логотип Noir Vapor' })).toHaveAttribute('src', 'https://cdn.test/shop-noir/logo/a.webp');
    // Clearly marked as a demo, never as a confirmed Telegram user.
    expect(within(profile).getByTestId('demo-profile-badge')).toHaveTextContent('Демо-профиль');
    expect(within(profile).getByRole('note')).toHaveTextContent(/демонстрация.*Вход не выполнен, аккаунт не создан/i);
    expect(profile).not.toHaveTextContent(/@\w/);

    const order = within(profile).getByTestId('demo-order');
    expect(order).toHaveTextContent('Тестовый заказ');
    expect(order).toHaveTextContent('Подтверждён');
    expect(order).toHaveTextContent('Пример заказа · не сохраняется');
    const lines = within(order).getAllByRole('listitem');
    expect(lines.map((l) => l.textContent)).toEqual([
      `Noir Salt 30 мл · Черника × 2${formatMoney(138_000, 'RUB')}`,
      `Obsidian Kit × 1${formatMoney(189_000, 'RUB')}`,
    ]);
    // textContent: formatMoney uses non-breaking spaces, which toHaveTextContent would normalise on one side only.
    expect(order.textContent).toContain(`Итого${formatMoney(138_000 + 189_000, 'RUB')}`);
    expect(screen.queryByTestId('my-order')).not.toBeInTheDocument();
    expect(screen.queryByText('Профиль доступен в Telegram')).not.toBeInTheDocument();
    expect(productsCalls.every((id) => id === 'shop-noir')).toBe(true);
  });

  it('performs no sign-in, no RPC, no write and no network request', () => {
    render(ui(baseShop));
    expect(screen.getByTestId('demo-order')).toBeInTheDocument();
    expectNoAuthNoWrites();
    // Nothing about the mock-up is persisted on the device either.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('switching shops shows only the current shop logo and name (EN and RU names)', () => {
    const { rerender } = render(ui(baseShop));
    rerender(ui(mint));
    const profile = screen.getByTestId('demo-profile');
    expect(within(profile).getByRole('heading', { level: 1, name: 'Mint Lab' })).toBeInTheDocument();
    expect(within(profile).getByRole('img', { name: 'Логотип Mint Lab' })).toHaveAttribute('src', 'https://cdn.test/shop-mint/logo/b.webp');
    expect(profile).not.toHaveTextContent('Noir');
    expect(within(profile).getByTestId('demo-order')).toHaveTextContent('Clear Mint 30 мл · Мята × 2');

    rerender(ui(russian));
    const ru = screen.getByTestId('demo-profile');
    expect(within(ru).getByRole('heading', { level: 1, name: 'Лавка Мяты' })).toBeInTheDocument();
    // No logo → the shop initials stand in for it (same as the storefront header).
    expect(ru).toHaveTextContent('ЛМ');
    expect(ru).not.toHaveTextContent(/Mint Lab|Noir/);
    // Empty catalog → generic test lines.
    expect(within(ru).getByTestId('demo-order')).toHaveTextContent('Тестовый товар');
    expectNoAuthNoWrites();
  });
});

describe('ProfilePage — existing behaviour is kept', () => {
  it('a regular (non-demo) shop outside Telegram still asks to open it in Telegram', () => {
    render(ui({ ...baseShop, isDemo: false }));
    expect(screen.getByText('Профиль доступен в Telegram')).toBeInTheDocument();
    expect(screen.queryByTestId('demo-profile')).not.toBeInTheDocument();
    expectNoAuthNoWrites();
  });

  it('a DEMO shop opened inside Telegram still shows the demo profile and never calls my-orders', () => {
    tgEnv = { inTelegram: true, rawInitData: 'user=%7B%22id%22%3A42%7D&hash=abc', startParam: null, platform: 'android' };
    render(ui(baseShop));
    expect(screen.getByTestId('demo-profile')).toBeInTheDocument();
    expect(screen.getByTestId('demo-order')).toHaveTextContent('Тестовый заказ');
    expect(screen.queryByTestId('my-order')).not.toBeInTheDocument();
    expectNoAuthNoWrites();
  });

  it('a Telegram session of a regular shop (e.g. after the hand-over) loads the real orders through the verified my-orders call', async () => {
    tgEnv = { inTelegram: true, rawInitData: 'user=%7B%22id%22%3A42%7D&hash=abc', startParam: null, platform: 'android' };
    api.fetchMyOrders.mockResolvedValue({
      user: { id: 42, first_name: 'Ирина', username: 'irina' },
      orders: [
        {
          id: 'o1', shop_id: 'shop-noir', order_number: 7, status: 'new', currency: 'RUB', total_minor: 69_000,
          contact_name: null, contact_phone: null, comment: null, fulfillment_method: 'delivery', delivery_address: 'ул. Ленина, 1',
          is_test: false, created_at: '2026-10-01T10:00:00Z',
          items: [{ id: 'i1', product_id: 'n1', variant_id: 'n1-v', product_name: 'Noir Salt 30 мл', variant_label: 'Черника', flavor: 'Черника', color: null, unit_price_minor: 69_000, quantity: 1, line_total_minor: 69_000 }],
        },
      ],
    });
    render(ui({ ...baseShop, isDemo: false }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Ирина' })).toBeInTheDocument();
    expect(screen.getByText('@irina')).toBeInTheDocument();
    expect(screen.getByTestId('my-order')).toHaveTextContent('Заказ №7');
    expect(screen.getByTestId('my-order')).toHaveTextContent('Доставка');
    expect(screen.getByTestId('my-order')).toHaveTextContent('Noir Salt 30 мл · Черника × 1');
    expect(api.fetchMyOrders).toHaveBeenCalledWith(tgEnv.rawInitData, 'noir-vapor');
    expect(screen.queryByTestId('demo-profile')).not.toBeInTheDocument();
    expect(screen.queryByText('Тестовый заказ')).not.toBeInTheDocument();
  });
});
