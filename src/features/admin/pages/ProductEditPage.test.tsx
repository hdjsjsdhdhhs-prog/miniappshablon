import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShopContext } from '../admin-context';
import type { AdminProduct, AdminShop } from '../api';
import { ProductEditPage } from './ProductEditPage';

const variant = (id: string, flavor: string, price: number | null) => ({
  id,
  shop_id: 'shop',
  product_id: 'p1',
  flavor,
  color: null,
  sku: null,
  price_override_minor: price,
  stock_quantity: 5,
  is_active: true,
  sort_order: 0,
  seed_key: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
});

let product: AdminProduct;
const api = vi.hoisted(() => ({
  fetchAdminProduct: vi.fn(),
  fetchAdminCategories: vi.fn(),
  saveProductWithPrice: vi.fn(),
  updateProduct: vi.fn(),
  createProduct: vi.fn(),
  syncVariantPricesToProduct: vi.fn(),
  createVariant: vi.fn(),
  updateVariant: vi.fn(),
  setVariantStock: vi.fn(),
}));
vi.mock('../api', () => api);
vi.mock('../components/ProductImagesEditor', () => ({ ProductImagesEditor: () => null }));

const shop = { id: 'shop', slug: 'noir-vapor', currency: 'RUB' } as AdminShop;

// Radix Switch measures itself with ResizeObserver, which jsdom does not provide.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AdminShopContext.Provider value={shop}>
        <MemoryRouter initialEntries={['/admin/shops/noir-vapor/products/p1']}>
          <Routes>
            <Route path="/admin/shops/:slug/products/:productId" element={<ProductEditPage />} />
          </Routes>
        </MemoryRouter>
      </AdminShopContext.Provider>
    </QueryClientProvider>,
  );
}

describe('ProductEditPage: one price per product', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    product = {
      id: 'p1',
      shop_id: 'shop',
      category_id: 'c',
      name: 'Noir Salt 30 мл',
      description: '',
      base_price_minor: 69000,
      is_published: true,
      is_featured: false,
      sort_order: 0,
      archived_at: null,
      seed_key: null,
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      product_variants: [variant('a', 'Мята', null), variant('b', 'Черника', 74000)],
      product_images: [],
    };
    api.fetchAdminProduct.mockImplementation(async () => product);
    api.fetchAdminCategories.mockResolvedValue([{ id: 'c', name: 'Жидкости', is_active: true, archived_at: null }]);
    api.saveProductWithPrice.mockImplementation(async (id: string) => ({ id }));
  });

  it('has a single product price field and no price fields on variants', async () => {
    renderPage();
    expect(await screen.findByTestId('product-price-input')).toHaveValue('690');
    expect(screen.getAllByTestId('variant-row')).toHaveLength(2);
    expect(screen.queryByLabelText(/Цена варианта|Цена нового варианта/)).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Цена' })).not.toBeInTheDocument();
  });

  it('the variants block shows no price at all and offers no way to set one', async () => {
    renderPage();
    await screen.findAllByTestId('variant-row');
    const rows = screen.getAllByTestId('variant-row');
    for (const row of rows) {
      expect(row.querySelectorAll('input')).toHaveLength(4); // вкус, цвет, SKU, остаток
      expect(row).not.toHaveTextContent(/₽|740/);
    }
    expect(screen.queryByText(/отдельная цена|Сбросить к цене товара/)).not.toBeInTheDocument();
    expect(screen.getByText('Одна цена для всех вкусов и цветов товара.')).toBeInTheDocument();
  });

  it('a new variant is created without a price of its own; saving a row never sends a price', async () => {
    api.createVariant.mockResolvedValue({ id: 'new' });
    api.updateVariant.mockResolvedValue({});
    renderPage();
    await userEvent.type(await screen.findByLabelText('Новый вкус'), 'Персик');
    await userEvent.clear(screen.getByLabelText('Остаток нового варианта'));
    await userEvent.type(screen.getByLabelText('Остаток нового варианта'), '7');
    await userEvent.click(screen.getByRole('button', { name: /Добавить/ }));
    expect(api.createVariant).toHaveBeenCalledWith('shop', 'p1', { flavor: 'Персик', color: null, sku: null, is_active: true }, 7);

    const [first] = screen.getAllByLabelText('SKU');
    await userEvent.type(first!, 'NS-MINT');
    await userEvent.click(screen.getAllByTestId('variant-save')[0]!);
    expect(api.updateVariant).toHaveBeenCalledTimes(1);
    expect(api.updateVariant.mock.calls[0]![1]).not.toHaveProperty('price_override_minor');
    expect(api.setVariantStock).not.toHaveBeenCalled(); // stock untouched
  });

  it('saving the price writes it for the product and synchronizes all its variants in one action', async () => {
    renderPage();
    const price = await screen.findByTestId('product-price-input');
    await userEvent.clear(price);
    await userEvent.type(price, '700');
    await userEvent.click(screen.getByTestId('product-save'));
    expect(api.saveProductWithPrice).toHaveBeenCalledTimes(1);
    expect(api.saveProductWithPrice).toHaveBeenCalledWith('p1', expect.objectContaining({ base_price_minor: 70000 }));
    // The plain update (which would leave variant prices untouched) is not used for the card.
    expect(api.updateProduct).not.toHaveBeenCalled();
  });
});
