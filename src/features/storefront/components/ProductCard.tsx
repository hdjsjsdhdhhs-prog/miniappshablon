import { ShoppingCartIcon } from '@phosphor-icons/react';
import { memo } from 'react';
import { Link } from 'react-router';
import { ProductImage } from '@/components/product-image';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/domain/money';
import { priceRange } from '@/domain/pricing';
import { cn } from '@/lib/utils';
import type { ProductDetail } from '../api';

export const ProductCard = memo(function ProductCard({
  product,
  slug,
  currency,
  onAddToCart,
}: {
  product: ProductDetail;
  slug: string;
  currency: string;
  /** Opens the quick flavor picker. Never adds anything by itself. */
  onAddToCart?: (product: ProductDetail) => void;
}) {
  const { min, max } = priceRange(product.basePriceMinor, product.variants);
  const inStock = product.variants.some((v) => v.stock_quantity > 0);
  const image = product.images[0];
  return (
    /*
     * Two sibling interactive areas, never nested: the link (photo, name, price — and, through its stretched
     * ::after, the rest of the card) opens the product page; the "В корзину" button above that overlay only
     * opens the quick flavor picker. The button is not inside the link, so its click cannot reach it.
     */
    <div
      className="glass-card glass-transition glass-lift group flex flex-col overflow-hidden rounded-xl text-card-foreground has-[a:focus-visible]:border-primary has-[a:focus-visible]:outline-2 has-[a:focus-visible]:outline-offset-2 has-[a:focus-visible]:outline-ring"
      data-testid="product-card"
    >
      <Link
        to={`/s/${slug}/product/${product.id}`}
        className="flex flex-1 flex-col after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:outline-none"
        data-testid="product-card-link"
      >
        {/* The photo stays crisp: no glass or tint over it, only a hairline that separates it from the text part. */}
        <div className="relative border-b border-(--glass-edge)">
          <ProductImage
            path={image?.storage_path}
            alt={image?.alt_text || product.name}
            className="[&_img]:transition-transform [&_img]:duration-500 [&_img]:ease-(--ease-glass) motion-safe:group-hover:[&_img]:scale-[1.03]"
          />
          {!inStock && (
            <span className="absolute top-2 left-2 rounded-full border border-(--glass-edge) bg-background/85 px-2.5 py-0.5 text-xs font-medium">
              Нет в наличии
            </span>
          )}
        </div>
        <div className={cn('flex flex-1 flex-col gap-1.5 px-3 pt-3', onAddToCart ? 'pb-2.5' : 'pb-3')}>
          <h3 className="line-clamp-2 text-sm leading-snug font-medium">{product.name}</h3>
          {/* mt-auto keeps price + button on one line across a grid row, whatever the name length. */}
          <p className="mt-auto text-[0.9375rem] font-semibold tracking-tight tabular-nums">
            {min !== max && <span className="font-normal text-muted-foreground">от </span>}
            {formatMoney(min, currency)}
          </p>
        </div>
      </Link>
      {onAddToCart && (
        // The wrapper lets taps on the padding fall through to the card link; only the button itself is interactive.
        <div className="pointer-events-none relative z-10 px-3 pb-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!inStock}
            aria-haspopup="dialog"
            aria-label={inStock ? `В корзину — ${product.name}` : `Нет в наличии — ${product.name}`}
            onClick={() => onAddToCart(product)}
            data-testid="quick-add"
            className={cn(
              // Compact visual height (shadcn `sm` — the Button has no `min` size), but a 46 px touch target:
              // the ::after extends the hit area 8 px into the card padding above and below.
              'glass-transition glass-press pointer-events-auto relative w-full border after:absolute after:inset-x-0 after:-inset-y-2 after:content-[""]',
              // Soft accent glass derived from the shop tokens (no tenant colours here).
              'border-(--glass-accent-edge) bg-(--glass-accent-fill-solid) bg-linear-to-b from-(--glass-pill-fill-top) to-transparent text-primary shadow-[inset_0_1px_0_var(--glass-highlight)] hover:border-primary hover:bg-(--glass-accent-fill-solid)',
              // Disabled keeps catching the tap, so it never falls through to the product link.
              'disabled:pointer-events-auto disabled:cursor-not-allowed disabled:border-(--glass-edge) disabled:bg-(--glass-pill-fill) disabled:text-muted-foreground',
            )}
          >
            {inStock && <ShoppingCartIcon aria-hidden />}
            <span className="truncate">{inStock ? 'В корзину' : 'Нет в наличии'}</span>
          </Button>
        </div>
      )}
    </div>
  );
});
