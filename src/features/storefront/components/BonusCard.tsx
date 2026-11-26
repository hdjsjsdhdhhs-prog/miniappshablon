import { GiftIcon } from '@phosphor-icons/react';
import { describeBonusOperation, formatBonuses, formatSignedBonuses, type BonusProfile } from '@/domain/loyalty';
import { formatMoney } from '@/domain/money';
import { cn } from '@/lib/utils';

/** How many of the latest operations the profile lists (the server returns up to 30). */
const SHOWN = 10;

/**
 * «Мои бонусы» of the buyer in THIS shop: the balance, what was earned and spent, and the latest operations with the order
 * each one belongs to. Part of the profile, in its own glass card — no separate screen.
 */
export function BonusCard({ profile }: { profile: BonusProfile }) {
  const items = profile.history.slice(0, SHOWN);
  return (
    <section aria-labelledby="bonus-card-title" className="glass-card space-y-3 rounded-2xl p-4" data-testid="bonus-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="bonus-card-title" className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
            <GiftIcon aria-hidden weight="fill" className="size-4 text-primary" /> Мои бонусы
          </h2>
          <p className="mt-1 text-2xl font-bold tabular-nums" data-testid="bonus-balance-value">
            {formatBonuses(profile.balance)}
          </p>
        </div>
        <dl className="shrink-0 text-right text-xs text-muted-foreground">
          <dt className="sr-only">Получено всего</dt>
          <dd data-testid="bonus-earned">Получено: {formatBonuses(profile.earned_total)}</dd>
          <dt className="sr-only">Потрачено</dt>
          <dd data-testid="bonus-spent">Потрачено: {formatBonuses(profile.spent_total)}</dd>
        </dl>
      </div>

      <p className="text-xs text-muted-foreground">
        {profile.enabled
          ? `1 бонус = ${formatMoney(profile.unit_minor, profile.currency)}. Бонусы можно потратить при оформлении следующего заказа — выберите «Использовать бонусы» в корзине.${profile.percent ? ` За подтверждённые заказы начисляется ${String(profile.percent).replace('.', ',')}% от оплаченной суммы.` : ''}`
          : 'Бонусная программа магазина сейчас приостановлена: ваши бонусы сохранены, потратить их можно после возобновления.'}
      </p>

      {items.length > 0 && (
        <div className="space-y-1.5">
          <h3 className="text-sm font-medium">Последние операции</h3>
          <ul className="space-y-1.5 text-sm" data-testid="bonus-history">
            {items.map((h) => (
              <li key={h.id} className="flex items-baseline justify-between gap-3" data-testid="bonus-history-item">
                <span className="min-w-0">
                  <span className={cn('font-semibold tabular-nums', h.amount > 0 ? 'text-emerald-500' : 'text-foreground')}>{formatSignedBonuses(h.amount)}</span>{' '}
                  — {describeBonusOperation(h.kind, h.order_number)}.
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{new Date(h.created_at).toLocaleDateString('ru-RU')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
