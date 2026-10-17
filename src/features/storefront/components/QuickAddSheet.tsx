import { ArrowClockwiseIcon, CheckIcon, ShoppingCartIcon, XIcon } from '@phosphor-icons/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { ProductImage } from '@/components/product-image';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogDescription, DialogOverlay, DialogTitle } from '@/components/ui/dialog';
import { formatMoney } from '@/domain/money';
import { effectivePriceMinor, priceRange } from '@/domain/pricing';
import {
  canAddToCart,
  findVariant,
  MAX_LINE_QUANTITY,
  variantLabel,
  type VariantLike,
  type VariantSelection,
} from '@/domain/variants';
import { useCart } from '@/features/cart/useCart';
import { cn } from '@/lib/utils';
import { NotFoundError, type ProductDetail } from '../api';
import { useProduct } from '../hooks';
import { useShop } from '../shop-context';
import { QuantityStepper } from './QuantityStepper';

const REASONS: Record<string, string> = {
  no_variant: 'Этот вариант закончился',
  out_of_stock: 'Этот вариант закончился',
  invalid_quantity: 'Некорректное количество',
  exceeds_stock: 'Больше нет в наличии',
};

/** Low stock is worth telling the buyer; exact big numbers are noise in a compact picker. */
const LOW_STOCK = 5;

function uniq(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => v !== null))];
}

