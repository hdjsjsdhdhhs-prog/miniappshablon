import { ArrowLeftIcon, CheckCircleIcon, ShoppingCartIcon } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { EmptyState, ErrorState, PageSpinner, StaleDataNotice } from '@/components/state-views';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/domain/money';
import { effectivePriceMinor } from '@/domain/pricing';
import { canAddToCart, defaultSelection, findVariant, MAX_LINE_QUANTITY, variantLabel, type VariantSelection } from '@/domain/variants';
import { useCart } from '@/features/cart/useCart';
import { NotFoundError } from '../api';
import { Gallery } from '../components/Gallery';
import { QuantityStepper } from '../components/QuantityStepper';
import { VariantPicker } from '../components/VariantPicker';
import { useProduct } from '../hooks';
import { useShop } from '../shop-context';

const REASONS: Record<string, string> = {
  no_variant: 'Такого сочетания нет',
  out_of_stock: 'Нет в наличии',
  invalid_quantity: 'Некорректное количество',
  exceeds_stock: 'Больше нет в наличии',
};

export function ProductPage() {
  const shop = useShop();
  const { productId = '' } = useParams();
  const product = useProduct(shop.id, productId);
  const cart = useCart(shop.id);
  const navigate = useNavigate();
  const location = useLocation();
  const [selection, setSelection] = useState<VariantSelection | null>(null);
  const [qty, setQty] = useState(1);

  const variants = useMemo(() => product.data?.variants ?? [], [product.data]);

  if (product.isPending) return <PageSpinner />;
  if (!product.data) {
    return product.error instanceof NotFoundError ? (
      <EmptyState
        title="Товар недоступен"
        description="Возможно, он снят с продажи."
        action={
          <Button asChild variant="outline">
            <Link to={`/s/${shop.slug}/`}>В каталог</Link>
          </Button>
        }
      />
    ) : (
      <ErrorState onRetry={() => void product.refetch()} />
    );
  }

  const p = product.data;
  // A stale selection (variant deactivated after refetch) falls back to the default one.
  const sel = selection && findVariant(variants, selection) ? selection : defaultSelection(variants);
  const variant = findVariant(variants, sel);
  const price = effectivePriceMinor(p.basePriceMinor, variant);
  const stock = variant?.stock_quantity ?? 0;
  const inCart = cart.lines.find((l) => l.variantId === variant?.id)?.quantity ?? 0;
  const maxQty = Math.max(1, Math.min(stock - inCart, MAX_LINE_QUANTITY));
  const check = canAddToCart(variants, sel, qty, inCart);

  const add = () => {
    if (!check.ok) {
      toast.error(REASONS[check.reason]);
      return;
    }
    cart.add(
      {
        variantId: check.variant.id,
        productId: p.id,
        name: p.name,
        variantLabel: variantLabel(check.variant),
        unitPriceMinor: price,
        imagePath: p.images[0]?.storage_path ?? null,
        maxQuantity: check.variant.stock_quantity,
      },
      qty,
    );
    setQty(1);
    toast.success('Добавлено в корзину', {
      action: { label: 'Корзина', onClick: () => navigate(`/s/${shop.slug}/cart`) },
    });
  };

  const back = () => {
    // A previous in-app entry (usually the catalog) keeps its category/search in the URL and its scroll
    // position (ScrollRestoration). A direct link has no such entry → open the shop catalog instead.
    if (location.key !== 'default') navigate(-1);
    else navigate(`/s/${shop.slug}/`, { replace: true });
  };

  return (
    <main className="pb-6">
      <div className="px-4 pt-3 pb-3">
        <button
          type="button"
          onClick={back}
          className="glass-panel glass-transition glass-press inline-flex h-10 items-center gap-1.5 rounded-full pr-4 pl-3 text-sm font-medium hover:border-(--glass-accent-edge)"
          data-testid="product-back"
        >
          <ArrowLeftIcon aria-hidden weight="bold" className="size-4" />
          Назад
        </button>
      </div>
      {product.isError && <StaleDataNotice onRetry={() => void product.refetch()} />}
      <Gallery images={p.images} name={p.name} />
      <div className="space-y-5 px-4 pt-4">
        <div className="space-y-1">
          <Link
            to={`/s/${shop.slug}/?category=${encodeURIComponent(p.categorySlug)}`}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {p.categoryName}
          </Link>
          <h1 className="text-xl font-bold">{p.name}</h1>
          <p className="text-2xl font-semibold" data-testid="product-price">
            {formatMoney(price, shop.currency)}
          </p>
          <p className="text-sm" data-testid="product-stock">
            {!variant ? (
              <span className="text-muted-foreground">Выберите вариант</span>
            ) : stock > 0 ? (
              <span className="inline-flex items-center gap-1 text-success">
                <CheckCircleIcon aria-hidden weight="fill" /> В наличии: {stock} шт.
              </span>
            ) : (
              <span className="text-destructive">Нет в наличии</span>
            )}
          </p>
        </div>

        <VariantPicker variants={variants} selection={sel} onChange={(s) => { setSelection(s); setQty(1); }} />

        <div className="flex items-center gap-3">
          <QuantityStepper value={Math.min(qty, maxQty)} max={maxQty} onChange={setQty} />
          <Button size="lg" className="h-11 flex-1" disabled={!check.ok} onClick={add} data-testid="add-to-cart">
            <ShoppingCartIcon aria-hidden />
            {check.ok ? 'В корзину' : REASONS[check.reason]}
          </Button>
        </div>
        {inCart > 0 && (
          <p className="text-sm text-muted-foreground">
            В корзине: {inCart} шт. ·{' '}
            <Link to={`/s/${shop.slug}/cart`} className="text-primary underline underline-offset-2">
              Перейти в корзину
            </Link>
          </p>
        )}

        {p.description && (
          <section aria-labelledby="desc" className="space-y-2">
            <h2 id="desc" className="font-semibold">
              Описание
            </h2>
            <p className="text-sm whitespace-pre-line text-muted-foreground">{p.description}</p>
          </section>
        )}
      </div>
    </main>
  );
}
