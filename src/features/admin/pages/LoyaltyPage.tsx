import { GiftIcon, PercentIcon, PencilSimpleIcon, TagIcon, TrashIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { bonusFor, formatBonuses, formatSignedBonuses } from '@/domain/loyalty';
import { formatMoney, minorToInput, parseMoneyInput } from '@/domain/money';
import { queryKeys } from '@/domain/query-keys';
import { cn } from '@/lib/utils';
import { useAdminShop } from '../admin-context';
import {
  AdminApiError,
  loyaltyApi,
  loyaltyErrorText,
  type LoyaltyOverview,
  type LoyaltyPromo,
  type LoyaltyRule,
  type PromoAdminStatus,
  type PromoUsage,
} from '../functions-api';

type TabId = 'bonus' | 'discount' | 'promo';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'bonus', label: 'Бонусная программа' },
  { id: 'discount', label: 'Скидки от суммы заказа' },
  { id: 'promo', label: 'Промокоды' },
];

const STATUS_LABEL: Record<PromoAdminStatus, string> = { active: 'Активен', finished: 'Завершён', disabled: 'Отключён' };

/** "5", "5,5", "5.25" → 5 / 5.5 / 5.25; null when it is not a number with at most two decimals. */
function parsePercent(input: string): number | null {
  const normalized = input.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Number(normalized);
}

const parseIntStrict = (input: string): number | null => (/^\d+$/.test(input.trim()) ? Number(input.trim()) : null);

