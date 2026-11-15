import { formatMoney } from '@/domain/money';
import { cn } from '@/lib/utils';

/**
 * A product / line price. Without a discount it renders exactly what was there before: the formatted amount, as
 * plain text inside the caller's element. With a discount the price actually charged comes first in a calm green
 * (theme token `success`), followed by the list price — smaller, muted and struck through.
 *
 * `oldPriceMinor` must be the list price of the same unit; it is ignored unless it is higher than `priceMinor`.
 */
export function Price({
  priceMinor,
  oldPriceMinor,
  currency,
  className,
}: {
  priceMinor: number;
  oldPriceMinor?: number | null;
  currency: string;
  className?: string;
}) {
  if (oldPriceMinor == null || oldPriceMinor <= priceMinor) return <>{formatMoney(priceMinor, currency)}</>;
  return (
    <span className={cn('inline-flex flex-wrap items-baseline gap-x-1.5 gap-y-0', className)} data-testid="price-discounted">
      <span className="sr-only">Цена со скидкой: </span>
      <span className="text-success" data-testid="price-current">
        {formatMoney(priceMinor, currency)}
      </span>
      <span className="sr-only">, прежняя цена: </span>
      <s className="text-[0.8em] font-normal text-muted-foreground decoration-1" data-testid="price-old">
        {formatMoney(oldPriceMinor, currency)}
      </s>
    </span>
  );
}
