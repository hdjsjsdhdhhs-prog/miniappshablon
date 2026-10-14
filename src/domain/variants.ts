import { z } from 'zod';

export interface VariantLike {
  id: string;
  flavor: string | null;
  color: string | null;
  stock_quantity: number;
  is_active: boolean;
  price_override_minor: number | null;
}

export interface VariantSelection {
  flavor: string | null;
  color: string | null;
}

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
  return { exists: matches.length > 0, inStock: matches.some((v) => v.stock_quantity > 0) };
}

/** Initial selection: first in-stock active variant, otherwise first active one. */
export function defaultSelection(variants: readonly VariantLike[]): VariantSelection {
  const active = variants.filter((v) => v.is_active);
  const pick = active.find((v) => v.stock_quantity > 0) ?? active[0];
  return { flavor: pick?.flavor ?? null, color: pick?.color ?? null };
}

export type AddToCartCheck =
  | { ok: true; variant: VariantLike }
  | { ok: false; reason: 'no_variant' | 'out_of_stock' | 'invalid_quantity' | 'exceeds_stock' };

/** Client-side guard before adding to cart (the server re-checks everything at checkout). */
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
  if (variant.stock_quantity <= 0) return { ok: false, reason: 'out_of_stock' };
  if (quantity + alreadyInCart > Math.min(variant.stock_quantity, MAX_LINE_QUANTITY)) {
    return { ok: false, reason: 'exceeds_stock' };
  }
  return { ok: true, variant };
}

/** Admin form schema for a variant row. */
export const variantFormSchema = z
  .object({
    flavor: z.string().trim().max(60),
    color: z.string().trim().max(60),
    sku: z.string().trim().max(64),
    price: z.string().trim(),
    stock: z.coerce.number().int('Целое число').min(0, 'Не меньше 0').max(1_000_000),
    isActive: z.boolean(),
  })
  .refine((v) => v.price === '' || /^\d+([.,]\d{1,2})?$/.test(v.price.replace(/\s/g, '')), {
    message: 'Цена в формате 1290 или 1290,50',
    path: ['price'],
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
