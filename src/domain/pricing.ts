/**
 * Pricing rules shared by UI.
 *
 * One price per product: `products.base_price_minor` is the only price, the same for every flavor/color.
 * Variants never carry their own price (`price_override_minor` is always NULL: the admin cannot set it,
 * tenant configs reject it, seed writes NULL), so checkout (`create_order_v2`, which charges
 * `coalesce(price_override_minor, discount_price_minor, base_price_minor)`) charges exactly this price as well.
 *
 * Optional discount: `products.discount_price_minor` (NULL = none). The list price stays in `base_price_minor`; with
 * a discount every flavor/color sells at the discount price. The server applies the same rule on its own in
 * `create_order_v2` and never trusts a price from the browser.
 */
export interface PricedProduct {
  basePriceMinor: number;
  discountPriceMinor?: number | null;
}

/** A discount is a positive price strictly below the list price (same rule as the CHECK on products). */
export function isValidDiscount(basePriceMinor: number, discountPriceMinor: number | null | undefined): discountPriceMinor is number {
  return typeof discountPriceMinor === 'number' && Number.isInteger(discountPriceMinor) && discountPriceMinor > 0 && discountPriceMinor < basePriceMinor;
}

/** What the buyer pays for one unit: the discount price when the product has one, otherwise the product price. */
export function productPriceMinor(product: PricedProduct): number {
  return isValidDiscount(product.basePriceMinor, product.discountPriceMinor) ? product.discountPriceMinor : product.basePriceMinor;
}

/** The list price to show struck through next to the discount price; null when the product has no discount. */
export function productOldPriceMinor(product: PricedProduct): number | null {
  return isValidDiscount(product.basePriceMinor, product.discountPriceMinor) ? product.basePriceMinor : null;
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
