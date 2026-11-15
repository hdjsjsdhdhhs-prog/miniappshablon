import { ShieldCheckIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queryKeys } from '@/domain/query-keys';
import { useSession } from '../auth';
import { AdminApiError, platformApi, publicShopUrl, type DemoDeleteResult, type PlatformShop, type ShopDeletePreview } from '../functions-api';
import { listTotpFactors, MFA_REQUIRED_TEXT, verifyTotp } from '../mfa';

/** The step-up could not be completed in the browser (before the server was asked to delete anything). */
class StepUpError extends Error {
  constructor(readonly reason: 'no_factor' | 'bad_code') {
    super(reason);
  }
}

const ERRORS: Record<string, string> = {
  confirmation_mismatch: 'Введённый slug не совпадает со slug магазина.',
  handover_in_progress: 'Сейчас идёт передача магазина клиенту. Дождитесь её завершения и повторите.',
  mfa_required: MFA_REQUIRED_TEXT,
  mfa_step_up_required: 'Удаление не подтверждено кодом. Введите текущий код из приложения-аутентификатора и повторите.',
  forbidden: 'Удалять магазины может только администратор платформы.',
  shop_not_found: 'Магазин не найден.',
  deletion_not_found: 'Удаление этого магазина не начиналось.',
  deletion_verification_failed: 'Проверка полноты удаления не прошла — изменения отменены. Повторите попытку.',
  notification_cleanup_failed: 'Не удалось удалить настройки уведомлений — изменения отменены. Повторите попытку.',
  bot_cleanup_failed: 'Не удалось удалить подключение Telegram-бота — изменения отменены. Повторите попытку.',
  auth_required: 'Сессия истекла. Войдите снова.',
};
const STEP_UP_ERRORS: Record<StepUpError['reason'], string> = {
  no_factor: 'Не найден подключённый аутентификатор. Настройте двухфакторную защиту и повторите.',
  bad_code: 'Код не подошёл или устарел. Введите текущий код из приложения.',
};
const errorText = (e: unknown) =>
  e instanceof StepUpError ? STEP_UP_ERRORS[e.reason] : (e instanceof AdminApiError && ERRORS[e.code]) || 'Не удалось выполнить удаление. Повторите попытку.';

const COUNT_LABELS: Array<[keyof NonNullable<ShopDeletePreview['counts']>, string]> = [
  ['products', 'Товары'],
  ['categories', 'Категории'],
  ['variants', 'Варианты'],
  ['media_files', 'Медиафайлы'],
  ['orders', 'Заказы'],
  ['members', 'Участники'],
  ['subscribers', 'Пользователи бота'],
  ['broadcasts', 'Рассылки'],
];

/**
 * "Удалить магазин": full, irreversible deletion of ANY shop, LIVE included (handed over to a client, with or without
 * an owner). Two confirmations, both checked by the server: the exact slug, and a fresh TOTP code — being signed in
 * with MFA is not enough. Order: the server records that this admin opened this deletion (challenge) → Supabase Auth
 * verifies the code → the server deletes only if that verification happened after the challenge, in this session.
 * The code never goes to our server. DEMO shops keep their own dialog (DeleteDemoDialog, no step-up).
 */
