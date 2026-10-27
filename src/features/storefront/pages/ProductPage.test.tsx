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
    { id: 'a', flavor: 'Мята', color: null, stock_quantity: 3, is_active: true, sort_order: 0 },
    { id: 'b', flavor: 'Черника', color: null, stock_quantity: 5, is_active: true, sort_order: 1 },
    { id: 'c', flavor: 'Ледяная вишня', color: null, stock_quantity: 0, is_active: true, sort_order: 2 },
  ],
};

const aurumPod: ProductDetail = {
  ...product,
  id: 'p2',
  name: 'Aurum Pod',
  basePriceMinor: 249000,
  variants: [
    { id: 'g', flavor: null, color: 'Графит', stock_quantity: 4, is_active: true, sort_order: 0 },
    { id: 'au', flavor: null, color: 'Золото', stock_quantity: 2, is_active: true, sort_order: 1 },
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

describe('ProductPage: one price per product', () => {
  beforeEach(() => {
    localStorage.clear();
    cartStore._resetCache();
    shown = product;
  });

  it('Noir Salt: the price stays 690 ₽ for every flavor, never "от"; stock follows the flavor', async () => {
    renderAt(['/s/demo/product/p1']);
    const price = screen.getByTestId('product-price');
    expect(price).toHaveTextContent(/^690\s?₽$/);
    expect(screen.getByRole('main')).not.toHaveTextContent(/(^|\s)от\s/);
    expect(screen.getByTestId('product-stock')).toHaveTextContent(/^Осталось: 3$/);
    await userEvent.click(screen.getByRole('radio', { name: 'Черника' }));
    expect(price).toHaveTextContent(/^690\s?₽$/);
    expect(screen.getByTestId('product-stock')).toHaveTextContent(/^Осталось: 5$/);
    await userEvent.click(screen.getByRole('radio', { name: /Ледяная вишня/ }));
    expect(price).toHaveTextContent(/^690\s?₽$/);
    expect(screen.getByTestId('product-stock')).toHaveTextContent('Нет в наличии');
    expect(screen.getByTestId('add-to-cart')).toBeDisabled();
  });

  it('Aurum Pod: switching the color keeps 2 490 ₽ and the cart gets that price for each color', async () => {
    shown = aurumPod;
    renderAt(['/s/demo/product/p2']);
    const price = screen.getByTestId('product-price');
    expect(price).toHaveTextContent(/^2\s?490\s?₽$/);
    await userEvent.click(screen.getByTestId('add-to-cart'));
    await userEvent.click(screen.getByRole('radio', { name: 'Золото' }));
    expect(price).toHaveTextContent(/^2\s?490\s?₽$/);
    await userEvent.click(screen.getByTestId('add-to-cart'));
    expect(cartStore.getLines(shop.id).map((l) => [l.variantLabel, l.unitPriceMinor])).toEqual([
      ['Графит', 249000],
      ['Золото', 249000],
    ]);
  });
});

describe('ProductPage back button', () => {
  beforeEach(() => {
    localStorage.clear();
    cartStore._resetCache();
    shown = product;
  });

  it('floats over the top of the photo (no separate strip) and returns to the catalog entry with its filters', async () => {
    renderAt(['/s/demo/?category=liquids&q=salt', '/s/demo/product/p1']);
    const back = screen.getByRole('button', { name: 'Назад' });
    const media = screen.getByTestId('product-media');
    const main = screen.getByRole('main');
    // The media block is the first thing on the page: nothing (no own bar) sits between the banner and the photo.
    expect(main.firstElementChild).toBe(media);
    const photo = media.querySelector('img, [role="img"]');
    expect(photo).not.toBeNull();
    // The button lives inside the media block on an absolutely positioned overlay, not in the flow above it.
    expect(media).toContainElement(back);
    const overlay = back.parentElement!;
    expect(overlay).toHaveClass('absolute', 'top-0', 'pointer-events-none');
    expect(overlay).not.toContainElement(photo as HTMLElement);
    expect(back).toHaveClass('pointer-events-auto', 'glass-on-media');
    // First focus stop of the page.
    expect(back.compareDocumentPosition(photo!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.click(back);
    expect(screen.getByTestId('location')).toHaveTextContent('/s/demo/?category=liquids&q=salt');
  });

  it('without in-app history falls back to the shop catalog', async () => {
    renderAt(['/s/demo/product/p1']);
    await userEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/s\/demo\/$/);
  });
});
