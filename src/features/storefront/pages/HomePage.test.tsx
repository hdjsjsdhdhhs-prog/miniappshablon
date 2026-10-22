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
  // Several flavors per product: the card still shows ONE fixed product price.
  variants: [
    { id: `${id}-a`, flavor: 'Мята', color: null, stock_quantity: 5, is_active: true, sort_order: 0 },
    { id: `${id}-b`, flavor: 'Черника', color: null, stock_quantity: 2, is_active: true, sort_order: 1 },
  ],
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
  // Used by the quick flavor sheet: returns the same in-stock listing row.
  useProduct: (_shopId: string, id: string) => {
    const data = inStock.find((p) => p.id === id);
    return { data, isError: false, error: null, refetch: async () => ({ data, isError: false, error: null }) };
  },
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
  info: { address: '', hours: '', delivery: '', payment: '', phone: '', telegram: '', telegramChannelUrl: '', telegramChannelLabel: '' },
  settings: { showFeatured: true, showInfo: true, showCategories: true },
  telegram: { botUsername: null, miniAppShortName: null },
};

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function renderHome(entry = '/s/demo/', value: Shop = shop) {
  return render(
    <ShopContext.Provider value={value}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/s/:slug" element={<><HomePage /><LocationProbe /></>} />
          <Route path="/s/:slug/product/:productId" element={<LocationProbe />} />
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
    // No visible "Категории" heading; the tile list keeps an accessible name.
    expect(screen.queryByRole('heading', { name: 'Категории' })).not.toBeInTheDocument();
    expect(screen.queryByText('Категории')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Категории' })).toBeInTheDocument();
    // No channel link configured → no button, and the info block does not appear because of it.
    expect(screen.queryByTestId('telegram-channel-link')).not.toBeInTheDocument();
  });

  it('shows the shop channel button under the title with the configured text and canonical link', () => {
    renderHome('/s/demo/', {
      ...shop,
      info: { ...shop.info, telegramChannelUrl: 't.me/noir_vapor_channel', telegramChannelLabel: 'Новости магазина' },
    });
    const link = screen.getByRole('link', { name: 'Новости магазина' });
    expect(link).toHaveAttribute('href', 'https://t.me/noir_vapor_channel');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // Placed in the brand header, right after the shop name.
    const h1 = screen.getByRole('heading', { level: 1, name: 'Demo Shop' });
    expect(h1.nextElementSibling).toBe(link);
    expect(screen.queryByRole('heading', { name: 'О магазине' })).not.toBeInTheDocument();
  });

  it('uses the default button text and hides the button for unsafe or non-Telegram links', () => {
    const { unmount } = renderHome('/s/demo/', { ...shop, info: { ...shop.info, telegramChannelUrl: 'https://t.me/+AbCdEfGhIj12' } });
    expect(screen.getByRole('link', { name: 'Наш канал в Телеграме' })).toHaveAttribute('href', 'https://t.me/+AbCdEfGhIj12');
    unmount();
    for (const bad of ['javascript:alert(1)', 'https://evil.example/t.me/channel', 'tg://resolve?domain=channel']) {
      const r = renderHome('/s/demo/', { ...shop, info: { ...shop.info, telegramChannelUrl: bad } });
      expect(screen.queryByTestId('telegram-channel-link')).not.toBeInTheDocument();
      r.unmount();
    }
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

  it('catalog and search cards show the fixed product price, never "от", for products with several flavors', async () => {
    renderHome();
    const prices = () => screen.getAllByTestId('product-card-price').map((p) => p.textContent);
    expect(prices()).toHaveLength(4);
    for (const p of prices()) expect(p).toMatch(/^500\s?₽$/);
    expect(screen.getByTestId('product-grid')).not.toHaveTextContent(/(^|\s)от\s/);

    await userEvent.type(screen.getByRole('searchbox'), 'noir');
    await waitFor(() => expect(cardNames()).toEqual(['Noir Salt 30 мл']));
    expect(prices()).toEqual([expect.stringMatching(/^500\s?₽$/)]);
    expect(screen.getByTestId('product-grid')).not.toHaveTextContent(/(^|\s)от\s/);
  });

  it('every card has "В корзину" right under the price; it opens the quick sheet, never the product page', async () => {
    renderHome();
    for (const card of screen.getAllByTestId('product-card')) {
      const link = within(card).getByTestId('product-card-link');
      const button = within(card).getByRole('button', { name: /^В корзину/ });
      // Sibling areas, not nested (valid HTML), and the button follows the link that ends with the price.
      expect(link).not.toContainElement(button);
      expect(link.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(link.lastElementChild?.lastElementChild?.textContent).toMatch(/500/);
    }

    const card = screen.getAllByTestId('product-card')[0]!;
    await userEvent.click(within(card).getByRole('button', { name: /^В корзину/ }));
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/s\/demo\/$/);
    const sheet = screen.getByRole('dialog');
    expect(within(sheet).getByRole('heading', { name: 'Noir Salt 30 мл' })).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // The rest of the card (photo, name, price) still opens the full product page.
    await userEvent.click(within(card).getByRole('heading', { name: 'Noir Salt 30 мл' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/s/demo/product/p1');
  });
});
