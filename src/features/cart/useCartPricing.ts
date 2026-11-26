import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { quoteHasFeatures, type CartQuote } from '@/domain/loyalty';
import { queryKeys } from '@/domain/query-keys';
import type { CartLine } from './cart-store';
import { ApiError, fetchCartQuote } from './checkout-api';

/**
 * The price of the cart with the shop's discounts, promo code and bonuses — as the SERVER computes it (cart-quote). The
 * browser only holds what the buyer typed (a code, a number of bonuses); every amount shown and sent to checkout comes from
 * the quote. A shop that uses none of these features gets a quote without them and the cart looks exactly as it always did.
 */
export function useCartPricing(opts: {
  shopId: string;
  shopSlug: string;
  lines: readonly CartLine[];
  baseTotalMinor: number;
  /** Real (non-DEMO) shop opened inside Telegram: the only case where a buyer can order, hence the only one asking. */
  enabled: boolean;
  initData: string;
}) {
  const { shopId, shopSlug, lines, baseTotalMinor, enabled, initData } = opts;
  const [promoDraft, setPromoDraft] = useState('');
  const [promo, setPromo] = useState<string | null>(null);
  const [useBonus, setUseBonus] = useState(false);
  const [bonusDraft, setBonusDraft] = useState('');
  const [bonusRequested, setBonusRequested] = useState(0);

  // The number of bonuses is sent to the server once the buyer stops typing.
  useEffect(() => {
    const parsed = /^\d+$/.test(bonusDraft.trim()) ? Math.min(Number(bonusDraft.trim()), 1_000_000) : 0;
    const wanted = useBonus ? parsed : 0;
    const t = setTimeout(() => setBonusRequested(wanted), 350);
    return () => clearTimeout(t);
  }, [bonusDraft, useBonus]);

  const fingerprint = useMemo(
    () => JSON.stringify([lines.map((l) => `${l.variantId}:${l.quantity}`).sort(), promo, bonusRequested]),
    [lines, promo, bonusRequested],
  );
  const query = useQuery({
    queryKey: queryKeys.cartQuote(shopId, fingerprint),
    queryFn: () => fetchCartQuote(initData, { shopSlug, lines, promoCode: promo, bonusSpend: bonusRequested }),
    enabled: enabled && lines.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 0,
    // A refusal (unknown function, an item that vanished) is not retried; a network / server error once.
    retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 1,
  });

  // 4xx other than an authentication failure: the cart is shown as it was and checkout, which re-checks everything, decides.
  const unavailable = query.error instanceof ApiError && query.error.status >= 400 && query.error.status < 500 && query.error.status !== 401;
  const quote: CartQuote | undefined = unavailable ? undefined : query.data;
  const active = quoteHasFeatures(quote);
  const settled = !enabled || unavailable || (query.data !== undefined && !query.isPlaceholderData && !query.isFetching);
  const failed = enabled && query.isError && !unavailable;

  const applyPromo = (): void => {
    const code = promoDraft.trim().toUpperCase();
    if (code) setPromo(code);
  };
  const clearPromo = (): void => {
    setPromo(null);
    setPromoDraft('');
  };
  const clearBonus = (): void => {
    setUseBonus(false);
    setBonusDraft('');
    setBonusRequested(0);
  };

  return {
    quote: active ? quote : undefined,
    /** Any of the three features is on in this shop. */
    active,
    /** The quote of the CURRENT cart / code / bonuses is in (checkout waits for it). */
    ready: settled && !failed,
    failed,
    refetch: () => void query.refetch(),
    /** What is sent to checkout: only a code the server accepted, and the bonuses the server clamped to what is possible. */
    promoCode: active && quote?.promo?.status === 'applied' ? quote.promo.code : null,
    bonusSpend: active ? (quote?.bonus.applied ?? 0) : 0,
    totalMinor: active && quote ? quote.total_minor : baseTotalMinor,
    promoDraft,
    setPromoDraft,
    promo,
    applyPromo,
    clearPromo,
    useBonus,
    setUseBonus,
    bonusDraft,
    setBonusDraft,
    clearBonus,
    promoPending: query.isFetching && promo !== null,
  };
}

export type CartPricing = ReturnType<typeof useCartPricing>;
