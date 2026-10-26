import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AdminApiError, platformApi, type PlatformShop, type PlatformUser, type TransferResult } from '../functions-api';

const ERRORS: Record<string, string> = {
  forbidden: 'Передавать магазины может только администратор платформы.',
  user_not_found: 'Учётная запись не найдена.',
  shop_not_found: 'Магазин не найден.',
  transfer_verification_failed: 'Проверка членства не прошла — передача отменена, изменений нет.',
  invalid_body: 'Проверьте email.',
  auth_required: 'Сессия истекла. Войдите снова.',
};
const errorText = (e: unknown) => (e instanceof AdminApiError && ERRORS[e.code]) || 'Не удалось выполнить действие. Повторите попытку.';

/**
 * Safe hand-over: 1) find an EXISTING account by email (new accounts are created with the existing
 * `pnpm owner:add` flow), 2) review who gains and who loses access, 3) transfer — the server makes the account
 * the only owner, verifies the membership in the same transaction and journals the transfer. Catalog, images,
 * stock and orders are not touched.
 */
export function TransferShopDialog({ shop, open, onOpenChange }: { shop: PlatformShop; open: boolean; onOpenChange: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [user, setUser] = useState<PlatformUser | null | undefined>(undefined);
  const [result, setResult] = useState<TransferResult | null>(null);

  const find = useMutation({
    mutationFn: () => platformApi.findUser(email.trim()),
    onSuccess: (u) => setUser(u),
  });
  const transfer = useMutation({
    mutationFn: () => platformApi.transfer(shop.id, user!.user_id),
    onSuccess: async (r) => {
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  const reset = (next: boolean) => {
    if (!next) {
      setEmail('');
      setUser(undefined);
      setResult(null);
      find.reset();
      transfer.reset();
    }
    onOpenChange(next);
  };

  const losing = user ? shop.members.filter((m) => m.user_id !== user.user_id) : [];

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogContent data-testid="transfer-dialog">
        <DialogHeader>
          <DialogTitle>Передать «{shop.name}»</DialogTitle>
          <DialogDescription>
            Новый владелец получит полный доступ к магазину. Товары, фото, варианты, остатки и заказы сохраняются.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3 text-sm" data-testid="transfer-result">
            <Alert>
              <AlertDescription>
                Магазин передан. Владелец: <b>{result.owner.email}</b>. Членство проверено: это единственный участник с ролью
                «Владелец».
              </AlertDescription>
            </Alert>
            {result.removed.length > 0 && (
              <p className="text-muted-foreground">Доступ снят: {result.removed.map((m) => m.email ?? m.user_id).join(', ')}</p>
            )}
            <p className="text-muted-foreground">Магазин остаётся в разделе «Все магазины платформы».</p>
          </div>
        ) : (
          <div className="space-y-4">
            <form
              className="space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                setUser(undefined);
                if (email.trim()) find.mutate();
              }}
            >
              <Label htmlFor="transfer-email">Email учётной записи нового владельца</Label>
              <div className="flex gap-2">
                <Input
                  id="transfer-email"
                  type="email"
                  autoComplete="off"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setUser(undefined);
                  }}
                  placeholder="client@example.com"
                />
                <Button type="submit" variant="outline" disabled={!email.trim() || find.isPending}>
                  {find.isPending ? 'Ищем…' : 'Найти'}
                </Button>
              </div>
            </form>

            {find.isError && (
              <Alert variant="destructive">
                <AlertDescription>{errorText(find.error)}</AlertDescription>
              </Alert>
            )}

            {user === null && (
              <Alert data-testid="transfer-user-missing">
                <AlertDescription>
                  Учётной записи с таким email нет. Создайте её существующим способом — командой оператора{' '}
                  <code className="font-mono text-xs break-all">
                    pnpm owner:add --slug {shop.slug} --email {email.trim()}
                  </code>{' '}
                  (временный пароль передайте клиенту защищённым каналом) — и повторите поиск.
                </AlertDescription>
              </Alert>
            )}

            {user && (
              <div className="space-y-2 rounded-lg border p-3 text-sm" data-testid="transfer-review">
                <p>
                  Новый владелец: <b>{user.email}</b>
                  {user.is_platform_admin && ' (администратор платформы)'}
                </p>
                {user.shops.length > 0 && (
                  <p className="text-muted-foreground">Уже управляет: {user.shops.map((s) => s.name).join(', ')}</p>
                )}
                <p className="text-muted-foreground">
                  {losing.length > 0
                    ? `Потеряют доступ: ${losing.map((m) => m.email ?? m.user_id).join(', ')}`
                    : 'Других участников у магазина нет.'}
                </p>
              </div>
            )}

            {transfer.isError && (
              <Alert variant="destructive">
                <AlertDescription>{errorText(transfer.error)}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <Button onClick={() => reset(false)}>Готово</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => reset(false)}>
                Отмена
              </Button>
              <Button disabled={!user || transfer.isPending} onClick={() => transfer.mutate()} data-testid="transfer-confirm">
                {transfer.isPending ? 'Передаём…' : 'Передать магазин'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
