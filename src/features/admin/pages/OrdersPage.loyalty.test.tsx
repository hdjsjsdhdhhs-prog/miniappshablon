import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShopContext } from '../admin-context';
import type * as Api from '../api';
import type { AdminOrder, AdminShop } from '../api';
import type * as FunctionsApi from '../functions-api';
import { OrdersPage } from './OrdersPage';

const api = vi.hoisted(() => ({ fetchAdminOrders: vi.fn(), setOrderStatus: vi.fn(), dispatch: vi.fn() }));
// Alias paths (not '../api'): in this checkout a relative vi.mock of '../api' is not applied to the page under test.
vi.mock('@/features/admin/api', async (importOriginal) => ({ ...(await importOriginal<typeof Api>()), fetchAdminOrders: api.fetchAdminOrders, setOrderStatus: api.setOrderStatus }));
vi.mock('@/features/admin/functions-api', async (importOriginal) => ({ ...(await importOriginal<typeof FunctionsApi>()), loyaltyApi: { dispatch: api.dispatch } }));

const shop = { id: 'shop-a', slug: 'noir', currency: 'RUB' } as AdminShop;

const order = (over: Partial<AdminOrder>): AdminOrder =>
  ({
    id: 'o1',
    shop_id: 'shop-a',
    order_number: 104,
    status: 'new',
    currency: 'RUB',
    total_minor: 300_000,
    customer_snapshot: { first_name: 'Ирина', username: 'irina' },
    contact_name: null,
    contact_phone: null,
    comment: null,
    fulfillment_method: 'pickup',
    delivery_address: null,
    is_test: false,
    created_at: '2026-11-25T10:00:00Z',
    items_total_minor: null,
    discount_type: null,
    discount_minor: 0,
    discount_info: null,
    bonus_spent: 0,
    bonus_accrued: null,
    order_items: [{ id: 'i1', product_name: 'Noir Salt', variant_label: '', unit_price_minor: 100_000, original_unit_price_minor: null, quantity: 3, line_total_minor: 300_000 }],
    ...over,
  }) as unknown as AdminOrder;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AdminShopContext.Provider value={shop}>
        <MemoryRouter>
          <OrdersPage />
        </MemoryRouter>
      </AdminShopContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.dispatch.mockResolvedValue({ sent: 1, failed: 0, skipped: 0 });
});

describe('OrdersPage — discounts and bonuses of an order', () => {
  it('a plain order shows no breakdown (nothing changes for a shop without the features)', async () => {
    api.fetchAdminOrders.mockResolvedValue([order({})]);
    renderPage();
    expect(await screen.findByTestId('admin-order')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-order-breakdown')).not.toBeInTheDocument();
  });

  it('shows the items total, every discount, the bonuses paid and the bonuses credited', async () => {
    api.fetchAdminOrders.mockResolvedValue([
      order({
        status: 'confirmed',
        total_minor: 265_000,
        items_total_minor: 300_000,
        discount_type: 'promo',
        discount_minor: 30_000,
        discount_info: { code: 'WELCOME300', kind: 'fixed', fixed_minor: 30_000 },
        bonus_spent: 50,
        bonus_accrued: 132,
      }),
      order({
        id: 'o2',
        order_number: 105,
        total_minor: 285_000,
        items_total_minor: 300_000,
        discount_type: 'threshold',
        discount_minor: 15_000,
        discount_info: { percent: 5, min_total_minor: 300_000 },
      }),
    ]);
    renderPage();
    const [first, second] = await screen.findAllByTestId('admin-order-breakdown');
    const compact = (el: HTMLElement) => el.textContent?.replace(/\s+/g, '');
    expect(compact(within(first!).getByTestId('admin-order-discount'))).toBe('ПромокодWELCOME300(300₽)−300₽');
    expect(compact(within(first!).getByTestId('admin-order-bonus-spent'))).toBe('Оплаченобонусами(50бонусов)−50₽');
    expect(within(first!).getByTestId('admin-order-bonus-accrued')).toHaveTextContent('Покупателю начислено 132 бонуса');
    expect(compact(within(second!).getByTestId('admin-order-discount'))).toBe('Скидказасуммузаказа5%(от3000₽)−150₽');
    expect(within(second!).queryByTestId('admin-order-bonus-accrued')).not.toBeInTheDocument();
  });

  it('confirming credits the bonuses (the database does it) and then asks the server to send the message — only when something was credited', async () => {
    api.fetchAdminOrders.mockResolvedValue([order({}), order({ id: 'o2', order_number: 105 })]);
    api.setOrderStatus.mockImplementation(async (id: string) => (id === 'o1' ? { id, status: 'confirmed', bonus_accrued: 150 } : { id, status: 'confirmed' }));
    renderPage();
    const cards = await screen.findAllByTestId('admin-order');
    await userEvent.click(within(cards[0]!).getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(api.setOrderStatus).toHaveBeenCalledWith('o1', 'confirmed'));
    await waitFor(() => expect(api.dispatch).toHaveBeenCalledWith('shop-a'));
    // An order that earned nothing (program off, or a tiny order) does not trigger a send.
    api.dispatch.mockClear();
    await userEvent.click(within(cards[1]!).getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(api.setOrderStatus).toHaveBeenCalledWith('o2', 'confirmed'));
    expect(api.dispatch).not.toHaveBeenCalled();
  });
});
