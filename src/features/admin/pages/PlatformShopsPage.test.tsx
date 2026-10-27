import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FunctionsApi from '../functions-api';
import type { PlatformShop } from '../functions-api';
import { PlatformShopsPage } from './PlatformShopsPage';
import { ShopsPage } from './ShopsPage';

const platform = vi.hoisted(() => ({
  list: vi.fn(),
  findUser: vi.fn(),
  transfer: vi.fn(),
  createDemo: vi.fn(),
  handoverCheck: vi.fn(),
  handover: vi.fn(),
}));
const role = vi.hoisted(() => ({ isAdmin: true }));
const myShops = vi.hoisted(() => vi.fn());

vi.mock('../functions-api', async (importOriginal) => ({
  ...(await importOriginal<typeof FunctionsApi>()),
  platformApi: platform,
  fetchIsPlatformAdmin: async () => role.isAdmin,
}));
vi.mock('../api', () => ({ fetchMyShops: myShops }));
vi.mock('../auth', () => ({
  useSession: () => ({ session: { user: { id: 'u-creator', email: 'creator@local.test' } }, loading: false }),
  signOut: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ publicImageUrl: () => null, supabase: {}, functionsUrl: (n: string) => n }));

const shop = (slug: string, name: string, owner: string | null, extra: Partial<PlatformShop> = {}): PlatformShop => ({
  id: `id-${slug}`,
  slug,
  name,
  mode: 'live',
  status: 'active',
  is_demo: false,
  logo_path: null,
  delivery_enabled: true,
  pickup_enabled: true,
  created_at: '2026-10-01T10:00:00Z',
  published_at: null,
  last_transfer_at: null,
  last_handover_at: null,
  members: owner ? [{ user_id: `u-${owner}`, email: owner, role: 'owner', since: '2026-10-01T10:00:00Z' }] : [],
  notifications: null,
  ...extra,
});

function renderAt(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  role.isAdmin = true;
});

