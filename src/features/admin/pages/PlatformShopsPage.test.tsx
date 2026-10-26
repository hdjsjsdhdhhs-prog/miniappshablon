import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FunctionsApi from '../functions-api';
import type { PlatformShop } from '../functions-api';
import { PlatformShopsPage } from './PlatformShopsPage';
import { ShopsPage } from './ShopsPage';

const platform = vi.hoisted(() => ({ list: vi.fn(), findUser: vi.fn(), transfer: vi.fn() }));
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
  created_at: '2026-10-01T10:00:00Z',
  published_at: null,
  last_transfer_at: null,
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
