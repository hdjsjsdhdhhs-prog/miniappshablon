// «Рассылка»: the browser composes the message and shows the progress; the recipients are chosen and the messages are
// sent by the server (supabase/functions/_shared/broadcast.test.ts, tests/integration/security/broadcast.test.ts).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShopContext } from '../admin-context';
import type { AdminShop } from '../api';
import type * as FunctionsApi from '../functions-api';
import type { Broadcast, BroadcastView } from '../functions-api';
import type * as Media from '../media';
import { BroadcastPage } from './BroadcastPage';

const api = vi.hoisted(() => ({ get: vi.fn(), start: vi.fn(), run: vi.fn(), cancel: vi.fn(), retry: vi.fn() }));
const media = vi.hoisted(() => ({ prepareImage: vi.fn(), uploadBroadcastPhoto: vi.fn(), removeBroadcastPhoto: vi.fn() }));

vi.mock('../functions-api', async (importOriginal) => ({ ...(await importOriginal<typeof FunctionsApi>()), broadcastApi: api }));
vi.mock('../media', async (importOriginal) => ({ ...(await importOriginal<typeof Media>()), ...media }));
vi.mock('@/lib/supabase', () => ({
  publicImageUrl: (path: string | null | undefined) => (path ? `https://cdn.test/${path}` : null),
  supabase: {},
  functionsUrl: (n: string) => n,
}));

const STORE = 'https://miniappdemo.pages.dev/s/noir-vapor/';
const PHOTO = 'shop-a/broadcast/3f2b8c1e-0000-4000-8000-000000000001.jpg';
const FIRE = '5368324170671202286';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const shop = { id: 'shop-a', slug: 'noir-vapor', name: 'Noir Vapor' } as AdminShop;

const counts = (over: Partial<Broadcast['counts']> = {}): Broadcast['counts'] => ({ pending: 0, sent: 12, failed: 0, blocked: 0, cancelled: 0, ...over });
const broadcast = (over: Partial<Broadcast> = {}): Broadcast => ({
  id: 'b-1',
  status: 'completed',
  message_text: 'Скидки сегодня!',
  photo_path: null,
  button_text: null,
  button_emoji_id: null,
  total: 12,
  counts: counts(),
  resume_at: null,
  last_error: null,
  created_at: new Date(Date.now() - 60_000).toISOString(),
  completed_at: new Date().toISOString(),
  ...over,
});
const view = (overview: Partial<BroadcastView['overview']> = {}, top: Partial<Omit<BroadcastView, 'overview'>> = {}): BroadcastView => ({
  overview: {
    shop: { id: 'shop-a', slug: 'noir-vapor', name: 'Noir Vapor' },
    bot: { bot_username: 'noir_shop_bot', status: 'connected' },
    audience: { active: 12, unsubscribed: 2, blocked: 1 },
    active: null,
    history: [],
    ...overview,
  },
  storefront_url: STORE,
  limits: { text: 4096, caption: 1024, button: 64 },
  ...top,
});
const sending = broadcast({ id: 'b-new', status: 'sending', counts: counts({ pending: 12, sent: 0 }), completed_at: null });

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminShopContext.Provider value={shop}>
        <MemoryRouter initialEntries={['/admin/shops/noir-vapor/broadcast']}>
          <Routes>
            <Route path="/admin/shops/:slug">
              <Route path="broadcast" element={<BroadcastPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AdminShopContext.Provider>
    </QueryClientProvider>,
  );
}

const setText = (value: string) => fireEvent.change(screen.getByTestId('broadcast-text'), { target: { value } });
/** «Отправить рассылку» and the confirmation. */
async function sendAndConfirm() {
  await userEvent.click(screen.getByTestId('broadcast-send'));
  await userEvent.click(await screen.findByTestId('broadcast-confirm-ok'));
}

beforeEach(() => {
  vi.resetAllMocks();
  // The worker step stays "in flight" unless a test answers it.
  api.run.mockImplementation(() => new Promise(() => undefined));
  media.removeBroadcastPhoto.mockResolvedValue(undefined);
});

