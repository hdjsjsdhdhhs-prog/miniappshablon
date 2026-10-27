import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageSpinner } from '@/components/state-views';
import { AdminApiError, platformApi, publicShopUrl, type HandoverProblem, type HandoverResult, type PlatformShop } from '../functions-api';
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
  invite_failed: 'Не удалось создать приглашение. Проверьте email и повторите.',
  user_not_found: 'Учётная запись не найдена.',
  transfer_verification_failed: 'Проверка результата не прошла — передача отменена, изменений нет.',
  invalid_body: 'Проверьте email.',
  auth_required: 'Сессия истекла. Войдите снова.',
  network_error: 'Нет связи с сервером. Повторите попытку.',
};

function errorText(e: unknown): string {
  if (e instanceof AdminApiError && e.code === 'shop_not_ready' && Array.isArray(e.details)) {
    return `Магазин не готов к передаче: ${(e.details as HandoverProblem[]).map((p) => HANDOVER_PROBLEMS[p] ?? p).join(' ')}`;
  }
  return (e instanceof AdminApiError && ERRORS[e.code]) || 'Не удалось передать магазин. Повторите попытку.';
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

        {result ? (
          <div className="space-y-3 text-sm" data-testid="handover-result">
            <Alert>
              <AlertDescription>
                Магазин передан: владелец <b>{result.handover.owner.email}</b>, режим <b>live</b>, DEMO выключен.
              </AlertDescription>
            </Alert>
            {result.invitation.status === 'sent' && (
              <p data-testid="handover-invitation">
                Письмо-приглашение отправлено на {result.handover.owner.email}. По ссылке из письма клиент задаст пароль и войдёт в
                свою админку.
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
                Нет учётной записи — придёт приглашение установить пароль. Есть — клиент войдёт со своим паролем.
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
