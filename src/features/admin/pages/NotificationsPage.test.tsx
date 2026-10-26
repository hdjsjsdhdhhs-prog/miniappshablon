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

  it('a non-owner sees that the section is owner-only', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockRejectedValue(new AdminApiError(403, 'forbidden', null));
    renderPage();
    expect(await screen.findByText('Настройки уведомлений доступны только владельцу магазина.')).toBeInTheDocument();
    expect(screen.queryByTestId('notifications-token')).not.toBeInTheDocument();
  });
});
