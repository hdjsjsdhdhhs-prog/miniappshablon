import { createContext, useContext } from 'react';
import type { Shop } from './api';

export const ShopContext = createContext<Shop | null>(null);

export function useShop(): Shop {
  const shop = useContext(ShopContext);
  if (!shop) throw new Error('useShop must be used inside the storefront layout');
  return shop;
}

export function shopPath(slug: string, sub = ''): string {
  return `/s/${slug}/${sub}`.replace(/\/+$/, sub ? '' : '/');
}