describe('Все магазины платформы', () => {
  it('lists every shop with owner, status and dates, and searches by owner email', async () => {
    platform.list.mockResolvedValue([
      shop('noir-vapor', 'Noir Vapor', 'creator@local.test', { is_demo: true, notifications: { enabled: true, status: 'ok' } }),
      shop('mint-lab', 'Mint Lab', 'client@local.test', { mode: 'preview', last_transfer_at: '2026-10-20T10:00:00Z' }),
    ]);
    renderAt(<PlatformShopsPage />);
    const rows = await screen.findAllByTestId('platform-shop');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('platform-summary')).toHaveTextContent('Всего: 2 · live: 1 · preview: 1');
    expect(within(rows[1]!).getByTestId('platform-shop-owner')).toHaveTextContent('client@local.test');
    expect(rows[1]).toHaveTextContent('передан 20.10.2026');
    expect(within(rows[0]!).getByRole('link', { name: 'Админка' })).toHaveAttribute('href', '/admin/shops/noir-vapor');
    expect(within(rows[0]!).getByRole('link', { name: /Витрина/ })).toHaveAttribute('href', '/s/noir-vapor/');
    expect(screen.getByRole('link', { name: 'Все магазины платформы' })).toBeInTheDocument();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Поиск магазинов' }), 'client@');
    expect(screen.getAllByTestId('platform-shop')).toHaveLength(1);
    expect(screen.getByTestId('platform-shop')).toHaveTextContent('Mint Lab');
  });

  it('a non-admin sees no platform tab and the list is never requested', async () => {
    role.isAdmin = false;
    renderAt(<PlatformShopsPage />);
    expect(await screen.findByText('Этот раздел доступен только администратору платформы.')).toBeInTheDocument();
    expect(platform.list).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: 'Все магазины платформы' })).not.toBeInTheDocument();
  });

  it('hand-over: find an existing account, review who loses access, transfer, show the verified result', async () => {
    platform.list.mockResolvedValue([shop('noir-vapor', 'Noir Vapor', 'creator@local.test')]);
    platform.findUser.mockResolvedValueOnce(null).mockResolvedValueOnce({
      user_id: 'u-client',
      email: 'client@local.test',
      is_platform_admin: false,
      shops: [],
    });
    platform.transfer.mockResolvedValue({
      shop: { id: 'id-noir-vapor', slug: 'noir-vapor', name: 'Noir Vapor' },
      owner: { user_id: 'u-client', email: 'client@local.test' },
      removed: [{ user_id: 'u-creator@local.test', email: 'creator@local.test', role: 'owner' }],
      members: [],
      transferred_at: '2026-10-25T10:00:00Z',
    });
    renderAt(<PlatformShopsPage />);
    await userEvent.click(await screen.findByTestId('platform-transfer'));
    const dialog = screen.getByTestId('transfer-dialog');
    expect(within(dialog).getByTestId('transfer-confirm')).toBeDisabled();

    const email = within(dialog).getByLabelText('Email учётной записи нового владельца');
    await userEvent.type(email, 'new@local.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Найти' }));
    expect(await within(dialog).findByTestId('transfer-user-missing')).toHaveTextContent('pnpm owner:add --slug noir-vapor --email new@local.test');
    expect(within(dialog).getByTestId('transfer-confirm')).toBeDisabled();

    await userEvent.clear(email);
    await userEvent.type(email, 'client@local.test');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Найти' }));
    expect(await within(dialog).findByTestId('transfer-review')).toHaveTextContent('Потеряют доступ: creator@local.test');
    await userEvent.click(within(dialog).getByTestId('transfer-confirm'));
    expect(platform.transfer).toHaveBeenCalledWith('id-noir-vapor', 'u-client');
    const result = await within(dialog).findByTestId('transfer-result');
    expect(result).toHaveTextContent('Магазин передан. Владелец: client@local.test');
    expect(result).toHaveTextContent('Доступ снят: creator@local.test');
    expect(result).toHaveTextContent('остаётся в разделе «Все магазины платформы»');
  });

  it('every row shows its public link with a copy button; DEMO rows offer "Передать клиенту" instead of "Передать"', async () => {
    platform.list.mockResolvedValue([shop('noir-vapor', 'Noir Vapor', null, { is_demo: true }), shop('neon', 'Neon', 'o@local.test')]);
    renderAt(<PlatformShopsPage />);
    const rows = await screen.findAllByTestId('platform-shop');
    expect(within(rows[0]!).getByTestId('platform-shop-url')).toHaveTextContent(`${window.location.origin}/s/noir-vapor/`);
    expect(within(rows[0]!).getByTestId('platform-copy-link')).toBeInTheDocument();
    expect(within(rows[0]!).getByTestId('platform-handover')).toHaveTextContent('Передать клиенту');
    expect(within(rows[0]!).queryByTestId('platform-transfer')).not.toBeInTheDocument();
    expect(within(rows[1]!).getByTestId('platform-transfer')).toBeInTheDocument();
    expect(within(rows[1]!).queryByTestId('platform-handover')).not.toBeInTheDocument();
  });

  it('create DEMO: slug from the name, taken slug blocked, server call with the DEMO template, link shown with copy', async () => {
    platform.list.mockResolvedValue([
      shop('mint-lab', 'Mint Lab', null, { is_demo: true, created_at: '2026-10-02T10:00:00Z' }),
      shop('noir-vapor', 'Noir Vapor', null, { is_demo: true, created_at: '2026-10-01T09:00:00Z' }),
      shop('real-shop', 'Real', 'o@local.test', { created_at: '2026-09-01T10:00:00Z' }),
    ]);
    platform.createDemo.mockResolvedValue({
      shop: { id: 'new-id', slug: 'myatnaya-lavka', name: 'Мятная лавка', mode: 'live', is_demo: true },
      media: { copied: 12, missing: 0 },
    });
    renderAt(<PlatformShopsPage />);
    await userEvent.click(await screen.findByTestId('platform-create-demo'));
    const dialog = screen.getByTestId('create-demo-dialog');
    const submit = within(dialog).getByTestId('create-demo-submit');
    expect(submit).toBeDisabled();

    await userEvent.type(within(dialog).getByTestId('create-demo-name'), 'Мятная лавка');
    expect(within(dialog).getByTestId('create-demo-slug')).toHaveValue('myatnaya-lavka');
    // The default template is the original (oldest active) DEMO storefront, not the first one in the list;
    // an older non-DEMO shop is never a template.
    expect(within(dialog).getByTestId('create-demo-template')).toHaveTextContent('Noir Vapor (noir-vapor)');

    await userEvent.clear(within(dialog).getByTestId('create-demo-slug'));
    await userEvent.type(within(dialog).getByTestId('create-demo-slug'), 'real-shop');
    expect(dialog).toHaveTextContent('Этот slug уже занят.');
    expect(submit).toBeDisabled();
    await userEvent.clear(within(dialog).getByTestId('create-demo-slug'));
    await userEvent.type(within(dialog).getByTestId('create-demo-slug'), '-bad');
    expect(submit).toBeDisabled();

    await userEvent.clear(within(dialog).getByTestId('create-demo-slug'));
    await userEvent.type(within(dialog).getByTestId('create-demo-slug'), 'myatnaya-lavka');
    await userEvent.click(submit);
    expect(platform.createDemo).toHaveBeenCalledWith({ templateId: 'id-noir-vapor', slug: 'myatnaya-lavka', name: 'Мятная лавка' });
    const result = await within(dialog).findByTestId('create-demo-result');
    expect(within(result).getByTestId('create-demo-url')).toHaveValue(`${window.location.origin}/s/myatnaya-lavka/`);
    expect(within(result).getByTestId('create-demo-copy')).toBeInTheDocument();
  });

  it('create DEMO: a server-side slug conflict is shown and nothing is reported as created', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    platform.list.mockResolvedValue([shop('noir-vapor', 'Noir Vapor', null, { is_demo: true })]);
    platform.createDemo.mockRejectedValue(new AdminApiError(409, 'slug_taken', null));
    renderAt(<PlatformShopsPage />);
    await userEvent.click(await screen.findByTestId('platform-create-demo'));
    const dialog = screen.getByTestId('create-demo-dialog');
    await userEvent.type(within(dialog).getByTestId('create-demo-name'), 'Race');
    await userEvent.click(within(dialog).getByTestId('create-demo-submit'));
    expect(await within(dialog).findByTestId('create-demo-error')).toHaveTextContent('уже занят');
    expect(within(dialog).queryByTestId('create-demo-result')).not.toBeInTheDocument();
  });

  it('hand-over to a client: blocked when not ready; otherwise e-mail + payment confirmation → invitation result', async () => {
    platform.list.mockResolvedValue([shop('demo-a', 'Demo A', null, { is_demo: true })]);
    platform.handoverCheck.mockResolvedValueOnce({ ready: false, problems: ['no_fulfillment'], shop: {} });
    renderAt(<PlatformShopsPage />);
    await userEvent.click(await screen.findByTestId('platform-handover'));
    let dialog = screen.getByTestId('handover-dialog');
    expect(await within(dialog).findByTestId('handover-not-ready')).toHaveTextContent('Не включён ни один способ получения');
    expect(within(dialog).getByTestId('handover-confirm')).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));

    platform.handoverCheck.mockResolvedValue({ ready: true, problems: [], shop: {} });
    platform.handover.mockResolvedValue({
      handover: {
        shop: { id: 'id-demo-a', slug: 'demo-a', name: 'Demo A', mode: 'live', is_demo: false },
        owner: { user_id: 'u-c', email: 'client@local.test' },
        removed: [],
        members: [],
        invitation: 'sent',
        legacy_test_orders: 0,
        transferred_at: '2026-10-26T10:00:00Z',
      },
      invitation: { status: 'sent', link: null },
    });
    await userEvent.click(screen.getByTestId('platform-handover'));
    dialog = screen.getByTestId('handover-dialog');
    const confirm = await within(dialog).findByTestId('handover-confirm');
    await userEvent.type(await within(dialog).findByTestId('handover-email'), 'client@local.test');
    expect(confirm).toBeDisabled(); // payment not confirmed yet
    await userEvent.click(within(dialog).getByTestId('handover-paid'));
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(platform.handover).toHaveBeenCalledWith('id-demo-a', 'client@local.test');
    const result = await within(dialog).findByTestId('handover-result');
    expect(result).toHaveTextContent('владелец client@local.test, режим live, DEMO выключен');
    expect(within(result).getByTestId('handover-invitation')).toHaveTextContent('Письмо-приглашение отправлено на client@local.test');
  });
});

