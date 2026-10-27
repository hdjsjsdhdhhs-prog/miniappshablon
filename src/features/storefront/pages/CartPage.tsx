import { CheckCircleIcon, ShoppingCartIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { ProductImage } from '@/components/product-image';
import { EmptyState } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatMoney } from '@/domain/money';
import { lineTotalMinor } from '@/domain/pricing';
import { queryKeys } from '@/domain/query-keys';
import { ApiError, checkoutKeyFor, clearCheckoutKey, submitCheckout, type OrderDto } from '@/features/cart/checkout-api';
import { describeCheckoutError } from '@/features/cart/checkout-errors';
import { CheckoutForm } from '@/features/cart/CheckoutForm';
import { FULFILLMENT_LABELS, toFulfillment, type CheckoutFormValues, type FulfillmentMethod } from '@/features/cart/checkout-schema';
import { useCart } from '@/features/cart/useCart';
import { getTelegramEnv } from '@/features/telegram/telegram';
import { QuantityStepper } from '../components/QuantityStepper';
import { DEMO_NOTICE, DEMO_ORDER_TITLE } from '../demo-profile';
import { useShop } from '../shop-context';

/** Result of the client-only DEMO checkout: never sent anywhere, never stored. */
interface DemoPlaced {
  totalMinor: number;
  currency: string;
  method: FulfillmentMethod;
}

