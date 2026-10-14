import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { orderTotalMinor, totalQuantity } from '@/domain/pricing';
import { cartStore, type CartLine } from './cart-store';

export function useCart(shopId: string) {
  const subscribe = useCallback((l: () => void) => cartStore.subscribe(shopId, l), [shopId]);
  const getSnapshot = useCallback(() => cartStore.getLines(shopId), [shopId]);
  const lines = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(
    () => ({
      lines,
      count: totalQuantity(lines),
      totalMinor: orderTotalMinor(lines),
      add: (line: Omit<CartLine, 'quantity'>, qty: number) => cartStore.add(shopId, line, qty),
      setQuantity: (variantId: string, qty: number) => cartStore.setQuantity(shopId, variantId, qty),
      remove: (variantId: string) => cartStore.remove(shopId, variantId),
      clear: () => cartStore.clear(shopId),
      reconcile: (u: Parameters<typeof cartStore.reconcile>[1]) => cartStore.reconcile(shopId, u),
    }),
    [lines, shopId],
  );
}
