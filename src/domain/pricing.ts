/** Pricing rules shared by UI. The same rule is implemented in SQL (create_order). */

export interface PricedVariant {
  price_override_minor: number | null;
}

/** Variant price = price_override_minor when set, otherwise the product base price. */
export function effectivePriceMinor(basePriceMinor: number, variant: PricedVariant | null | undefined): number {
  return variant?.price_override_minor ?? basePriceMinor;
}

export interface CartLineLike {
  unitPriceMinor: number;
  quantity: number;
}

export function lineTotalMinor(line: CartLineLike): number {
  return line.unitPriceMinor * line.quantity;
}

export function orderTotalMinor(lines: readonly CartLineLike[]): number {
  return lines.reduce((sum, l) => sum + lineTotalMinor(l), 0);
}

export function totalQuantity(lines: readonly { quantity: number }[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

/** Price range for a product card ("от 1 290 ₽" when variants differ). */
export function priceRange(
  basePriceMinor: number,
  variants: readonly PricedVariant[],
): { min: number; max: number } {
  if (variants.length === 0) return { min: basePriceMinor, max: basePriceMinor };
  const prices = variants.map((v) => effectivePriceMinor(basePriceMinor, v));
  return { min: Math.min(...prices), max: Math.max(...prices) };
}
