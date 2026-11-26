import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShopContext } from '../admin-context';
import type { AdminShop } from '../api';
import type * as FunctionsApi from '../functions-api';
import type { NotificationSettings } from '../functions-api';
import { NotificationsPage } from './NotificationsPage';

const api = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), check: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), retry: vi.fn() }));
vi.mock('../functions-api', async (importOriginal) => ({ ...(await importOriginal<typeof FunctionsApi>()), notificationsApi: api }));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// Fake token in BotFather format (never valid).
const TOKEN = '123456789:FAKE_ui_token_cccccccccccccccccccccccc';
const shop = { id: 'shop-a', slug: 'noir-vapor', name: 'Noir Vapor' } as AdminShop;

const empty: NotificationSettings = {
  configured: false,
  enabled: false,
  token_hint: null,
  bot_username: null,
  chat_id: null,
  chat_title: null,
  chat_type: null,
  status: 'unverified',
  last_error: null,
  last_checked_at: null,
  updated_at: null,
  queue: { pending: 0, sent: 0, dead: 0 },
};
const connected: NotificationSettings = {
  ...empty,
  configured: true,
  enabled: true,
  token_hint: '123456789:••••cccc',
  bot_username: 'noir_orders_bot',
  chat_id: '@noir_orders',
  chat_title: 'Noir заказы',
  chat_type: 'channel',
  status: 'ok',
  last_checked_at: '2026-10-25T10:00:00Z',
  queue: { pending: 0, sent: 3, dead: 0 },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminShopContext.Provider value={shop}>
        <NotificationsPage />
      </AdminShopContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('NotificationsPage', () => {
  it('explains the setup and saves token + chat; the token is cleared and only its mask is shown', async () => {
    api.get.mockResolvedValue(empty);
    api.save.mockResolvedValue(connected);
    renderPage();
    expect(await screen.findByText('Уведомления в Telegram')).toBeInTheDocument();
    expect(screen.getByTestId('notifications-status')).toHaveTextContent('Не настроено');
    expect(screen.getByText(/администратором с правом отправлять/)).toBeInTheDocument();
    const tokenInput = screen.getByTestId('notifications-token');
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tokenInput).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByTestId('notifications-save')).toBeDisabled();

    await userEvent.type(tokenInput, TOKEN);
    await userEvent.type(screen.getByTestId('notifications-chat'), '@noir_orders');
    await userEvent.click(screen.getByTestId('notifications-save'));
    expect(api.save).toHaveBeenCalledWith('shop-a', { botToken: TOKEN, chatId: '@noir_orders' });

    await waitFor(() => expect(screen.getByTestId('notifications-status')).toHaveTextContent('Подключено'));
    expect(screen.getByTestId('notifications-token')).toHaveValue('');
    expect(screen.getByTestId('notifications-token-hint')).toHaveTextContent('123456789:••••cccc');
    expect(document.body.innerHTML).not.toContain(TOKEN.split(':')[1]);
    expect(screen.getByTestId('notifications-notice')).toHaveTextContent('Новые заказы будут приходить в Telegram');
    // Nothing about the connection is kept in the browser.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('keeps the stored token when only the chat changes, checks the stored connection and toggles sending', async () => {
    api.get.mockResolvedValue(connected);
    api.save.mockResolvedValue({ ...connected, chat_id: '@noir_orders2' });
    api.check.mockResolvedValue({ ok: true, bot: { username: 'noir_orders_bot' }, chat: { title: 'Noir заказы', type: 'channel' }, settings: connected });
    api.setEnabled.mockResolvedValue({ ...connected, enabled: false });
    renderPage();
    expect(await screen.findByText('@noir_orders_bot')).toBeInTheDocument();
    expect(screen.getByTestId('notifications-queue')).toHaveTextContent('отправлено 3');

    await userEvent.click(screen.getByTestId('notifications-check'));
    expect(api.check).toHaveBeenCalledWith('shop-a', {});
    expect(await screen.findByTestId('notifications-notice')).toHaveTextContent('Тестовое сообщение отправлено в «Noir заказы» ботом @noir_orders_bot');

    const chat = screen.getByTestId('notifications-chat');
    await userEvent.clear(chat);
    await userEvent.type(chat, '@noir_orders2');
    await userEvent.click(screen.getByTestId('notifications-save'));
    expect(api.save).toHaveBeenCalledWith('shop-a', { botToken: undefined, chatId: '@noir_orders2' });

    await userEvent.click(screen.getByTestId('notifications-enabled'));
    expect(api.setEnabled).toHaveBeenCalledWith('shop-a', false);
    await waitFor(() => expect(screen.getByTestId('notifications-status')).toHaveTextContent('Выключено'));
  });

  it('shows clear Telegram errors and the owner-only message', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockResolvedValue(empty);
    api.save.mockRejectedValue(new AdminApiError(400, 'bot_cannot_post', null));
    renderPage();
    await userEvent.type(await screen.findByTestId('notifications-token'), TOKEN);
    await userEvent.type(screen.getByTestId('notifications-chat'), '@noir_orders');
    await userEvent.click(screen.getByTestId('notifications-save'));
    expect(await screen.findByTestId('notifications-notice')).toHaveTextContent('Добавьте его администратором с правом публикации');
  });

  it('warns inside the instruction that the notification bot must be a separate bot, not the storefront bot', async () => {
    api.get.mockResolvedValue(empty);
    renderPage();
    const warning = await screen.findByTestId('notifications-separate-bot-warning');
    expect(warning).toHaveTextContent(
      'Важно: для уведомлений необходимо использовать отдельного Telegram-бота. Не подключайте сюда бота, который используется для витрины Mini App. Для витрины создайте второго бота через @BotFather',
    );
    // The warning is part of the «Как подключить» instruction next to the numbered steps.
    expect(warning.closest('aside')).toHaveTextContent('Как подключить');
    expect(warning.closest('aside')).toContainElement(screen.getByText(/Создайте приватную группу или канал для заказов/));
  });

  it('refuses the storefront bot with a red error that names the section, keeps the saved connection and never shows the token', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockResolvedValue(connected);
    api.save.mockRejectedValue(new AdminApiError(409, 'bot_used_for_storefront', null));
    renderPage();
    expect(await screen.findByText('@noir_orders_bot')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('notifications-token'), TOKEN);
    await userEvent.click(screen.getByTestId('notifications-save'));

    const notice = await screen.findByTestId('notifications-notice');
    expect(notice).toHaveTextContent(
      'Этот Telegram-бот уже подключён для витрины Mini App. Для уведомлений необходимо использовать отдельного Telegram-бота. Один бот не может использоваться одновременно для уведомлений и витрины',
    );
    // The red (destructive) alert of the project, not the neutral one.
    expect(notice.className).toContain('text-destructive');
    expect(notice.textContent).not.toContain(TOKEN.split(':')[1]);
    // The working connection is still shown as it was: nothing replaced, nothing cleared.
    expect(screen.getByTestId('notifications-status')).toHaveTextContent('Подключено');
    expect(screen.getByTestId('notifications-token-hint')).toHaveTextContent('123456789:••••cccc');
    expect(screen.getByText('@noir_orders_bot')).toBeInTheDocument();
    expect(screen.getByTestId('notifications-chat')).toHaveValue('@noir_orders');
    // A conflict is not a wrong token and not an unavailable Telegram.
    expect(notice).not.toHaveTextContent('Telegram не принял токен');
    expect(notice).not.toHaveTextContent('Telegram сейчас недоступен');
  });

  it.each([
    ['telegram_unauthorized', 'Telegram не принял токен'],
    ['telegram_unavailable', 'Telegram сейчас недоступен'],
  ])('a %s error is shown separately from the duplicate-bot error', async (code, text) => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockResolvedValue(empty);
    api.save.mockRejectedValue(new AdminApiError(code === 'telegram_unavailable' ? 502 : 400, code, null));
    renderPage();
    await userEvent.type(await screen.findByTestId('notifications-token'), TOKEN);
    await userEvent.type(screen.getByTestId('notifications-chat'), '@noir_orders');
    await userEvent.click(screen.getByTestId('notifications-save'));
    const notice = await screen.findByTestId('notifications-notice');
    expect(notice).toHaveTextContent(text);
    expect(notice).not.toHaveTextContent('уже подключён');
  });

  it('a non-owner sees that the section is owner-only', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockRejectedValue(new AdminApiError(403, 'forbidden', null));
    renderPage();
    expect(await screen.findByText('Настройки уведомлений доступны только владельцу магазина.')).toBeInTheDocument();
    expect(screen.queryByTestId('notifications-token')).not.toBeInTheDocument();
  });
});