export function DeleteShopDialog({ shop, open, onOpenChange }: { shop: PlatformShop; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const { session } = useSession();
  const [typed, setTyped] = useState('');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<DemoDeleteResult | null>(null);
  const preview = useQuery({ queryKey: queryKeys.platformShopDelete(shop.id), queryFn: () => platformApi.shopDeletePreview(shop.id), enabled: open, retry: false });
  const factors = useQuery({ queryKey: queryKeys.adminMfaFactors(session?.user.id ?? ''), queryFn: listTotpFactors, enabled: open && !!session });

  const done = async (r: DemoDeleteResult) => {
    setResult(r);
    await qc.invalidateQueries({ queryKey: ['admin'] });
  };
  const remove = useMutation({
    mutationFn: async () => {
      const factor = factors.data?.find((f) => f.status === 'verified');
      if (!factor) throw new StepUpError('no_factor');
      await platformApi.shopDeleteChallenge(shop.id);
      try {
        await verifyTotp(factor.id, code);
      } catch {
        throw new StepUpError('bad_code');
      }
      return platformApi.shopDelete(shop.id, typed.trim());
    },
    onSuccess: done,
    // A code confirms one attempt only: the next one needs the current code again.
    onSettled: () => setCode(''),
  });
  // Storage cleanup of a deletion that already passed both confirmations: no new code is needed.
  const resume = useMutation({ mutationFn: () => platformApi.demoDeleteResume(shop.id), onSuccess: done });
  const pending = remove.isPending || resume.isPending;

  const p = preview.data;
  const inProgress = shop.status === 'deleting' || p?.status === 'deleting' || result?.deletion.status === 'pending';
  const completed = result?.deletion.status === 'deleted' || p?.status === 'deleted';
  const owners = (p?.members ?? []).filter((m) => m.role === 'owner');
  const failure = remove.error ?? resume.error ?? preview.error;
  const confirmed = typed.trim() === shop.slug && /^\d{6}$/.test(code);

  return (
    <Dialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <DialogContent data-testid="shop-delete-dialog">
        <DialogHeader>
          <DialogTitle>Удалить магазин «{shop.name}»?</DialogTitle>
          <DialogDescription>
            Это действующий магазин. Он будет удалён полностью и безвозвратно: товары, категории, варианты, заказы покупателей, участники,
            приглашения, настройки, уведомления, подключённый Telegram-бот с его аудиторией и рассылками, все файлы. Ссылка перестанет
            открываться, slug больше нельзя будет занять.
          </DialogDescription>
        </DialogHeader>

        {completed ? (
          <Alert data-testid="shop-delete-done">
            <AlertDescription>
              Магазин «{shop.name}» удалён полностью, включая файлы. Slug <span className="font-mono">{shop.slug}</span> зарезервирован.
            </AlertDescription>
          </Alert>
        ) : preview.isPending ? (
          <PageSpinner />
        ) : (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="shop-delete-summary">
              <dt className="text-muted-foreground">Название</dt>
              <dd>{shop.name}</dd>
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="font-mono" data-testid="shop-delete-slug">
                {shop.slug}
              </dd>
              <dt className="text-muted-foreground">Ссылка</dt>
              <dd className="font-mono text-xs break-all">{publicShopUrl(shop.slug)}</dd>
              {p?.counts &&
                COUNT_LABELS.map(([k, label]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums" data-testid={`shop-delete-count-${k}`}>
                      {p.counts![k]}
                    </dd>
                  </div>
                ))}
              {p?.bot && (
                <>
                  <dt className="text-muted-foreground">Telegram-бот</dt>
                  <dd data-testid="shop-delete-bot">@{p.bot}</dd>
                </>
              )}
              <dt className="text-muted-foreground">Владелец</dt>
              <dd data-testid="shop-delete-owner">{owners.length ? owners.map((o) => o.email ?? o.user_id).join(', ') : 'не назначен'}</dd>
            </dl>

            {p?.has_owner && !inProgress && (
              <Alert variant="destructive" data-testid="shop-delete-owner-warning">
                <WarningCircleIcon aria-hidden />
                <AlertDescription>
                  У магазина есть владелец ({owners.map((o) => o.email ?? o.user_id).join(', ')}). Он потеряет доступ к этому магазину и все его
                  данные. Его учётная запись и другие магазины сохранятся.
                </AlertDescription>
              </Alert>
            )}
            {p?.pending_handover && !inProgress && (
              <Alert data-testid="shop-delete-pending-handover">
                <AlertDescription>Незавершённая передача клиенту {p.pending_handover.email} будет отменена.</AlertDescription>
              </Alert>
            )}

            {inProgress ? (
              <Alert data-testid="shop-delete-in-progress">
                <AlertDescription>
                  Данные магазина уже удалены, витрина недоступна, но файлы ещё не очищены
                  {typeof result?.deletion.remaining === 'number' ? ` (осталось: ${result.deletion.remaining})` : ''}. Удаление не завершено —
                  продолжите его.
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3 rounded-md border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="shop-delete-confirm">
                    1. Введите slug магазина: <span className="font-mono">{shop.slug}</span>
                  </Label>
                  <Input id="shop-delete-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="shop-delete-input" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="shop-delete-code" className="flex items-center gap-1.5">
                    <ShieldCheckIcon aria-hidden className="size-4" /> 2. Код из приложения-аутентификатора
                  </Label>
                  <Input
                    id="shop-delete-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                    className="max-w-40 font-mono tracking-widest"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    aria-describedby="shop-delete-code-hint"
                    data-testid="shop-delete-code"
                  />
                  <p id="shop-delete-code-hint" className="text-xs text-muted-foreground">
                    Нужен текущий код: вход с двухфакторной защитой сам по себе удаление не подтверждает.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {failure && !completed && (
          <Alert variant="destructive" data-testid="shop-delete-error">
            <WarningCircleIcon aria-hidden />
            <AlertDescription>{errorText(failure)}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            {completed ? 'Готово' : 'Отмена'}
          </Button>
          {!completed &&
            (inProgress ? (
              <Button variant="destructive" disabled={pending} onClick={() => resume.mutate()} data-testid="shop-delete-resume">
                {pending ? 'Удаляем…' : 'Продолжить удаление'}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={pending || !p || p.status !== 'ready' || !confirmed || factors.isPending}
                onClick={() => remove.mutate()}
                data-testid="shop-delete-confirm"
              >
                <TrashIcon aria-hidden /> {pending ? 'Удаляем…' : 'Удалить магазин навсегда'}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
