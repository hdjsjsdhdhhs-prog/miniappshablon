import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BonusProfile } from '@/domain/loyalty';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import type * as CheckoutApi from '@/features/cart/checkout-api';
import type { OrderDto } from '@/features/cart/checkout-api';
import type { TelegramEnv } from '@/features/telegram/telegram';
import type { Shop } from '../api';
import { ShopContext } from '../shop-context';
import { ProfilePage } from './ProfilePage';

// The buyer's profile in a shop with the bonus program: balance, history, and the discounts / bonuses of each order.
const tgEnv: TelegramEnv = { inTelegram: true, rawInitData: 'user=%7B%22id%22%3A42%7D&hash=abc', startParam: null, platform: 'android' };
vi.mock('@/features/telegram/telegram', () => ({ getTelegramEnv: () => tgEnv, openTelegramUrl: () => false }));

const api = vi.hoisted(() => ({ fetchMyOrders: vi.fn() }));
vi.mock('@/features/cart/checkout-api', async (importOriginal) => ({ ...(await importOriginal<typeof CheckoutApi>()), fetchMyOrders: api.fetchMyOrders }));

const shop = {
  id: 'shop-a',
  slug: 'noir',
  name: 'Noir',
  currency: 'RUB',
  mode: 'live',
  isDemo: false,
  theme: DARK_PREMIUM_THEME,
  fulfillment: { delivery: true, pickup: true, pickupInstructions: '' },
} as Shop;

const order = (over: Partial<OrderDto>): OrderDto => ({
  id: 'o1',
  shop_id: 'shop-a',
  order_number: 104,
  status: 'confirmed',
  currency: 'RUB',
  total_minor: 300_000,
  contact_name: null,
  contact_phone: null,
  comment: null,
  fulfillment_method: 'pickup',
  delivery_address: null,
  is_test: false,
  created_at: '2026-11-25T10:00:00Z',
  items: [{ id: 'i1', product_id: 'p', variant_id: 'v', product_name: 'Noir Salt', variant_label: '', flavor: null, color: null, unit_price_minor: 100_000, quantity: 3, line_total_minor: 300_000 }],
  ...over,
});

const profile = (over: Partial<BonusProfile> = {}): BonusProfile => ({
  enabled: true,
  percent: 5,
  balance: 150,
  earned_total: 250,
  spent_total: 100,
  unit_minor: 100,
  currency: 'RUB',
  history: [
    { id: 3, kind: 'accrual', amount: 100, balance_after: 150, order_id: 'o9', order_number: 109, created_at: '2026-11-25T12:00:00Z' },
    { id: 2, kind: 'spend', amount: -50, balance_after: 50, order_id: 'o8', order_number: 108, created_at: '2026-11-24T12:00:00Z' },
    { id: 1, kind: 'accrual', amount: 150, balance_after: 100, order_id: 'o4', order_number: 104, created_at: '2026-11-20T12:00:00Z' },
  ],
  ...over,
});

