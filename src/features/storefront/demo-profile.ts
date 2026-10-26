import type { OrderStatus } from '@/domain/order-status';
import { lineTotalMinor, orderTotalMinor, productPriceMinor } from '@/domain/pricing';
import { variantLabel } from '@/domain/variants';
import type { TelegramEnv } from '@/features/telegram/telegram';
import type { ProductSummary, Shop } from './api';

/**
 * Client-only showcase of the buyer profile for DEMO shops opened outside Telegram.
 *
 * Nothing here talks to the backend: no auth, no user, no order, no checkout/RPC call. The "order" is built
 * in memory from the shop's public catalog listing (already loaded by the home page) and is never stored.
 */

export const DEMO_ORDER_TITLE = 'Тестовый заказ';

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
 * The demo profile replaces the "open in Telegram" screen only for a DEMO shop and only when the page has no
 * Telegram initData to be verified. A Telegram launch (initData present) keeps the real, server-verified flow —
 * even in a demo shop — and a regular shop never gets a mock-up.
 */
export function shouldShowDemoProfile(shop: Pick<Shop, 'isDemo'>, tg: Pick<TelegramEnv, 'inTelegram' | 'rawInitData'>): boolean {
  return shop.isDemo && !(tg.inTelegram && tg.rawInitData);
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
