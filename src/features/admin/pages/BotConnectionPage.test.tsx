import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShopContext } from '../admin-context';
import type { AdminShop } from '../api';
import type * as FunctionsApi from '../functions-api';
import type { BotView } from '../functions-api';
import { BotConnectionPage } from './BotConnectionPage';

const api = vi.hoisted(() => ({ get: vi.fn(), connect: vi.fn(), sync: vi.fn(), disconnect: vi.fn(), saveWelcome: vi.fn() }));
const notifications = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), check: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), retry: vi.fn() }));
vi.mock('../functions-api', async (importOriginal) => ({ ...(await importOriginal<typeof FunctionsApi>()), botApi: api, notificationsApi: notifications }));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// Fake token in BotFather format (never valid).
const TOKEN = '123456789:AAFakeTokenForUnitTestsOnly_abcdefghij';
const SECRET = TOKEN.split(':')[1]!;
const shop = { id: 'shop-a', slug: 'noir-vapor', name: 'Noir Vapor' } as AdminShop;
const STORE = 'https://miniappdemo.pages.dev/s/noir-vapor/';
const WELCOME_DEFAULT =
  'Добро пожаловать в {название_магазина}\n\nНажмите кнопку "Открыть приложение", чтобы просмотреть каталог и ознакомиться с товарами.\n\nПо вопросам и помощи нажмите кнопку "Связаться с менеджером" ниже.';

const empty: BotView = {
  settings: {
    shop: { id: 'shop-a', slug: 'noir-vapor', name: 'Noir Vapor' },
    connection: null,
    welcome: { welcome_text: WELCOME_DEFAULT, open_button_text: 'Открыть приложение', manager_button_text: 'Связаться с менеджером', manager_url: null, customized: false, updated_at: null },
  },
  storefront_url: STORE,
};
const connected: BotView = {
  ...empty,
  settings: {
    ...empty.settings,
    connection: {
      bot_id: 123456789,
      bot_username: 'noir_shop_bot',
      token_hint: '123456789:••••ghij',
      status: 'connected',
      last_error: null,
      menu_button_url: STORE,
      connected_at: '2026-11-07T10:00:00Z',
      updated_at: '2026-11-07T10:00:00Z',
    },
  },
};

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminShopContext.Provider value={shop}>
        <BotConnectionPage />
      </AdminShopContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('BotConnectionPage — not connected', () => {
  it('shows the instruction, connects with the token (show/hide while typing) and never keeps or shows the token afterwards', async () => {
    api.get.mockResolvedValue(empty);
    api.connect.mockResolvedValue({ ...connected, previous: null });
    renderPage();
    expect(await screen.findByText('Подключите Telegram-бота')).toBeInTheDocument();
    expect(screen.getByTestId('bot-status')).toHaveTextContent('Бот не подключён');
    expect(screen.getByText(/чтобы ваши покупатели могли открывать Mini App прямо из чата с ботом/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Открыть BotFather/ })).toHaveAttribute('href', 'https://t.me/BotFather');
    expect(screen.getByText('/newbot')).toBeInTheDocument();
    expect(screen.getByText(/Не передавайте токен посторонним/)).toBeInTheDocument();

    const input = screen.getByTestId('bot-token');
    expect(screen.getByLabelText('Токен Telegram-бота')).toBe(input);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('placeholder', '123456789:AA...');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByTestId('bot-connect')).toBeDisabled();
    await userEvent.type(input, TOKEN);
    await userEvent.click(screen.getByTestId('bot-token-toggle'));
    expect(input).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByTestId('bot-token-toggle'));
    expect(input).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByTestId('bot-connect'));
    expect(api.connect).toHaveBeenCalledWith('shop-a', TOKEN, false);
    await waitFor(() => expect(screen.getByTestId('bot-status')).toHaveTextContent('Бот подключён'));
    expect(screen.getByTestId('bot-username')).toHaveTextContent('@noir_shop_bot');
    expect(screen.getByTestId('bot-token-hint')).toHaveTextContent('123456789:••••ghij');
    expect(screen.getByTestId('bot-storefront-url')).toHaveTextContent(STORE);
    expect(screen.getByTestId('bot-notice')).toHaveTextContent('Бот @noir_shop_bot подключён');
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    // «Уведомления» are a separate feature: nothing here touches them.
    expect(Object.values(notifications).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  it.each([
    ['telegram_unauthorized', 'Не удалось подключить бота. Проверьте правильность токена BotFather.'],
    ['bot_in_use', 'Этот Telegram-бот уже используется другим магазином платформы.'],
    ['bot_connect_rate_limited', 'Слишком много попыток подключения'],
  ])('shows a plain error for %s', async (code, text) => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockResolvedValue(empty);
    api.connect.mockRejectedValue(new AdminApiError(400, code, null));
    renderPage();
    await userEvent.type(await screen.findByTestId('bot-token'), TOKEN);
    await userEvent.click(screen.getByTestId('bot-connect'));
    expect(await screen.findByTestId('bot-notice')).toHaveTextContent(text);
    expect(screen.getByTestId('bot-status')).toHaveTextContent('Бот не подключён');
  });

  it('a webhook of another service needs an explicit confirmation before it is replaced', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockResolvedValue(empty);
    api.connect.mockRejectedValueOnce(new AdminApiError(409, 'webhook_conflict', { host: 'crm.example' })).mockResolvedValueOnce({ ...connected, previous: null });
    renderPage();
    await userEvent.type(await screen.findByTestId('bot-token'), TOKEN);
    await userEvent.click(screen.getByTestId('bot-connect'));
    const alert = await screen.findByTestId('bot-webhook-conflict');
    expect(alert).toHaveTextContent('crm.example');
    expect(screen.getByTestId('bot-webhook-replace')).toBeDisabled();
    await userEvent.click(screen.getByTestId('bot-webhook-confirm'));
    await userEvent.click(screen.getByTestId('bot-webhook-replace'));
    expect(api.connect).toHaveBeenLastCalledWith('shop-a', TOKEN, true);
    await waitFor(() => expect(screen.getByTestId('bot-status')).toHaveTextContent('Бот подключён'));
  });

  it('a non-owner sees that the section is owner-only', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    api.get.mockRejectedValue(new AdminApiError(403, 'forbidden', null));
    renderPage();
    expect(await screen.findByText('Подключение бота доступно только владельцу магазина.')).toBeInTheDocument();
    expect(screen.queryByTestId('bot-token')).not.toBeInTheDocument();
  });
});

