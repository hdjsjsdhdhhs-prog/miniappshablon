import { describe, expect, it } from 'vitest';
import {
  bestThreshold,
  bonusFor,
  bonusWord,
  describeBonusOperation,
  formatBonuses,
  formatSignedBonuses,
  nextThreshold,
  percentOf,
  priceBreakdown,
  promoDiscount,
  quoteHasFeatures,
  type CartQuote,
  type DiscountRule,
} from './loyalty';

const RULES: DiscountRule[] = [
  { min_total_minor: 300_000, percent: 5 },
  { min_total_minor: 500_000, percent: 7 },
  { min_total_minor: 1_000_000, percent: 10 },
];

describe('bonusFor — the accrual rule', () => {
  it('3 000 ₽ at 5 % → 150 bonuses (the example of the task)', () => {
    expect(bonusFor(300_000, 5)).toBe(150);
  });

  it('whole bonuses only: fractions are dropped, never rounded up', () => {
    expect(bonusFor(99_999, 5)).toBe(49); // 999.99 ₽ × 5 % = 49.9995
    expect(bonusFor(100_000, 5)).toBe(50);
    expect(bonusFor(1_999, 5)).toBe(0); // 19.99 ₽ × 5 % = 0.9995
    expect(bonusFor(2_000, 5)).toBe(1);
  });

  it('handles fractional percents exactly (two decimals) without floating point drift', () => {
    expect(bonusFor(100_000, 2.5)).toBe(25);
    expect(bonusFor(100_000, 0.07)).toBe(0);
    expect(bonusFor(10_000_000, 0.07)).toBe(70); // 100 000 ₽ × 0.07 %
    expect(bonusFor(333_300, 7.77)).toBe(258); // 3333 ₽ × 7.77 % = 258.9741
    expect(bonusFor(100_000, 100)).toBe(1_000);
  });

  it('nothing for an empty / negative amount or a zero percent', () => {
    expect(bonusFor(0, 5)).toBe(0);
    expect(bonusFor(-100, 5)).toBe(0);
    expect(bonusFor(300_000, 0)).toBe(0);
  });
});

describe('automatic discount by order total', () => {
  it('picks the best reached level and never adds levels up', () => {
    expect(bestThreshold(RULES, 299_999)).toBeNull();
    expect(bestThreshold(RULES, 300_000)?.percent).toBe(5);
    expect(bestThreshold(RULES, 300_001)?.percent).toBe(5);
    expect(bestThreshold(RULES, 499_999)?.percent).toBe(5);
    expect(bestThreshold(RULES, 500_000)?.percent).toBe(7);
    expect(bestThreshold(RULES, 999_999)?.percent).toBe(7);
    expect(bestThreshold(RULES, 1_000_000)?.percent).toBe(10);
    expect(bestThreshold(RULES, 50_000_000)?.percent).toBe(10);
  });

  it('chooses the most favourable percent even when the levels are not monotonic', () => {
    const odd: DiscountRule[] = [
      { min_total_minor: 100_000, percent: 9 },
      { min_total_minor: 200_000, percent: 4 },
    ];
    expect(bestThreshold(odd, 250_000)?.percent).toBe(9);
  });

  it('the discount is rounded down to a minor unit', () => {
    expect(percentOf(300_000, 5)).toBe(15_000);
    expect(percentOf(300_001, 5)).toBe(15_000);
    expect(percentOf(299_999, 5)).toBe(14_999); // 14 999.95
    expect(percentOf(0, 5)).toBe(0);
  });

  it('boundaries: just below, exactly on and just above a threshold', () => {
    const at = (s: number) => priceBreakdown({ subtotalMinor: s, rules: RULES });
    expect(at(299_999)).toMatchObject({ discountType: null, discountMinor: 0, totalMinor: 299_999 });
    expect(at(300_000)).toMatchObject({ discountType: 'threshold', discountMinor: 15_000, totalMinor: 285_000 });
    expect(at(300_001)).toMatchObject({ discountMinor: 15_000, totalMinor: 285_001 });
    expect(at(500_000)).toMatchObject({ discountMinor: 35_000, totalMinor: 465_000 });
    expect(at(1_000_000)).toMatchObject({ discountMinor: 100_000, totalMinor: 900_000 });
  });

  it('tells how much is missing for the next worthwhile level', () => {
    expect(nextThreshold(RULES, 255_000)).toMatchObject({ min_total_minor: 300_000, percent: 5, remaining_minor: 45_000 });
    expect(nextThreshold(RULES, 300_000)).toMatchObject({ min_total_minor: 500_000, percent: 7, remaining_minor: 200_000 });
    expect(nextThreshold(RULES, 1_000_000)).toBeNull();
    // A higher minimum with a LOWER percent is never offered.
    expect(nextThreshold([{ min_total_minor: 100_000, percent: 9 }, { min_total_minor: 200_000, percent: 4 }], 150_000)).toBeNull();
  });
});

describe('promo codes', () => {
  it('percent: rounded down; fixed: capped at the items total', () => {
    expect(promoDiscount({ discount_type: 'percent', percent: 10 }, 123_459)).toBe(12_345);
    expect(promoDiscount({ discount_type: 'fixed', fixed_minor: 30_000 }, 100_000)).toBe(30_000);
    expect(promoDiscount({ discount_type: 'fixed', fixed_minor: 30_000 }, 20_000)).toBe(20_000);
  });
});

