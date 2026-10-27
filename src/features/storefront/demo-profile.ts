import type { OrderStatus } from '@/domain/order-status';
import { lineTotalMinor, orderTotalMinor, productPriceMinor } from '@/domain/pricing';
import { variantLabel } from '@/domain/variants';
import type { ProductSummary, Shop } from './api';

/**
 * Client-only showcase of the buyer profile and checkout for DEMO shops — in a browser and inside Telegram.
 *
 * Nothing here talks to the backend: no auth, no user, no order, no checkout/RPC call. The "order" is built
 * in memory from the shop's public catalog listing (already loaded by the home page) and is never stored.
 * The server enforces the same rule: create_order rejects DEMO shops (shop_demo).
 */

export const DEMO_ORDER_TITLE = 'Тестовый заказ';
export const DEMO_NOTICE = 'Это демонстрация';

export interface DemoOrderLine {
  key: string;
  name: string;
  variantLabel: string;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
}

export interface DemoOrder {
  title: string;
  status: OrderStatus;
  currency: string;
  lines: DemoOrderLine[];
  totalMinor: number;
}

/**
 * A DEMO shop always shows the demo profile and the demo checkout, also when opened inside Telegram: a DEMO shop
 * never stores orders (the server rejects them), so a "real" profile there could only ever be empty. A regular
 * shop — including a former DEMO shop after its hand-over — never gets the mock-up and uses the verified
 * Telegram identity. The Telegram environment deliberately plays no role.
 */
export function shouldShowDemoProfile(shop: Pick<Shop, 'isDemo'>): boolean {
  return shop.isDemo;
}

const QUANTITIES = [2, 1, 1] as const;

/** Used only when the shop has no product in stock to show. */
const FALLBACK_LINES: ReadonlyArray<Omit<DemoOrderLine, 'key' | 'lineTotalMinor'>> = [
  { name: 'Тестовый товар', variantLabel: 'Вариант A', quantity: 2, unitPriceMinor: 49_000 },
  { name: 'Тестовый товар', variantLabel: 'Вариант B', quantity: 1, unitPriceMinor: 89_000 },
  { name: 'Тестовый аксессуар', variantLabel: '', quantity: 1, unitPriceMinor: 19_000 },
];

export function buildDemoOrder(products: readonly ProductSummary[], currency: string): DemoOrder {
  const picked = products.slice(0, QUANTITIES.length);
  const base = picked.length
    ? picked.map((p, i) => {
        const v = p.variants.find((x) => x.is_active && x.stock_quantity > 0) ?? p.variants[0];
        return {
          key: `demo-${p.id}`,
          name: p.name,
          variantLabel: v ? variantLabel(v) : '',
          quantity: QUANTITIES[i] ?? 1,
          unitPriceMinor: productPriceMinor(p),
        };
      })
    : FALLBACK_LINES.map((l, i) => ({ ...l, key: `demo-fallback-${i}` }));
  const lines = base.map((l) => ({ ...l, lineTotalMinor: lineTotalMinor(l) }));
  return { title: DEMO_ORDER_TITLE, status: 'confirmed', currency, lines, totalMinor: orderTotalMinor(lines) };
}