describe('BotConnectionPage — connected', () => {
  it('edits the welcome with a Telegram-style preview of the text and exactly two buttons (no URL field for button 1)', async () => {
    api.get.mockResolvedValue(connected);
    api.saveWelcome.mockImplementation(async (_id: string, w: { welcomeText: string; openButtonText: string; managerButtonText: string }) => ({
      ...connected,
      settings: {
        ...connected.settings,
        welcome: { welcome_text: w.welcomeText, open_button_text: w.openButtonText, manager_button_text: w.managerButtonText, manager_url: 'https://t.me/noir_manager', customized: true, updated_at: '2026-11-07T11:00:00Z' },
      },
      menu_synced: false,
    }));
    renderPage();
    expect(await screen.findByText('Приветственное сообщение')).toBeInTheDocument();
    expect(screen.getByText(/Это сообщение автоматически отправляется пользователю/)).toBeInTheDocument();
    expect(screen.getByLabelText('Текст приветствия')).toHaveValue(WELCOME_DEFAULT);
    expect(screen.getByTestId('bot-preview-text')).toHaveTextContent('Добро пожаловать в Noir Vapor');
    expect(screen.getByTestId('bot-preview-button-1')).toHaveTextContent('Открыть приложение');
    expect(screen.getByTestId('bot-preview-button-2')).toHaveTextContent('Связаться с менеджером');
    expect(screen.getByText('Ссылка автоматически ведёт на вашу Mini App.')).toBeInTheDocument();
    expect(screen.getByTestId('bot-manager-missing')).toHaveTextContent('Ссылка менеджера не заполнена');
    expect(screen.getByTestId('bot-welcome-counter')).toHaveTextContent('/ 4096');
    // Only two text inputs and one link input for the buttons: no URL for button 1.
    expect(screen.getAllByPlaceholderText('https://t.me/username')).toHaveLength(1);

    const text = screen.getByTestId('bot-welcome-text');
    await userEvent.clear(text);
    await userEvent.type(text, 'Привет из {{название_магазина} 🎉');
    expect(screen.getByTestId('bot-preview-text')).toHaveTextContent('Привет из Noir Vapor 🎉');

    const open = screen.getByTestId('bot-open-text');
    await userEvent.clear(open);
    await userEvent.type(open, 'Каталог');
    expect(screen.getByTestId('bot-preview-button-1')).toHaveTextContent('Каталог');

    const link = screen.getByTestId('bot-manager-url');
    await userEvent.type(link, 'javascript:alert(1)');
    expect(screen.getByTestId('bot-manager-url-error')).toHaveTextContent('https://t.me/username');
    expect(screen.getByTestId('bot-welcome-save')).toBeDisabled();
    await userEvent.clear(link);
    await userEvent.type(link, '@noir_manager');
    expect(screen.queryByTestId('bot-manager-url-error')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('bot-buttons-save'));
    expect(api.saveWelcome).toHaveBeenCalledWith('shop-a', {
      welcomeText: 'Привет из {название_магазина} 🎉',
      openButtonText: 'Каталог',
      managerButtonText: 'Связаться с менеджером',
      managerUrl: '@noir_manager',
    });
    expect(await screen.findByTestId('bot-welcome-notice')).toHaveTextContent('Новые обращения /start получат обновлённое приветствие');
    await waitFor(() => expect(screen.queryByTestId('bot-manager-missing')).not.toBeInTheDocument());
  });

  it('explains how to enable the Main Mini App in BotFather without claiming it was done automatically', async () => {
    api.get.mockResolvedValue(connected);
    renderPage();
    const steps = await screen.findByTestId('bot-main-app-steps');
    expect(steps).toHaveTextContent('/mybots');
    expect(steps).toHaveTextContent('Configure Mini App');
    expect(screen.getByText(/позволяет включить только в @BotFather/)).toBeInTheDocument();
  });

  it('disconnect and replacement both ask for confirmation first', async () => {
    api.get.mockResolvedValue(connected);
    api.disconnect.mockResolvedValue({ ...empty, cleanup: { webhook_removed: true, menu_reset: true, telegram: 'ok' } });
    api.connect.mockResolvedValue({ ...connected, previous: { bot_username: 'noir_shop_bot', webhook_removed: true, menu_reset: true, error: null } });
    renderPage();

    await userEvent.click(await screen.findByTestId('bot-replace'));
    await userEvent.type(within(screen.getByTestId('bot-replace-form')).getByTestId('bot-token'), TOKEN);
    await userEvent.click(within(screen.getByTestId('bot-replace-form')).getByTestId('bot-connect'));
    expect(api.connect).not.toHaveBeenCalled();
    expect(await screen.findByTestId('bot-confirm')).toHaveTextContent('Заменить бота?');
    await userEvent.click(screen.getByTestId('bot-confirm-ok'));
    expect(api.connect).toHaveBeenCalledWith('shop-a', TOKEN, false);
    expect(await screen.findByTestId('bot-notice')).toHaveTextContent('Прежний бот @noir_shop_bot отключён от магазина');

    await userEvent.click(screen.getByTestId('bot-disconnect'));
    expect(api.disconnect).not.toHaveBeenCalled();
    expect(await screen.findByTestId('bot-confirm')).toHaveTextContent('Отключить бота?');
    await userEvent.click(screen.getByTestId('bot-confirm-ok'));
    expect(api.disconnect).toHaveBeenCalledWith('shop-a');
    await waitFor(() => expect(screen.getByTestId('bot-status')).toHaveTextContent('Бот не подключён'));
    expect(screen.getByTestId('bot-notice')).toHaveTextContent('Настройки приветствия сохранены');
  });

  it('shows a connection error stored on the server in plain words', async () => {
    api.get.mockResolvedValue({ ...connected, settings: { ...connected.settings, connection: { ...connected.settings.connection!, status: 'error', last_error: 'webhook_replaced' } } });
    renderPage();
    expect(await screen.findByTestId('bot-status')).toHaveTextContent('Ошибка подключения');
    expect(screen.getByTestId('bot-error')).toHaveTextContent('настройки изменил другой сервис');
  });
});
