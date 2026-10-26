import { TelegramLogoIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { queryKeys } from '@/domain/query-keys';
import { useAdminShop } from '../admin-context';
import { AdminApiError, notificationErrorText, notificationsApi, type NotificationSettings } from '../functions-api';

function StatusBadge({ s }: { s: NotificationSettings }) {
  if (!s.configured) return <Badge variant="secondary">Не настроено</Badge>;
  if (!s.enabled) return <Badge variant="secondary">Выключено</Badge>;
  if (s.status === 'ok') return <Badge className="bg-emerald-600 text-white">Подключено</Badge>;
  if (s.status === 'error') return <Badge variant="destructive">Ошибка</Badge>;
  return <Badge variant="outline">Не проверено</Badge>;
}

/**
 * «Уведомления в Telegram». The owner's own bot posts every new order into the owner's private group or
 * channel. The token is sent to the server once, verified against the Bot API and kept in Supabase Vault;
 * the page only ever receives a masked hint. Form fields are not persisted anywhere in the browser.
 */
export function NotificationsPage() {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const key = queryKeys.adminNotifications(shop.id);
  const settings = useQuery({
    queryKey: key,
    queryFn: () => notificationsApi.get(shop.id),
    retry: (count, err) => !(err instanceof AdminApiError && err.status < 500) && count < 2,
  });
  const [token, setToken] = useState('');
  const [chat, setChat] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const s = settings.data;
  const chatValue = chat ?? s?.chat_id ?? '';
  const update = (next: NotificationSettings | null | undefined) => {
    if (next) qc.setQueryData(key, next);
  };
  const fail = (e: unknown) => setNotice({ ok: false, text: notificationErrorText(e) });

  const save = useMutation({
    mutationFn: () => notificationsApi.save(shop.id, { botToken: token.trim() || undefined, chatId: chatValue.trim() }),
    onSuccess: (next) => {
      update(next);
      setToken('');
      setChat(null);
      setNotice(
        next.status === 'error'
          ? { ok: false, text: `Сохранено, но ${notificationErrorText(next.last_error).toLowerCase()}` }
          : { ok: true, text: 'Сохранено. Новые заказы будут приходить в Telegram.' },
      );
    },
    onError: fail,
  });
  const check = useMutation({
    // Unsaved token typed in → dry-run check of the typed values; otherwise the stored connection.
    mutationFn: () =>
      notificationsApi.check(shop.id, token.trim() ? { botToken: token.trim(), chatId: chatValue.trim() } : chat !== null ? { chatId: chatValue.trim() } : {}),
    onSuccess: (r) => {
      if (!token.trim() && chat === null) update(r.settings);
      setNotice({ ok: true, text: `Тестовое сообщение отправлено в «${r.chat.title ?? chatValue}»${r.bot.username ? ` ботом @${r.bot.username}` : ''}.` });
    },
    onError: async (e) => {
      fail(e);
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => notificationsApi.setEnabled(shop.id, enabled),
    onSuccess: (next) => {
      update(next);
      toast.success(next.enabled ? 'Уведомления включены' : 'Уведомления выключены');
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => notificationsApi.remove(shop.id),
    onSuccess: (next) => {
      update(next);
      setToken('');
      setChat(null);
      setNotice({ ok: true, text: 'Подключение удалено, токен стёрт из хранилища.' });
    },
    onError: fail,
  });
  const retry = useMutation({
    mutationFn: () => notificationsApi.retry(shop.id),
    onSuccess: (r) => {
      update(r.settings);
      setNotice(r.failed ? { ok: false, text: `Отправлено: ${r.sent}, не удалось: ${r.failed}.` } : { ok: true, text: `Отправлено уведомлений: ${r.sent}.` });
    },
    onError: fail,
  });

  if (settings.isPending) return <PageSpinner />;
  if (settings.isError) {
    if (settings.error instanceof AdminApiError && settings.error.code === 'forbidden') {
      return (
        <Alert>
          <AlertDescription>{notificationErrorText(settings.error)}</AlertDescription>
        </Alert>
      );
    }
    return <ErrorState onRetry={() => void settings.refetch()} />;
  }
  const busy = save.isPending || check.isPending || toggle.isPending || remove.isPending || retry.isPending;
  const canSave = !!chatValue.trim() && (s!.configured || !!token.trim());

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]" data-testid="notifications-page">
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
            <TelegramLogoIcon aria-hidden weight="fill" className="size-5 text-[#2aabee]" />
            <CardTitle className="text-base">Уведомления в Telegram</CardTitle>
            <span className="ml-auto" data-testid="notifications-status">
              <StatusBadge s={s!} />
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            {s!.configured && (
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Бот</dt>
                <dd>{s!.bot_username ? `@${s!.bot_username}` : '—'}</dd>
                <dt className="text-muted-foreground">Токен</dt>
                <dd className="font-mono text-xs" data-testid="notifications-token-hint">
                  {s!.token_hint}
                </dd>
                <dt className="text-muted-foreground">Получатель</dt>
                <dd>
                  {s!.chat_title ? `${s!.chat_title} · ` : ''}
                  <span className="font-mono text-xs">{s!.chat_id}</span>
                </dd>
                <dt className="text-muted-foreground">Проверено</dt>
                <dd>{s!.last_checked_at ? new Date(s!.last_checked_at).toLocaleString('ru-RU') : 'ещё нет'}</dd>
                <dt className="text-muted-foreground">Доставка</dt>
                <dd data-testid="notifications-queue">
                  отправлено {s!.queue.sent}
                  {s!.queue.pending > 0 && ` · в очереди ${s!.queue.pending}`}
                  {s!.queue.dead > 0 && ` · не доставлено ${s!.queue.dead}`}
                </dd>
              </dl>
            )}
            {s!.configured && s!.status === 'error' && s!.last_error && (
              <Alert variant="destructive">
                <AlertDescription>{notificationErrorText(s!.last_error)}</AlertDescription>
              </Alert>
            )}

            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                setNotice(null);
                if (canSave) save.mutate();
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="n-token">Токен бота</Label>
                <Input
                  id="n-token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="text"
                  placeholder={s!.configured ? 'Оставьте пустым, чтобы не менять токен' : '123456789:AA…'}
                  value={token}
                  maxLength={100}
                  onChange={(e) => setToken(e.target.value)}
                  data-testid="notifications-token"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="n-chat">Канал или группа</Label>
                <Input
                  id="n-chat"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="@channelusername или -1001234567890"
                  value={chatValue}
                  maxLength={100}
                  onChange={(e) => setChat(e.target.value)}
                  data-testid="notifications-chat"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!canSave || busy} data-testid="notifications-save">
                  {save.isPending ? 'Проверяем и сохраняем…' : s!.configured ? 'Сохранить изменения' : 'Сохранить'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || (!s!.configured && !(token.trim() && chatValue.trim()))}
                  onClick={() => {
                    setNotice(null);
                    check.mutate();
                  }}
                  data-testid="notifications-check"
                >
                  {check.isPending ? 'Отправляем тест…' : 'Проверить подключение'}
                </Button>
                {s!.configured && s!.queue.pending > 0 && (
                  <Button type="button" variant="outline" disabled={busy} onClick={() => retry.mutate()}>
                    Повторить неотправленные
                  </Button>
                )}
              </div>
            </form>

            {notice && (
              <Alert variant={notice.ok ? 'default' : 'destructive'} data-testid="notifications-notice">
                <AlertDescription>{notice.text}</AlertDescription>
              </Alert>
            )}

            {s!.configured && (
              <div className="flex flex-wrap items-center gap-4 border-t pt-4">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={s!.enabled}
                    disabled={busy}
                    onCheckedChange={(v) => toggle.mutate(v)}
                    aria-label="Отправлять уведомления о заказах"
                    data-testid="notifications-enabled"
                  />
                  Отправлять уведомления о заказах
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto text-destructive"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm('Удалить подключение? Токен будет стёрт из хранилища.')) remove.mutate();
                  }}
                  data-testid="notifications-delete"
                >
                  Отключить и удалить
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <aside className="space-y-3 text-sm lg:sticky lg:top-4 lg:self-start">
        <p className="font-medium">Как подключить</p>
        <ol className="list-decimal space-y-2 pl-5 text-muted-foreground">
          <li>
            Создайте отдельного бота в <span className="font-medium text-foreground">@BotFather</span> (команда /newbot) и скопируйте
            его токен.
          </li>
          <li>Создайте приватную группу или канал для заказов.</li>
          <li>
            Добавьте бота в группу или канал <span className="font-medium text-foreground">администратором с правом отправлять (публиковать) сообщения</span>.
          </li>
          <li>
            Укажите <span className="font-mono">@username</span> канала или числовой chat ID группы (вида{' '}
            <span className="font-mono">-100…</span>), сохраните и нажмите «Проверить подключение» — придёт тестовое сообщение.
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          Токен хранится на сервере в зашифрованном хранилище и больше не показывается — только его маска. Сбой Telegram не
          отменяет заказ: уведомление будет отправлено повторно.
        </p>
      </aside>
    </div>
  );
}
