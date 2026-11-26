/**
 * Bonuses, automatic order-total discounts and promo codes («Бонусы и промокоды», migration 20261125090000).
 *
 * The SQL (private.loyalty_calc, private.bonus_for, private.percent_of) is the ONLY authority: checkout recomputes everything
 * and the cart shows the numbers of the `cart-quote` Edge Function. The pure functions below mirror it exactly — same
 * order of operations, same rounding — and exist for the admin forms (live examples) and for tests that prove the two
 * implementations agree (tests/integration/loyalty.test.ts runs the same vectors through both).
 *
 * THE PRICE RULE
 *   1. items total   = Σ lines at the price charged today (product discount prices of stage 4B are already inside).
 *   2. discount      = ONE of the automatic threshold discount and an applied promo code — never both: the code is applied
 *                      only when strictly better for the buyer, otherwise it is left unused. Percent discounts round DOWN
 *                      to a minor unit; a fixed code is capped at the items total.
 *   3. bonuses       = whole bonuses spent. 1 bonus = 1 whole currency unit = 100 minor units. At most the balance and at
 *                      most the whole units left after step 2.
 *   total            = items total − discount − 100 × bonuses (never negative).
 *   bonuses earned   = floor(total × percent / 100 / 100) when the administrator confirms the order — whole bonuses only.
 */

/** 1 bonus = 1 whole currency unit; every supported currency has exponent 2 (see money.ts). */
export const BONUS_UNIT_MINOR = 100;

export interface DiscountRule {
  id?: string;
  min_total_minor: number;
  percent: number;
}

/** Percent of an amount in minor units, rounded down. */
export function percentOf(minor: number, percent: number): number {
  return Math.floor((Math.max(minor, 0) * Math.max(percent, 0)) / 100);
}

/**
 * Bonuses earned for an eligible amount (what the buyer actually pays: after discounts and after spending bonuses).
 * 300000 minor (3 000 ₽) at 5 % → 150. Exact: the product is an integer multiple of 1/100 % so it is computed in integer
 * hundredths of a percent (no floating point).
 */
export function bonusFor(eligibleMinor: number, percent: number): number {
  if (!(eligibleMinor > 0) || !(percent > 0)) return 0;
  const hundredths = Math.round(percent * 100);
  // BigInt: eligible × hundredths can pass 2^53 for a huge order; the SQL does the same in numeric.
  return Number((BigInt(Math.trunc(eligibleMinor)) * BigInt(hundredths)) / BigInt(1_000_000));
}

/** The reached rule with the highest percent (ties: the higher minimum), or null. Rules never add up. */
export function bestThreshold(rules: readonly DiscountRule[], subtotalMinor: number): DiscountRule | null {
  const reached = rules.filter((r) => r.min_total_minor <= subtotalMinor);
  if (reached.length === 0) return null;
  return [...reached].sort((a, b) => b.percent - a.percent || b.min_total_minor - a.min_total_minor)[0]!;
}

/** The nearest higher minimum that gives a higher percent than the current one, with what is still missing. */
export function nextThreshold(rules: readonly DiscountRule[], subtotalMinor: number): (DiscountRule & { remaining_minor: number }) | null {
  const current = bestThreshold(rules, subtotalMinor)?.percent ?? 0;
  const next = rules
    .filter((r) => r.min_total_minor > subtotalMinor && r.percent > current)
    .sort((a, b) => a.min_total_minor - b.min_total_minor)[0];
  return next ? { ...next, remaining_minor: next.min_total_minor - subtotalMinor } : null;
}

export interface PromoDefinition {
  discount_type: 'percent' | 'fixed';
  percent?: number | null;
  fixed_minor?: number | null;
}

export function promoDiscount(promo: PromoDefinition, subtotalMinor: number): number {
  return promo.discount_type === 'percent' ? percentOf(subtotalMinor, promo.percent ?? 0) : Math.min(promo.fixed_minor ?? 0, subtotalMinor);
}

export interface PriceBreakdown {
  subtotalMinor: number;
  discountType: 'threshold' | 'promo' | null;
  discountMinor: number;
  afterDiscountMinor: number;
  /** Bonuses spent after clamping to the balance and to the whole units that remain to pay. */
  bonusApplied: number;
  bonusMaxSpend: number;
  totalMinor: number;
  /** Bonuses the administrator's confirmation would credit for this total. */
  bonusEarned: number;
}

export interface PriceInput {
  subtotalMinor: number;
  rules?: readonly DiscountRule[];
  promo?: PromoDefinition | null;
  bonusBalance?: number;
  bonusRequested?: number;
  bonusPercent?: number | null;
}

