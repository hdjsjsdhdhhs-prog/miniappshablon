import { TrashIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queryKeys } from '@/domain/query-keys';
import { AdminApiError, platformApi, publicShopUrl, type DemoDeletePreview, type DemoDeleteResult, type PlatformShop } from '../functions-api';
import { MFA_REQUIRED_TEXT } from '../mfa';

const ERRORS: Record<string, string> = {
  not_demo: 'Это не DEMO-магазин: настоящие (LIVE) магазины этим действием не удаляются.',
  confirmation_mismatch: 'Введённый slug не совпадает со slug магазина.',
  handover_in_progress: 'Сейчас идёт передача магазина клиенту. Дождитесь её завершения и повторите.',
  mfa_required: MFA_REQUIRED_TEXT,
  forbidden: 'Удалять магазины может только администратор платформы.',
  shop_not_found: 'Магазин не найден.',
  deletion_not_found: 'Удаление этого магазина не начиналось.',
  deletion_verification_failed: 'Проверка полноты удаления не прошла — изменения отменены. Повторите попытку.',
  notification_cleanup_failed: 'Не удалось удалить настройки Telegram-бота — изменения отменены. Повторите попытку.',
  auth_required: 'Сессия истекла. Войдите снова.',
};
const errorText = (e: unknown) => (e instanceof AdminApiError && ERRORS[e.code]) || 'Не удалось выполнить удаление. Повторите попытку.';

const COUNT_LABELS: Array<[keyof NonNullable<DemoDeletePreview['counts']>, string]> = [
  ['products', 'Товары'],
  ['categories', 'Категории'],
  ['variants', 'Варианты'],
  ['media_files', 'Медиафайлы'],
  ['orders', 'Заказы'],
  ['members', 'Участники'],
];

/**
 * "Удалить DEMO": full, irreversible deletion of a DEMO shop (aal2 platform admin only — enforced by the server).
 * Shows what will be deleted and who owns the shop, then requires the exact slug. "Удалено" is shown only when the
 * server reports the deletion complete (files included); otherwise the dialog offers to continue the deletion.
 */
export function DeleteDemoDialog({ shop, open, onOpenChange }: { shop: PlatformShop; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<DemoDeleteResult | null>(null);
  const preview = useQuery({ queryKey: queryKeys.platformDemoDelete(shop.id), queryFn: () => platformApi.demoDeletePreview(shop.id), enabled: open, retry: false });

  const done = async (r: DemoDeleteResult) => {
    setResult(r);
    await qc.invalidateQueries({ queryKey: ['admin'] });
  };
  const remove = useMutation({ mutationFn: () => platformApi.demoDelete(shop.id, typed.trim()), onSuccess: done });
  const resume = useMutation({ mutationFn: () => platformApi.demoDeleteResume(shop.id), onSuccess: done });
  const pending = remove.isPending || resume.isPending;

  const p = preview.data;
  const inProgress = shop.status === 'deleting' || p?.status === 'deleting' || result?.deletion.status === 'pending';
  const completed = result?.deletion.status === 'deleted' || p?.status === 'deleted';
  const owners = (p?.members ?? []).filter((m) => m.role === 'owner');
  const failure = remove.error ?? resume.error ?? preview.error;

  return (
    <Dialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <DialogContent data-testid="demo-delete-dialog">
        <DialogHeader>
          <DialogTitle>Удалить DEMO «{shop.name}»?</DialogTitle>
          <DialogDescription>
            Магазин будет удалён полностью и безвозвратно: товары, категории, варианты, заказы, участники, приглашения, настройки,
            уведомления и Telegram-бот, все файлы. Ссылка перестанет открываться, slug больше нельзя будет занять.
          </DialogDescription>
        </DialogHeader>

        {completed ? (
          <Alert data-testid="demo-delete-done">
            <AlertDescription>
              DEMO-магазин «{shop.name}» удалён полностью, включая файлы. Slug <span className="font-mono">{shop.slug}</span> зарезервирован.
            </AlertDescription>
          </Alert>
        ) : preview.isPending ? (
          <PageSpinner />
        ) : (
          <div className="space-y-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="demo-delete-summary">
              <dt className="text-muted-foreground">Название</dt>
              <dd>{shop.name}</dd>
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="font-mono" data-testid="demo-delete-slug">
                {shop.slug}
              </dd>
              <dt className="text-muted-foreground">Ссылка</dt>
              <dd className="font-mono text-xs break-all">{publicShopUrl(shop.slug)}</dd>
              {p?.counts &&
                COUNT_LABELS.map(([k, label]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums" data-testid={`demo-delete-count-${k}`}>
                      {p.counts![k]}
                    </dd>
                  </div>
                ))}
              <dt className="text-muted-foreground">Владелец</dt>
              <dd data-testid="demo-delete-owner">{owners.length ? owners.map((o) => o.email ?? o.user_id).join(', ') : 'не назначен'}</dd>
            </dl>

            {p?.has_owner && !inProgress && (
              <Alert variant="destructive" data-testid="demo-delete-owner-warning">
                <WarningCircleIcon aria-hidden />
                <AlertDescription>
                  У магазина есть владелец ({owners.map((o) => o.email).join(', ')}). Он потеряет доступ к этому магазину. Его учётная запись
                  и другие магазины сохранятся.
                </AlertDescription>
              </Alert>
            )}
            {p?.pending_handover && !inProgress && (
              <Alert data-testid="demo-delete-pending-handover">
                <AlertDescription>Незавершённая передача клиенту {p.pending_handover.email} будет отменена.</AlertDescription>
              </Alert>
            )}

            {inProgress ? (
              <Alert data-testid="demo-delete-in-progress">
                <AlertDescription>
                  Данные магазина уже удалены, витрина недоступна, но файлы ещё не очищены
                  {typeof result?.deletion.remaining === 'number' ? ` (осталось: ${result.deletion.remaining})` : ''}. Удаление не завершено —
                  продолжите его.
                </AlertDescription>
              </Alert>
            ) : p?.status === 'not_demo' ? (
              <Alert variant="destructive">
                <AlertDescription>{ERRORS.not_demo}</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="demo-delete-confirm">
                  Для подтверждения введите slug магазина: <span className="font-mono">{shop.slug}</span>
                </Label>
                <Input
                  id="demo-delete-confirm"
                  autoComplete="off"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  data-testid="demo-delete-input"
                />
              </div>
            )}
          </div>
        )}

        {failure && !completed && (
          <Alert variant="destructive" data-testid="demo-delete-error">
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
              <Button variant="destructive" disabled={pending} onClick={() => resume.mutate()} data-testid="demo-delete-resume">
                {pending ? 'Удаляем…' : 'Продолжить удаление'}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={pending || !p || p.status !== 'ready' || typed.trim() !== shop.slug}
                onClick={() => remove.mutate()}
                data-testid="demo-delete-confirm"
              >
                <TrashIcon aria-hidden /> {pending ? 'Удаляем…' : 'Удалить DEMO навсегда'}
              </Button>
            ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