describe('Мои магазины', () => {
  it('shows own shops with status, storefront path and section links; search narrows the list', async () => {
    myShops.mockResolvedValue([
      { role: 'owner', shop: { id: '1', slug: 'noir-vapor', name: 'Noir Vapor', mode: 'live', is_demo: true, logo_path: null } },
      { role: 'manager', shop: { id: '2', slug: 'neon-district', name: 'Neon District', mode: 'preview', is_demo: false, logo_path: null } },
    ]);
    renderAt(<ShopsPage />);
    const cards = await screen.findAllByTestId('my-shop');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent('live');
    expect(cards[0]).toHaveTextContent('DEMO');
    expect(cards[0]).toHaveTextContent('/s/noir-vapor/');
    expect(cards[1]).toHaveTextContent('preview');
    expect(cards[1]).toHaveTextContent('Менеджер');
    for (const [name, href] of [
      ['Управление', '/admin/shops/noir-vapor'],
      ['Товары', '/admin/shops/noir-vapor/products'],
      ['Категории', '/admin/shops/noir-vapor/categories'],
      ['Заказы', '/admin/shops/noir-vapor/orders'],
      ['Настройки', '/admin/shops/noir-vapor/settings'],
      ['Уведомления', '/admin/shops/noir-vapor/notifications'],
    ] as const) {
      expect(within(cards[0]!).getByRole('link', { name })).toHaveAttribute('href', href);
    }
    await userEvent.type(screen.getByRole('searchbox', { name: 'Поиск магазинов' }), 'neon');
    expect(screen.getAllByTestId('my-shop')).toHaveLength(1);
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Поиск магазинов' }));
    await userEvent.type(screen.getByRole('searchbox', { name: 'Поиск магазинов' }), 'zzz');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });
});
