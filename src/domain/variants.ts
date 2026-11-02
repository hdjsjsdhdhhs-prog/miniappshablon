import { z } from 'zod';
import { isAvailable, type StockStatus } from './stock';

/** A variant as the storefront sees it: availability is a status, never a quantity (see ./stock). */
export interface VariantLike {
  id: string;
  flavor: string | null;
  color: string | null;
  stock_status: StockStatus;
  is_active: boolean;
}

export interface VariantSelection {
  flavor: string | null;
  color: string | null;
}

/**
 * Business limit of one cart line (the checkout API accepts 1–99 per line, create_order_v2 re-checks the real stock
 * and the per-order unit limit). It is independent of the stock, so the quantity picker reveals nothing about it.
 */
export const MAX_LINE_QUANTITY = 99;

export function variantLabel(v: Pick<VariantLike, 'flavor' | 'color'>): string {
  return [v.flavor, v.color].filter(Boolean).join(' · ');
}

function uniq(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

/** Distinct option values offered by active variants. */
export function variantOptions(variants: readonly VariantLike[]): { flavors: string[]; colors: string[] } {
  const active = variants.filter((v) => v.is_active);
  return { flavors: uniq(active.map((v) => v.flavor)), colors: uniq(active.map((v) => v.color)) };
}

/** Finds the exact sellable row for a selection. Returns null for a non-existent combination. */
export function findVariant(variants: readonly VariantLike[], sel: VariantSelection): VariantLike | null {
  return variants.find((v) => v.is_active && v.flavor === sel.flavor && v.color === sel.color) ?? null;
}

/** Whether an option value can still lead to an existing combination given the other choice. */
export function isOptionAvailable(
  variants: readonly VariantLike[],
  kind: 'flavor' | 'color',
  value: string,
  other: string | null,
): { exists: boolean; inStock: boolean } {
  const matches = variants.filter(
    (v) =>
      v.is_active &&
      v[kind] === value &&
      (other === null || (kind === 'flavor' ? v.color === other : v.flavor === other)),
  );
  return { exists: matches.length > 0, inStock: matches.some((v) => isAvailable(v.stock_status)) };
}

/** Initial selection: first available active variant, otherwise first active one. */
export function defaultSelection(variants: readonly VariantLike[]): VariantSelection {
  const active = variants.filter((v) => v.is_active);
  const pick = active.find((v) => isAvailable(v.stock_status)) ?? active[0];
  return { flavor: pick?.flavor ?? null, color: pick?.color ?? null };
}

export type AddToCartCheck =
  | { ok: true; variant: VariantLike }
  | { ok: false; reason: 'no_variant' | 'out_of_stock' | 'invalid_quantity' | 'exceeds_limit' };

/**
 * Client-side guard before adding to cart (the server re-checks everything at checkout). Out of stock → refused;
 * otherwise only the business limit applies: whether the exact quantity is there is decided by create_order_v2.
 */
export function canAddToCart(
  variants: readonly VariantLike[],
  sel: VariantSelection,
  quantity: number,
  alreadyInCart = 0,
): AddToCartCheck {
  const variant = findVariant(variants, sel);
  if (!variant) return { ok: false, reason: 'no_variant' };
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
    return { ok: false, reason: 'invalid_quantity' };
  }
  if (!isAvailable(variant.stock_status)) return { ok: false, reason: 'out_of_stock' };
  if (quantity + alreadyInCart > MAX_LINE_QUANTITY) return { ok: false, reason: 'exceeds_limit' };
  return { ok: true, variant };
}

/** Admin form schema for a variant row. A variant has no price of its own (one price per product). */
export const variantFormSchema = z.object({
  flavor: z.string().trim().max(60),
  color: z.string().trim().max(60),
  sku: z.string().trim().max(64),
  stock: z.coerce.number().int('Целое число').min(0, 'Не меньше 0').max(1_000_000),
  isActive: z.boolean(),
});

/** Duplicate flavor/color combinations violate the DB unique index; detect before saving. */
export function findDuplicateCombos(rows: ReadonlyArray<Pick<VariantLike, 'flavor' | 'color'>>): number[] {
  const seen = new Map<string, number>();
  const dupes: number[] = [];
  rows.forEach((r, i) => {
    const key = `${(r.flavor ?? '').trim().toLowerCase()}|${(r.color ?? '').trim().toLowerCase()}`;
    if (seen.has(key)) dupes.push(i);
    else seen.set(key, i);
  });
  return dupes;
}
