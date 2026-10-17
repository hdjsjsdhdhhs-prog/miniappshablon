import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { cartStore } from '@/features/cart/cart-store';
import type { ProductDetail, Shop, Variant } from '../api';
import { ShopContext } from '../shop-context';
import { QuickAddSheet } from './QuickAddSheet';

const v = (id: string, flavor: string | null, color: string | null, stock: number, price: number | null = null): Variant => ({
  id,
  flavor,
  color,
  price_override_minor: price,
  stock_quantity: stock,
  is_active: true,
  sort_order: 0,
});

const make = (variants: Variant[]): ProductDetail => ({
  id: 'p1',
  name: 'Noir Salt 30 мл',
  description: '',
  basePriceMinor: 69000,
  categoryId: 'c',
  categoryName: 'Жидкости',
  categorySlug: 'liquids',
  images: [],
  variants,
});

// Fake "server" behind useProduct: `server` is what the next (re)fetch returns.
let server: ProductDetail;
let current: { data: ProductDetail | undefined; isError: boolean; error: unknown };
vi.mock('../hooks', () => ({
  useProduct: () => ({
    ...current,
    refetch: async () => {
      current = { data: server, isError: false, error: null };
      return current;
    },
  }),
}));

const shop = {
  id: 'shop-qa',
  slug: 'demo',
  name: 'Demo',
  currency: 'RUB',
  theme: DARK_PREMIUM_THEME,
} as Shop;

function open(product: ProductDetail, onOpenChange = vi.fn()) {
  server = product;
  current = { data: product, isError: false, error: null };
  render(
    <ShopContext.Provider value={shop}>
      <MemoryRouter>
        <QuickAddSheet product={product} open onOpenChange={onOpenChange} />
      </MemoryRouter>
    </ShopContext.Provider>,
  );
  return { onOpenChange, sheet: screen.getByTestId('quick-add-sheet') };
}

const confirmBtn = () => screen.getByTestId('quick-confirm');
const lines = () => cartStore.getLines(shop.id);

describe('QuickAddSheet', () => {
  beforeEach(() => {
    localStorage.clear();
    cartStore._resetCache();
  });

  it('shows name, price and only purchasable flavors; nothing is pre-selected or added on open', () => {
    const { sheet } = open(make([v('a', 'Мята', null, 3), v('b', 'Вишня', null, 0), v('c', 'Черника', null, 8, 74000)]));
    expect(within(sheet).getByRole('heading', { name: 'Noir Salt 30 мл' })).toBeInTheDocument();
    const group = within(sheet).getByRole('radiogroup', { name: 'Выберите вкус' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Мята'),
      expect.stringContaining('Черника'),
    ]);
    expect(within(group).queryByText('Вишня')).not.toBeInTheDocument();
    for (const r of within(group).getAllByRole('radio')) expect(r).toHaveAttribute('aria-checked', 'false');
    // Prices differ → "от" the minimum until a flavor is chosen.
    expect(screen.getByTestId('quick-price')).toHaveTextContent(/от\s*690/);
    expect(confirmBtn()).toBeDisabled();
    expect(confirmBtn()).toHaveTextContent('Выберите вкус');
    expect(lines()).toEqual([]);
  });

  it('highlights the chosen flavor, shows its price and adds exactly that variant with the quantity', async () => {
    const { onOpenChange } = open(make([v('a', 'Мята', null, 3), v('c', 'Черника', null, 8, 74000)]));
    await userEvent.click(screen.getByRole('radio', { name: /Черника/ }));
    expect(screen.getByRole('radio', { name: /Черника/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Мята/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('quick-price')).toHaveTextContent('740');
    await userEvent.click(screen.getByRole('button', { name: 'Увеличить' }));
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([
      expect.objectContaining({ variantId: 'c', productId: 'p1', variantLabel: 'Черника', unitPriceMinor: 74000, quantity: 2 }),
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a repeated add of the same variant merges into one line (existing cart behaviour)', async () => {
    cartStore.add(shop.id, { variantId: 'a', productId: 'p1', name: 'Noir Salt 30 мл', variantLabel: 'Мята', unitPriceMinor: 69000, imagePath: null, maxQuantity: 3 }, 1);
    open(make([v('a', 'Мята', null, 3)]));
    await userEvent.click(screen.getByRole('radio', { name: /Мята/ }));
    expect(screen.getByTestId('quick-in-cart')).toHaveTextContent('Уже в корзине: 1 шт.');
    await userEvent.click(confirmBtn());
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ variantId: 'a', quantity: 2 });
  });

  it('refuses the add when stock ran out after opening and offers a refresh', async () => {
    const { onOpenChange } = open(make([v('a', 'Мята', null, 3), v('c', 'Черника', null, 8)]));
    await userEvent.click(screen.getByRole('radio', { name: /Мята/ }));
    server = make([v('a', 'Мята', null, 0), v('c', 'Черника', null, 8)]);
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([]);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('quick-error')).toHaveTextContent('Этот вариант закончился');
    expect(screen.getByRole('button', { name: /Обновить/ })).toBeInTheDocument();
    // The sold-out flavor disappears from the fresh list.
    expect(screen.queryByRole('radio', { name: /Мята/ })).not.toBeInTheDocument();
  });

  it('offers only existing flavor × color combinations', async () => {
    open(make([v('1', 'Мята', 'Чёрный', 2), v('2', 'Мята', 'Белый', 0), v('3', 'Вишня', 'Белый', 4)]));
    await userEvent.click(screen.getByRole('radio', { name: /Мята/ }));
    const colors = screen.getByRole('radiogroup', { name: 'Цвет' });
    // Мята/Белый is out of stock → only Чёрный is offered with Мята.
    expect(within(colors).getAllByRole('radio').map((r) => r.textContent)).toEqual([expect.stringContaining('Чёрный')]);
    expect(confirmBtn()).toHaveTextContent('Выберите цвет');
    await userEvent.click(within(colors).getByRole('radio', { name: /Чёрный/ }));
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([expect.objectContaining({ variantId: '1', variantLabel: 'Мята · Чёрный' })]);
  });

  it('a product without options needs no empty flavor list: direct confirmation', async () => {
    open(make([v('d', null, null, 5)]));
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(confirmBtn()).toBeEnabled();
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([expect.objectContaining({ variantId: 'd', quantity: 1 })]);
  });

  it('everything sold out → "Нет в наличии", confirmation disabled', () => {
    open(make([v('a', 'Мята', null, 0)]));
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(confirmBtn()).toBeDisabled();
    expect(confirmBtn()).toHaveTextContent('Нет в наличии');
  });
});