export function CartPage() {
  const shop = useShop();
  const cart = useCart(shop.id);
  const queryClient = useQueryClient();
  const tg = getTelegramEnv();
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<OrderDto | null>(null);
  const [demoPlaced, setDemoPlaced] = useState<DemoPlaced | null>(null);

  const checkout = useMutation({
    mutationFn: (values: CheckoutFormValues) => {
      const order = { fulfillment: toFulfillment(values), comment: values.comment };
      return submitCheckout(tg.rawInitData ?? '', {
        shopSlug: shop.slug,
        currency: shop.currency,
        idempotencyKey: checkoutKeyFor(shop.id, cart.lines, order),
        lines: cart.lines,
        expectedTotalMinor: cart.totalMinor,
        ...order,
      });
    },
    onSuccess: (res) => {
      setPlaced(res.order);
      setError(null);
      cart.clear();
      clearCheckoutKey(shop.id);
      void queryClient.invalidateQueries({ queryKey: ['shop', shop.id] });
    },
    onError: (err) => {
      const view = describeCheckoutError(err);
      setError(view.message);
      if (view.reconcile) cart.reconcile(view.reconcile);
      view.removeVariantIds?.forEach((id) => cart.remove(id));
      if (view.resetIdempotencyKey) clearCheckoutKey(shop.id);
      // The owner changed the delivery/pickup settings meanwhile: reload them so the form shows what is offered now.
      if (err instanceof ApiError && err.code === 'fulfillment_unavailable') void queryClient.invalidateQueries({ queryKey: queryKeys.shop(shop.slug) });
    },
  });

  const submit = (values: CheckoutFormValues) => {
    if (shop.isDemo) {
      // DEMO: a local "Тестовый заказ" only — no request, no order row, no stock change, nothing in any history.
      setDemoPlaced({ totalMinor: cart.totalMinor, currency: shop.currency, method: values.method });
      setError(null);
      cart.clear();
      return;
    }
    checkout.mutate(values);
  };

  if (demoPlaced) {
    return (
      <main className="px-4 py-10" data-testid="demo-order-placed">
        <EmptyState
          icon={<CheckCircleIcon weight="fill" className="text-success" />}
          title={`${DEMO_ORDER_TITLE} оформлен`}
          description={`${DEMO_NOTICE}: заказ на ${formatMoney(demoPlaced.totalMinor, demoPlaced.currency)} (${FULFILLMENT_LABELS[demoPlaced.method].toLowerCase()}) никуда не отправлен, остатки не изменились, в истории заказов магазина его нет.`}
          action={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild>
                <Link to={`/s/${shop.slug}/profile`}>Демо-профиль</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to={`/s/${shop.slug}/`}>Продолжить покупки</Link>
              </Button>
            </div>
          }
        />
      </main>
    );
  }

  if (placed) {
    return (
      <main className="px-4 py-10">
        <EmptyState
          icon={<CheckCircleIcon weight="fill" className="text-success" />}
          title={`Заказ №${placed.order_number} отправлен`}
          description={`Сумма ${formatMoney(placed.total_minor, placed.currency)}. Магазин свяжется с вами для подтверждения, оплата и получение согласуются отдельно.${placed.is_test ? ' Это тестовый заказ demo-витрины.' : ''}`}
          action={
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button asChild>
                <Link to={`/s/${shop.slug}/profile`}>Мои заказы</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to={`/s/${shop.slug}/`}>Продолжить покупки</Link>
              </Button>
            </div>
          }
        />
      </main>
    );
  }

  if (cart.lines.length === 0) {
    return (
      <main className="px-4 py-10">
        <EmptyState
          icon={<ShoppingCartIcon />}
          title="Корзина пуста"
          description="Добавьте товары из каталога."
          action={
            <Button asChild>
              <Link to={`/s/${shop.slug}/`}>В каталог</Link>
            </Button>
          }
        />
      </main>
    );
  }

  // DEMO shops simulate the order locally (in a browser and in Telegram); real orders need verified initData.
  const canOrder = shop.isDemo || (tg.inTelegram && !!tg.rawInitData && shop.mode === 'live');

  return (
    <main className="space-y-5 px-4 pt-4 pb-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Корзина</h1>
        <Button variant="ghost" size="sm" onClick={() => cart.clear()}>
          <TrashIcon aria-hidden /> Очистить
        </Button>
      </div>

      <ul className="space-y-3" aria-label="Товары в корзине">
        {cart.lines.map((l) => (
          <li key={l.variantId} className="glass-card flex gap-3 rounded-xl p-3" data-testid="cart-line">
            <ProductImage path={l.imagePath} alt={l.name} className="size-20 shrink-0 rounded-md" sizes="80px" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Link to={`/s/${shop.slug}/product/${l.productId}`} className="line-clamp-2 text-sm font-medium">
                {l.name}
              </Link>
              {l.variantLabel && <p className="text-xs text-muted-foreground">{l.variantLabel}</p>}
              <p className="text-xs text-muted-foreground">{formatMoney(l.unitPriceMinor, shop.currency)} / шт.</p>
              <div className="mt-auto flex items-center justify-between gap-2">
                <QuantityStepper
                  value={l.quantity}
                  max={Math.min(l.maxQuantity, 99)}
                  onChange={(q) => cart.setQuantity(l.variantId, q)}
                  label={`Количество: ${l.name}`}
                />
                <span className="text-sm font-semibold tabular-nums">{formatMoney(lineTotalMinor(l), shop.currency)}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => cart.remove(l.variantId)}
              aria-label={`Удалить ${l.name}`}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-destructive"
            >
              <TrashIcon aria-hidden className="size-5" />
            </button>
          </li>
        ))}
      </ul>

      <div className="glass-panel flex items-center justify-between rounded-xl p-4">
        <span className="text-muted-foreground">Итого</span>
        <span className="text-lg font-bold tabular-nums" data-testid="cart-total">
          {formatMoney(cart.totalMinor, shop.currency)}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Цены и наличие проверяются магазином при оформлении. Онлайн-оплаты нет: заказ подтверждает магазин, оплата и получение согласуются отдельно.
      </p>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {shop.isDemo ? (
        <Alert data-testid="demo-checkout-note">
          <AlertDescription>{DEMO_NOTICE}: заказ будет тестовым — он не отправляется в магазин и не меняет остатки.</AlertDescription>
        </Alert>
      ) : (
        <>
          {!tg.inTelegram && (
            <Alert>
              <AlertDescription>Оформление доступно в Telegram: откройте магазин через бота, чтобы подтвердить аккаунт.</AlertDescription>
            </Alert>
          )}
          {shop.mode !== 'live' && (
            <Alert>
              <AlertDescription>Магазин в режиме предпросмотра — заказы отключены.</AlertDescription>
            </Alert>
          )}
        </>
      )}

      <section aria-labelledby="checkout-title" className="space-y-3">
        <h2 id="checkout-title" className="font-semibold">
          Получение заказа
        </h2>
        <CheckoutForm
          // Remount when the owner's settings change, so the default method follows what is offered.
          key={`${shop.fulfillment.delivery}-${shop.fulfillment.pickup}`}
          fulfillment={shop.fulfillment}
          disabled={!canOrder}
          submitting={checkout.isPending}
          submitLabel={`${shop.isDemo ? 'Оформить тестовый заказ' : 'Оформить заказ'} · ${formatMoney(cart.totalMinor, shop.currency)}`}
          onSubmit={submit}
        />
      </section>
    </main>
  );
}
