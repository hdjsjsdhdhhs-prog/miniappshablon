/**
 * Pricing rules shared by UI.
 *
 * One price per product: `products.base_price_minor` is the only price, the same for every flavor/color.
 * Variants never carry their own price (`price_override_minor` is always NULL: the admin cannot set it,
 * tenant configs reject it, seed writes NULL), so checkout (`create_order`, which charges
 * `coalesce(price_override_minor, base_price_minor)`) charges exactly this price as well.
 */
export function productPriceMinor(product: { basePriceMinor: number }): number {
  return product.basePriceMinor;
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
