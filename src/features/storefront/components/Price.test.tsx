import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { formatMoney } from '@/domain/money';
import type { ProductDetail } from '../api';
import { Price } from './Price';
import { ProductCard } from './ProductCard';

vi.mock('@/lib/supabase', () => ({ publicImageUrl: () => null, supabase: {} }));

const money = (minor: number) => formatMoney(minor, 'RUB');

describe('Price', () => {
  it('without a discount renders the amount only — exactly as before', () => {
    const { container } = render(
      <p>
        <Price priceMinor={69000} currency="RUB" />
      </p>,
    );
    expect(container.querySelector('p')!.textContent).toBe(money(69000));
    expect(container.querySelector('p')!.children).toHaveLength(0);
    expect(screen.queryByTestId('price-discounted')).not.toBeInTheDocument();
  });

  it('with a discount shows the price charged first and the list price struck through, both named for screen readers', () => {
    render(<Price priceMinor={59000} oldPriceMinor={69000} currency="RUB" />);
    expect(screen.getByTestId('price-current').textContent).toBe(money(59000));
    const old = screen.getByTestId('price-old');
    expect(old.tagName).toBe('S');
    expect(old.textContent).toBe(money(69000));
    expect(screen.getByTestId('price-discounted').textContent).toBe(`Цена со скидкой: ${money(59000)}, прежняя цена: ${money(69000)}`);
  });

  it.each([
    ['equal to the price', 69000],
    ['lower than the price', 50000],
    ['null', null],
    ['absent', undefined],
  ])('an old price that is %s is ignored', (_label, oldPrice) => {
    const { container } = render(<Price priceMinor={69000} oldPriceMinor={oldPrice} currency="RUB" />);
    expect(container.textContent).toBe(money(69000));
    expect(container.querySelector('s')).toBeNull();
  });
});

describe('ProductCard price', () => {
  const product = (over: Partial<ProductDetail> = {}) =>
    ({
      id: 'p1',
      name: 'Noir Salt 30 мл',
      description: '',
      basePriceMinor: 69000,
      discountPriceMinor: null,
      categoryId: 'c',
      categoryName: 'Жидкости',
      categorySlug: 'liquids',
      variants: [{ id: 'v1', flavor: 'Мята', color: null, stock_status: 'in_stock', is_active: true, sort_order: 0 }],
      images: [],
      ...over,
    }) as ProductDetail;
  const renderCard = (p: ProductDetail) =>
    render(
      <MemoryRouter>
        <ProductCard product={p} slug="noir-vapor" currency="RUB" />
      </MemoryRouter>,
    );

  it('a product without a discount shows its price as plain text', () => {
    renderCard(product());
    expect(screen.getByTestId('product-card-price').textContent).toBe(money(69000));
    expect(screen.queryByTestId('price-old')).not.toBeInTheDocument();
  });

  it('a discounted product shows the discount price and the regular price struck through', () => {
    renderCard(product({ discountPriceMinor: 59000 }));
    const price = screen.getByTestId('product-card-price');
    expect(price.querySelector('[data-testid="price-current"]')!.textContent).toBe(money(59000));
    expect(price.querySelector('s')!.textContent).toBe(money(69000));
  });

  it('a discount that is not below the price is never shown', () => {
    renderCard(product({ discountPriceMinor: 69000 }));
    expect(screen.getByTestId('product-card-price').textContent).toBe(money(69000));
    expect(screen.queryByTestId('price-discounted')).not.toBeInTheDocument();
  });
});
