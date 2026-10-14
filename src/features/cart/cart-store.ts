import { MAX_LINE_QUANTITY } from '@/domain/variants';

/**
 * Per-shop cart persisted in localStorage for UX only. The server re-validates every line
 * (ownership, price, stock) at checkout; nothing here is a source of truth.
 */
export interface CartLine {
  variantId: string;
  productId: string;
  name: string;
  variantLabel: string;
  unitPriceMinor: number;
  imagePath: string | null;
  quantity: number;
  /** Stock known when the line was last touched; used only to cap the stepper. */
  maxQuantity: number;
}

const VERSION = 'v1';
export const cartStorageKey = (shopId: string) => `tma-cart:${VERSION}:${shopId}`;

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
const cache = new Map<string, CartLine[]>();
const EMPTY: CartLine[] = [];

function isLine(v: unknown): v is CartLine {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.variantId === 'string' &&
    typeof l.productId === 'string' &&
    typeof l.name === 'string' &&
    typeof l.unitPriceMinor === 'number' &&
    Number.isInteger(l.quantity) &&
    (l.quantity as number) > 0
  );
}

function parseStored(shopId: string): CartLine[] {
  try {
    const raw = localStorage.getItem(cartStorageKey(shopId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isLine) : EMPTY;
  } catch {
    return EMPTY;
  }
}

function read(shopId: string): CartLine[] {
  const hit = cache.get(shopId);
  if (hit) return hit;
  const lines = parseStored(shopId);
  cache.set(shopId, lines);
  return lines;
}

function write(shopId: string, lines: CartLine[]): void {
  cache.set(shopId, lines);
  try {
    if (lines.length === 0) localStorage.removeItem(cartStorageKey(shopId));
    else localStorage.setItem(cartStorageKey(shopId), JSON.stringify(lines));
  } catch {
    /* storage may be unavailable (private mode); the in-memory cart still works */
  }
  listeners.get(shopId)?.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(`tma-cart:${VERSION}:`)) return;
    const shopId = e.key.slice(`tma-cart:${VERSION}:`.length);
    cache.delete(shopId);
    listeners.get(shopId)?.forEach((l) => l());
  });
}

export const cartStore = {
  subscribe(shopId: string, listener: Listener): () => void {
    let set = listeners.get(shopId);
    if (!set) listeners.set(shopId, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  },
  getLines: read,

  add(shopId: string, line: Omit<CartLine, 'quantity'>, quantity: number): CartLine[] {
    const lines = read(shopId);
    const cap = Math.min(line.maxQuantity, MAX_LINE_QUANTITY);
    const existing = lines.find((l) => l.variantId === line.variantId);
    const next = existing
      ? lines.map((l) =>
          l.variantId === line.variantId ? { ...l, ...line, quantity: Math.min(l.quantity + quantity, cap) } : l,
        )
      : [...lines, { ...line, quantity: Math.min(quantity, cap) }];
    write(shopId, next);
    return next;
  },

  setQuantity(shopId: string, variantId: string, quantity: number): void {
    const lines = read(shopId);
    if (quantity <= 0) {
      write(shopId, lines.filter((l) => l.variantId !== variantId));
      return;
    }
    write(
      shopId,
      lines.map((l) =>
        l.variantId === variantId
          ? { ...l, quantity: Math.min(quantity, l.maxQuantity, MAX_LINE_QUANTITY) }
          : l,
      ),
    );
  },

  remove(shopId: string, variantId: string): void {
    write(shopId, read(shopId).filter((l) => l.variantId !== variantId));
  },

  clear(shopId: string): void {
    write(shopId, []);
  },

  /** Applies server-confirmed prices/stock after a failed checkout (price_changed / insufficient_stock). */
  reconcile(
    shopId: string,
    updates: { prices?: Record<string, number>; available?: Record<string, number> },
  ): void {
    const next = read(shopId)
      .map((l) => {
        const price = updates.prices?.[l.variantId];
        const avail = updates.available?.[l.variantId];
        let line = l;
        if (price !== undefined) line = { ...line, unitPriceMinor: price };
        if (avail !== undefined) line = { ...line, maxQuantity: avail, quantity: Math.min(line.quantity, avail) };
        return line;
      })
      .filter((l) => l.quantity > 0);
    write(shopId, next);
  },

  /** Test helper. */
  _resetCache(): void {
    cache.clear();
  },
};
