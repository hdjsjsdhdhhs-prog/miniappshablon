import { createContext, useContext } from 'react';
import type { AdminShop } from './api';

export const AdminShopContext = createContext<AdminShop | null>(null);

export function useAdminShop(): AdminShop {
  const shop = useContext(AdminShopContext);
  if (!shop) throw new Error('useAdminShop outside AdminShopLayout');
  return shop;
}