/** Shared header of a block: title, what it does in one sentence and the on/off switch (saved at once). */
function BlockSwitch({
  id,
  label,
  checked,
  disabled,
  onChange,
  testId,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-3 text-sm font-medium">
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} data-testid={testId} />
      {label}
      <Badge variant={checked ? 'default' : 'secondary'} className="ml-1">
        {checked ? 'Включено' : 'Выключено'}
      </Badge>
    </label>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

/**
 * «Бонусы и промокоды»: three independent blocks of one shop — the bonus program, automatic discounts by order total and
 * promo codes. Everything is OFF until the owner switches it on here; until then the shop works exactly as before. The
 * server computes every amount of an order, this page only configures the rules.
 */
export function LoyaltyPage() {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const key = queryKeys.adminLoyalty(shop.id);
  const [tab, setTab] = useState<TabId>('bonus');
  const overviewQuery = useQuery({
    queryKey: key,
    queryFn: () => loyaltyApi.get(shop.id),
    retry: (count, err) => !(err instanceof AdminApiError && err.status < 500) && count < 2,
  });
  const o = overviewQuery.data;

  // Bonus messages queued by confirmations are sent by the first attempt of the admin panel; a visit also retries due ones.
  const dispatched = useRef(false);
  const pending = o?.stats.notifications?.pending ?? 0;
  useEffect(() => {
    if (!dispatched.current && pending > 0) {
      dispatched.current = true;
      void loyaltyApi
        .dispatch(shop.id)
        .then(() => qc.invalidateQueries({ queryKey: key }))
        .catch(() => undefined);
    }
  }, [pending, shop.id, qc, key]);

  if (overviewQuery.isPending) return <PageSpinner />;
  if (overviewQuery.isError) {
    if (overviewQuery.error instanceof AdminApiError && overviewQuery.error.code === 'forbidden') {
      return (
        <Alert>
          <AlertDescription>{loyaltyErrorText(overviewQuery.error)}</AlertDescription>
        </Alert>
      );
    }
    return <ErrorState onRetry={() => void overviewQuery.refetch()} />;
  }
  const overview = overviewQuery.data;
  const set = (next: LoyaltyOverview) => qc.setQueryData(key, next);

  return (
    <div className="space-y-5" data-testid="loyalty-page">
      <div>
        <h2 className="text-lg font-semibold">Бонусы и промокоды</h2>
        <p className="text-sm text-muted-foreground">
          Три независимых механизма. Пока вы их не включили, магазин работает как раньше: цены, корзина и оформление заказа не меняются.
        </p>
      </div>

      <div role="tablist" aria-label="Разделы «Бонусы и промокоды»" className="scrollbar-none flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`loyalty-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`loyalty-panel-${t.id}`}
            onClick={() => setTab(t.id)}
            data-testid={`loyalty-tab-${t.id}`}
            className={cn(
              'min-h-9 rounded-full border px-3 py-1.5 text-sm whitespace-nowrap',
              tab === t.id ? 'border-foreground bg-foreground text-background' : 'bg-card',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`loyalty-panel-${tab}`} aria-labelledby={`loyalty-tab-${tab}`}>
        {tab === 'bonus' && <BonusTab shopId={shop.id} overview={overview} onChange={set} />}
        {tab === 'discount' && <DiscountTab shopId={shop.id} overview={overview} onChange={set} />}
        {tab === 'promo' && <PromoTab shopId={shop.id} overview={overview} onChange={set} />}
      </div>

      <Alert data-testid="loyalty-order-rule">
        <AlertDescription>
          <span className="font-medium">Как складываются скидки.</span> Сначала берутся актуальные цены товаров (с вашими скидками на товары).
          Затем действует <span className="font-medium">одна</span> скидка на заказ: скидка за сумму или промокод — та, что выгоднее покупателю
          (они не суммируются, а промокод, который не дал выгоды, не расходуется). После этого покупатель может оплатить часть заказа бонусами.
          Сумма заказа не бывает отрицательной.
        </AlertDescription>
      </Alert>
    </div>
  );
}

interface TabProps {
  shopId: string;
  overview: LoyaltyOverview;
  onChange: (next: LoyaltyOverview) => void;
}

// ---- Бонусная программа ------------------------------------------------------------------------------------------------

function BonusTab({ shopId, overview, onChange }: TabProps) {
  const { settings, stats } = overview;
  const currency = overview.shop.currency;
  const [percent, setPercent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const percentText = percent ?? String(settings.bonus_percent).replace('.', ',');
  const parsed = parsePercent(percentText);
  const valid = parsed !== null && parsed > 0 && parsed <= 100;

  const save = useMutation({
    mutationFn: (patch: { bonusEnabled?: boolean; bonusPercent?: number }) => loyaltyApi.saveSettings(shopId, patch),
    onSuccess: (next, patch) => {
      onChange(next);
      setPercent(null);
      setError(null);
      if (patch.bonusEnabled !== undefined) toast.success(patch.bonusEnabled ? 'Бонусная программа включена' : 'Бонусная программа выключена');
      else toast.success('Процент сохранён');
    },
    onError: (e) => setError(loyaltyErrorText(e)),
  });

  const example = valid ? bonusFor(300_000, parsed) : null;
  const dirty = valid && parsed !== settings.bonus_percent;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]" data-testid="loyalty-bonus">
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <GiftIcon aria-hidden weight="fill" className="size-5 text-primary" />
          <CardTitle className="text-base">Бонусная программа</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <BlockSwitch
            id="bonus-enabled"
            label="Включить бонусную программу"
            checked={settings.bonus_enabled}
            disabled={save.isPending}
            onChange={(v) => save.mutate({ bonusEnabled: v })}
            testId="bonus-enabled"
          />
          <p className="text-sm" data-testid="bonus-current">
            Сейчас:{' '}
            {settings.bonus_enabled ? (
              <>
                <span className="font-medium">включена</span>, начисляется <span className="font-medium">{settings.bonus_percent.toString().replace('.', ',')}%</span> с
                подтверждённого заказа
              </>
            ) : (
              <span className="font-medium">выключена</span>
            )}
            .
          </p>

          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (valid) save.mutate({ bonusPercent: parsed });
            }}
          >
            <Label htmlFor="bonus-percent">Процент начисления бонусов</Label>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-32">
                <Input
                  id="bonus-percent"
                  inputMode="decimal"
                  autoComplete="off"
                  value={percentText}
                  onChange={(e) => setPercent(e.target.value)}
                  aria-invalid={!valid}
                  className="pr-7"
                  data-testid="bonus-percent"
                />
                <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                  %
                </span>
              </div>
              <Button type="submit" disabled={!dirty || save.isPending} data-testid="bonus-percent-save">
                Сохранить процент
              </Button>
            </div>
            {!valid && <p className="text-sm text-destructive">Укажите число больше 0 и не больше 100 (не более двух знаков после запятой).</p>}
            {example !== null && (
              <Hint>
                Например, заказ на {formatMoney(300_000, currency)} после подтверждения даст покупателю{' '}
                <span className="font-medium text-foreground" data-testid="bonus-example">
                  {formatBonuses(example)}
                </span>
                . Процент можно менять в любое время — он действует на заказы, которые вы подтверждаете после изменения.
              </Hint>
            )}
          </form>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1 border-t pt-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">1 бонус = 1 {currency === 'RUB' ? '₽' : 'денежной единице'}</span> ({formatMoney(100, currency)}).
            </p>
            <p>Бонусы начисляются только после того, как вы подтвердите заказ — не при оформлении и не при смене других статусов.</p>
            <p>
              Начисляем с суммы, которую покупатель реально оплатил: после скидок и без части, оплаченной бонусами. Дробные бонусы отбрасываются.
            </p>
            <p>Заказ отменён — списанные бонусы возвращаются покупателю, а начисленные за него снимаются (баланс не уходит в минус).</p>
            <p>Покупатель сам выбирает, сколько бонусов потратить при оформлении. Сообщение о начислении приходит от бота вашего магазина, если покупатель его запускал.</p>
          </div>
        </CardContent>
      </Card>

      <aside className="space-y-4 text-sm">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Статистика</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1" data-testid="bonus-stats">
              <dt className="text-muted-foreground">Покупателей с бонусами</dt>
              <dd className="tabular-nums">{stats.customers}</dd>
              <dt className="text-muted-foreground">Сейчас на балансах</dt>
              <dd className="tabular-nums">{formatBonuses(stats.balance_total)}</dd>
              <dt className="text-muted-foreground">Начислено всего</dt>
              <dd className="tabular-nums">{formatBonuses(stats.earned_total)}</dd>
              <dt className="text-muted-foreground">Потрачено</dt>
              <dd className="tabular-nums">{formatBonuses(stats.spent_total)}</dd>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Последние операции</CardTitle>
          </CardHeader>
          <CardContent>
            {overview.recent.length === 0 ? (
              <p className="text-muted-foreground">Пока нет операций.</p>
            ) : (
              <ul className="space-y-1.5" data-testid="bonus-recent">
                {overview.recent.map((r) => (
                  <li key={r.id} className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">
                      {r.username ? `@${r.username}` : r.customer} · №{r.order_number}
                    </span>
                    <span className={cn('shrink-0 tabular-nums', r.amount > 0 ? 'text-emerald-500' : 'text-muted-foreground')}>{formatSignedBonuses(r.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {stats.notifications && stats.notifications.dead > 0 && (
              <Hint>Не доставлено сообщений о начислении: {stats.notifications.dead} (покупатель не запускал бота или заблокировал его).</Hint>
            )}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

// ---- Скидки от суммы заказа --------------------------------------------------------------------------------------------

function DiscountTab({ shopId, overview, onChange }: TabProps) {
  const { settings, rules } = overview;
  const currency = overview.shop.currency;
  const [editing, setEditing] = useState<LoyaltyRule | null>(null);
  const [min, setMin] = useState('');
  const [percent, setPercent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<LoyaltyRule | null>(null);

  const minMinor = parseMoneyInput(min);
  const percentValue = parseIntStrict(percent);
  const formValid = minMinor !== null && minMinor > 0 && percentValue !== null && percentValue >= 1 && percentValue <= 90;

  const toggle = useMutation({
    mutationFn: (v: boolean) => loyaltyApi.saveSettings(shopId, { discountEnabled: v }),
    onSuccess: (next) => {
      onChange(next);
      toast.success(next.settings.discount_enabled ? 'Скидки от суммы заказа включены' : 'Скидки от суммы заказа выключены');
    },
    onError: (e) => setError(loyaltyErrorText(e)),
  });
  const reset = () => {
    setEditing(null);
    setMin('');
    setPercent('');
  };
  const save = useMutation({
    mutationFn: () => loyaltyApi.saveRule(shopId, { ruleId: editing?.id, minTotalMinor: minMinor!, percent: percentValue! }),
    onSuccess: (next) => {
      onChange(next);
      setError(null);
      toast.success(editing ? 'Правило обновлено' : 'Правило добавлено');
      reset();
    },
    onError: (e) => setError(loyaltyErrorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => loyaltyApi.deleteRule(shopId, id),
    onSuccess: (next) => {
      onChange(next);
      setError(null);
      setRemoving(null);
      toast.success('Правило удалено');
      if (editing && !next.rules.some((r) => r.id === editing.id)) reset();
    },
    onError: (e) => {
      setRemoving(null);
      setError(loyaltyErrorText(e));
    },
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]" data-testid="loyalty-discount">
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <PercentIcon aria-hidden weight="bold" className="size-5 text-primary" />
          <CardTitle className="text-base">Скидки от суммы заказа</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <BlockSwitch
            id="discount-enabled"
            label="Включить автоматические скидки"
            checked={settings.discount_enabled}
            disabled={toggle.isPending}
            onChange={(v) => toggle.mutate(v)}
            testId="discount-enabled"
          />
          <Hint>
            Покупатель получает скидку автоматически, когда сумма товаров в корзине (с учётом ваших скидок на товары) достигает порога. Если подходят несколько
            порогов — применяется самый выгодный, скидки не складываются.
          </Hint>

          {rules.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="rules-empty">
              Правил пока нет. Добавьте первое — например, «от 3 000 ₽ — скидка 5%».
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm" data-testid="rules-table">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-2 font-medium">Минимальная сумма заказа</th>
                    <th className="px-3 py-2 font-medium">Скидка</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-b last:border-0" data-testid="rule-row">
                      <td className="px-3 py-2 tabular-nums">{formatMoney(r.min_total_minor, currency)}</td>
                      <td className="px-3 py-2 tabular-nums">{r.percent}%</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Изменить правило от ${formatMoney(r.min_total_minor, currency)}`}
                            onClick={() => {
                              setEditing(r);
                              setMin(minorToInput(r.min_total_minor));
                              setPercent(String(r.percent));
                              setError(null);
                            }}
                          >
                            <PencilSimpleIcon aria-hidden /> Изменить
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            aria-label={`Удалить правило от ${formatMoney(r.min_total_minor, currency)}`}
                            onClick={() => setRemoving(r)}
                          >
                            <TrashIcon aria-hidden /> Удалить
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form
            className="space-y-3 rounded-lg border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (formValid) save.mutate();
            }}
            aria-label={editing ? 'Изменить правило скидки' : 'Добавить правило скидки'}
          >
            <p className="text-sm font-medium">{editing ? `Изменить правило (сейчас от ${formatMoney(editing.min_total_minor, currency)})` : 'Добавить правило'}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="rule-min">Минимальная сумма заказа, {currency === 'RUB' ? '₽' : currency}</Label>
                <Input id="rule-min" inputMode="decimal" autoComplete="off" placeholder="3000" value={min} onChange={(e) => setMin(e.target.value)} data-testid="rule-min" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rule-percent">Скидка, %</Label>
                <Input id="rule-percent" inputMode="numeric" autoComplete="off" placeholder="5" value={percent} onChange={(e) => setPercent(e.target.value)} data-testid="rule-percent" />
              </div>
            </div>
            <Hint>Скидка — от 1% до 90%. Например: от 3 000 ₽ — 5%, от 5 000 ₽ — 7%, от 10 000 ₽ — 10%.</Hint>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!formValid || save.isPending} data-testid="rule-save">
                {editing ? 'Сохранить правило' : 'Добавить правило'}
              </Button>
              {editing && (
                <Button type="button" variant="outline" onClick={reset}>
                  Отмена
                </Button>
              )}
            </div>
          </form>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <aside className="space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Как это работает</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Порог проверяется на сервере по актуальным ценам — подменить сумму в браузере нельзя.</li>
          <li>В корзине покупатель видит сумму товаров, достигнутый порог, процент, экономию и подсказку, сколько осталось до следующего уровня.</li>
          <li>Скидка за сумму и промокод не суммируются — действует более выгодная.</li>
          <li>Новые правила действуют на новые заказы; оформленные заказы не пересчитываются.</li>
        </ul>
      </aside>

      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить правило?</DialogTitle>
            <DialogDescription>
              {removing ? `Правило «от ${formatMoney(removing.min_total_minor, currency)} — ${removing.percent}%» перестанет действовать. Оформленные заказы не изменятся.` : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Назад
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing.id)} data-testid="rule-delete-confirm">
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- Промокоды ---------------------------------------------------------------------------------------------------------

function PromoStatusBadge({ status }: { status: PromoAdminStatus }) {
  if (status === 'active') return <Badge className="bg-emerald-600 text-white">{STATUS_LABEL.active}</Badge>;
  return <Badge variant="secondary">{STATUS_LABEL[status]}</Badge>;
}

function promoValueText(p: LoyaltyPromo, currency: string): string {
  return p.discount_type === 'percent' ? `${p.percent}%` : formatMoney(p.fixed_minor ?? 0, currency);
}

const USAGE_LABEL: Record<PromoUsage['status'], string> = { reserved: 'ждёт подтверждения заказа', redeemed: 'использован', released: 'освобождён (заказ отменён)' };

function PromoTab({ shopId, overview, onChange }: TabProps) {
  const { settings, promos } = overview;
  const currency = overview.shop.currency;
  const [editing, setEditing] = useState<LoyaltyPromo | null>(null);
  const [code, setCode] = useState('');
  const [type, setType] = useState<'fixed' | 'percent'>('fixed');
  const [value, setValue] = useState('');
  const [limit, setLimit] = useState('100');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyOf, setHistoryOf] = useState<LoyaltyPromo | null>(null);
  const [removing, setRemoving] = useState<LoyaltyPromo | null>(null);

  const normalizedCode = code.trim().toUpperCase();
  const codeValid = editing !== null || /^[A-Z0-9_-]{3,32}$/.test(normalizedCode);
  const valueMinor = type === 'fixed' ? parseMoneyInput(value) : null;
  const valuePercent = type === 'percent' ? parseIntStrict(value) : null;
  const valueNumber = type === 'fixed' ? valueMinor : valuePercent;
  const valueValid = type === 'fixed' ? valueMinor !== null && valueMinor > 0 : valuePercent !== null && valuePercent >= 1 && valuePercent <= 90;
  const limitNumber = parseIntStrict(limit);
  const limitValid = limitNumber !== null && limitNumber >= 1 && limitNumber <= 1_000_000;
  const formValid = codeValid && valueValid && limitValid && (editing !== null || normalizedCode.length > 0);

  const reset = () => {
    setEditing(null);
    setCode('');
    setType('fixed');
    setValue('');
    setLimit('100');
    setActive(true);
  };
  const apply = (next: LoyaltyOverview, text?: string) => {
    onChange(next);
    setError(null);
    if (text) toast.success(text);
  };
  const fail = (e: unknown) => setError(loyaltyErrorText(e));

  const toggle = useMutation({
    mutationFn: (v: boolean) => loyaltyApi.saveSettings(shopId, { promoEnabled: v }),
    onSuccess: (next) => apply(next, next.settings.promo_enabled ? 'Промокоды включены' : 'Промокоды выключены'),
    onError: fail,
  });
  const save = useMutation({
    mutationFn: () =>
      loyaltyApi.savePromo(shopId, {
        promoId: editing?.id,
        code: normalizedCode || editing?.code || '',
        discountType: type,
        value: valueNumber!,
        maxActivations: limitNumber!,
        isActive: active,
      }),
    onSuccess: (next) => {
      apply(next, editing ? 'Промокод обновлён' : 'Промокод создан');
      reset();
    },
    onError: fail,
  });
  const setPromoActive = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => loyaltyApi.setPromoActive(shopId, id, on),
    onSuccess: (next, { on }) => apply(next, on ? 'Промокод включён' : 'Промокод отключён'),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => loyaltyApi.deletePromo(shopId, id),
    onSuccess: (next) => {
      setRemoving(null);
      apply(next, 'Промокод удалён');
    },
    onError: (e) => {
      setRemoving(null);
      fail(e);
    },
  });
  const history = useQuery({
    queryKey: [...queryKeys.adminLoyalty(shopId), 'promo-history', historyOf?.id ?? null],
    queryFn: () => loyaltyApi.promoHistory(shopId, historyOf!.id),
    enabled: !!historyOf,
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]" data-testid="loyalty-promo">
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          <TagIcon aria-hidden weight="fill" className="size-5 text-primary" />
          <CardTitle className="text-base">Промокоды</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <BlockSwitch
            id="promo-enabled"
            label="Принимать промокоды"
            checked={settings.promo_enabled}
            disabled={toggle.isPending}
            onChange={(v) => toggle.mutate(v)}
            testId="promo-enabled"
          />
          <Hint>Пока переключатель выключен, покупатели не видят поле для промокода, а введённые коды не работают. Сами коды сохраняются.</Hint>

          {promos.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground" data-testid="promos-empty">
              Промокодов пока нет. Создайте первый ниже.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm" data-testid="promos-table">
                <thead className="text-left text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-2 font-medium">Промокод</th>
                    <th className="px-3 py-2 font-medium">Скидка</th>
                    <th className="px-3 py-2 font-medium">Использовано</th>
                    <th className="px-3 py-2 font-medium">Лимит</th>
                    <th className="px-3 py-2 font-medium">Статус</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {promos.map((p) => (
                    <tr key={p.id} className="border-b last:border-0" data-testid="promo-row" data-code={p.code}>
                      <td className="px-3 py-2 font-mono font-medium">{p.code}</td>
                      <td className="px-3 py-2 tabular-nums">{promoValueText(p, currency)}</td>
                      <td className="px-3 py-2 tabular-nums" data-testid="promo-used">
                        {p.used_count}
                        {p.pending_count > 0 && <span className="text-xs text-muted-foreground"> (ждут подтверждения: {p.pending_count})</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{p.max_activations}</td>
                      <td className="px-3 py-2" data-testid="promo-status">
                        <PromoStatusBadge status={p.status} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={setPromoActive.isPending}
                            onClick={() => setPromoActive.mutate({ id: p.id, on: !p.is_active })}
                            aria-label={`${p.is_active ? 'Отключить' : 'Включить'} промокод ${p.code}`}
                          >
                            {p.is_active ? 'Отключить' : 'Включить'}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Изменить промокод ${p.code}`}
                            onClick={() => {
                              setEditing(p);
                              setCode(p.code);
                              setType(p.discount_type);
                              setValue(p.discount_type === 'percent' ? String(p.percent ?? '') : minorToInput(p.fixed_minor ?? 0));
                              setLimit(String(p.max_activations));
                              setActive(p.is_active);
                              setError(null);
                            }}
                          >
                            <PencilSimpleIcon aria-hidden /> Изменить
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setHistoryOf(p)} aria-label={`История использования ${p.code}`}>
                            История
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            aria-label={`Удалить промокод ${p.code}`}
                            onClick={() => setRemoving(p)}
                          >
                            <TrashIcon aria-hidden />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <form
            className="space-y-3 rounded-lg border p-3"
            aria-label={editing ? 'Изменить промокод' : 'Создать промокод'}
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              if (formValid) save.mutate();
            }}
          >
            <p className="text-sm font-medium">{editing ? `Изменить промокод ${editing.code}` : 'Создать промокод'}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="promo-code">Промокод</Label>
                <Input
                  id="promo-code"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="WELCOME300"
                  value={code}
                  maxLength={32}
                  disabled={!!editing}
                  onChange={(e) => setCode(e.target.value)}
                  aria-invalid={code.trim() !== '' && !codeValid}
                  className="font-mono uppercase"
                  data-testid="promo-code"
                />
                <Hint>Латинские буквы и цифры, «_» и «-», от 3 до 32 символов. Регистр не важен.</Hint>
              </div>
              <div className="space-y-1.5">
                <Label id="promo-type-label">Тип скидки</Label>
                <div role="radiogroup" aria-labelledby="promo-type-label" className="grid grid-cols-2 gap-2">
                  {(
                    [
                      ['fixed', 'Сумма, ₽'],
                      ['percent', 'Процент, %'],
                    ] as const
                  ).map(([t, label]) => (
                    <button
                      key={t}
                      type="button"
                      role="radio"
                      aria-checked={type === t}
                      onClick={() => {
                        setType(t);
                        setValue('');
                      }}
                      data-testid={`promo-type-${t}`}
                      className={cn('min-h-9 rounded-lg border px-3 py-1.5 text-sm', type === t ? 'border-primary bg-primary/15 font-medium' : 'bg-card hover:border-primary/60')}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-value">{type === 'fixed' ? `Размер скидки, ${currency === 'RUB' ? '₽' : currency}` : 'Размер скидки, % (1–90)'}</Label>
                <Input
                  id="promo-value"
                  inputMode={type === 'fixed' ? 'decimal' : 'numeric'}
                  autoComplete="off"
                  placeholder={type === 'fixed' ? '300' : '10'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  data-testid="promo-value"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="promo-limit">Количество активаций</Label>
                <Input id="promo-limit" inputMode="numeric" autoComplete="off" value={limit} onChange={(e) => setLimit(e.target.value)} data-testid="promo-limit" />
                <Hint>После последней активации код перестанет работать сам.{editing && editing.used_count > 0 ? ` Уже использовано: ${editing.used_count}.` : ''}</Hint>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={active} onCheckedChange={setActive} aria-label="Промокод активен" data-testid="promo-active" />
              Промокод активен
            </label>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!formValid || save.isPending} data-testid="promo-save">
                {editing ? 'Сохранить промокод' : 'Создать промокод'}
              </Button>
              {editing && (
                <Button type="button" variant="outline" onClick={reset}>
                  Отмена
                </Button>
              )}
            </div>
          </form>
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <aside className="space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Как считаются активации</p>
        <ul className="list-disc space-y-1.5 pl-5">
          <li>Активация резервируется в момент оформления заказа — одну и ту же активацию двое покупателей получить не могут.</li>
          <li>Вы подтверждаете заказ — активация засчитана окончательно. Заказ отменён — активация освобождается и код снова можно использовать.</li>
          <li>Промокод другого магазина здесь не сработает, а ваш — нигде, кроме вашего магазина.</li>
          <li>Использованный промокод удалить нельзя — его можно отключить, история сохранится.</li>
        </ul>
      </aside>

      <Dialog open={!!historyOf} onOpenChange={(open) => !open && setHistoryOf(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>История использования {historyOf?.code}</DialogTitle>
            <DialogDescription>Заказы, в которых применяли этот промокод.</DialogDescription>
          </DialogHeader>
          {history.isPending ? (
            <PageSpinner />
          ) : history.isError ? (
            <p className="text-sm text-destructive">{loyaltyErrorText(history.error)}</p>
          ) : history.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Этот промокод ещё не использовали.</p>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto text-sm" data-testid="promo-history">
              {history.data.map((u) => (
                <li key={u.order_number} className="flex flex-wrap justify-between gap-2 border-b pb-2 last:border-0">
                  <span>
                    Заказ №{u.order_number} · −{formatMoney(u.discount_minor, currency)}
                  </span>
                  <span className="text-muted-foreground">
                    {USAGE_LABEL[u.status]} · {new Date(u.created_at).toLocaleString('ru-RU')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Удалить промокод {removing?.code}?</DialogTitle>
            <DialogDescription>Код перестанет работать. Удалить можно только промокод, который ещё никто не использовал.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Назад
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => removing && remove.mutate(removing.id)} data-testid="promo-delete-confirm">
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
