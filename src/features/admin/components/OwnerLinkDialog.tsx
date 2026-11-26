import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ownerLinkUrl } from '@/domain/owner-registration';
import { AdminApiError, platformApi, type HandoverProblem, type PlatformShop } from '../functions-api';
import { HANDOVER_PROBLEMS } from '../handover-problems';
import { MFA_REQUIRED_TEXT } from '../mfa';
import { OWNER_INVITE_STATUS } from '../owner-invite-status';
import { CopyLinkButton } from './CopyLinkButton';

const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

const ERRORS: Record<string, string> = {
  forbidden: 'Создавать ссылки может только администратор платформы.',
  mfa_required: MFA_REQUIRED_TEXT,
  shop_not_found: 'Магазин не найден.',
  shop_deleting: 'Магазин удаляется.',
  shop_not_ready: 'Магазин не готов к передаче.',
  handover_pending: 'Магазин ожидает подтверждения другим клиентом (передача по email). Отмените ту передачу или дождитесь её завершения.',
  handover_in_progress: 'С магазином прямо сейчас выполняется операция (регистрация по ссылке или передача). Подождите до трёх минут и повторите.',
  owner_is_platform_admin: 'Эта почта принадлежит администратору платформы — владельцем магазина она быть не может.',
  invalid_body: 'Проверьте электронную почту покупателя.',
  invalid_email: 'Проверьте электронную почту покупателя.',
  auth_required: 'Сессия истекла. Войдите снова.',
  network_error: 'Нет связи с сервером. Повторите попытку.',
};

