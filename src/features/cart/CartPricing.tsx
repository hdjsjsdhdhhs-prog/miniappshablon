import { GiftIcon, InfoIcon, TagIcon, XIcon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { BONUS_UNIT_MINOR, formatBonuses, type CartQuote } from '@/domain/loyalty';
import { formatMoney } from '@/domain/money';
import { cn } from '@/lib/utils';
import { promoReasonMessage } from './checkout-errors';
import type { CartPricing } from './useCartPricing';

function Row({ label, value, testId, className }: { label: string; value: string; testId?: string; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-sm', className)}>
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 tabular-nums" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function thresholdTitle(q: CartQuote): string {
  const t = q.threshold!;
  return `Скидка за сумму заказа ${t.percent}% (от ${formatMoney(t.min_total_minor, q.currency)})`;
}

/** «Введите промокод» + «Применить». The answer is the server's: applied, refused (why), or left unused (why). */
function PromoBlock({ pricing, quote }: { pricing: CartPricing; quote: CartQuote }) {
  const outcome = quote.promo;
  const applied = outcome?.status === 'applied';
  const message =
    outcome && pricing.promo && outcome.status !== 'applied' ? promoReasonMessage(outcome.reason) : null;
  return (
    <section aria-labelledby="promo-title" className="glass-card space-y-2 rounded-xl p-3" data-testid="cart-promo">
      <h3 id="promo-title" className="flex items-center gap-2 text-sm font-semibold">
        <TagIcon aria-hidden weight="fill" className="size-4 text-primary" /> Промокод
      </h3>
      {pricing.promo ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-sm" data-testid="promo-applied">
          <span className="min-w-0">
            <span className="font-mono font-medium">{pricing.promo}</span>
            {applied && outcome && <span className="text-emerald-500"> · скидка {formatMoney(outcome.discount_minor, quote.currency)}</span>}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={pricing.clearPromo} aria-label="Убрать промокод" data-testid="promo-remove">
            <XIcon aria-hidden /> Убрать
          </Button>
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            pricing.applyPromo();
          }}
        >
          <Label htmlFor="cart-promo-input" className="sr-only">
            Введите промокод
          </Label>
          <Input
            id="cart-promo-input"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="Введите промокод"
            value={pricing.promoDraft}
            maxLength={40}
            onChange={(e) => pricing.setPromoDraft(e.target.value)}
            className="font-mono uppercase"
            data-testid="promo-input"
          />
          <Button type="submit" variant="outline" disabled={!pricing.promoDraft.trim() || pricing.promoPending} data-testid="promo-apply">
            Применить
          </Button>
        </form>
      )}
      {message && (
        <p role="status" className={cn('text-sm', outcome?.status === 'invalid' ? 'text-destructive' : 'text-muted-foreground')} data-testid="promo-message">
          {message}
        </p>
      )}
      {quote.features.discount && (
        <p className="text-xs text-muted-foreground" data-testid="promo-stacking-note">
          Скидка за сумму заказа и промокод не суммируются — действует более выгодная.
        </p>
      )}
    </section>
  );
}

