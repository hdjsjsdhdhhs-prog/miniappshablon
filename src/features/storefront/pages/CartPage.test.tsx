import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { cartStore } from '@/features/cart/cart-store';
import type { ProductDetail, Shop } from '../api';
import { ShopContext } from '../shop-context';
import { CartPage } from './CartPage';
import { ProductPage } from './ProductPage';

// Noir Salt 30 мл: one product price (690 ₽) for every flavor.
const noirSalt: ProductDetail = {
  id: 'p1',
  name: 'Noir Salt 30 мл',
  description: '',
  basePriceMinor: 69000,
  categoryId: 'c',
  categoryName: 'Жидкости',
  categorySlug: 'liquids',
  images: [],
  variants: [
    { id: 'mango', flavor: 'Манго-маракуйя', color: null, stock_quantity: 12, is_active: true, sort_order: 0 },
    { id: 'blueberry', flavor: 'Черника', color: null, stock_quantity: 5, is_active: true, sort_order: 1 },
  ],
};

vi.mock('../hooks', () => ({
  useProduct: () => ({ data: noirSalt, isPending: false, isError: false, error: null, refetch: vi.fn() }),
}));

const shop = { id: 'shop-cart', slug: 'demo', name: 'Demo', currency: 'RUB', mode: 'live', theme: DARK_PREMIUM_THEME } as Shop;

function renderShop(entry: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShopContext.Provider value={shop}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/s/:slug/product/:productId" element={<ProductPage />} />
            <Route path="/s/:slug/cart" element={<CartPage />} />
          </Routes>
        </MemoryRouter>
      </ShopContext.Provider>
    </QueryClientProvider>,
  );
}

describe('CartPage: one price per product', () => {
  beforeEach(() => {
    localStorage.clear();
    cartStore._resetCache();
  });

  it('two flavors of one product cost the same in the cart and in the checkout total; no "от"', async () => {
    renderShop('/s/demo/product/p1');
    await userEvent.click(screen.getByTestId('add-to-cart')); // Манго-маракуйя (default)
    await userEvent.click(screen.getByRole('radio', { name: 'Черника' }));
    await userEvent.click(screen.getByRole('button', { name: 'Увеличить' }));
    await userEvent.click(screen.getByTestId('add-to-cart')); // Черника × 2
    await userEvent.click(screen.getByRole('link', { name: 'Перейти в корзину' }));

    const lines = screen.getAllByTestId('cart-line');
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(within(line).getByText(/690\s?₽ \/ шт\./)).toBeInTheDocument();
    expect(within(lines[0]!).getByText('Манго-маракуйя')).toBeInTheDocument();
    expect(within(lines[1]!).getByText('Черника')).toBeInTheDocument();
    expect(within(lines[1]!).getByText(/^1\s?380\s?₽$/)).toBeInTheDocument();
    // Total sent as expectedTotalMinor to checkout: 3 × 690 ₽.
    expect(screen.getByTestId('cart-total')).toHaveTextContent(/^2\s?070\s?₽$/);
    expect(cartStore.getLines(shop.id).map((l) => l.unitPriceMinor)).toEqual([69000, 69000]);
    expect(screen.getByRole('main')).not.toHaveTextContent(/(^|\s)от\s\d/);
  });
});
