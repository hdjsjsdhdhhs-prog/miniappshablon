import { describe, expect, it } from 'vitest';
import {
  canAddToCart,
  defaultSelection,
  findDuplicateCombos,
  findVariant,
  isOptionAvailable,
  variantFormSchema,
  variantLabel,
  variantOptions,
  type VariantLike,
} from './variants';
import { stockStatusOf } from './stock';

// The storefront gets only the status; `stock` here is just a readable way to pick it (same thresholds as SQL).
const v = (id: string, flavor: string | null, color: string | null, stock: number, active = true): VariantLike => ({
  id,
  flavor,
  color,
  stock_status: stockStatusOf(stock),
  is_active: active,
});

const variants = [
  v('a', 'Мята', 'Чёрный', 3),
  v('b', 'Мята', 'Белый', 0),
  v('c', 'Вишня', 'Чёрный', 5),
  v('d', 'Арбуз', 'Белый', 2, false),
];

describe('variants', () => {
  it('lists options of active variants only', () => {
    expect(variantOptions(variants)).toEqual({ flavors: ['Мята', 'Вишня'], colors: ['Чёрный', 'Белый'] });
  });

  it('finds only existing active combinations', () => {
    expect(findVariant(variants, { flavor: 'Мята', color: 'Белый' })?.id).toBe('b');
    expect(findVariant(variants, { flavor: 'Вишня', color: 'Белый' })).toBeNull();
    expect(findVariant(variants, { flavor: 'Арбуз', color: 'Белый' })).toBeNull(); // inactive
  });

  it('reports option availability relative to the other choice', () => {
    expect(isOptionAvailable(variants, 'color', 'Белый', 'Мята')).toEqual({ exists: true, inStock: false });
    expect(isOptionAvailable(variants, 'color', 'Белый', 'Вишня')).toEqual({ exists: false, inStock: false });
    expect(isOptionAvailable(variants, 'flavor', 'Вишня', null)).toEqual({ exists: true, inStock: true });
  });

  it('defaults to the first in-stock variant', () => {
    expect(defaultSelection([v('x', 'A', null, 0), v('y', 'B', null, 1)])).toEqual({ flavor: 'B', color: null });
    expect(defaultSelection([])).toEqual({ flavor: null, color: null });
  });

  it('blocks adding non-existent or out-of-stock variants and quantities over the business limit', () => {
    expect(canAddToCart(variants, { flavor: 'Вишня', color: 'Белый' }, 1)).toEqual({ ok: false, reason: 'no_variant' });
    expect(canAddToCart(variants, { flavor: 'Мята', color: 'Белый' }, 1)).toEqual({ ok: false, reason: 'out_of_stock' });
    expect(canAddToCart(variants, { flavor: 'Мята', color: 'Чёрный' }, 0)).toEqual({ ok: false, reason: 'invalid_quantity' });
    expect(canAddToCart(variants, { flavor: 'Мята', color: 'Чёрный' }, 1.5)).toEqual({ ok: false, reason: 'invalid_quantity' });
    expect(canAddToCart(variants, { flavor: 'Мята', color: 'Чёрный' }, 98, 2)).toEqual({ ok: false, reason: 'exceeds_limit' });
    const ok = canAddToCart(variants, { flavor: 'Мята', color: 'Чёрный' }, 3);
    expect(ok.ok && ok.variant.id).toBe('a');
  });

  it('stock boundaries: 0 cannot be added; 1 and 2 (low stock) can; the cap does not depend on the stock', () => {
    for (const [stock, ok] of [[0, false], [1, true], [2, true], [3, true]] as const) {
      const list = [v('x', 'A', null, stock)];
      expect(canAddToCart(list, { flavor: 'A', color: null }, 1).ok, `stock ${stock}`).toBe(ok);
      // Never capped at the stock: the server decides whether the quantity is there.
      if (ok) expect(canAddToCart(list, { flavor: 'A', color: null }, 5).ok, `stock ${stock}`).toBe(true);
    }
  });

  it('labels and detects duplicate combinations case-insensitively', () => {
    expect(variantLabel({ flavor: 'Мята', color: null })).toBe('Мята');
    expect(variantLabel({ flavor: 'Мята', color: 'Чёрный' })).toBe('Мята · Чёрный');
    expect(findDuplicateCombos([{ flavor: 'Мята', color: null }, { flavor: 'мята ', color: null }])).toEqual([1]);
  });

  it('validates admin variant form input', () => {
    const base = { flavor: '', color: '', sku: '', stock: '5', isActive: true };
    expect(variantFormSchema.safeParse(base).success).toBe(true);
    expect(variantFormSchema.safeParse({ ...base, stock: '-1' }).success).toBe(false);
    expect(variantFormSchema.safeParse({ ...base, stock: '1.5' }).success).toBe(false);
    // One price per product: the variant form has no price; a stray price field never reaches the parsed row.
    const parsed = variantFormSchema.parse({ ...base, price: '740' });
    expect(Object.keys(parsed).sort()).toEqual(['color', 'flavor', 'isActive', 'sku', 'stock']);
  });
});
