import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { cartStore } from '@/features/cart/cart-store';
import type { ProductDetail, Shop, Variant } from '../api';
import { ShopContext } from '../shop-context';
import { QuickAddSheet } from './QuickAddSheet';

const v = (id: string, flavor: string | null, color: string | null, stock: number): Variant => ({
  id,
  flavor,
  color,
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
    const { sheet } = open(make([v('a', 'Мята', null, 3), v('b', 'Вишня', null, 0), v('c', 'Черника', null, 8)]));
    expect(within(sheet).getByRole('heading', { name: 'Noir Salt 30 мл' })).toBeInTheDocument();
    const group = within(sheet).getByRole('radiogroup', { name: 'Выберите вкус' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual([
      expect.stringContaining('Мята'),
      expect.stringContaining('Черника'),
    ]);
    expect(within(group).queryByText('Вишня')).not.toBeInTheDocument();
    for (const r of within(group).getAllByRole('radio')) expect(r).toHaveAttribute('aria-checked', 'false');
    // Chips carry only the name and the remaining stock — never a price (the price is shown once, in the header).
    expect(within(group).getAllByTestId('quick-option-stock').map((s) => s.textContent)).toEqual(['ОСТАЛОСЬ: 3', 'ОСТАЛОСЬ: 8']);
    for (const r of within(group).getAllByRole('radio')) expect(r.textContent).not.toMatch(/₽|\d\s?\d{3}/);
    // One fixed product price in the header even before a flavor is chosen — never "от".
    expect(screen.getByTestId('quick-price')).toHaveTextContent(/^690\s?₽$/);
    expect(sheet).not.toHaveTextContent(/(^|\s)от\s/);
    expect(confirmBtn()).toBeDisabled();
    expect(confirmBtn()).toHaveTextContent('Выберите вкус');
    expect(lines()).toEqual([]);
  });

  it('highlights the chosen flavor, keeps the product price and adds exactly that variant with the quantity', async () => {
    const { onOpenChange } = open(make([v('a', 'Мята', null, 3), v('c', 'Черника', null, 8)]));
    await userEvent.click(screen.getByRole('radio', { name: /Черника/ }));
    expect(screen.getByRole('radio', { name: /Черника/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Мята/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('quick-price')).toHaveTextContent(/^690\s?₽$/);
    await userEvent.click(screen.getByRole('button', { name: 'Увеличить' }));
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([
      expect.objectContaining({ variantId: 'c', productId: 'p1', variantLabel: 'Черника', unitPriceMinor: 69000, quantity: 2 }),
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

  it('one price for every flavor when variants have no own price; chips show stock only', async () => {
    open(make([v('a', 'Мята', null, 4), v('c', 'Черника', null, 12)]));
    const price = screen.getByTestId('quick-price');
    expect(price).toHaveTextContent('690');
    expect(price).not.toHaveTextContent('от');
    expect(screen.getByRole('radio', { name: /Мята/ })).toHaveTextContent('ОСТАЛОСЬ: 4');
    await userEvent.click(screen.getByRole('radio', { name: /Черника/ }));
    expect(price).toHaveTextContent('690');
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([expect.objectContaining({ variantId: 'c', unitPriceMinor: 69000 })]);
  });

  it('Noir Salt with one price: shown once in the header, never changes with the flavor, cart gets that price', async () => {
    const { sheet } = open(make([v('m', 'Манго-маракуйя', null, 12), v('c', 'Ледяная вишня', null, 8), v('b', 'Черника', null, 5)]));
    const price = screen.getByTestId('quick-price');
    // Exactly one price in the whole panel.
    expect(within(sheet).getAllByText(/690/)).toHaveLength(1);
    expect(price).toHaveTextContent(/^690\s?₽$/);
    for (const name of [/Черника/, /Манго/, /вишня/]) {
      await userEvent.click(screen.getByRole('radio', { name }));
      expect(price).toHaveTextContent(/^690\s?₽$/);
      expect(within(sheet).getAllByText(/690/)).toHaveLength(1);
    }
    expect(within(sheet).getAllByTestId('quick-option-stock').map((s) => s.textContent)).toEqual([
      'ОСТАЛОСЬ: 12',
      'ОСТАЛОСЬ: 8',
      'ОСТАЛОСЬ: 5',
    ]);
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([expect.objectContaining({ variantId: 'c', unitPriceMinor: 69000, quantity: 1 })]);
  });

  it('Aurum Pod with one price: switching the color keeps the price', async () => {
    const pod = { ...make([v('g', null, 'Графит', 4), v('au', null, 'Золото', 2)]), name: 'Aurum Pod', basePriceMinor: 249000 };
    open(pod);
    const price = screen.getByTestId('quick-price');
    expect(price).toHaveTextContent(/^2\s?490\s?₽$/);
    await userEvent.click(screen.getByRole('radio', { name: /Золото/ }));
    expect(price).toHaveTextContent(/^2\s?490\s?₽$/);
    expect(screen.getByRole('radio', { name: /Золото/ })).toHaveTextContent('ОСТАЛОСЬ: 2');
    await userEvent.click(screen.getByRole('radio', { name: /Графит/ }));
    expect(price).toHaveTextContent(/^2\s?490\s?₽$/);
    await userEvent.click(confirmBtn());
    expect(lines()).toEqual([expect.objectContaining({ variantId: 'g', unitPriceMinor: 249000 })]);
  });

  it('a flavor offered in several colors shows the stock that fits the current choice', async () => {
    open(make([v('1', 'Мята', 'Чёрный', 2), v('2', 'Мята', 'Белый', 3), v('3', 'Вишня', 'Белый', 4)]));
    expect(screen.getByRole('radio', { name: /Мята/ })).toHaveTextContent('ОСТАЛОСЬ: 5');
    await userEvent.click(screen.getByRole('radio', { name: /Мята/ }));
    const colors = screen.getByRole('radiogroup', { name: 'Цвет' });
    expect(within(colors).getByRole('radio', { name: /Белый/ })).toHaveTextContent('ОСТАЛОСЬ: 3');
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
