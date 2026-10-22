import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { VariantLike, VariantSelection } from '@/domain/variants';
import { BottomNav } from './BottomNav';
import { CategoryTiles } from './CategoryTiles';
import { QuantityStepper } from './QuantityStepper';
import { VariantPicker } from './VariantPicker';

const variants: VariantLike[] = [
  { id: 'a', flavor: 'Мята', color: 'Чёрный', stock_quantity: 3, is_active: true },
  { id: 'b', flavor: 'Вишня', color: 'Белый', stock_quantity: 0, is_active: true },
];

function PickerHarness({ onSel }: { onSel?: (s: VariantSelection) => void }) {
  const [sel, setSel] = useState<VariantSelection>({ flavor: 'Мята', color: 'Чёрный' });
  return (
    <>
      <VariantPicker variants={variants} selection={sel} onChange={(s) => { setSel(s); onSel?.(s); }} />
      <output data-testid="sel">{`${sel.flavor}|${sel.color}`}</output>
    </>
  );
}

describe('VariantPicker', () => {
  it('renders flavor and color groups with radio semantics and stock hints', () => {
    render(<PickerHarness />);
    expect(screen.getByRole('radiogroup', { name: 'Вкус' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Мята' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Вишня.*нет в наличии/ })).toBeInTheDocument();
  });

  it('switching to an option without the current combination selects an existing variant', async () => {
    render(<PickerHarness />);
    await userEvent.click(screen.getByRole('radio', { name: /Вишня/ }));
    // Вишня exists only with Белый, so the color follows; the selection always maps to a real row.
    expect(screen.getByTestId('sel')).toHaveTextContent('Вишня|Белый');
  });
});

describe('BottomNav', () => {
  it('links to catalog, cart (with count) and profile of the current shop', () => {
    render(
      <MemoryRouter initialEntries={['/s/demo/cart']}>
        <BottomNav slug="demo" cartCount={3} />
      </MemoryRouter>,
    );
    // The catalog is the shop home; it must not stay highlighted on other sections.
    const catalog = screen.getByRole('link', { name: /Каталог/ });
    expect(catalog).toHaveAttribute('href', '/s/demo/');
    expect(catalog).not.toHaveAttribute('aria-current');
    const cart = screen.getByRole('link', { name: /Корзина/ });
    expect(cart).toHaveAttribute('href', '/s/demo/cart');
    expect(cart).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('cart-count')).toHaveTextContent('3');
    expect(screen.getByRole('link', { name: /Профиль/ })).toHaveAttribute('href', '/s/demo/profile');
  });

  it('the shared selected surface follows the current route and hides where no tab is current', async () => {
    render(
      <MemoryRouter initialEntries={['/s/demo/cart']}>
        <BottomNav slug="demo" cartCount={0} />
      </MemoryRouter>,
    );
    const indicator = screen.getByTestId('bottom-nav-indicator');
    expect(indicator).toHaveAttribute('data-visible');
    expect(indicator.style.getPropertyValue('--nav-index')).toBe('1');

    await userEvent.click(screen.getByRole('link', { name: /Профиль/ }));
    expect(screen.getByRole('link', { name: /Профиль/ })).toHaveAttribute('aria-current', 'page');
    expect(indicator.style.getPropertyValue('--nav-index')).toBe('2');

    await userEvent.click(screen.getByRole('link', { name: /Каталог/ }));
    expect(indicator.style.getPropertyValue('--nav-index')).toBe('0');
  });

  it('no tab highlighted on a product page', () => {
    render(
      <MemoryRouter initialEntries={['/s/demo/product/42']}>
        <BottomNav slug="demo" cartCount={0} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('bottom-nav-indicator')).not.toHaveAttribute('data-visible');
    expect(screen.queryByRole('link', { current: 'page' })).not.toBeInTheDocument();
  });
});

describe('QuantityStepper & CategoryTiles', () => {
  it('respects min/max bounds', async () => {
    const values: number[] = [];
    render(<QuantityStepper value={1} max={2} onChange={(v) => values.push(v)} />);
    expect(screen.getByRole('button', { name: 'Уменьшить' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Увеличить' }));
    expect(values).toEqual([2]);
  });

  it('category tiles mark only the selected tile as pressed and report clicks (also on the active one)', async () => {
    const picked: string[] = [];
    const cats = [
      { id: '1', name: 'Жидкости', slug: 'liquids', imagePath: null },
      { id: '2', name: 'Pod-системы', slug: 'pods', imagePath: null },
    ];
    render(<CategoryTiles categories={cats} selected="liquids" onSelect={(s) => picked.push(s)} />);
    expect(screen.getByRole('button', { name: 'Жидкости' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pod-системы' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Pod-системы' }));
    await userEvent.click(screen.getByRole('button', { name: 'Жидкости' }));
    expect(picked).toEqual(['pods', 'liquids']);
  });
});
