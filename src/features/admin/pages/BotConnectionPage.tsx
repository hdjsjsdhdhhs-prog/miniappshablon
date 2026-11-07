import { ArrowSquareOutIcon, EyeIcon, EyeSlashIcon, RobotIcon, TelegramLogoIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { BUTTON_TEXT_MAX, normalizeManagerUrl, renderWelcome, SHOP_NAME_PLACEHOLDER, WELCOME_TEXT_MAX } from '@/domain/bot-welcome';
import { queryKeys } from '@/domain/query-keys';
import { useAdminShop } from '../admin-context';
import { CopyLinkButton } from '../components/CopyLinkButton';
import { AdminApiError, botApi, botErrorText, type BotView, type BotWelcome } from '../functions-api';

const BOTFATHER_URL = 'https://t.me/BotFather';

type Notice = { ok: boolean; text: string } | null;

function StatusBadge({ view }: { view: BotView }) {
  const c = view.settings.connection;
  if (!c) return <Badge variant="secondary">Бот не подключён</Badge>;
  if (c.status === 'error') return <Badge variant="destructive">Ошибка подключения</Badge>;
  return <Badge className="bg-emerald-600 text-white">Бот подключён</Badge>;
}

function Step({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>
        {n}
      </span>
      <div className="min-w-0 space-y-1.5 pt-0.5">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  );
}

/** Token form of steps 3–4 (first connection and «Переподключить бота»). The token lives only in this state. */
function ConnectForm({
  pending,
  submitLabel,
  onSubmit,
}: {
  pending: boolean;
  submitLabel: string;
  onSubmit: (token: string, reset: () => void) => void;
}) {
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim())
          onSubmit(token.trim(), () => {
            setToken('');
            setVisible(false);
          });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="bot-token">Токен Telegram-бота</Label>
        <div className="flex gap-2">
          <Input
            id="bot-token"
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder="123456789:AA..."
            value={token}
            maxLength={100}
            onChange={(e) => setToken(e.target.value)}
            data-testid="bot-token"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={visible ? 'Скрыть токен' : 'Показать токен'}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            data-testid="bot-token-toggle"
          >
            {visible ? <EyeSlashIcon aria-hidden /> : <EyeIcon aria-hidden />}
          </Button>
        </div>
      </div>
      <Button type="submit" disabled={!token.trim() || pending} data-testid="bot-connect">
        {pending ? 'Проверяем токен и подключаем бота…' : submitLabel}
      </Button>
    </form>
  );
}

