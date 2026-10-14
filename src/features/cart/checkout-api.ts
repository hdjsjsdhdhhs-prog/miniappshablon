import { functionsUrl } from '@/lib/supabase';
import { env } from '@/lib/env';
import type { CartLine } from './cart-store';

export interface OrderItemDto {
  id: string;
  product_id: string | null;
  variant_id: string | null;
  product_name: string;
  variant_label: string;
  flavor: string | null;
  color: string | null;
  unit_price_minor: number;
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
  contact_name: string;
  contact_phone: string | null;
  comment: string | null;
  is_test: boolean;
  created_at: string;
  items: OrderItemDto[];
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
  expectedTotalMinor: number;
  contact: { name: string; phone: string; comment: string };
}

export function submitCheckout(initData: string, input: CheckoutInput) {
  return callFunction<{ replayed: boolean; order: OrderDto }>('checkout', initData, {
    shopSlug: input.shopSlug,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    expectedTotalMinor: input.expectedTotalMinor,
    items: input.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    contact: input.contact,
  });
}

export function fetchMyOrders(initData: string, shopSlug: string) {
  return callFunction<{ user: { id: number; first_name: string | null; username: string | null }; orders: OrderDto[] }>(
    'my-orders',
    initData,
    { shopSlug },
  );
}

/**
 * One idempotency key per (shop, cart content). Retrying the same cart (e.g. after a timeout)
 * reuses the key, so the server returns the original order instead of creating a duplicate.
 */
export function checkoutKeyFor(
  shopId: string,
  lines: readonly CartLine[],
  contact: CheckoutInput['contact'],
): string {
  // Must cover everything the server hashes (items + contact), otherwise a retry with an edited
  // phone/comment would reuse the key and be rejected as idempotency_conflict.
  const fingerprint = JSON.stringify([
    [...lines].map((l) => `${l.variantId}:${l.quantity}`).sort(),
    contact.name.trim(),
    contact.phone.trim(),
    contact.comment.trim(),
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