describe('BroadcastPage', () => {
  it('without a connected bot it only points to «Подключение бота»', async () => {
    api.get.mockResolvedValue(view({ bot: null, audience: { active: 0, unsubscribed: 0, blocked: 0 } }));
    renderPage();
    const alert = await screen.findByTestId('broadcast-no-bot');
    expect(alert).toHaveTextContent('Сначала подключите бота');
    expect(within(alert).getByRole('link', { name: 'Перейти к подключению бота' })).toHaveAttribute('href', '/admin/shops/noir-vapor/bot');
    expect(screen.queryByTestId('broadcast-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('broadcast-send')).not.toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('shop-a');
  });

  it('is for the owner only', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockRejectedValue(new AdminApiError(403, 'forbidden', null));
    renderPage();
    expect(await screen.findByText('Рассылка доступна только владельцу магазина.')).toBeInTheDocument();
    expect(screen.queryByTestId('broadcast-text')).not.toBeInTheDocument();
  });

  it('shows who gets the message: the users who started the bot, without those who left or blocked it', async () => {
    api.get.mockResolvedValue(view());
    renderPage();
    expect(await screen.findByTestId('broadcast-audience')).toHaveTextContent('12');
    expect(screen.getByTestId('broadcast-audience-rest')).toHaveTextContent('отписались: 2 · заблокировали бота: 1');
    expect(screen.getByRole('link', { name: '@noir_shop_bot' })).toHaveAttribute('href', 'https://t.me/noir_shop_bot');
    expect(screen.getByText(/только тем, кто сам запустил вашего бота/)).toBeInTheDocument();
    // Nothing to send yet.
    expect(screen.getByTestId('broadcast-send')).toBeDisabled();
    expect(api.run).not.toHaveBeenCalled();
  });

  it('nobody started the bot yet: the message can be written but not sent', async () => {
    api.get.mockResolvedValue(view({ audience: { active: 0, unsubscribed: 0, blocked: 0 } }));
    renderPage();
    await screen.findByTestId('broadcast-text');
    setText('Скидки');
    expect(screen.getByTestId('broadcast-send')).toBeDisabled();
    expect(screen.getByTestId('broadcast-empty-audience')).toHaveTextContent('вашего бота ещё никто не запустил');
    expect(screen.queryByTestId('broadcast-audience-rest')).not.toBeInTheDocument();
  });

  it('composes a message with a preview, asks for confirmation, starts the broadcast and follows it to the end', async () => {
    const template = 'Скидки в {название_магазина} 🔥';
    const finished = broadcast({ id: 'b-new', message_text: template, button_text: 'Открыть магазин' });
    api.get.mockResolvedValue(view());
    api.start.mockResolvedValue({ ...view({ active: sending, history: [sending] }), replayed: false });
    let finish: () => void = () => undefined;
    api.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ...view({ history: [finished] }), worker: { state: 'done', sent: 12 } });
        }),
    );
    renderPage();
    await screen.findByTestId('broadcast-text');

    setText(template);
    expect(screen.getByTestId('broadcast-preview-text')).toHaveTextContent('Скидки в Noir Vapor 🔥');
    expect(screen.getByTestId('broadcast-counter')).toHaveTextContent('22 / 4096');
    // The Mini App button is on by default.
    expect(screen.getByTestId('broadcast-button-text')).toHaveValue('Открыть магазин');
    expect(screen.getByTestId('broadcast-preview-button-1')).toHaveTextContent('Открыть магазин');

    await userEvent.click(screen.getByTestId('broadcast-send'));
    const confirm = await screen.findByTestId('broadcast-confirm');
    expect(confirm).toHaveTextContent('Сообщение получат 12 пользователей бота @noir_shop_bot');
    expect(confirm).toHaveTextContent('Отозвать уже отправленные сообщения нельзя');
    expect(api.start).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('broadcast-confirm-ok'));
    expect(api.start).toHaveBeenCalledTimes(1);
    // Content only: the browser never names a recipient.
    expect(api.start).toHaveBeenCalledWith('shop-a', {
      idempotencyKey: expect.stringMatching(UUID),
      text: template,
      photoPath: null,
      button: { text: 'Открыть магазин', emojiId: null },
    });

    // Started: the progress, an empty composer, and no second broadcast until this one is over.
    const progress = await screen.findByTestId('broadcast-progress');
    expect(within(progress).getByTestId('broadcast-progress-total')).toHaveTextContent('0 из 12');
    expect(screen.getByTestId('broadcast-notice')).toHaveTextContent('Рассылка запущена');
    expect(screen.getByTestId('broadcast-text')).toHaveValue('');
    expect(screen.getByTestId('broadcast-send')).toBeDisabled();
    expect(screen.getByText('Новую рассылку можно запустить после завершения текущей.')).toBeInTheDocument();
    expect(screen.queryByTestId('broadcast-history')).not.toBeInTheDocument();

    // The page drives the worker step; when it reports the end, the broadcast moves to the history.
    await waitFor(() => expect(api.run).toHaveBeenCalledWith('shop-a'));
    finish();
    await waitFor(() => expect(screen.queryByTestId('broadcast-progress')).not.toBeInTheDocument());
    const item = screen.getByTestId('broadcast-history-item');
    expect(item).toHaveTextContent('Завершена');
    expect(item).toHaveTextContent('Скидки в Noir Vapor 🔥');
    expect(within(item).getByTestId('broadcast-count-sent')).toHaveTextContent('12');
    expect(api.run).toHaveBeenCalledTimes(1);
  });

  it('a repeated "send" of the same message reuses its idempotency key; a changed message gets a new one', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockResolvedValue(view());
    api.start.mockRejectedValue(new AdminApiError(502, 'telegram_unavailable', null));
    renderPage();
    await screen.findByTestId('broadcast-text');
    const keys = () => api.start.mock.calls.map((call) => (call[1] as { idempotencyKey: string }).idempotencyKey);
    const closed = () => waitFor(() => expect(screen.queryByTestId('broadcast-confirm')).not.toBeInTheDocument());

    setText('Скидки');
    await sendAndConfirm();
    expect(await screen.findByTestId('broadcast-notice')).toHaveTextContent('Telegram сейчас недоступен');
    // Nothing is lost: the message is still in the composer.
    expect(screen.getByTestId('broadcast-text')).toHaveValue('Скидки');
    await closed();

    await sendAndConfirm();
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(2));
    expect(keys()[1]).toBe(keys()[0]);
    await closed();

    setText('Скидки и подарки');
    await sendAndConfirm();
    await waitFor(() => expect(api.start).toHaveBeenCalledTimes(3));
    expect(keys()[2]).toMatch(UUID);
    expect(keys()[2]).not.toBe(keys()[0]);
  });

  it('counts the message as Telegram sends it: 4096 characters of text, 1024 with a photo; a Premium emoji tag counts as its emoji', async () => {
    api.get.mockResolvedValue(view());
    media.prepareImage.mockImplementation(async (file: File) => file);
    media.uploadBroadcastPhoto.mockResolvedValue(PHOTO);
    renderPage();
    await screen.findByTestId('broadcast-text');
    const send = screen.getByTestId('broadcast-send');

    setText('x'.repeat(4096));
    expect(send).toBeEnabled();
    setText('x'.repeat(4097));
    expect(screen.getByTestId('broadcast-too-long')).toHaveTextContent('до 4096 символов');
    expect(send).toBeDisabled();
    // 4094 characters and one Premium emoji: the 54-character tag is sent as the 2-unit emoji inside it.
    setText(`${'x'.repeat(4094)}<tg-emoji emoji-id="${FIRE}">🔥</tg-emoji>`);
    expect(screen.getByTestId('broadcast-counter')).toHaveTextContent('4096 / 4096');
    expect(screen.getByTestId('broadcast-preview-premium-emoji')).toHaveTextContent('🔥');
    expect(send).toBeEnabled();

    // With a photo the text becomes its caption.
    await userEvent.upload(screen.getByTestId('broadcast-photo-input'), new File(['x'], 'photo.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByTestId('broadcast-counter')).toHaveTextContent('4096 / 1024'));
    expect(media.prepareImage).toHaveBeenCalledWith(expect.any(File), 'broadcast');
    expect(media.uploadBroadcastPhoto).toHaveBeenCalledWith('shop-a', expect.any(File));
    expect(screen.getByTestId('broadcast-too-long')).toHaveTextContent('подпись до 1024 символов');
    expect(screen.getByTestId('broadcast-preview-photo')).toHaveAttribute('src', `https://cdn.test/${PHOTO}`);
    expect(send).toBeDisabled();
    setText('x'.repeat(1024));
    expect(send).toBeEnabled();

    // Removing the photo deletes the uploaded file and restores the limit.
    await userEvent.click(screen.getByTestId('broadcast-photo-remove'));
    expect(media.removeBroadcastPhoto).toHaveBeenCalledWith('shop-a', PHOTO);
    expect(screen.getByTestId('broadcast-counter')).toHaveTextContent('1024 / 4096');
    expect(screen.queryByTestId('broadcast-preview-photo')).not.toBeInTheDocument();
  });

  it('a photo and a Premium emoji icon of the button are sent with the message', async () => {
    api.get.mockResolvedValue(view());
    api.start.mockResolvedValue({ ...view({ active: sending, history: [sending] }), replayed: false });
    media.prepareImage.mockImplementation(async (file: File) => file);
    media.uploadBroadcastPhoto.mockResolvedValue(PHOTO);
    renderPage();
    await screen.findByTestId('broadcast-text');
    setText('Новинка');
    const send = screen.getByTestId('broadcast-send');
    await userEvent.upload(screen.getByTestId('broadcast-photo-input'), new File(['x'], 'photo.png', { type: 'image/png' }));
    await screen.findByTestId('broadcast-preview-photo');

    // The button needs a text; its icon is a number.
    const buttonText = screen.getByTestId('broadcast-button-text');
    await userEvent.clear(buttonText);
    expect(send).toBeDisabled();
    await userEvent.type(buttonText, '🛍 Каталог');
    expect(send).toBeEnabled();
    const emoji = screen.getByTestId('broadcast-button-emoji');
    await userEvent.type(emoji, 'abc');
    expect(screen.getByTestId('broadcast-button-emoji-error')).toBeInTheDocument();
    expect(send).toBeDisabled();
    await userEvent.clear(emoji);
    await userEvent.type(emoji, FIRE);
    expect(screen.getByTestId('broadcast-preview-button-1')).toHaveTextContent('🛍 Каталог');
    expect(screen.getByTestId('broadcast-preview-button-1-premium')).toBeInTheDocument();
    // What happens for a bot without Telegram Premium is explained next to the field.
    expect(screen.getByTestId('premium-emoji-hint')).toHaveTextContent('рассылка всё равно будет отправлена');

    await sendAndConfirm();
    expect(api.start).toHaveBeenCalledWith('shop-a', {
      idempotencyKey: expect.stringMatching(UUID),
      text: 'Новинка',
      photoPath: PHOTO,
      button: { text: '🛍 Каталог', emojiId: FIRE },
    });
    // A photo that was sent is kept: the server reads it while the broadcast runs.
    await screen.findByTestId('broadcast-progress');
    expect(media.removeBroadcastPhoto).not.toHaveBeenCalledWith('shop-a', PHOTO);
  });

  it('the button needs a public storefront address; a message without the button does not', async () => {
    api.get.mockResolvedValue(view({}, { storefront_url: null }));
    api.start.mockResolvedValue({ ...view({ active: sending, history: [sending] }, { storefront_url: null }), replayed: false });
    renderPage();
    await screen.findByTestId('broadcast-text');
    setText('Скидки');
    expect(screen.getByTestId('broadcast-no-storefront')).toBeInTheDocument();
    expect(screen.getByTestId('broadcast-send')).toBeDisabled();

    await userEvent.click(screen.getByTestId('broadcast-button-toggle'));
    expect(screen.queryByTestId('broadcast-button-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('broadcast-preview-button-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('broadcast-send')).toBeEnabled();

    await sendAndConfirm();
    expect(api.start).toHaveBeenCalledWith('shop-a', { idempotencyKey: expect.stringMatching(UUID), text: 'Скидки', photoPath: null, button: null });
  });

  it('a running broadcast: opening the page resumes it; progress, the flood-control pause and «Остановить»', async () => {
    const active = broadcast({
      id: 'b-run',
      status: 'sending',
      counts: counts({ pending: 5, sent: 4, failed: 1, blocked: 2 }),
      resume_at: new Date(Date.now() + 60_000).toISOString(),
      completed_at: null,
    });
    const stopped = broadcast({ id: 'b-run', status: 'cancelled', counts: counts({ sent: 4, failed: 1, blocked: 2, cancelled: 5 }) });
    api.get.mockResolvedValue(view({ active, history: [active] }));
    api.run.mockResolvedValue({ ...view({ active, history: [active] }), worker: { state: 'paused', sent: 0 } });
    api.cancel.mockResolvedValue(view({ history: [stopped] }));
    renderPage();

    const progress = await screen.findByTestId('broadcast-progress');
    expect(within(progress).getByTestId('broadcast-progress-total')).toHaveTextContent('7 из 12');
    expect(within(progress).getByRole('progressbar', { name: 'Ход рассылки' })).toHaveAttribute('aria-valuenow', '58');
    expect(within(progress).getByTestId('broadcast-count-sent')).toHaveTextContent('4');
    expect(within(progress).getByTestId('broadcast-count-pending')).toHaveTextContent('5');
    expect(within(progress).getByTestId('broadcast-count-blocked')).toHaveTextContent('2');
    expect(within(progress).getByTestId('broadcast-count-failed')).toHaveTextContent('1');
    expect(within(progress).getByTestId('broadcast-paused')).toHaveTextContent('Telegram попросил сделать паузу');
    await waitFor(() => expect(api.run).toHaveBeenCalledWith('shop-a'));
    // No new broadcast while this one runs.
    setText('Ещё одна');
    expect(screen.getByTestId('broadcast-send')).toBeDisabled();

    await userEvent.click(screen.getByTestId('broadcast-cancel'));
    expect(api.cancel).toHaveBeenCalledWith('shop-a', 'b-run');
    await waitFor(() => expect(screen.queryByTestId('broadcast-progress')).not.toBeInTheDocument());
    expect(screen.getByTestId('broadcast-notice')).toHaveTextContent('Рассылка остановлена');
    const item = screen.getByTestId('broadcast-history-item');
    expect(item).toHaveTextContent('Остановлена');
    expect(within(item).getByTestId('broadcast-count-cancelled')).toHaveTextContent('5');
    expect(screen.getByTestId('broadcast-send')).toBeEnabled();
  });

  it('tells when sends that failed are waiting for their retry', async () => {
    const active = broadcast({ id: 'b-run', status: 'sending', counts: counts({ pending: 2, sent: 10 }), completed_at: null });
    api.get.mockResolvedValue(view({ active, history: [active] }));
    api.run.mockResolvedValue({ ...view({ active, history: [active] }), worker: { state: 'waiting', sent: 0 } });
    renderPage();
    expect(await screen.findByTestId('broadcast-waiting')).toHaveTextContent('повторим отправку через несколько секунд');
  });

  it('history: «Повторить неудачные» only for a recent broadcast with failed sends; why a broadcast was stopped', async () => {
    const recent = broadcast({ id: 'b-1', counts: counts({ sent: 9, failed: 3 }) });
    const old = broadcast({ id: 'b-2', created_at: new Date(Date.now() - 49 * 3_600_000).toISOString(), counts: counts({ sent: 10, failed: 2 }) });
    const clean = broadcast({ id: 'b-3', photo_path: PHOTO });
    const stopped = broadcast({ id: 'b-4', status: 'cancelled', last_error: 'bot_changed', counts: counts({ sent: 0, cancelled: 12 }) });
    const retrying = broadcast({ id: 'b-1', status: 'sending', counts: counts({ pending: 3, sent: 9 }), completed_at: null });
    api.get.mockResolvedValue(view({ history: [recent, old, clean, stopped] }));
    api.retry.mockResolvedValue({ ...view({ active: retrying, history: [retrying, old, clean, stopped] }), retried: 3 });
    renderPage();

    const items = await screen.findAllByTestId('broadcast-history-item');
    expect(items).toHaveLength(4);
    expect(within(items[0]!).getByTestId('broadcast-retry')).toHaveTextContent('Повторить неудачные (3)');
    // Older than two days, or nothing failed: no retry.
    expect(within(items[1]!).queryByTestId('broadcast-retry')).not.toBeInTheDocument();
    expect(within(items[1]!).getByTestId('broadcast-count-failed')).toHaveTextContent('2');
    expect(within(items[2]!).queryByTestId('broadcast-retry')).not.toBeInTheDocument();
    expect(items[2]).toHaveTextContent('с фото');
    expect(items[3]).toHaveTextContent('Остановлена');
    expect(items[3]).toHaveTextContent('Бот магазина был заменён или отключён');

    await userEvent.click(within(items[0]!).getByTestId('broadcast-retry'));
    expect(api.retry).toHaveBeenCalledWith('shop-a', 'b-1');
    expect(await screen.findByTestId('broadcast-notice')).toHaveTextContent('Повторяем отправку: 3.');
    expect(await screen.findByTestId('broadcast-progress')).toBeInTheDocument();
    expect(screen.getAllByTestId('broadcast-history-item')).toHaveLength(3);
    await waitFor(() => expect(api.run).toHaveBeenCalledWith('shop-a'));
  });
});