describe('priceBreakdown — one order of operations', () => {
  it('threshold and promo never add up: the better one wins, a tie leaves the promo unused', () => {
    // 6 000 ₽: threshold 7 % = 420 ₽.
    const base = { subtotalMinor: 600_000, rules: RULES };
    expect(priceBreakdown({ ...base, promo: { discount_type: 'fixed', fixed_minor: 30_000 } })).toMatchObject({ discountType: 'threshold', discountMinor: 42_000 });
    expect(priceBreakdown({ ...base, promo: { discount_type: 'percent', percent: 10 } })).toMatchObject({ discountType: 'promo', discountMinor: 60_000, totalMinor: 540_000 });
    expect(priceBreakdown({ ...base, promo: { discount_type: 'fixed', fixed_minor: 42_000 } })).toMatchObject({ discountType: 'threshold', discountMinor: 42_000 });
  });

  it('a promo alone below the first threshold', () => {
    expect(priceBreakdown({ subtotalMinor: 100_000, rules: RULES, promo: { discount_type: 'fixed', fixed_minor: 30_000 } })).toMatchObject({
      discountType: 'promo',
      discountMinor: 30_000,
      totalMinor: 70_000,
    });
  });

  it('bonuses come last: clamped to the balance and to the whole currency units left to pay', () => {
    const base = { subtotalMinor: 300_000, rules: RULES, bonusPercent: 5 };
    // 3 000 ₽ − 5 % = 2 850 ₽ to pay → at most 2 850 bonuses.
    expect(priceBreakdown({ ...base, bonusBalance: 50, bonusRequested: 50 })).toMatchObject({ bonusApplied: 50, totalMinor: 280_000, bonusMaxSpend: 50 });
    expect(priceBreakdown({ ...base, bonusBalance: 50, bonusRequested: 999 })).toMatchObject({ bonusApplied: 50 });
    expect(priceBreakdown({ ...base, bonusBalance: 9_999, bonusRequested: 9_999 })).toMatchObject({ bonusApplied: 2_850, totalMinor: 0 });
    expect(priceBreakdown({ ...base, bonusBalance: 100, bonusRequested: -5 })).toMatchObject({ bonusApplied: 0 });
  });

  it('the total is never negative, even with a fixed promo above the items total', () => {
    const r = priceBreakdown({ subtotalMinor: 20_000, promo: { discount_type: 'fixed', fixed_minor: 30_000 }, bonusPercent: 5, bonusBalance: 500, bonusRequested: 500 });
    expect(r.totalMinor).toBe(0);
    expect(r.discountMinor).toBe(20_000);
    expect(r.bonusApplied).toBe(0);
  });

  it('bonuses earned are counted from what is actually paid, after discounts and spent bonuses (the task example)', () => {
    // 3 000 ₽, no discounts, 5 %: 150.
    expect(priceBreakdown({ subtotalMinor: 300_000, bonusPercent: 5 }).bonusEarned).toBe(150);
    // 3 000 ₽ with the 5 % threshold and 100 bonuses spent: pay 2 750 ₽ → 137 (137.5 dropped to 137).
    expect(priceBreakdown({ subtotalMinor: 300_000, rules: RULES, bonusPercent: 5, bonusBalance: 100, bonusRequested: 100 })).toMatchObject({ totalMinor: 275_000, bonusEarned: 137 });
  });

  it('with every feature off the total is exactly the items total', () => {
    expect(priceBreakdown({ subtotalMinor: 123_456 })).toMatchObject({ discountType: null, discountMinor: 0, bonusApplied: 0, totalMinor: 123_456, bonusEarned: 0 });
    // Bonuses off (no percent) ignore any balance / request.
    expect(priceBreakdown({ subtotalMinor: 123_456, bonusBalance: 500, bonusRequested: 500 }).totalMinor).toBe(123_456);
  });
});

describe('bonus wording', () => {
  it('declines "бонус" by the Russian rules', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111, 112].map(bonusWord)).toEqual(['бонус', 'бонуса', 'бонусов', 'бонусов', 'бонус', 'бонуса', 'бонусов', 'бонусов', 'бонусов']);
    expect(formatBonuses(150)).toBe('150 бонусов');
    expect(formatBonuses(1234)).toBe('1 234 бонуса');
  });

  it('describes the history operations of the profile', () => {
    expect(describeBonusOperation('accrual', 104)).toBe('начислено за заказ №104');
    expect(describeBonusOperation('spend', 108)).toBe('использовано в заказе №108');
    expect(describeBonusOperation('spend_refund', 108)).toBe('возвращено: заказ №108 отменён');
    expect(describeBonusOperation('accrual_reversal', 104)).toBe('списано: заказ №104 отменён');
    expect(formatSignedBonuses(150)).toBe('+150');
    expect(formatSignedBonuses(-50)).toBe('−50');
  });
});

describe('quoteHasFeatures', () => {
  const quote = (features: CartQuote['features']) => ({ features }) as CartQuote;
  it('is false when the shop uses none of the features (the cart then stays as it was)', () => {
    expect(quoteHasFeatures(undefined)).toBe(false);
    expect(quoteHasFeatures(quote({ bonus: false, discount: false, promo: false }))).toBe(false);
    expect(quoteHasFeatures(quote({ bonus: false, discount: true, promo: false }))).toBe(true);
    expect(quoteHasFeatures(quote({ bonus: false, discount: false, promo: true }))).toBe(true);
    expect(quoteHasFeatures(quote({ bonus: true, discount: false, promo: false }))).toBe(true);
  });
});