function OptionGroup({
  legend,
  kind,
  values,
  selection,
  sellable,
  showPrice,
  basePriceMinor,
  currency,
  onPick,
}: {
  legend: string;
  kind: 'flavor' | 'color';
  values: string[];
  selection: VariantSelection;
  sellable: readonly VariantLike[];
  showPrice: boolean;
  basePriceMinor: number;
  currency: string;
  onPick: (value: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-semibold">{legend}</legend>
      <div role="radiogroup" aria-label={legend} className="grid grid-cols-2 gap-2">
        {values.map((value) => {
          const active = selection[kind] === value;
          // Meta (price / low stock) only when this chip resolves to one concrete sellable variant.
          const v = findVariant(sellable, { ...selection, [kind]: value });
          const price = v ? effectivePriceMinor(basePriceMinor, v) : null;
          const low = v && v.stock_quantity <= LOW_STOCK ? v.stock_quantity : null;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onPick(value)}
              data-testid="quick-option"
              className={cn(
                'glass-transition glass-press relative flex min-h-11 flex-col justify-center rounded-lg border px-3 py-2 pr-8 text-left text-sm',
                active
                  ? 'border-primary bg-primary/15 font-medium shadow-[0_0_0_1px_var(--glass-accent-edge)]'
                  : 'border-(--glass-edge) bg-(--glass-pill-fill) hover:border-(--glass-accent-edge)',
              )}
            >
              <span className="line-clamp-2 leading-snug break-words">{value}</span>
              {(showPrice && price !== null) || low !== null ? (
                <span className="mt-0.5 text-xs font-normal text-muted-foreground tabular-nums">
                  {showPrice && price !== null && formatMoney(price, currency)}
                  {showPrice && price !== null && low !== null && ' · '}
                  {low !== null && `осталось ${low}`}
                </span>
              ) : null}
              {active && (
                <CheckIcon aria-hidden weight="bold" className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-primary" />
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function SheetBody({ listed, onDone }: { listed: ProductDetail; onDone: () => void }) {
  const shop = useShop();
  const cart = useCart(shop.id);
  const navigate = useNavigate();
  // Fresh price/stock for the panel (staleTime 0); the listing row is shown until it arrives.
  const query = useProduct(shop.id, listed.id);
  const p = query.data ?? listed;
  const gone = query.error instanceof NotFoundError;

  const [picked, setPicked] = useState<VariantSelection>({ flavor: null, color: null });
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only active variants come from the API; of those, only the ones that can actually be bought are offered.
  const sellable = useMemo(() => (gone ? [] : p.variants.filter((v) => v.is_active && v.stock_quantity > 0)), [p, gone]);
  const hasFlavor = p.variants.some((v) => v.flavor !== null);
  const hasColor = p.variants.some((v) => v.color !== null);
  const needsChoice = hasFlavor || hasColor;

  const flavors = uniq(sellable.map((v) => v.flavor));
  // Colors are narrowed to the ones that exist (in stock) with the chosen flavor: no impossible combinations.
  const flavor = picked.flavor && flavors.includes(picked.flavor) ? picked.flavor : null;
  const colors = uniq(sellable.filter((v) => !hasFlavor || flavor === null || v.flavor === flavor).map((v) => v.color));
  const color = picked.color && colors.includes(picked.color) ? picked.color : null;
  const sel: VariantSelection = { flavor, color };

  // A product without options has a single default variant: nothing to choose, direct add with quantity.
  // With options, nothing is pre-selected — the buyer always picks explicitly.
  const variant = needsChoice && flavor === null && color === null ? null : findVariant(sellable, sel);
  const range = priceRange(p.basePriceMinor, sellable.length ? sellable : p.variants);
  const pricesDiffer = range.min !== range.max;
  const price = variant ? effectivePriceMinor(p.basePriceMinor, variant) : range.min;

  const inCart = variant ? (cart.lines.find((l) => l.variantId === variant.id)?.quantity ?? 0) : 0;
  const room = variant ? Math.min(variant.stock_quantity, MAX_LINE_QUANTITY) - inCart : 0;
  const maxQty = Math.max(1, room);
  const quantity = Math.min(qty, maxQty);

  const soldOut = sellable.length === 0;
  const hint = soldOut
    ? gone
      ? 'Товар больше недоступен'
      : 'Нет в наличии'
    : !variant
      ? hasFlavor && flavor === null
        ? 'Выберите вкус'
        : hasColor && color === null
          ? 'Выберите цвет'
          : 'Выберите вариант'
      : room <= 0
        ? 'В корзине весь остаток'
        : null;

  const pick = (kind: 'flavor' | 'color', value: string) => {
    setError(null);
    setQty(1);
    setPicked((prev) => {
      if (kind === 'color') return { ...prev, color: value };
      // Changing the flavor keeps the color only if that exact combination is still sellable.
      const keep = prev.color !== null && sellable.some((v) => v.flavor === value && v.color === prev.color);
      return { flavor: value, color: keep ? prev.color : null };
    });
  };

  const refresh = () => {
    setError(null);
    void query.refetch();
  };

  const confirm = async () => {
    if (!variant || busy) return;
    setBusy(true);
    setError(null);
    // Stock may have changed since the panel opened: re-read before touching the cart.
    const fresh = await query.refetch();
    setBusy(false);
    if (fresh.error instanceof NotFoundError) return; // the panel switches to "Товар больше недоступен"
    if (fresh.isError || !fresh.data) {
      setError('Не удалось проверить наличие. Проверьте подключение.');
      return;
    }
    const data = fresh.data;
    const already = cart.lines.find((l) => l.variantId === variant.id)?.quantity ?? 0;
    const check = canAddToCart(data.variants, { flavor: variant.flavor, color: variant.color }, quantity, already);
    if (!check.ok) {
      // The panel already re-rendered with the fresh data (the sold-out option disappears).
      setError(`${REASONS[check.reason]}. Наличие обновлено — выберите снова.`);
      setQty(1);
      return;
    }
    // Same cart call as the product page: the line is keyed by variant id, a repeat add merges quantities.
    cart.add(
      {
        variantId: check.variant.id,
        productId: data.id,
        name: data.name,
        variantLabel: variantLabel(check.variant),
        unitPriceMinor: effectivePriceMinor(data.basePriceMinor, check.variant),
        imagePath: data.images[0]?.storage_path ?? null,
        maxQuantity: check.variant.stock_quantity,
      },
      quantity,
    );
    toast.success('Добавлено в корзину', {
      action: { label: 'Корзина', onClick: () => navigate(`/s/${shop.slug}/cart`) },
    });
    onDone();
  };

  const image = p.images[0];

  return (
    <>
      <DialogOverlay className="duration-300" />
      <DialogPrimitive.Content
        data-testid="quick-add-sheet"
        className={cn(
          'glass-bar glass-sheet fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full max-w-lg flex-col rounded-t-2xl border-b-0 outline-none',
          // Only as tall as its content; long flavor lists scroll inside, the header and the action stay put.
          'max-h-[calc(100dvh-var(--safe-top)-1.5rem)]',
          'duration-300 ease-(--ease-glass) data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom',
        )}
      >
        <div className="flex items-start gap-3 p-4 pb-3">
          <ProductImage
            path={image?.storage_path}
            alt=""
            sizes="56px"
            className="size-14 shrink-0 rounded-lg ring-1 ring-(--glass-edge)"
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <DialogTitle className="line-clamp-2 text-base leading-snug font-semibold">{p.name}</DialogTitle>
            <p className="text-lg font-semibold tracking-tight tabular-nums" data-testid="quick-price">
              {!variant && pricesDiffer && <span className="text-sm font-normal text-muted-foreground">от </span>}
              {formatMoney(price, shop.currency)}
            </p>
            <DialogDescription className="sr-only">Выбор варианта и количества для добавления в корзину</DialogDescription>
          </div>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-lg" className="-mt-1 -mr-1 shrink-0 rounded-full" aria-label="Закрыть">
              <XIcon aria-hidden />
            </Button>
          </DialogClose>
        </div>

        {needsChoice && !soldOut && (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-1">
            {flavors.length > 0 && (
              <OptionGroup
                legend="Выберите вкус"
                kind="flavor"
                values={flavors}
                selection={sel}
                sellable={sellable}
                showPrice={pricesDiffer}
                basePriceMinor={p.basePriceMinor}
                currency={shop.currency}
                onPick={(v) => pick('flavor', v)}
              />
            )}
            {colors.length > 0 && (
              <OptionGroup
                legend={hasFlavor ? 'Цвет' : 'Выберите цвет'}
                kind="color"
                values={colors}
                selection={sel}
                sellable={sellable}
                showPrice={pricesDiffer}
                basePriceMinor={p.basePriceMinor}
                currency={shop.currency}
                onPick={(v) => pick('color', v)}
              />
            )}
          </div>
        )}

        <div className="space-y-2.5 p-4 pt-3 pb-[calc(1rem+var(--safe-bottom))]">
          {query.isError && !gone && !error && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              Не удалось обновить наличие.
              <button type="button" onClick={refresh} className="font-medium text-foreground underline underline-offset-2">
                Обновить
              </button>
            </p>
          )}
          {error && (
            <p role="alert" className="flex items-center gap-2 text-sm text-destructive" data-testid="quick-error">
              <span className="flex-1">{error}</span>
              <button
                type="button"
                onClick={refresh}
                className="inline-flex min-h-8 items-center gap-1 font-medium text-foreground underline underline-offset-2"
              >
                <ArrowClockwiseIcon aria-hidden className="size-3.5" /> Обновить
              </button>
            </p>
          )}
          {inCart > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="quick-in-cart">
              Уже в корзине: {inCart} шт.
            </p>
          )}
          <div className="flex items-center gap-3">
            {!soldOut && (
              <QuantityStepper
                value={quantity}
                max={maxQty}
                onChange={setQty}
                className="border-(--glass-edge) bg-(--glass-pill-fill)"
              />
            )}
            <Button
              size="lg"
              className="h-11 flex-1"
              disabled={!!hint || busy}
              onClick={() => void confirm()}
              data-testid="quick-confirm"
            >
              {!hint && <ShoppingCartIcon aria-hidden />}
              {busy ? 'Проверяем…' : (hint ?? 'Добавить в корзину')}
            </Button>
          </div>
        </div>
      </DialogPrimitive.Content>
    </>
  );
}

/**
 * Compact bottom sheet for picking a flavor (and other options) straight from the catalog grid.
 * Built on the installed shadcn/Radix Dialog (no Drawer/vaul in the project). Rendered WITHOUT a portal so it
 * stays inside `.storefront-scene` and inherits the shop's Liquid Glass tokens; it sits above the bottom nav
 * (z-50 vs z-40) and pads itself by the safe area. Adding happens only on explicit confirmation.
 */
export function QuickAddSheet({
  product,
  open,
  onOpenChange,
}: {
  product: ProductDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetBody listed={product} onDone={() => onOpenChange(false)} />
    </DialogPrimitive.Root>
  );
}
