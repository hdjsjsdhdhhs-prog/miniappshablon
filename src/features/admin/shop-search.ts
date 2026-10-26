export const SHOP_SECTIONS = [
  { to: 'products', label: 'Товары' },
  { to: 'categories', label: 'Категории' },
  { to: 'orders', label: 'Заказы' },
  { to: 'settings', label: 'Настройки' },
  { to: 'notifications', label: 'Уведомления' },
] as const;

export function storefrontPath(slug: string): string {
  return `/s/${slug}/`;
}

/** Case-insensitive substring match over any of the given fields; an empty query matches everything. */
export function matchesShopSearch(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => f?.toLowerCase().includes(q));
}