/** Same calculation as private.loyalty_calc for a code that is valid (the existence / activity checks are the server's). */
export function priceBreakdown(input: PriceInput): PriceBreakdown {
  const subtotal = input.subtotalMinor;
  const rule = bestThreshold(input.rules ?? [], subtotal);
  const threshold = rule ? percentOf(subtotal, rule.percent) : 0;
  const promo = input.promo ? promoDiscount(input.promo, subtotal) : 0;
  // A promo code is used only when strictly better than the automatic discount; they never add up.
  const usePromo = promo > 0 && threshold < promo;
  const discountMinor = usePromo ? promo : threshold;
  const discountType = usePromo ? 'promo' : threshold > 0 ? 'threshold' : null;
  const after = subtotal - discountMinor;
  const bonusOn = input.bonusPercent != null;
  const maxSpend = bonusOn ? Math.min(input.bonusBalance ?? 0, Math.floor(after / BONUS_UNIT_MINOR)) : 0;
  const applied = bonusOn ? Math.min(Math.max(input.bonusRequested ?? 0, 0), maxSpend) : 0;
  const total = after - applied * BONUS_UNIT_MINOR;
  return {
    subtotalMinor: subtotal,
    discountType,
    discountMinor,
    afterDiscountMinor: after,
    bonusApplied: applied,
    bonusMaxSpend: maxSpend,
    totalMinor: total,
    bonusEarned: bonusOn ? bonusFor(total, input.bonusPercent ?? 0) : 0,
  };
}

/** "1 бонус", "2 бонуса", "5 бонусов", "11 бонусов", "21 бонус". */
export function bonusWord(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const last = abs % 10;
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return 'бонусов';
  if (last === 1) return 'бонус';
  if (last >= 2 && last <= 4) return 'бонуса';
  return 'бонусов';
}

const grouped = new Intl.NumberFormat('ru-RU');
/** "1 234 бонуса" (a plain space, never a no-break one, so text matches are predictable). */
export function formatBonuses(n: number): string {
  return `${grouped.format(n).replace(/[\u00a0\u202f]/g, ' ')} ${bonusWord(n)}`;
}

// ---- Data shapes of the Edge Functions ----------------------------------------------------------------------------------

export type PromoStatus = 'applied' | 'not_applied' | 'invalid';
export type PromoReason = 'disabled' | 'not_found' | 'inactive' | 'exhausted' | 'no_effect' | 'better_discount';

/** Answer of cart-quote (public.loyalty_quote). */
export interface CartQuote {
  currency: string;
  features: { bonus: boolean; discount: boolean; promo: boolean };
  subtotal_minor: number;
  threshold: { percent: number; min_total_minor: number; discount_minor: number } | null;
  next_threshold: { percent: number; min_total_minor: number; remaining_minor: number } | null;
  promo: {
    code: string;
    status: PromoStatus;
    reason: PromoReason | null;
    discount_minor: number;
    kind: 'percent' | 'fixed' | null;
    percent: number | null;
    fixed_minor: number | null;
  } | null;
  discount: { type: 'threshold' | 'promo' | null; minor: number; info: Record<string, unknown> | null };
  after_discount_minor: number;
  bonus: {
    enabled: boolean;
    percent: number | null;
    balance: number;
    requested: number;
    applied: number;
    max_spend: number;
    spend_minor: number;
    unit_minor: number;
  };
  total_minor: number;
  accrual_preview: number;
}

/** True when any of the three features is on in the shop — the cart shows its extra blocks only then. */
export function quoteHasFeatures(q: CartQuote | undefined | null): q is CartQuote {
  return !!q && (q.features.bonus || q.features.discount || q.features.promo);
}

export type BonusOperationKind = 'accrual' | 'spend' | 'accrual_reversal' | 'spend_refund';

export interface BonusHistoryItem {
  id: number;
  kind: BonusOperationKind;
  /** Signed: + credited / returned, − spent / taken back. */
  amount: number;
  balance_after: number;
  order_id: string;
  order_number: number;
  created_at: string;
}

/** The buyer's bonus profile (public.loyalty_customer_profile); null/absent when the shop has no program and no balance. */
export interface BonusProfile {
  enabled: boolean;
  percent: number | null;
  balance: number;
  earned_total: number;
  spent_total: number;
  unit_minor: number;
  currency: string;
  history: BonusHistoryItem[];
}

/** "начислено за заказ №104" / "использовано в заказе №108" … */
export function describeBonusOperation(kind: BonusOperationKind, orderNumber: number): string {
  switch (kind) {
    case 'accrual':
      return `начислено за заказ №${orderNumber}`;
    case 'spend':
      return `использовано в заказе №${orderNumber}`;
    case 'spend_refund':
      return `возвращено: заказ №${orderNumber} отменён`;
    case 'accrual_reversal':
      return `списано: заказ №${orderNumber} отменён`;
  }
}

/** "+150" / "−50" (a real minus sign). */
export function formatSignedBonuses(n: number): string {
  return n > 0 ? `+${grouped.format(n).replace(/[\u00a0\u202f]/g, ' ')}` : `−${grouped.format(Math.abs(n)).replace(/[\u00a0\u202f]/g, ' ')}`;
}