/** «Использовать бонусы»: the balance, how many to spend and the effect on the total. */
function BonusBlock({ pricing, quote }: { pricing: CartPricing; quote: CartQuote }) {
  const b = quote.bonus;
  const canSpend = b.balance > 0 && b.max_spend > 0;
  return (
    <section aria-labelledby="bonus-title" className="glass-card space-y-2 rounded-xl p-3" data-testid="cart-bonus">
      <div className="flex items-center justify-between gap-3">
        <h3 id="bonus-title" className="flex items-center gap-2 text-sm font-semibold">
          <GiftIcon aria-hidden weight="fill" className="size-4 text-primary" /> Бонусы
        </h3>
        <span className="text-sm text-muted-foreground" data-testid="bonus-balance">
          Доступно: {formatBonuses(b.balance)}
        </span>
      </div>
      {b.balance === 0 ? (
        <p className="text-sm text-muted-foreground">Бонусов пока нет — они начисляются после подтверждения заказа.</p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={pricing.useBonus}
              disabled={!canSpend && !pricing.useBonus}
              onCheckedChange={(v) => {
                pricing.setUseBonus(v);
                if (v && !pricing.bonusDraft) pricing.setBonusDraft(String(b.max_spend));
              }}
              aria-label="Использовать бонусы"
              data-testid="bonus-toggle"
            />
            Использовать бонусы
          </label>
          {pricing.useBonus && (
            <div className="space-y-1.5">
              <Label htmlFor="cart-bonus-input" className="text-xs text-muted-foreground">
                Сколько бонусов списать (1 бонус = {formatMoney(BONUS_UNIT_MINOR, quote.currency)})
              </Label>
              <div className="flex gap-2">
                <Input
                  id="cart-bonus-input"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pricing.bonusDraft}
                  onChange={(e) => pricing.setBonusDraft(e.target.value.replace(/[^\d]/g, ''))}
                  data-testid="bonus-input"
                />
                <Button type="button" variant="outline" onClick={() => pricing.setBonusDraft(String(b.max_spend))} data-testid="bonus-max">
                  Максимум
                </Button>
              </div>
              {b.requested > b.applied && (
                <p className="text-xs text-muted-foreground" data-testid="bonus-clamped">
                  Можно списать не больше {formatBonuses(b.max_spend)} — на столько хватает баланса и стоимости заказа.
                </p>
              )}
            </div>
          )}
        </>
      )}
      {quote.accrual_preview > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="cart-accrual-preview">
          После подтверждения заказа магазином вы получите {formatBonuses(quote.accrual_preview)}.
        </p>
      )}
    </section>
  );
}

/**
 * Discounts, promo code and bonuses of the cart. Shown only for a shop that turned at least one of them on; the numbers are
 * the server's quote. The buyer sees the price without discounts, every discount that applies, the bonuses used and what is left to pay.
 */
export function CartPricingPanel({ pricing }: { pricing: CartPricing }) {
  const q = pricing.quote;
  if (!q) return null;
  const money = (minor: number) => formatMoney(minor, q.currency);
  const next = q.next_threshold;
  const discount = q.discount;
  return (
    <div className="space-y-3" data-testid="cart-pricing">
      {q.features.promo && <PromoBlock pricing={pricing} quote={q} />}
      {q.features.bonus && <BonusBlock pricing={pricing} quote={q} />}

      {q.features.discount && next && (
        <div role="note" className="glass-card flex gap-3 rounded-xl p-3 text-sm" data-testid="cart-next-threshold">
          <InfoIcon aria-hidden weight="fill" className="mt-0.5 size-5 shrink-0 text-primary" />
          <p>
            Добавьте товаров ещё на <span className="font-semibold">{money(next.remaining_minor)}</span> и получите скидку{' '}
            <span className="font-semibold">{next.percent}%</span>.
          </p>
        </div>
      )}

      <div className="glass-panel space-y-2 rounded-xl p-4" data-testid="cart-summary">
        <Row label="Сумма товаров" value={money(q.subtotal_minor)} testId="cart-subtotal" className="text-muted-foreground" />
        {discount.type === 'threshold' && q.threshold && (
          <Row label={thresholdTitle(q)} value={`−${money(discount.minor)}`} testId="cart-discount" className="text-emerald-500" />
        )}
        {discount.type === 'promo' && q.promo && (
          <Row label={`Промокод ${q.promo.code}`} value={`−${money(discount.minor)}`} testId="cart-discount" className="text-emerald-500" />
        )}
        {q.bonus.applied > 0 && (
          <Row label={`Оплачено бонусами (${formatBonuses(q.bonus.applied)})`} value={`−${money(q.bonus.spend_minor)}`} testId="cart-bonus-spent" className="text-emerald-500" />
        )}
        {discount.minor > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="cart-savings">
            Вы экономите {money(discount.minor + q.bonus.spend_minor)}
          </p>
        )}
        <div className="flex items-center justify-between gap-3 border-t pt-2">
          <span className="text-muted-foreground">К оплате</span>
          <span className="text-lg font-bold tabular-nums" data-testid="cart-total">
            {money(q.total_minor)}
          </span>
        </div>
      </div>
    </div>
  );
}
