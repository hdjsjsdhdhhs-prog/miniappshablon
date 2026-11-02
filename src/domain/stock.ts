/**
 * Public stock projection. The storefront never requests the exact quantity: PostgreSQL computes
 * product_variants.stock_status (generated column, migration 20261102090100) and the storefront reads only that
 * column (after the Contract step 3C it is the only stock column buyers can read). Exact quantities are shown in the
 * admin only (admin_variant_stock RPC, members of the shop).
 *
 *   0    → out_of_stock  «Нет в наличии» (cannot be chosen or added to the cart)
 *   1–2  → low_stock     «Осталось мало» (can be chosen and bought)
 *   ≥ 3  → in_stock      «В наличии»
 */
export type StockStatus = 'out_of_stock' | 'low_stock' | 'in_stock';

export const STOCK_STATUS_LABELS: Readonly<Record<StockStatus, string>> = {
  out_of_stock: 'Нет в наличии',
  low_stock: 'Осталось мало',
  in_stock: 'В наличии',
};

/** Upper bound of `low_stock`; mirrors the SQL expression (used only to word the UI, never as a quantity cap). */
export const LOW_STOCK_MAX = 2;

export function isStockStatus(value: unknown): value is StockStatus {
  return value === 'out_of_stock' || value === 'low_stock' || value === 'in_stock';
}

export function isAvailable(status: StockStatus): boolean {
  return status !== 'out_of_stock';
}

/** The better of two statuses (a chip that stands for several variants shows the best one). */
export function bestStockStatus(statuses: readonly StockStatus[]): StockStatus {
  if (statuses.includes('in_stock')) return 'in_stock';
  if (statuses.includes('low_stock')) return 'low_stock';
  return 'out_of_stock';
}

/** Same thresholds as the SQL generated column; for the admin preview of what buyers will see. */
export function stockStatusOf(quantity: number): StockStatus {
  if (quantity <= 0) return 'out_of_stock';
  if (quantity <= LOW_STOCK_MAX) return 'low_stock';
  return 'in_stock';
}