function errorText(e: unknown): string {
  if (e instanceof AdminApiError && e.code === 'shop_not_ready' && Array.isArray(e.details)) {
    return `Магазин не готов к передаче: ${(e.details as HandoverProblem[]).map((p) => HANDOVER_PROBLEMS[p] ?? p).join(' ')}`;
  }
  return (e instanceof AdminApiError && ERRORS[e.code]) || 'Не удалось выполнить действие. Повторите попытку.';
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * «Ссылка для регистрации владельца»: one individual, time-limited, one-time link for ONE shop. The buyer registers on
 * it without any approval; the shop then belongs to them alone (existing hand-over / transfer rules). The link is shown
 * once, at creation: the server keeps only its hash, so a lost link is replaced, never recovered.
 */
export function OwnerLinkDialog({
  shop,
  open,
  onOpenChange,
  issuedToken,
  onIssued,
}: {
  shop: PlatformShop;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The token returned by the last creation in this browser session (memory only), or null. */
  issuedToken: string | null;
  onIssued: (token: string | null) => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const invite = shop.owner_invite ?? null;
  const active = invite?.status === 'active';
  const bound = email.trim() !== '';
  const emailValid = !bound || EMAIL.test(email.trim());

  const create = useMutation({
    mutationFn: () => platformApi.ownerLinkCreate(shop.id, bound ? { email: email.trim() } : {}),
    onSuccess: async (r) => {
      onIssued(r.token);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const revoke = useMutation({
    mutationFn: () => platformApi.ownerLinkRevoke(shop.id),
    onSuccess: async () => {
      onIssued(null);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    },
    // A refusal (a registration is running) also shows the fresh state.
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });

  const url = issuedToken && active ? ownerLinkUrl(issuedToken, window.location.origin) : null;
  const status = invite ? OWNER_INVITE_STATUS[invite.status] : null;
  const owners = shop.members.filter((m) => m.role === 'owner');
  const busy = create.isPending || revoke.isPending || invite?.in_progress === true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="owner-link-dialog">
        <DialogHeader>
          <DialogTitle>Ссылка для регистрации владельца «{shop.name}»</DialogTitle>
          <DialogDescription>
            Отправьте ссылку покупателю: он сам введёт почту и пароль и сразу станет единственным владельцем магазина. Подтверждать
            регистрацию не нужно. Каталог, заказы и настройки сохраняются; прежний владелец потеряет доступ.
          </DialogDescription>
        </DialogHeader>

        {invite && status && (
          <div className="space-y-1.5 rounded-lg border p-3 text-sm" data-testid="owner-link-status" data-status={invite.status}>
            <p className="flex flex-wrap items-center gap-2">
              <Badge variant={status.variant}>{status.label}</Badge>
              {invite.in_progress && <Badge variant="outline">Идёт регистрация</Badge>}
              {invite.stale && (
                <Badge variant="destructive" title="Магазин сменил владельца другим способом: сервер откажет по этой ссылке">
                  Устарела
                </Badge>
              )}
            </p>
            <p className="text-muted-foreground">
              Создана {dateTime(invite.created_at)} · действует до {dateTime(invite.expires_at)}
            </p>
            {invite.bound_email && <p className="text-muted-foreground">Только для почты: {invite.bound_email}</p>}
            {invite.status === 'used' && (
              <p data-testid="owner-link-used">
                Зарегистрировался <b>{invite.used_email}</b> — {dateTime(invite.used_at)}
                {invite.used_via === 'claim' ? ' (вошёл в существующий аккаунт)' : ''}. Теперь он владелец магазина. Почта введена самим покупателем и не
                подтверждалась письмом.
              </p>
            )}
            {invite.status === 'revoked' && (
              <p className="text-muted-foreground">
                Отозвана {dateTime(invite.revoked_at)}
                {invite.revoked_reason === 'replaced' ? ' (заменена новой ссылкой)' : ''}.
              </p>
            )}
            {invite.stale && <p className="text-destructive">Владелец магазина изменился после создания ссылки. Создайте новую.</p>}
          </div>
        )}

        {url && (
          <div className="space-y-2" data-testid="owner-link-issued">
            <Label htmlFor="owner-link-url">Ссылка для покупателя</Label>
            <Input id="owner-link-url" readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} data-testid="owner-link-url" />
            <div className="flex flex-wrap items-center gap-2">
              <CopyLinkButton url={url} label="Скопировать ссылку" testId="owner-link-copy" secret />
              <span className="text-xs text-muted-foreground">Ссылка показана один раз: на сервере хранится только её отпечаток.</span>
            </div>
          </div>
        )}
        {active && !url && (
          <Alert data-testid="owner-link-hidden">
            <AlertDescription>
              Саму ссылку увидеть уже нельзя — на сервере хранится только её отпечаток. Если вы её не скопировали, создайте новую: прежняя перестанет
              работать.
            </AlertDescription>
          </Alert>
        )}

        {!active && owners.length > 0 && invite?.status !== 'used' && (
          <p className="text-sm text-muted-foreground">
            Сейчас владелец: {owners.map((o) => o.email ?? o.user_id).join(', ')}. Новая ссылка передаст магазин покупателю, этот доступ будет снят.
          </p>
        )}

        <form
          className="space-y-3"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (emailValid && !busy) create.mutate();
          }}
          id="owner-link-form"
        >
          <div className="space-y-1.5">
            <Label htmlFor="owner-link-email">Почта покупателя (необязательно)</Label>
            <Input
              id="owner-link-email"
              type="email"
              autoComplete="off"
              placeholder="buyer@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={!emailValid}
              data-testid="owner-link-email"
            />
            <p className="text-xs text-muted-foreground">
              Ссылку может открыть и использовать <b>первым любой, у кого она оказалась</b> — например, если покупатель её переслал. Если вы знаете почту
              покупателя, укажите её: тогда зарегистрироваться по ссылке сможет только этот адрес. Не знаете — оставьте поле пустым.
            </p>
            {!emailValid && <p className="text-xs text-destructive">Введите корректный адрес электронной почты.</p>}
          </div>
          {(create.isError || revoke.isError) && (
            <Alert variant="destructive" data-testid="owner-link-error">
              <AlertDescription>{errorText(create.error ?? revoke.error)}</AlertDescription>
            </Alert>
          )}
        </form>

        <DialogFooter className="gap-2 sm:justify-between">
          {active ? (
            <Button type="button" variant="outline" disabled={busy} onClick={() => revoke.mutate()} data-testid="owner-link-revoke">
              Отозвать ссылку
            </Button>
          ) : (
            <span />
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Закрыть
            </Button>
            <Button type="submit" form="owner-link-form" disabled={busy || !emailValid} data-testid="owner-link-create">
              {create.isPending ? 'Создаём…' : active ? 'Создать новую ссылку взамен старой' : 'Создать ссылку для регистрации владельца'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
