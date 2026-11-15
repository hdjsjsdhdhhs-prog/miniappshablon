import { ImageIcon, PaperPlaneTiltIcon, TrashIcon, UploadSimpleIcon, UsersThreeIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ErrorState, PageSpinner } from '@/components/state-views';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { insertAtCaret, isEmojiIdInput, renderWelcome, richPlainText, SHOP_NAME_PLACEHOLDER } from '@/domain/bot-welcome';
import { queryKeys } from '@/domain/query-keys';
import { publicImageUrl } from '@/lib/supabase';
import { useAdminShop } from '../admin-context';
import { ButtonEmojiField, PremiumEmojiHint, PremiumEmojiInsert } from '../components/PremiumEmoji';
import { TelegramPreview } from '../components/TelegramPreview';
import { AdminApiError, botErrorText, broadcastApi, type Broadcast, type BroadcastDraft, type BroadcastView, type BroadcastWorkerState } from '../functions-api';
import { ImageValidationError, prepareImage, removeBroadcastPhoto, uploadBroadcastPhoto } from '../media';

type Notice = { ok: boolean; text: string } | null;

const DEFAULT_BUTTON_TEXT = 'Открыть магазин';
/** A broadcast older than this can no longer be retried (same rule as the server). */
const RETRY_WINDOW_MS = 48 * 60 * 60 * 1000;

const STATUS_LABELS: Record<Broadcast['status'], string> = { sending: 'Отправляется', completed: 'Завершена', cancelled: 'Остановлена' };
const END_REASONS: Record<string, string> = {
  bot_changed: 'Бот магазина был заменён или отключён — рассылка остановлена.',
  telegram_unauthorized: 'Telegram не принял токен бота (он отозван в @BotFather) — рассылка остановлена. Переподключите бота.',
};

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
const done = (b: Broadcast) => b.counts.sent + b.counts.failed + b.counts.blocked + b.counts.cancelled;

function Counts({ b }: { b: Broadcast }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm" data-testid="broadcast-counts">
      <div className="flex gap-1.5">
        <dt className="text-muted-foreground">Доставлено</dt>
        <dd className="font-medium tabular-nums text-emerald-400" data-testid="broadcast-count-sent">
          {b.counts.sent}
        </dd>
      </div>
      {b.counts.pending > 0 && (
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">В очереди</dt>
          <dd className="tabular-nums" data-testid="broadcast-count-pending">
            {b.counts.pending}
          </dd>
        </div>
      )}
      {b.counts.blocked > 0 && (
        <div className="flex gap-1.5" title="Пользователь заблокировал бота или удалил аккаунт. Больше сообщения ему не отправляются.">
          <dt className="text-muted-foreground">Заблокировали бота</dt>
          <dd className="tabular-nums" data-testid="broadcast-count-blocked">
            {b.counts.blocked}
          </dd>
        </div>
      )}
      {b.counts.failed > 0 && (
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Не доставлено</dt>
          <dd className="tabular-nums text-destructive" data-testid="broadcast-count-failed">
            {b.counts.failed}
          </dd>
        </div>
      )}
      {b.counts.cancelled > 0 && (
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Не отправлено</dt>
          <dd className="tabular-nums" data-testid="broadcast-count-cancelled">
            {b.counts.cancelled}
          </dd>
        </div>
      )}
    </dl>
  );
}

