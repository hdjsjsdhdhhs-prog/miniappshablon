import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { cartStore } from '@/features/cart/cart-store';
import type { ProductDetail, Shop } from '../api';
import { ShopContext } from '../shop-context';
import { ProductPage } from './ProductPage';

const product: ProductDetail = {
  id: 'p1',
  name: 'Noir Salt 30 мл',
  description: '',
  basePriceMinor: 69000,
  categoryId: 'c',
  categoryName: 'Жидкости',
  categorySlug: 'liquids',
  images: [],
  variants: [
    { id: 'a', flavor: 'Мята', color: null, price_override_minor: null, stock_quantity: 3, is_active: true, sort_order: 0 },
    { id: 'b', flavor: 'Черника', color: null, price_override_minor: null, stock_quantity: 5, is_active: true, sort_order: 1 },
    { id: 'c', flavor: 'Ледяная вишня', color: null, price_override_minor: null, stock_quantity: 0, is_active: true, sort_order: 2 },
  ],
};

let shown: ProductDetail = product;
vi.mock('../hooks', () => ({
  useProduct: () => ({ data: shown, isPending: false, isError: false, error: null, refetch: vi.fn() }),
}));

const shop = { id: 'shop-pp', slug: 'demo', name: 'Demo', currency: 'RUB', theme: DARK_PREMIUM_THEME } as Shop;

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="location">{l.pathname + l.search}</p>;
}

function renderAt(entries: string[]) {
  render(
    <ShopContext.Provider value={shop}>
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/s/:slug/" element={<LocationProbe />} />
          <Route path="/s/:slug/product/:productId" element={<ProductPage />} />
        </Routes>
      </MemoryRouter>
    </ShopContext.Provider>,
  );
}

describe('ProductPage back button', () => {
  beforeEach(() => {
    localStorage.clear();
    cartStore._resetCache();
    shown = product;
  });

  it('sits above the gallery and returns to the catalog entry with its filters', async () => {
    renderAt(['/s/demo/?category=liquids&q=salt', '/s/demo/product/p1']);
    const back = screen.getByRole('button', { name: 'Назад' });
    const gallery = screen.getByRole('main').querySelector('img, [role="img"]') ?? screen.getByRole('heading', { level: 1 });
    expect(back.compareDocumentPosition(gallery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(back);
    expect(screen.getByTestId('location')).toHaveTextContent('/s/demo/?category=liquids&q=salt');
  });

  it('without in-app history falls back to the shop catalog', async () => {
    renderAt(['/s/demo/product/p1']);
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/s\/demo\/$/);
  });
});