/** Telegram-like preview of the welcome message and its inline keyboard. */
function TelegramPreview({ text, openText, managerText, managerOk }: { text: string; openText: string; managerText: string; managerOk: boolean }) {
  return (
    <div className="rounded-xl bg-[#0e1621] p-3" data-testid="bot-preview">
      <div className="max-w-[300px] space-y-1">
        <div className="rounded-2xl rounded-bl-sm bg-[#182533] px-3 py-2 text-sm whitespace-pre-wrap break-words text-white" data-testid="bot-preview-text">
          {text || ' '}
        </div>
        <div className="grid gap-1">
          <div className="flex items-center justify-center gap-1 rounded-lg bg-[#2b5278]/70 px-3 py-2 text-center text-sm text-white" data-testid="bot-preview-button-1">
            {openText || '—'}
          </div>
          <div
            className={`flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-center text-sm text-white ${managerOk ? 'bg-[#2b5278]/70' : 'bg-[#2b5278]/30 opacity-60'}`}
            data-testid="bot-preview-button-2"
          >
            {managerText || '—'} <ArrowSquareOutIcon aria-hidden className="size-3" />
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeEditor({ view, onSaved }: { view: BotView; onSaved: (next: BotView) => void }) {
  const shopName = view.settings.shop.name;
  const w = view.settings.welcome;
  const [draft, setDraft] = useState<Pick<BotWelcome, 'welcome_text' | 'open_button_text' | 'manager_button_text'> & { manager_url: string }>({
    welcome_text: w.welcome_text,
    open_button_text: w.open_button_text,
    manager_button_text: w.manager_button_text,
    manager_url: w.manager_url ?? '',
  });
  const [notice, setNotice] = useState<Notice>(null);

  const rendered = renderWelcome(draft.welcome_text, shopName);
  const managerNormalized = normalizeManagerUrl(draft.manager_url);
  const managerInvalid = draft.manager_url.trim() !== '' && !managerNormalized;
  const tooLong = rendered.length > WELCOME_TEXT_MAX;
  const invalid = !draft.welcome_text.trim() || tooLong || !draft.open_button_text.trim() || !draft.manager_button_text.trim() || managerInvalid;

  const save = useMutation({
    mutationFn: () =>
      botApi.saveWelcome(view.settings.shop.id, {
        welcomeText: draft.welcome_text,
        openButtonText: draft.open_button_text,
        managerButtonText: draft.manager_button_text,
        managerUrl: draft.manager_url,
      }),
    onSuccess: (next) => {
      onSaved(next);
      // Show what the server stored (normalised manager link, trimmed button texts).
      const saved = next.settings.welcome;
      setDraft({
        welcome_text: saved.welcome_text,
        open_button_text: saved.open_button_text,
        manager_button_text: saved.manager_button_text,
        manager_url: saved.manager_url ?? '',
      });
      setNotice({ ok: true, text: 'Сохранено. Новые обращения /start получат обновлённое приветствие.' });
    },
    onError: (e) => setNotice({ ok: false, text: botErrorText(e) }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    if (!invalid) save.mutate();
  };
  const set = (k: keyof typeof draft) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Приветственное сообщение</CardTitle>
            <p className="text-sm text-muted-foreground">
              Это сообщение автоматически отправляется пользователю, когда он открывает чат с ботом и нажимает /start.
            </p>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="bot-welcome">Текст приветствия</Label>
                <Textarea
                  id="bot-welcome"
                  rows={7}
                  value={draft.welcome_text}
                  onChange={set('welcome_text')}
                  aria-invalid={tooLong || !draft.welcome_text.trim()}
                  data-testid="bot-welcome-text"
                />
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    <span className="font-mono">{SHOP_NAME_PLACEHOLDER}</span> заменится на «{shopName}». Можно использовать переносы строк и эмодзи.
                  </span>
                  <span className={tooLong ? 'text-destructive' : undefined} data-testid="bot-welcome-counter">
                    {rendered.length} / {WELCOME_TEXT_MAX}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">Telegram принимает сообщения длиной до 4096 символов. Текст отправляется как есть, без оформления.</p>
              </div>
              <Button type="submit" disabled={invalid || save.isPending} data-testid="bot-welcome-save">
                {save.isPending ? 'Сохраняем…' : 'Сохранить сообщение'}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Кнопки приветственного сообщения</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-5" onSubmit={submit}>
              <fieldset className="space-y-1.5">
                <legend className="mb-1.5 text-sm font-medium">Кнопка 1 — открытие приложения</legend>
                <Label htmlFor="bot-open-text">Текст кнопки</Label>
                <Input id="bot-open-text" maxLength={BUTTON_TEXT_MAX} value={draft.open_button_text} onChange={set('open_button_text')} data-testid="bot-open-text" />
                <p className="text-xs text-muted-foreground">Ссылка автоматически ведёт на вашу Mini App.</p>
              </fieldset>
              <fieldset className="space-y-1.5">
                <legend className="mb-1.5 text-sm font-medium">Кнопка 2 — связь с менеджером</legend>
                <Label htmlFor="bot-manager-text">Текст кнопки</Label>
                <Input id="bot-manager-text" maxLength={BUTTON_TEXT_MAX} value={draft.manager_button_text} onChange={set('manager_button_text')} data-testid="bot-manager-text" />
                <Label htmlFor="bot-manager-url" className="pt-2">
                  Telegram менеджера
                </Label>
                <Input
                  id="bot-manager-url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://t.me/username"
                  maxLength={200}
                  value={draft.manager_url}
                  onChange={set('manager_url')}
                  aria-invalid={managerInvalid}
                  data-testid="bot-manager-url"
                />
                {managerInvalid ? (
                  <p className="text-xs text-destructive" data-testid="bot-manager-url-error">
                    {botErrorText('invalid_manager_url')}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Можно ввести @username — ссылка будет сохранена как https://t.me/username.</p>
                )}
              </fieldset>
              {!w.manager_url && (
                <Alert data-testid="bot-manager-missing">
                  <WarningCircleIcon aria-hidden />
                  <AlertTitle>Ссылка менеджера не заполнена</AlertTitle>
                  <AlertDescription>
                    Укажите Telegram менеджера, чтобы под приветствием появилась вторая кнопка. Пока ссылки нет, бот отправляет только кнопку открытия
                    приложения.
                  </AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={invalid || save.isPending} data-testid="bot-buttons-save">
                {save.isPending ? 'Сохраняем…' : 'Сохранить кнопки'}
              </Button>
            </form>
          </CardContent>
        </Card>
        {notice && (
          <Alert variant={notice.ok ? 'default' : 'destructive'} data-testid="bot-welcome-notice">
            <AlertDescription>{notice.text}</AlertDescription>
          </Alert>
        )}
      </div>

      <aside className="space-y-3 text-sm lg:sticky lg:top-4 lg:self-start">
        <p className="font-medium">Предпросмотр</p>
        <TelegramPreview text={rendered} openText={draft.open_button_text} managerText={draft.manager_button_text} managerOk={!!managerNormalized} />
        <p className="text-xs text-muted-foreground">Так покупатель увидит приветствие в чате с ботом после команды /start.</p>
      </aside>
    </div>
  );
}

/**
 * «Подключение бота». The owner's own bot (created in @BotFather) greets buyers on /start and opens the shop's Mini App.
 * The token is sent to the server once and kept in Supabase Vault; the page only receives a masked hint. Independent of
 * «Уведомления»: their bot and chat are neither read nor changed here.
 */
export function BotConnectionPage() {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const key = queryKeys.adminBot(shop.id);
  const bot = useQuery({
    queryKey: key,
    queryFn: () => botApi.get(shop.id),
    retry: (count, err) => !(err instanceof AdminApiError && err.status < 500) && count < 2,
  });
  const [notice, setNotice] = useState<Notice>(null);
  const [conflict, setConflict] = useState<{ token: string; host: string | null; reset: () => void } | null>(null);
  const [conflictConfirmed, setConflictConfirmed] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirm, setConfirm] = useState<null | 'disconnect' | { token: string; reset: () => void }>(null);

  const update = (next: BotView) => qc.setQueryData(key, { settings: next.settings, storefront_url: next.storefront_url });

  const connect = useMutation({
    mutationFn: (v: { token: string; confirmReplace: boolean; reset: () => void }) => botApi.connect(shop.id, v.token, v.confirmReplace),
    onSuccess: (next, v) => {
      v.reset();
      update(next);
      setConflict(null);
      setConflictConfirmed(false);
      setReplacing(false);
      const prev = next.previous;
      setNotice({
        ok: true,
        text: `Бот @${next.settings.connection?.bot_username} подключён. Кнопка меню и приветствие настроены.${prev ? ` Прежний бот @${prev.bot_username} отключён от магазина.` : ''}`,
      });
    },
    onError: (e, v) => {
      if (e instanceof AdminApiError && e.code === 'webhook_conflict') {
        setConflict({ token: v.token, host: (e.details as { host?: string | null } | null)?.host ?? null, reset: v.reset });
        setNotice(null);
        return;
      }
      setNotice({ ok: false, text: botErrorText(e) });
    },
  });
  const sync = useMutation({
    mutationFn: () => botApi.sync(shop.id),
    onSuccess: (next) => {
      update(next);
      setNotice(next.webhook_ok ? { ok: true, text: 'Подключение проверено: кнопка меню обновлена, бот получает сообщения.' } : { ok: false, text: botErrorText('webhook_replaced') });
    },
    onError: async (e) => {
      setNotice({ ok: false, text: botErrorText(e) });
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  const disconnect = useMutation({
    mutationFn: () => botApi.disconnect(shop.id),
    onSuccess: (next) => {
      update(next);
      setConfirm(null);
      setReplacing(false);
      setNotice({
        ok: true,
        text:
          next.cleanup.telegram === 'token_revoked'
            ? 'Бот отключён от магазина. Токен уже отозван в @BotFather, поэтому настройки в Telegram остались без изменений.'
            : 'Бот отключён от магазина. Настройки приветствия сохранены — они пригодятся при повторном подключении.',
      });
      toast.success('Бот отключён');
    },
    onError: (e) => {
      setConfirm(null);
      setNotice({ ok: false, text: botErrorText(e) });
    },
  });

  if (bot.isPending) return <PageSpinner />;
  if (bot.isError) {
    if (bot.error instanceof AdminApiError && bot.error.code === 'forbidden') {
      return (
        <Alert>
          <AlertDescription>{botErrorText(bot.error)}</AlertDescription>
        </Alert>
      );
    }
    return <ErrorState onRetry={() => void bot.refetch()} />;
  }
  const view = bot.data;
  const c = view.settings.connection;
  const busy = connect.isPending || sync.isPending || disconnect.isPending;
  const startConnect = (token: string, reset: () => void) => {
    setNotice(null);
    if (c) setConfirm({ token, reset });
    else connect.mutate({ token, confirmReplace: false, reset });
  };

  return (
    <div className="space-y-6" data-testid="bot-page">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
          <TelegramLogoIcon aria-hidden weight="fill" className="size-5 text-[#2aabee]" />
          <CardTitle className="text-base">{c ? 'Telegram-бот магазина' : 'Подключите Telegram-бота'}</CardTitle>
          <span className="ml-auto" data-testid="bot-status">
            <StatusBadge view={view} />
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          {!c && (
            <>
              <p className="text-sm text-muted-foreground">
                Подключите собственного бота Telegram, чтобы ваши покупатели могли открывать Mini App прямо из чата с ботом. После подключения мы
                автоматически настроим приветственное сообщение и кнопки для перехода в ваш магазин.
              </p>
              <ol className="space-y-4" data-testid="bot-steps">
                <Step n={1} title="Откройте официального бота @BotFather.">
                  <Button asChild variant="outline" size="sm">
                    <a href={BOTFATHER_URL} target="_blank" rel="noreferrer">
                      Открыть BotFather <ArrowSquareOutIcon aria-hidden />
                    </a>
                  </Button>
                </Step>
                <Step n={2} title="Создайте нового бота.">
                  <p className="text-sm text-muted-foreground">
                    Отправьте команду <span className="rounded bg-muted px-1 font-mono">/newbot</span> и следуйте инструкциям BotFather.
                  </p>
                </Step>
                <Step n={3} title="Скопируйте выданный BotFather API Token.">
                  <Alert>
                    <WarningCircleIcon aria-hidden />
                    <AlertDescription>Не передавайте токен посторонним. Он предоставляет полный доступ к управлению вашим ботом.</AlertDescription>
                  </Alert>
                </Step>
                <Step n={4} title="Вставьте токен в поле ниже и нажмите «Подключить бота».">
                  <ConnectForm pending={connect.isPending} submitLabel="Подключить бота" onSubmit={startConnect} />
                </Step>
              </ol>
            </>
          )}

          {c && (
            <>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                <dt className="text-muted-foreground">Бот</dt>
                <dd>
                  <a className="underline underline-offset-2" href={`https://t.me/${c.bot_username}`} target="_blank" rel="noreferrer" data-testid="bot-username">
                    @{c.bot_username}
                  </a>
                </dd>
                <dt className="text-muted-foreground">Токен</dt>
                <dd className="font-mono text-xs" data-testid="bot-token-hint">
                  {c.token_hint}
                </dd>
                <dt className="text-muted-foreground">Открывает</dt>
                <dd className="break-all" data-testid="bot-storefront-url">
                  {view.storefront_url ?? '—'}
                </dd>
                <dt className="text-muted-foreground">Подключён</dt>
                <dd>{new Date(c.connected_at).toLocaleString('ru-RU')}</dd>
              </dl>
              {c.status === 'error' && (
                <Alert variant="destructive" data-testid="bot-error">
                  <AlertDescription>{botErrorText(c.last_error)}</AlertDescription>
                </Alert>
              )}
              <p className="text-sm text-muted-foreground">
                Покупатель открывает магазин кнопкой «{view.settings.welcome.open_button_text}» под приветствием или кнопкой меню слева от поля ввода в чате с
                ботом.
              </p>
              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button type="button" variant="outline" disabled={busy} onClick={() => sync.mutate()} data-testid="bot-sync">
                  {sync.isPending ? 'Проверяем…' : 'Проверить подключение'}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setReplacing((v) => !v)} data-testid="bot-replace">
                  Переподключить бота
                </Button>
                <Button type="button" variant="ghost" className="ml-auto text-destructive" disabled={busy} onClick={() => setConfirm('disconnect')} data-testid="bot-disconnect">
                  Отключить бота
                </Button>
              </div>
              {replacing && (
                <div className="space-y-2 rounded-lg border p-4" data-testid="bot-replace-form">
                  <p className="text-sm text-muted-foreground">
                    Вставьте токен нового бота (или новый токен этого же бота). Текущий бот продолжит работать, пока новый не будет полностью подключён.
                    Приветствие и кнопки сохранятся.
                  </p>
                  <ConnectForm pending={connect.isPending} submitLabel="Подключить нового бота" onSubmit={startConnect} />
                </div>
              )}
            </>
          )}

          {conflict && (
            <Alert variant="destructive" data-testid="bot-webhook-conflict">
              <WarningCircleIcon aria-hidden />
              <AlertTitle>Бот уже подключён к другому сервису</AlertTitle>
              <AlertDescription>
                <p>
                  Сообщения этого бота сейчас получает другая интеграция{conflict.host ? ` (${conflict.host})` : ''}. Если подключить бота к магазину, она
                  перестанет получать сообщения.
                </p>
                <label className="flex items-center gap-2 pt-1 text-foreground">
                  <input type="checkbox" checked={conflictConfirmed} onChange={(e) => setConflictConfirmed(e.target.checked)} data-testid="bot-webhook-confirm" />
                  Я понимаю, что прежняя интеграция будет отключена
                </label>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!conflictConfirmed || connect.isPending}
                    onClick={() => connect.mutate({ token: conflict.token, confirmReplace: true, reset: conflict.reset })}
                    data-testid="bot-webhook-replace"
                  >
                    {connect.isPending ? 'Подключаем бота…' : 'Заменить и подключить'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setConflict(null);
                      setConflictConfirmed(false);
                    }}
                  >
                    Отмена
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {notice && (
            <Alert variant={notice.ok ? 'default' : 'destructive'} data-testid="bot-notice">
              <AlertDescription>{notice.text}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {c && (
        <>
          <WelcomeEditor view={view} onSaved={update} />
          <Card>
            <CardHeader className="flex flex-row items-center gap-2 space-y-0">
              <RobotIcon aria-hidden className="size-5" />
              <CardTitle className="text-base">Кнопка «Открыть» в профиле бота (по желанию)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Кнопку меню в чате и кнопку под приветствием мы уже настроили. Отдельную кнопку запуска приложения в профиле бота Telegram позволяет
                включить только в @BotFather:
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-muted-foreground" data-testid="bot-main-app-steps">
                <li>
                  Откройте @BotFather и отправьте команду <span className="font-mono">/mybots</span>.
                </li>
                <li>Выберите бота @{c.bot_username} → Bot Settings → Configure Mini App → Enable Mini App.</li>
                <li>Отправьте ссылку на ваш магазин:</li>
              </ol>
              {view.storefront_url && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-muted px-2 py-1 font-mono text-xs break-all">{view.storefront_url}</span>
                  <CopyLinkButton url={view.storefront_url} testId="bot-copy-storefront" />
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={confirm !== null} onOpenChange={(v) => !busy && !v && setConfirm(null)}>
        <DialogContent data-testid="bot-confirm">
          <DialogHeader>
            <DialogTitle>{confirm === 'disconnect' ? 'Отключить бота?' : 'Заменить бота?'}</DialogTitle>
            <DialogDescription>
              {confirm === 'disconnect'
                ? `Бот @${c?.bot_username ?? ''} перестанет отвечать на /start и открывать магазин. Настройки приветствия, уведомления и сам магазин не изменятся.`
                : `Сначала проверим новый токен. Бот @${c?.bot_username ?? ''} будет отключён только после успешного подключения нового.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Отмена
            </Button>
            <Button
              variant={confirm === 'disconnect' ? 'destructive' : 'default'}
              disabled={busy}
              data-testid="bot-confirm-ok"
              onClick={() => {
                if (confirm === 'disconnect') disconnect.mutate();
                else if (confirm) {
                  const { token, reset } = confirm;
                  setConfirm(null);
                  connect.mutate({ token, confirmReplace: false, reset });
                }
              }}
            >
              {confirm === 'disconnect' ? (disconnect.isPending ? 'Отключаем…' : 'Отключить бота') : 'Заменить бота'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
