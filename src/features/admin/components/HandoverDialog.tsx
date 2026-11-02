import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageSpinner } from '@/components/state-views';
import {
  AdminApiError,
  platformApi,
  publicShopUrl,
  type HandoverProblem,
  type HandoverReservation,
  type HandoverResult,
  type PlatformShop,
} from '../functions-api';
import { CopyLinkButton } from './CopyLinkButton';

const HANDOVER_PROBLEMS: Record<HandoverProblem, string> = {
  shop_suspended: 'Магазин приостановлен (status ≠ active).',
  not_demo: 'Магазин уже не DEMO — для смены владельца используйте «Передать».',
  age_restriction: 'Возрастное ограничение должно быть не ниже 18+.',
  no_fulfillment: 'Не включён ни один способ получения (доставка / самовывоз) — включите в настройках магазина.',
  no_categories: 'Нет активных категорий.',
  no_products: 'Нет опубликованных товаров в наличии.',
};

const ERRORS: Record<string, string> = {
  forbidden: 'Передавать магазины может только администратор платформы.',
  shop_not_found: 'Магазин не найден.',
  shop_not_ready: 'Магазин не готов к передаче.',
  owner_is_platform_admin: 'Это учётная запись администратора платформы. Клиенту нужна отдельная учётная запись.',
  owner_unconfirmed:
    'Учётная запись с этим email создана самостоятельной регистрацией и не подтверждена — передать ей магазин нельзя (её мог создать не клиент). Попросите клиента восстановить пароль по ссылке «Забыли пароль» (это подтвердит email и заменит пароль) и повторите передачу.',
  owner_blocked: 'Учётная запись заблокирована.',
  handover_pending: 'Магазин уже ожидает подтверждения другим клиентом. Отмените ту передачу, чтобы передать другому.',
  handover_in_progress:
    'Передача этого магазина уже выполняется (другая вкладка или другой администратор). Обновите окно через минуту; зависшая операция снимается автоматически через 10 минут.',
  handover_reservation_active: 'Резерв передачи ещё действует — дождитесь завершения операции или истечения резерва.',
  handover_reservation_lost: 'Передача была отменена или перехвачена другой операцией — изменений нет. Откройте окно заново.',
  handover_reservation_mismatch: 'Передача была отменена или перехвачена другой операцией — изменений нет. Откройте окно заново.',
  invite_failed: 'Не удалось создать приглашение. Проверьте email и повторите.',
  user_not_found: 'Учётная запись не найдена.',
  transfer_verification_failed: 'Проверка результата не прошла — передача отменена, изменений нет.',
  invalid_body: 'Проверьте email.',
  auth_required: 'Сессия истекла. Войдите снова.',
  network_error: 'Нет связи с сервером. Повторите попытку.',
};

