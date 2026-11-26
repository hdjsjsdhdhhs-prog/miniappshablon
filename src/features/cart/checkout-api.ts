import type { BonusProfile, CartQuote } from '@/domain/loyalty';
import { functionsUrl } from '@/lib/supabase';
import { env } from '@/lib/env';
import type { CartLine } from './cart-store';
import type { CheckoutFulfillment } from './checkout-schema';

export interface OrderItemDto {
  id: string;
  product_id: string | null;
  variant_id: string | null;
  product_name: string;
  variant_label: string;
  flavor: string | null;
  color: string | null;
  /** Price charged for one unit (snapshot taken by the server when the order was created). */
  unit_price_minor: number;
  /** List price of the unit when it was sold with a discount; null / absent otherwise and for older orders. */
  original_unit_price_minor?: number | null;
  quantity: number;
  line_total_minor: number;
}

export interface OrderDto {
  id: string;
  shop_id: string;
  order_number: number;
  status: string;
  currency: string;
  total_minor: number;
  /** Legacy orders only (the form no longer asks for a name/phone). */
  contact_name: string | null;
  contact_phone: string | null;
  comment: string | null;
  fulfillment_method: 'delivery' | 'pickup' | null;
  delivery_address: string | null;
  is_test: boolean;
  created_at: string;
  items: OrderItemDto[];
  /**
   * Price breakdown — present only for an order placed with the bonus program / discounts / promo codes of the shop
   * (20261125090000): total_minor = items_total_minor − discount_minor − bonus_spent × 100.
   */
  items_total_minor?: number;
  discount_type?: 'threshold' | 'promo' | null;
  discount_minor?: number;
  discount_info?: { percent?: number | null; min_total_minor?: number; code?: string; kind?: 'percent' | 'fixed'; fixed_minor?: number | null } | null;
  bonus_spent?: number;
  /** Bonuses credited when the shop confirmed the order; absent until then. */
  bonus_accrued?: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(code);
  }
}

export async function callFunction<T>(name: string, initData: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(functionsUrl(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: env.supabaseAnonKey,
        Authorization: `Bearer ${env.supabaseAnonKey}`,
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', null);
  }
  const json = (await res.json().catch(() => null)) as { error?: { code: string; details: unknown } } | null;
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'unknown_error', json?.error?.details ?? null);
  return json as T;
}

export interface CheckoutInput {
  shopSlug: string;
  currency: string;
  idempotencyKey: string;
  lines: readonly CartLine[];
  /** What the buyer saw: the amount to pay after discounts and bonuses (the server recomputes it and refuses a mismatch). */
  expectedTotalMinor: number;
  fulfillment: CheckoutFulfillment;
  comment: string;
  /** Promo code the buyer applied (the server resolves it in THIS shop; never an amount). */
  promoCode?: string | null;
  /** Whole bonuses to spend (never more than the buyer's balance; the server refuses more). */
  bonusSpend?: number;
}

export function submitCheckout(initData: string, input: CheckoutInput) {
  return callFunction<{ replayed: boolean; order: OrderDto }>('checkout', initData, {
    shopSlug: input.shopSlug,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    expectedTotalMinor: input.expectedTotalMinor,
    items: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    fulfillment: input.fulfillment,
    comment: input.comment,
    // Only when used, so a shop without these features receives exactly the request it always did.
    ...(input.promoCode ? { promoCode: input.promoCode } : {}),
    ...(input.bonusSpend && input.bonusSpend > 0 ? { bonusSpend: input.bonusSpend } : {}),
  });
}

export function fetchMyOrders(initData: string, shopSlug: string) {
  return callFunction<{
    user: { id: number; first_name: string | null; username: string | null };
    orders: OrderDto[];
    /** Bonus balance and history in this shop; null / absent: no bonus program and no balance. */
    loyalty?: BonusProfile | null;
  }>('my-orders', initData, { shopSlug });
}

/**
 * The price of the cart as checkout would charge it, computed by the server (discounts, promo code, bonuses). Nothing is
 * reserved or spent by asking.
 */
export function fetchCartQuote(initData: string, input: { shopSlug: string; lines: readonly CartLine[]; promoCode?: string | null; bonusSpend?: number }) {
  return callFunction<{ quote: CartQuote }>('cart-quote', initData, {
    shopSlug: input.shopSlug,
    items: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    ...(input.promoCode ? { promoCode: input.promoCode } : {}),
    ...(input.bonusSpend && input.bonusSpend > 0 ? { bonusSpend: input.bonusSpend } : {}),
  }).then((r) => r.quote);
}

/**
 * One idempotency key per (shop, cart content). Retrying the same cart (e.g. after a timeout)
 * reuses the key, so the server returns the original order instead of creating a duplicate.
 */
export function checkoutKeyFor(
  shopId: string,
  lines: readonly CartLine[],
  order: Pick<CheckoutInput, 'fulfillment' | 'comment' | 'promoCode' | 'bonusSpend'>,
): string {
  // Must cover everything the server hashes (items + fulfillment + comment + promo code + bonuses), otherwise a retry
  // with an edited address/comment/promo code would reuse the key and be rejected as idempotency_conflict.
  const fingerprint = JSON.stringify([
    [...lines].map((l) => `${l.variantId}:${l.quantity}`).sort(),
    order.fulfillment.method,
    order.fulfillment.method === 'delivery' ? order.fulfillment.address.trim() : null,
    order.comment.trim(),
    ...(order.promoCode || (order.bonusSpend ?? 0) > 0 ? [order.promoCode?.trim().toUpperCase() ?? null, order.bonusSpend ?? 0] : []),
  ]);
  const storageKey = `tma-checkout-key:${shopId}`;
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { f: string; k: string } | null;
    if (saved?.f === fingerprint) return saved.k;
    const k = crypto.randomUUID();
    sessionStorage.setItem(storageKey, JSON.stringify({ f: fingerprint, k }));
    return k;
  } catch {
    return crypto.randomUUID();
  }
}

export function clearCheckoutKey(shopId: string): void {
  try {
    sessionStorage.removeItem(`tma-checkout-key:${shopId}`);
  } catch {
    /* ignore */
  }
}
