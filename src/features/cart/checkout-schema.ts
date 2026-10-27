import { z } from 'zod';

export type FulfillmentMethod = 'delivery' | 'pickup';

export const FULFILLMENT_LABELS: Record<FulfillmentMethod, string> = { delivery: 'Доставка', pickup: 'Самовывоз' };

/** Methods the shop currently offers, in display order. */
export function availableMethods(f: { delivery: boolean; pickup: boolean }): FulfillmentMethod[] {
  return (['delivery', 'pickup'] as const).filter((m) => f[m]);
}

/**
 * Buyer form. Name and phone are not asked: the buyer is the verified Telegram user. The address is required
 * only for delivery and is dropped for pickup. The server re-validates everything (method enabled, address).
 */
export const checkoutFormSchema = z
  .object({
    method: z.enum(['delivery', 'pickup'], { error: 'Выберите способ получения' }),
    address: z.string().trim().max(300, 'Не длиннее 300 символов'),
    comment: z.string().trim().max(500, 'Не длиннее 500 символов'),
  })
  .superRefine((v, ctx) => {
    if (v.method === 'delivery' && !v.address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'Укажите адрес доставки' });
  });

export type CheckoutFormValues = z.infer<typeof checkoutFormSchema>;

/** What is sent to the checkout Edge Function (no address for pickup). */
export type CheckoutFulfillment = { method: 'delivery'; address: string } | { method: 'pickup' };

export function toFulfillment(v: Pick<CheckoutFormValues, 'method' | 'address'>): CheckoutFulfillment {
  return v.method === 'delivery' ? { method: 'delivery', address: v.address.trim() } : { method: 'pickup' };
}