function renderProfile(data: { orders: OrderDto[]; loyalty?: BonusProfile | null }) {
  api.fetchMyOrders.mockResolvedValue({ user: { id: 42, first_name: 'Ирина', username: 'irina' }, orders: data.orders, loyalty: data.loyalty });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShopContext.Provider value={shop}>
        <MemoryRouter>
          <ProfilePage />
        </MemoryRouter>
      </ShopContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('ProfilePage — «Мои бонусы»', () => {
  it('shows the balance, what was earned and spent, and the latest operations with their orders', async () => {
    renderProfile({ orders: [order({})], loyalty: profile() });
    const card = await screen.findByTestId('bonus-card');
    expect(within(card).getByRole('heading', { name: 'Мои бонусы' })).toBeInTheDocument();
    expect(screen.getByTestId('bonus-balance-value')).toHaveTextContent('150 бонусов');
    expect(screen.getByTestId('bonus-earned')).toHaveTextContent('Получено: 250 бонусов');
    expect(screen.getByTestId('bonus-spent')).toHaveTextContent('Потрачено: 100 бонусов');
    const items = screen.getAllByTestId('bonus-history-item').map((li) => li.textContent?.replace(/\s+/g, ' ').replace(/\d+\.\d+\.\d+$/, '').trim());
    expect(items).toEqual(['+100 — начислено за заказ №109.', '−50 — использовано в заказе №108.', '+150 — начислено за заказ №104.']);
    expect(card).toHaveTextContent('1 бонус =');
    expect(card).toHaveTextContent('5% от оплаченной суммы');
    // It sits in the profile, above the orders.
    expect(screen.getByRole('heading', { name: 'Мои заказы' })).toBeInTheDocument();
  });

  it('a profile of a shop without a bonus program shows no bonus card (nothing changes for that shop)', async () => {
    renderProfile({ orders: [order({})], loyalty: null });
    expect(await screen.findByTestId('my-order')).toBeInTheDocument();
    expect(screen.queryByTestId('bonus-card')).not.toBeInTheDocument();
    expect(screen.queryByTestId('my-order-breakdown')).not.toBeInTheDocument();
  });

  it('an older answer without the field is the same as no program', async () => {
    renderProfile({ orders: [order({})] });
    expect(await screen.findByTestId('my-order')).toBeInTheDocument();
    expect(screen.queryByTestId('bonus-card')).not.toBeInTheDocument();
  });

  it('a paused program keeps the balance visible and says it can be spent later', async () => {
    renderProfile({ orders: [], loyalty: profile({ enabled: false, percent: null }) });
    expect(await screen.findByTestId('bonus-card')).toHaveTextContent('Бонусная программа магазина сейчас приостановлена');
    expect(screen.getByTestId('bonus-balance-value')).toHaveTextContent('150 бонусов');
  });

  it('a new buyer sees an empty balance and no operations', async () => {
    renderProfile({ orders: [], loyalty: profile({ balance: 0, earned_total: 0, spent_total: 0, history: [] }) });
    expect(await screen.findByTestId('bonus-balance-value')).toHaveTextContent('0 бонусов');
    expect(screen.queryByTestId('bonus-history')).not.toBeInTheDocument();
  });
});

describe('ProfilePage — what an order was placed with', () => {
  it('lists the items total, the discount, the bonuses spent and the bonuses it earned', async () => {
    renderProfile({
      orders: [
        order({
          total_minor: 265_000,
          items_total_minor: 300_000,
          discount_type: 'promo',
          discount_minor: 30_000,
          discount_info: { code: 'WELCOME300', kind: 'fixed', fixed_minor: 30_000 },
          bonus_spent: 50,
          bonus_accrued: 132,
        }),
      ],
      loyalty: profile(),
    });
    const breakdown = await screen.findByTestId('my-order-breakdown');
    const compact = (id: string) => within(breakdown).getByTestId(id).textContent?.replace(/\s+/g, '');
    expect(breakdown.textContent).toContain('Сумма товаров');
    expect(compact('my-order-discount')).toMatch(/^ПромокодWELCOME300−300₽$/);
    expect(compact('my-order-bonus-spent')).toMatch(/^Оплаченобонусами\(50бонусов\)−50₽$/);
    expect(within(breakdown).getByTestId('my-order-bonus-accrued')).toHaveTextContent('За этот заказ начислено 132 бонуса');
    expect(screen.getByTestId('my-order').textContent).toMatch(/Итого\s?2\s?650\s?₽/);
  });

  it('names a threshold discount with its percent', async () => {
    renderProfile({
      orders: [order({ total_minor: 285_000, items_total_minor: 300_000, discount_type: 'threshold', discount_minor: 15_000, discount_info: { percent: 5, min_total_minor: 300_000 }, bonus_spent: 0 })],
      loyalty: null,
    });
    expect(await screen.findByTestId('my-order-discount')).toHaveTextContent('Скидка за сумму заказа 5%');
    expect(screen.queryByTestId('my-order-bonus-spent')).not.toBeInTheDocument();
  });
});
