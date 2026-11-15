import { describe, expect, it } from 'vitest';
import { formatMoney, minorToInput, parseMoneyInput } from './money';
import { isValidDiscount, lineTotalMinor, orderTotalMinor, productOldPriceMinor, productPriceMinor, totalQuantity } from './pricing';

describe('pricing', () => {
  it('one price per product: the product price, whatever variants it has', () => {
    expect(productPriceMinor({ basePriceMinor: 69000 })).toBe(69000);
    const noirSalt = { basePriceMinor: 69000, variants: [{ flavor: 'Манго' }, { flavor: 'Черника' }, { flavor: 'Ледяная вишня' }] };
    expect(productPriceMinor(noirSalt)).toBe(69000);
    const aurumPod = { basePriceMinor: 249000, variants: [{ color: 'Графит' }, { color: 'Золото' }] };
    expect(productPriceMinor(aurumPod)).toBe(249000);
  });

  it('a discount: the buyer pays the discount price and the list price is the one shown struck through', () => {
    const noirSalt = { basePriceMinor: 69000, discountPriceMinor: 59000 };
    expect(productPriceMinor(noirSalt)).toBe(59000);
    expect(productOldPriceMinor(noirSalt)).toBe(69000);
    // Without a discount everything is as before: the product price, and no old price.
    for (const plain of [{ basePriceMinor: 69000 }, { basePriceMinor: 69000, discountPriceMinor: null }, { basePriceMinor: 69000, discountPriceMinor: undefined }]) {
      expect(productPriceMinor(plain)).toBe(69000);
      expect(productOldPriceMinor(plain)).toBeNull();
    }
  });

  it('a discount is a positive whole amount strictly below the price; anything else is ignored, never charged', () => {
    expect(isValidDiscount(69000, 59000)).toBe(true);
    expect(isValidDiscount(69000, 1)).toBe(true);
    for (const bad of [69000, 70000, 0, -100, 590.5, Number.NaN, null, undefined]) {
      expect(isValidDiscount(69000, bad), String(bad)).toBe(false);
      expect(productPriceMinor({ basePriceMinor: 69000, discountPriceMinor: bad }), String(bad)).toBe(69000);
      expect(productOldPriceMinor({ basePriceMinor: 69000, discountPriceMinor: bad }), String(bad)).toBeNull();
    }
  });

  it('computes line and order totals in integer minor units', () => {
    const lines = [
      { unitPriceMinor: 69000, quantity: 2 },
      { unitPriceMinor: 1990, quantity: 3 },
    ];
    expect(lineTotalMinor(lines[0]!)).toBe(138000);
    expect(orderTotalMinor(lines)).toBe(143970);
    expect(totalQuantity(lines)).toBe(5);
    expect(orderTotalMinor([])).toBe(0);
  });
});

describe('money', () => {
  it('parses user input without float errors', () => {
    expect(parseMoneyInput('1290')).toBe(129000);
    expect(parseMoneyInput('1 290,5')).toBe(129050);
    expect(parseMoneyInput('0.07')).toBe(7);
    expect(parseMoneyInput('12.345')).toBeNull();
    expect(parseMoneyInput('-1')).toBeNull();
    expect(parseMoneyInput('abc')).toBeNull();
  });

  it('round-trips minor units for inputs', () => {
    expect(minorToInput(129000)).toBe('1290');
    expect(minorToInput(129050)).toBe('1290,50');
    expect(parseMoneyInput(minorToInput(7))).toBe(7);
  });

  it('formats currency from minor units', () => {
    expect(formatMoney(129000, 'RUB').replace(/\s/g, ' ')).toMatch(/1 290\s?₽/);
  });
});
