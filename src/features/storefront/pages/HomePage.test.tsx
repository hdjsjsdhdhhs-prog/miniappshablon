import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import type { Category, ProductDetail, Shop } from '../api';
import { ShopContext } from '../shop-context';
import { HomePage } from './HomePage';

const categories: Category[] = [
  { id: 'c-liq', name: 'Жидкости', slug: 'liquids', imagePath: null },
  { id: 'c-pod', name: 'Pod-системы', slug: 'pods', imagePath: null },
  { id: 'c-cart', name: 'Картриджи', slug: 'carts', imagePath: null },
  { id: 'c-acc', name: 'Аксессуары', slug: 'accessories', imagePath: null },
];

const product = (id: string, name: string, categoryId: string): ProductDetail => ({
  id,
  name,
  description: '',
  basePriceMinor: 50000,
  categoryId,
  categoryName: '',
  categorySlug: '',
  images: [],
  variants: [{ id: `${id}-v`, flavor: null, color: null, price_override_minor: null, stock_quantity: 5, is_active: true, sort_order: 0 }],
});

// What the server returns for the in-stock listing (out-of-stock products are filtered by the API).
// "Картриджи" deliberately has nothing in stock.
const inStock = [
  product('p1', 'Noir Salt 30 мл', 'c-liq'),
  product('p2', 'Velvet Ice 30 мл', 'c-liq'),
  product('p3', 'Obsidian Kit', 'c-pod'),
  product('p4', 'Чехол кожаный', 'c-acc'),
];

const productsCalls: Array<{ categoryId: string | null; search: string }> = [];

vi.mock('../hooks', () => ({
  useCategories: () => ({ isPending: false, isError: false, data: categories, refetch: vi.fn() }),
  // Fake server: applies the same category + name filter as fetchProductsPage.
  useProducts: (_shopId: string, params: { categoryId: string | null; search: string }) => {
    productsCalls.push(params);
    const q = params.search.toLowerCase();
    const items = inStock.filter(
      (p) => (!params.categoryId || p.categoryId === params.categoryId) && (!q || p.name.toLowerCase().includes(q)),
    );
    return {
      isPending: false,
      isError: false,
      isFetching: false,
      hasNextPage: false,
      isFetchingNextPage: false,
      data: { pages: [{ items, nextPage: null }] },
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    };
  },
}));

const shop: Shop = {
  id: 'shop-1',
  slug: 'demo',
  name: 'Demo Shop',
  description: 'Описание',
  logoPath: null,
  coverPath: null,
  theme: DARK_PREMIUM_THEME,
  currency: 'RUB',
  mode: 'live',
  isDemo: true,
  ageRestriction: 18,
  legalNotice: '18+',
  info: { address: '', hours: '', delivery: '', payment: '', phone: '', telegram: '' },
  settings: { showFeatured: true, showInfo: true, showCategories: true },
  telegram: { botUsername: null, miniAppShortName: null },
};

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function renderHome(entry = '/s/demo/') {
  return render(
    <ShopContext.Provider value={shop}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/s/:slug" element={<><HomePage /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>
    </ShopContext.Provider>,
  );
}

const tile = (name: string) => screen.getByRole('button', { name });
const cardNames = () => screen.queryAllByTestId('product-card').map((c) => within(c).getByRole('heading').textContent);

describe('HomePage catalog', () => {
  beforeEach(() => {
    productsCalls.length = 0;
  });

  it('shows header, category tiles and all in-stock products; no "Рекомендуем" block', () => {
    renderHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Demo Shop' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Поиск товаров' })).toBeInTheDocument();
    expect(screen.getAllByTestId('category-tile')).toHaveLength(4);
    for (const c of categories) expect(tile(c.name)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('products-title')).toHaveTextContent('Все товары');
    expect(cardNames()).toHaveLength(4);
    expect(screen.queryByText('Рекомендуем')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Весь каталог/ })).not.toBeInTheDocument();
  });

  it('selecting a tile filters in place, highlights it and renames the list; re-tapping keeps it', async () => {
    renderHome();
    await userEvent.click(tile('Жидкости'));
    expect(tile('Жидкости')).toHaveAttribute('aria-pressed', 'true');
    expect(tile('Pod-системы')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('products-title')).toHaveTextContent('Жидкости');
    expect(cardNames()).toEqual(['Noir Salt 30 мл', 'Velvet Ice 30 мл']);
    // Same page: only the query string changes.
    expect(screen.getByTestId('location')).toHaveTextContent('/s/demo/?category=liquids');

    await userEvent.click(tile('Pod-системы'));
    expect(tile('Pod-системы')).toHaveAttribute('aria-pressed', 'true');
    expect(tile('Жидкости')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('products-title')).toHaveTextContent('Pod-системы');
    expect(cardNames()).toEqual(['Obsidian Kit']);

    await userEvent.click(tile('Pod-системы'));
    expect(tile('Pod-системы')).toHaveAttribute('aria-pressed', 'true');
    expect(cardNames()).toEqual(['Obsidian Kit']);
    expect(screen.getAllByTestId('category-tile')).toHaveLength(4);
    expect(productsCalls.at(-1)).toEqual({ categoryId: 'c-pod', search: '' });
  });

  it('shows a clear message for a category without stock and can return to all products', async () => {
    renderHome();
    await userEvent.click(tile('Картриджи'));
    expect(screen.getByText('В категории «Картриджи» сейчас нет товаров в наличии')).toBeInTheDocument();
    expect(screen.queryAllByTestId('product-card')).toHaveLength(0);
    expect(screen.getAllByTestId('category-tile')).toHaveLength(4);

    await userEvent.click(screen.getByRole('button', { name: 'Показать все товары' }));
    expect(screen.getByTestId('products-title')).toHaveTextContent('Все товары');
    expect(cardNames()).toHaveLength(4);
    for (const c of categories) expect(tile(c.name)).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/s\/demo\/$/);
  });

  it('search combines with the active category', async () => {
    renderHome('/s/demo/?category=liquids');
    expect(tile('Жидкости')).toHaveAttribute('aria-pressed', 'true');
    await userEvent.type(screen.getByRole('searchbox'), 'velvet');
    // The search box is debounced (300 ms).
    await waitFor(() => expect(cardNames()).toEqual(['Velvet Ice 30 мл']));
    expect(productsCalls.at(-1)).toEqual({ categoryId: 'c-liq', search: 'velvet' });

    // A query matching only another category gives an empty, explained result inside the active one.
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'чехол');
    expect(await screen.findByText('Ничего не найдено по запросу «чехол»')).toBeInTheDocument();
    expect(screen.getByText('В категории «Жидкости» нет подходящих товаров в наличии.')).toBeInTheDocument();

    // "Все товары" drops the category but keeps the query.
    await userEvent.click(screen.getByRole('button', { name: 'Все товары' }));
    expect(cardNames()).toEqual(['Чехол кожаный']);
    expect(productsCalls.at(-1)).toEqual({ categoryId: null, search: 'чехол' });
  });
});
