import { memo } from 'react';
import { Link } from 'react-router';
import { ProductImage } from '@/components/product-image';
import { formatMoney } from '@/domain/money';
import { priceRange } from '@/domain/pricing';
import type { ProductDetail } from '../api';

export const ProductCard = memo(function ProductCard({
  product,
  slug,
  currency,
}: {
  product: ProductDetail;
  slug: string;
  currency: string;
}) {
  const { min, max } = priceRange(product.basePriceMinor, product.variants);
  const inStock = product.variants.some((v) => v.stock_quantity > 0);
  const image = product.images[0];
  return (
    <Link
      to={`/s/${slug}/product/${product.id}`}
      className="group flex flex-col overflow-hidden rounded-lg border bg-card text-card-foreground transition-colors hover:border-primary/60 focus-visible:border-primary"
      data-testid="product-card"
    >
      <div className="relative">
        <ProductImage path={image?.storage_path} alt={image?.alt_text || product.name} />
        {!inStock && (
          <span className="absolute top-2 left-2 rounded-md bg-background/90 px-2 py-0.5 text-xs font-medium">
            Нет в наличии
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <h3 className="line-clamp-2 text-sm leading-snug font-medium">{product.name}</h3>
        <p className="mt-auto text-sm font-semibold">
          {min !== max && <span className="font-normal text-muted-foreground">от </span>}
          {formatMoney(min, currency)}
        </p>
      </div>
    </Link>
  );
});