/** "m:ss" for a countdown. */
function formatLeft(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function errorText(e: unknown): string {
  if (e instanceof AdminApiError && e.code === 'shop_not_ready' && Array.isArray(e.details)) {
    return `Магазин не готов к передаче: ${(e.details as HandoverProblem[]).map((p) => HANDOVER_PROBLEMS[p] ?? p).join(' ')}`;
  }
  if (e instanceof AdminApiError && e.code === 'invitation_rate_limited') {
    const d = (e.details ?? {}) as { reason?: string; retry_after_sec?: number; limit?: number };
    const wait = typeof d.retry_after_sec === 'number' ? ` Повторить можно через ${formatLeft(d.retry_after_sec)}.` : '';
    return d.reason === 'hourly'
      ? `Лимит приглашений на этот email исчерпан (не более ${d.limit ?? 5} в час для магазина).${wait}`
      : `Приглашение на этот email только что отправлено (не чаще одного раза в минуту).${wait}`;
  }
  return (e instanceof AdminApiError && ERRORS[e.code]) || 'Не удалось передать магазин. Повторите попытку.';
}

/** Seconds until `deadline` (ms), ticking once a second; null without a deadline. */
function useSecondsLeft(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * State of the shop's hand-over reservation (audit S2-06). While its lease runs it only shows the time left — a
 * live reservation cannot be removed here. Once expired, "Очистить просроченный резерв" asks the server, which
 * re-checks the expiry itself and refuses a live reservation. An expired reservation no longer blocks a new
 * hand-over, so clearing it only tidies up the state and the log — it does not "unblock" the shop.
 */
function ReservationNotice({
  shopId,
  reservation,
  fetchedAt,
  onChanged,
}: {
  shopId: string;
  reservation: HandoverReservation;
  fetchedAt: number;
  onChanged: () => Promise<unknown>;
}) {
  // Counted from the server's remaining_sec, not from the browser clock vs. expires_at.
  const left = useSecondsLeft(reservation.expired ? null : fetchedAt + reservation.remaining_sec * 1000);
  const expired = reservation.expired || left === 0;
  const synced = useRef(false);
  useEffect(() => {
    // The lease ran out while the dialog was open: ask the server for the current state once.
    if (left === 0 && !reservation.expired && !synced.current) {
      synced.current = true;
      void onChanged();
    }
  }, [left, reservation.expired, onChanged]);
  const release = useMutation({
    mutationFn: () => platformApi.releaseStaleHandover(shopId),
    onSuccess: (r) => {
      if (r.released) toast.success('Просроченный резерв очищен');
    },
    onSettled: () => onChanged(),
  });

  if (!expired) {
    return (
      <Alert data-testid="handover-reservation" data-state="active">
        <AlertDescription>
          Выполняется передача на <b>{reservation.email}</b>: магазин зарезервирован, другие передачи пока недоступны. Резерв истечёт через{' '}
          <b data-testid="handover-reservation-left">{formatLeft(left ?? reservation.remaining_sec)}</b>.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert data-testid="handover-reservation" data-state="expired">
      <AlertDescription>
        <p>
          Резерв передачи на <b>{reservation.email}</b> истёк {new Date(reservation.expires_at).toLocaleString('ru-RU')} — операция, вероятно,
          прервалась. Новой передаче он уже не мешает; запись можно очистить.
        </p>
        {release.isError && (
          <p className="text-destructive" data-testid="handover-release-stale-error">
            {errorText(release.error)}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-2"
          disabled={release.isPending}
          onClick={() => release.mutate()}
          data-testid="handover-release-stale"
        >
          Очистить просроченный резерв
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/**
 * "Передать клиенту" (DEMO → paying client): readiness check → e-mail → confirmation → one server call that
 * invites (or links) the account, makes it the only owner and turns the shop into a regular live shop with the
 * same slug and link. The client sets a password from the invitation; they never get platform-admin rights.
 */
export function HandoverDialog({ shop, open, onOpenChange }: { shop: PlatformShop; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [paid, setPaid] = useState(false);
  const [result, setResult] = useState<HandoverResult | null>(null);
  const check = useQuery({ queryKey: ['admin', 'handover-check', shop.id], queryFn: () => platformApi.handoverCheck(shop.id), enabled: open, staleTime: 0 });
  const handover = useMutation({
    mutationFn: () => platformApi.handover(shop.id, email.trim()),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const cancelPending = useMutation({
    mutationFn: () => platformApi.cancelHandover(shop.id),
    // Also after a refusal (409 handover_reservation_active: a reservation appeared meanwhile) — show the fresh state.
    onSettled: async () => {
      await qc.invalidateQueries({ queryKey: ['admin'] });
      await check.refetch();
    },
  });
  const pending = check.data?.pending_handover && !check.data.pending_handover.expired ? check.data.pending_handover : null;
  const reservation = check.data?.reservation ?? null;
  // The server refuses handover-cancel while a reservation is live (and never removes one): not offered then.
  const reservationLive = reservation !== null && !reservation.expired;
  const refreshState = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const emailValid = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const ready = check.data?.ready === true;
  const url = publicShopUrl(shop.slug);

  const close = (next: boolean) => {
    if (!next) {
      setEmail('');
      setPaid(false);
      setResult(null);
      handover.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent data-testid="handover-dialog">
        <DialogHeader>
          <DialogTitle>Передать клиенту «{shop.name}»</DialogTitle>
          <DialogDescription>
            Клиент станет единственным владельцем, магазин перейдёт из DEMO в обычный режим (live). Каталог, фото, slug и ссылка
            сохраняются. Прав администратора платформы клиент не получает.
          </DialogDescription>
        </DialogHeader>

        {!result && reservation && (
          <ReservationNotice
            key={`${reservation.created_at}|${reservation.expires_at}`}
            shopId={shop.id}
            reservation={reservation}
            fetchedAt={check.dataUpdatedAt}
            onChanged={refreshState}
          />
        )}

        {result ? (
          <div className="space-y-3 text-sm" data-testid="handover-result">
            {result.handover.status === 'pending' ? (
              <Alert data-testid="handover-pending">
                <AlertDescription>
                  Ожидает подтверждения: магазин перейдёт к <b>{result.handover.owner.email}</b> и станет обычным (live) автоматически, когда
                  клиент подтвердит email по ссылке из приглашения. До этого магазин остаётся DEMO и у него нет владельца.
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <AlertDescription>
                  Магазин передан: владелец <b>{result.handover.owner.email}</b>, режим <b>live</b>, DEMO выключен.
                  {result.handover.notifications?.settings_removed && ' Telegram-уведомления DEMO-периода отключены — клиент подключит свои.'}
                </AlertDescription>
              </Alert>
            )}
            {result.invitation.status === 'sent' && (
              <p data-testid="handover-invitation">
                Письмо-приглашение отправлено на {result.handover.owner.email}. По ссылке из письма клиент подтвердит email, задаст пароль
                и войдёт в свою админку.
              </p>
            )}
            {result.invitation.status === 'existing' && (
              <p data-testid="handover-invitation">У клиента уже есть учётная запись — он входит в админку со своим паролем.</p>
            )}
            {result.invitation.status === 'link' && result.invitation.link && (
              <div className="space-y-1.5" data-testid="handover-invitation">
                <p className="text-destructive">
                  Письмо отправить не удалось. Передайте клиенту одноразовую ссылку-приглашение защищённым каналом (не публикуйте её):
                </p>
                <Input readOnly value={result.invitation.link} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <CopyLinkButton url={result.invitation.link} label="Копировать приглашение" />
              </div>
            )}
            {result.handover.removed.length > 0 && (
              <p className="text-muted-foreground">Доступ снят: {result.handover.removed.map((m) => m.email ?? m.user_id).join(', ')}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs break-all text-muted-foreground">{url}</span>
              <CopyLinkButton url={url} />
            </div>
          </div>
        ) : check.isPending ? (
          <PageSpinner />
        ) : check.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{errorText(check.error)}</AlertDescription>
          </Alert>
        ) : !ready ? (
          <Alert variant="destructive" data-testid="handover-not-ready">
            <AlertDescription>
              <p>Магазин не готов к передаче:</p>
              <ul className="mt-1 list-disc pl-5">
                {check.data.problems.map((p) => (
                  <li key={p}>{HANDOVER_PROBLEMS[p] ?? p}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : (
          <form
            id="handover-form"
            className="space-y-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (emailValid && paid) handover.mutate();
            }}
          >
            {pending && (
              <Alert data-testid="handover-pending-current">
                <AlertDescription>
                  <p>
                    Ожидает подтверждения клиентом <b>{pending.email}</b> (до {new Date(pending.expires_at).toLocaleDateString('ru-RU')}). Можно
                    отправить приглашение повторно на тот же email или отменить передачу.
                  </p>
                  {pending.last_error && <p className="text-destructive">Последняя попытка не удалась: {pending.last_error}</p>}
                  {cancelPending.isError && (
                    <p className="text-destructive" data-testid="handover-cancel-error">
                      {errorText(cancelPending.error)}
                    </p>
                  )}
                  {!reservationLive && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      disabled={cancelPending.isPending}
                      onClick={() => cancelPending.mutate()}
                      data-testid="handover-cancel"
                    >
                      Отменить передачу
                    </Button>
                  )}
                </AlertDescription>
              </Alert>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="handover-email">Email клиента</Label>
              <Input
                id="handover-email"
                type="email"
                autoComplete="off"
                placeholder="client@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="handover-email"
              />
              <p className="text-xs text-muted-foreground">
                Нет учётной записи — придёт приглашение; магазин перейдёт клиенту после подтверждения email. Есть подтверждённая —
                передача сразу, клиент войдёт со своим паролем.
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={paid} onCheckedChange={(v) => setPaid(v === true)} className="mt-0.5" data-testid="handover-paid" />
              Оплата получена, магазин можно передать клиенту и перевести в обычный режим.
            </label>
            {handover.isError && (
              <Alert variant="destructive" data-testid="handover-error">
                <AlertDescription>{errorText(handover.error)}</AlertDescription>
              </Alert>
            )}
          </form>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>Готово</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => close(false)}>
                Отмена
              </Button>
              <Button
                type="submit"
                form="handover-form"
                disabled={!ready || !emailValid || !paid || handover.isPending}
                data-testid="handover-confirm"
              >
                {handover.isPending ? 'Передаём…' : 'Передать клиенту'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
