/**
 * TanStack Query keys. Every tenant-scoped key starts with the shop scope so data of one shop is
 * never reused for another one.
 */
export const queryKeys = {
  shop: (slug: string) => ['shop', slug] as const,
  categories: (shopId: string) => ['shop', shopId, 'categories'] as const,
  products: (shopId: string, params: { categoryId: string | null; search: string }) =>
    ['shop', shopId, 'products', params] as const,
  product: (shopId: string, productId: string) => ['shop', shopId, 'product', productId] as const,
  myOrders: (shopId: string, telegramUserId: number | null) =>
    ['shop', shopId, 'my-orders', telegramUserId] as const,

  adminSession: () => ['admin', 'session'] as const,
  adminShops: (userId: string) => ['admin', userId, 'shops'] as const,
  adminShop: (slug: string) => ['admin', 'shop-by-slug', slug] as const,
  adminCategories: (shopId: string) => ['admin', 'shop', shopId, 'categories'] as const,
  adminProducts: (shopId: string) => ['admin', 'shop', shopId, 'products'] as const,
  adminProduct: (shopId: string, productId: string) => ['admin', 'shop', shopId, 'product', productId] as const,
  adminOrders: (shopId: string, status: string) => ['admin', 'shop', shopId, 'orders', status] as const,
  adminStats: (shopId: string) => ['admin', 'shop', shopId, 'stats'] as const,
} as const;

/** True when the key belongs to the given shop scope (used to verify isolation in tests). */
export function keyBelongsToShop(key: readonly unknown[], shopIdOrSlug: string): boolean {
  return (key[0] === 'shop' || (key[0] === 'admin' && key[1] === 'shop')) &&
    (key[1] === shopIdOrSlug || key[2] === shopIdOrSlug);
}