function ProgressCard({ b, worker, onCancel, cancelling }: { b: Broadcast; worker: BroadcastWorkerState | null; onCancel: () => void; cancelling: boolean }) {
  const percent = b.total > 0 ? Math.min(100, Math.round((done(b) / b.total) * 100)) : 0;
  const resumeAt = b.resume_at ? new Date(b.resume_at) : null;
  return (
    <Card data-testid="broadcast-progress">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
        <PaperPlaneTiltIcon aria-hidden weight="fill" className="size-5 text-[#2aabee]" />
        <CardTitle className="text-base">Рассылка отправляется</CardTitle>
        <span className="ml-auto text-sm tabular-nums text-muted-foreground" data-testid="broadcast-progress-total">
          {done(b)} из {b.total}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        <div
          role="progressbar"
          aria-label="Ход рассылки"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        <Counts b={b} />
        {resumeAt ? (
          <p className="text-sm text-muted-foreground" data-testid="broadcast-paused">
            Telegram попросил сделать паузу до {resumeAt.toLocaleTimeString('ru-RU')}. Отправка продолжится автоматически.
          </p>
        ) : worker === 'waiting' ? (
          <p className="text-sm text-muted-foreground" data-testid="broadcast-waiting">
            Часть сообщений не ушла с первого раза — повторим отправку через несколько секунд.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Не закрывайте эту страницу, пока идёт отправка: если закрыть, рассылка продолжится, когда вы откроете её снова.</p>
        )}
        <Button type="button" variant="outline" size="sm" disabled={cancelling} onClick={onCancel} data-testid="broadcast-cancel">
          {cancelling ? 'Останавливаем…' : 'Остановить рассылку'}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * «Рассылка»: a message to the users who started the shop's own Telegram bot. The browser only composes the message;
 * the recipients are chosen and the messages are sent by the server (bot-connection → broadcast-*), through the bot
 * connected in «Подключение бота». While a broadcast is running the page keeps calling the worker step and shows the
 * progress it returns.
 */
export function BroadcastPage() {
  const shop = useAdminShop();
  const qc = useQueryClient();
  const key = queryKeys.adminBroadcast(shop.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => broadcastApi.get(shop.id),
    retry: (count, err) => !(err instanceof AdminApiError && err.status < 500) && count < 2,
  });

  const [text, setText] = useState('');
  const [photoPath, setPhotoPath] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [withButton, setWithButton] = useState(true);
  const [buttonText, setButtonText] = useState(DEFAULT_BUTTON_TEXT);
  const [buttonEmoji, setButtonEmoji] = useState('');
  const [notice, setNotice] = useState<Notice>(null);
  const [confirming, setConfirming] = useState(false);
  const [worker, setWorker] = useState<BroadcastWorkerState | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // One idempotency key per composed message: a repeated "send" of the same content never starts a second broadcast.
  const sendKey = useRef<{ fingerprint: string; key: string } | null>(null);

  const update = (next: BroadcastView) => qc.setQueryData(key, { overview: next.overview, storefront_url: next.storefront_url, limits: next.limits });

  const activeId = query.data?.overview.active?.id ?? null;
  // The worker: one step after another while the broadcast is running. Stops with the page; the next visit resumes.
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    void (async () => {
      while (!stopped) {
        try {
          const next = await broadcastApi.run(shop.id);
          if (stopped) return;
          qc.setQueryData(key, { overview: next.overview, storefront_url: next.storefront_url, limits: next.limits });
          setWorker(next.worker.state);
          if (!next.overview.active) return;
          await sleep(next.worker.state === 'send' ? 300 : 2000);
        } catch {
          await sleep(3000);
        }
      }
    })();
    return () => {
      stopped = true;
    };
    // `key` is derived from shop.id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, shop.id, qc]);

  const start = useMutation({
    mutationFn: (draft: BroadcastDraft) => broadcastApi.start(shop.id, draft),
    onSuccess: (next) => {
      update(next);
      setConfirming(false);
      setWorker(null);
      sendKey.current = null;
      setText('');
      setPhotoPath(null);
      setNotice({ ok: true, text: 'Рассылка запущена. Ход отправки показан ниже.' });
    },
    onError: (e) => {
      setConfirming(false);
      setNotice({ ok: false, text: botErrorText(e) });
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => broadcastApi.cancel(shop.id, id),
    onSuccess: (next) => {
      update(next);
      setNotice({ ok: true, text: 'Рассылка остановлена. Уже отправленные сообщения остаются у получателей.' });
    },
    onError: (e) => setNotice({ ok: false, text: botErrorText(e) }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => broadcastApi.retry(shop.id, id),
    onSuccess: (next) => {
      update(next);
      setWorker(null);
      setNotice(next.retried > 0 ? { ok: true, text: `Повторяем отправку: ${next.retried}.` } : { ok: true, text: 'Повторять нечего: недоставленных сообщений нет.' });
    },
    onError: (e) => setNotice({ ok: false, text: botErrorText(e) }),
  });

  if (query.isPending) return <PageSpinner />;
  if (query.isError) {
    if (query.error instanceof AdminApiError && query.error.code === 'forbidden') {
      return (
        <Alert>
          <AlertDescription>Рассылка доступна только владельцу магазина.</AlertDescription>
        </Alert>
      );
    }
    return <ErrorState onRetry={() => void query.refetch()} />;
  }

  const { overview, limits, storefront_url: storefront } = query.data;
  // "Now" for the retry window: the moment this data arrived (kept pure for render; the server decides anyway).
  const fetchedAt = query.dataUpdatedAt;
  const active = overview.active;
  const audience = overview.audience;
  const rendered = renderWelcome(text, overview.shop.name);
  const sentLength = richPlainText(rendered).length;
  const maxLength = photoPath ? limits.caption : limits.text;
  const tooLong = sentLength > maxLength;
  const buttonInvalid = withButton && (!buttonText.trim() || buttonText.trim().length > limits.button || !isEmojiIdInput(buttonEmoji));
  const noStorefront = withButton && !storefront;
  const canSend = !!overview.bot && !active && audience.active > 0 && text.trim() !== '' && !tooLong && !buttonInvalid && !noStorefront && !uploading;

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setNotice(null);
    try {
      const path = await uploadBroadcastPhoto(shop.id, await prepareImage(file, 'broadcast'));
      const previous = photoPath;
      setPhotoPath(path);
      void removeBroadcastPhoto(shop.id, previous);
    } catch (e) {
      toast.error(e instanceof ImageValidationError || e instanceof Error ? e.message : 'Не удалось загрузить фотографию');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const send = () => {
    const draft = {
      text,
      photoPath,
      button: withButton ? { text: buttonText.trim(), emojiId: buttonEmoji.trim() || null } : null,
    };
    const fingerprint = JSON.stringify(draft);
    if (sendKey.current?.fingerprint !== fingerprint) sendKey.current = { fingerprint, key: crypto.randomUUID() };
    setNotice(null);
    start.mutate({ idempotencyKey: sendKey.current.key, ...draft });
  };

  return (
    <div className="space-y-6" data-testid="broadcast-page">
      {!overview.bot ? (
        <Alert data-testid="broadcast-no-bot">
          <WarningCircleIcon aria-hidden />
          <AlertTitle>Сначала подключите бота</AlertTitle>
          <AlertDescription>
            <p>Рассылка отправляется от имени Telegram-бота вашего магазина тем, кто его запустил.</p>
            <Button asChild size="sm" variant="outline" className="mt-1">
              <Link to="../bot">Перейти к подключению бота</Link>
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
            <UsersThreeIcon aria-hidden className="size-5" />
            <CardTitle className="text-base">Получатели</CardTitle>
            <span className="ml-auto text-sm text-muted-foreground">
              бот{' '}
              <a className="underline underline-offset-2" href={`https://t.me/${overview.bot.bot_username}`} target="_blank" rel="noreferrer">
                @{overview.bot.bot_username}
              </a>
            </span>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              Сообщение получат: <span className="text-base font-semibold tabular-nums" data-testid="broadcast-audience">{audience.active}</span>
              {(audience.unsubscribed > 0 || audience.blocked > 0) && (
                <span className="text-muted-foreground" data-testid="broadcast-audience-rest">
                  {' '}
                  · отписались: {audience.unsubscribed} · заблокировали бота: {audience.blocked}
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              Рассылка уходит только тем, кто сам запустил вашего бота (нажал «Start»). Написать остальным Telegram не позволяет. Получатель может
              отписаться командой /stop и вернуться командой /start.
            </p>
          </CardContent>
        </Card>
      )}

      {active && <ProgressCard b={active} worker={worker} cancelling={cancel.isPending} onCancel={() => cancel.mutate(active.id)} />}

      {notice && (
        <Alert variant={notice.ok ? 'default' : 'destructive'} data-testid="broadcast-notice">
          <AlertDescription>{notice.text}</AlertDescription>
        </Alert>
      )}

      {overview.bot && (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Сообщение</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="broadcast-text">Текст сообщения</Label>
                  <Textarea
                    id="broadcast-text"
                    ref={textRef}
                    rows={7}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    aria-invalid={tooLong}
                    placeholder="Например: новые поступления уже в каталоге 🔥"
                    data-testid="broadcast-text"
                  />
                  <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                    <span>
                      <span className="font-mono">{SHOP_NAME_PLACEHOLDER}</span> заменится на «{overview.shop.name}». Текст отправляется как есть, без оформления.
                    </span>
                    <span className={tooLong ? 'text-destructive' : undefined} data-testid="broadcast-counter">
                      {sentLength} / {maxLength}
                    </span>
                  </div>
                  {tooLong && (
                    <p className="text-xs text-destructive" data-testid="broadcast-too-long">
                      {photoPath ? 'С фотографией Telegram принимает подпись до 1024 символов. Сократите текст или уберите фото.' : 'Telegram принимает сообщения до 4096 символов.'}
                    </p>
                  )}
                </div>
                <PremiumEmojiInsert idPrefix="broadcast" onInsert={(tag) => setText((v) => insertAtCaret(textRef.current, v, tag))} />
                <PremiumEmojiHint where="broadcast" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Фотография</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                    {photoPath ? (
                      <img src={publicImageUrl(photoPath) ?? undefined} alt="Фотография рассылки" className="size-full object-cover" />
                    ) : (
                      <ImageIcon aria-hidden className="size-6 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="sr-only"
                      aria-label="Фотография рассылки: выбрать файл"
                      onChange={(e) => void pickPhoto(e.target.files?.[0])}
                      data-testid="broadcast-photo-input"
                    />
                    <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                      <UploadSimpleIcon aria-hidden /> {uploading ? 'Загрузка…' : photoPath ? 'Заменить' : 'Прикрепить фото'}
                    </Button>
                    {photoPath && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={uploading}
                        onClick={() => {
                          void removeBroadcastPhoto(shop.id, photoPath);
                          setPhotoPath(null);
                        }}
                        data-testid="broadcast-photo-remove"
                      >
                        <TrashIcon aria-hidden /> Убрать
                      </Button>
                    )}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">Необязательно. Одна фотография над текстом; с фотографией текст — до 1024 символов.</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <CardTitle className="text-base">Кнопка перехода в Mini App</CardTitle>
                <Switch
                  className="ml-auto"
                  checked={withButton}
                  onCheckedChange={setWithButton}
                  aria-label="Добавить кнопку перехода в Mini App"
                  data-testid="broadcast-button-toggle"
                />
              </CardHeader>
              {withButton && (
                <CardContent className="space-y-1.5">
                  <Label htmlFor="broadcast-button-text">Текст кнопки</Label>
                  <Input
                    id="broadcast-button-text"
                    maxLength={limits.button}
                    value={buttonText}
                    onChange={(e) => setButtonText(e.target.value)}
                    aria-invalid={!buttonText.trim()}
                    data-testid="broadcast-button-text"
                  />
                  <p className="text-xs text-muted-foreground">
                    Кнопка под сообщением открывает ваш магазин прямо в Telegram. Обычный эмодзи можно написать в тексте кнопки.
                  </p>
                  <ButtonEmojiField id="broadcast-button-emoji" value={buttonEmoji} onChange={setButtonEmoji} testId="broadcast-button-emoji" />
                  {noStorefront && (
                    <p className="text-xs text-destructive" data-testid="broadcast-no-storefront">
                      {botErrorText('public_url_not_configured')}
                    </p>
                  )}
                </CardContent>
              )}
            </Card>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={!canSend || start.isPending} onClick={() => setConfirming(true)} data-testid="broadcast-send">
                <PaperPlaneTiltIcon aria-hidden /> Отправить рассылку
              </Button>
              {active ? (
                <span className="text-sm text-muted-foreground">Новую рассылку можно запустить после завершения текущей.</span>
              ) : audience.active === 0 ? (
                <span className="text-sm text-muted-foreground" data-testid="broadcast-empty-audience">
                  Пока некому отправлять: вашего бота ещё никто не запустил.
                </span>
              ) : null}
            </div>
          </div>

          <aside className="space-y-3 text-sm lg:sticky lg:top-4 lg:self-start">
            <p className="font-medium">Предпросмотр</p>
            <TelegramPreview
              testId="broadcast-preview"
              text={rendered}
              photoUrl={publicImageUrl(photoPath)}
              buttons={withButton ? [{ text: buttonText, emojiId: isEmojiIdInput(buttonEmoji) ? buttonEmoji.trim() || null : null }] : []}
            />
            <p className="text-xs text-muted-foreground">Так сообщение увидит получатель в чате с ботом.</p>
          </aside>
        </div>
      )}

      {overview.history.some((b) => b.status !== 'sending') && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Последние рассылки</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y" data-testid="broadcast-history">
              {overview.history
                .filter((b) => b.status !== 'sending')
                .map((b) => {
                  const retryable = b.counts.failed > 0 && fetchedAt - new Date(b.created_at).getTime() < RETRY_WINDOW_MS;
                  return (
                    <li key={b.id} className="space-y-2 py-3 first:pt-0 last:pb-0" data-testid="broadcast-history-item">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={b.status === 'cancelled' ? 'outline' : 'secondary'}>{STATUS_LABELS[b.status]}</Badge>
                        <span className="text-sm text-muted-foreground">{new Date(b.created_at).toLocaleString('ru-RU')}</span>
                        <span className="text-sm text-muted-foreground">· получателей: {b.total}</span>
                        {b.photo_path && <span className="text-sm text-muted-foreground">· с фото</span>}
                      </div>
                      <p className="line-clamp-2 text-sm break-words">{richPlainText(renderWelcome(b.message_text, overview.shop.name))}</p>
                      <Counts b={b} />
                      {b.last_error && END_REASONS[b.last_error] && <p className="text-xs text-destructive">{END_REASONS[b.last_error]}</p>}
                      {retryable && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!!active || retry.isPending}
                          onClick={() => retry.mutate(b.id)}
                          data-testid="broadcast-retry"
                        >
                          Повторить неудачные ({b.counts.failed})
                        </Button>
                      )}
                    </li>
                  );
                })}
            </ul>
          </CardContent>
        </Card>
      )}

      <Dialog open={confirming} onOpenChange={(v) => !start.isPending && setConfirming(v)}>
        <DialogContent data-testid="broadcast-confirm">
          <DialogHeader>
            <DialogTitle>Отправить рассылку?</DialogTitle>
            <DialogDescription>
              Сообщение получат {audience.active} пользователей бота @{overview.bot?.bot_username}. Отозвать уже отправленные сообщения нельзя.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={start.isPending} onClick={() => setConfirming(false)}>
              Отмена
            </Button>
            <Button disabled={start.isPending} onClick={send} data-testid="broadcast-confirm-ok">
              {start.isPending ? 'Запускаем…' : 'Отправить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
