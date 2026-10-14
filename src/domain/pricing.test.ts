import { describe, expect, it } from 'vitest';
import { formatMoney, minorToInput, parseMoneyInput } from './money';
import { effectivePriceMinor, lineTotalMinor, orderTotalMinor, priceRange, totalQuantity } from './pricing';

describe('pricing', () => {
  it('uses price_override_minor when present, otherwise the base price', () => {
    expect(effectivePriceMinor(69000, { price_override_minor: null })).toBe(69000);
    expect(effectivePriceMinor(69000, { price_override_minor: 74000 })).toBe(74000);
    expect(effectivePriceMinor(69000, { price_override_minor: 0 })).toBe(0);
    expect(effectivePriceMinor(69000, null)).toBe(69000);
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

  it('reports price range across variants', () => {
    expect(priceRange(100, [])).toEqual({ min: 100, max: 100 });
    expect(priceRange(100, [{ price_override_minor: null }, { price_override_minor: 150 }, { price_override_minor: 90 }])).toEqual({ min: 90, max: 150 });
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
