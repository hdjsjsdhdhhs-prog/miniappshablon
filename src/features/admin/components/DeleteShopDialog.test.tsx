// "Удалить магазин" for a LIVE shop: the slug and a fresh TOTP code, in the order the server requires
// (challenge → Supabase Auth verifies the code → delete). The server-side rules themselves are covered by
// tests/integration/security/platform-admin-mfa.test.ts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FunctionsApi from '../functions-api';
import type { PlatformShop, ShopDeletePreview } from '../functions-api';
import type * as Mfa from '../mfa';
import { DeleteShopDialog } from './DeleteShopDialog';

const platform = vi.hoisted(() => ({ shopDeletePreview: vi.fn(), shopDeleteChallenge: vi.fn(), shopDelete: vi.fn(), demoDeleteResume: vi.fn() }));
const mfa = vi.hoisted(() => ({ listTotpFactors: vi.fn(), verifyTotp: vi.fn() }));

vi.mock('../functions-api', async (importOriginal) => ({ ...(await importOriginal<typeof FunctionsApi>()), platformApi: platform }));
vi.mock('../mfa', async (importOriginal) => ({ ...(await importOriginal<typeof Mfa>()), ...mfa }));
vi.mock('../auth', () => ({
  useSession: () => ({ session: { user: { id: 'u-admin', email: 'admin@local.test' } }, loading: false }),
  signOut: vi.fn(),
}));
vi.mock('@/lib/supabase', () => ({ publicImageUrl: () => null, supabase: {}, functionsUrl: (n: string) => n }));

const CODE = '123456';
const owner = { user_id: 'u-client', email: 'client@local.test', role: 'owner' as const, since: '2026-10-01T10:00:00Z' };
const shop: PlatformShop = {
  id: 'id-mint-lab',
  slug: 'mint-lab',
  name: 'Mint Lab',
  mode: 'live',
  status: 'active',
  is_demo: false,
  logo_path: null,
  delivery_enabled: true,
  pickup_enabled: true,
  created_at: '2026-10-01T10:00:00Z',
  published_at: '2026-10-02T10:00:00Z',
  last_transfer_at: null,
  last_handover_at: null,
  members: [owner],
  notifications: null,
};
const preview = (over: Partial<ShopDeletePreview> = {}): ShopDeletePreview => ({
  status: 'ready',
  counts: { products: 14, categories: 3, variants: 40, images: 20, media_files: 22, orders: 57, members: 2, subscribers: 310, broadcasts: 4 },
  members: [owner],
  has_owner: true,
  bot: 'mint_lab_bot',
  pending_handover: null,
  deletion: null,
  ...over,
});

function renderDialog(target: PlatformShop = shop) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <DeleteShopDialog shop={target} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

/** Fills both confirmations once the preview is shown. */
async function confirmWith(slug: string, code: string) {
  await userEvent.type(await screen.findByTestId('shop-delete-input'), slug);
  await userEvent.type(screen.getByTestId('shop-delete-code'), code);
}
const firstCall = (fn: { mock: { invocationCallOrder: number[] } }) => fn.mock.invocationCallOrder[0]!;

beforeEach(() => {
  vi.resetAllMocks();
  platform.shopDeletePreview.mockResolvedValue(preview());
  platform.shopDeleteChallenge.mockResolvedValue({ challenge: { challenged: true, expires_in_sec: 300 } });
  platform.shopDelete.mockResolvedValue({ deletion: { status: 'deleted' } });
  mfa.listTotpFactors.mockResolvedValue([{ id: 'factor-1', status: 'verified', created_at: '2026-10-01T10:00:00Z' }]);
  mfa.verifyTotp.mockResolvedValue(undefined);
});

describe('DeleteShopDialog (LIVE shop)', () => {
  it('shows what will be lost — data, bot audience and broadcasts, the owner — before anything can be confirmed', async () => {
    renderDialog();
    const summary = await screen.findByTestId('shop-delete-summary');
    expect(platform.shopDeletePreview).toHaveBeenCalledWith('id-mint-lab');
    expect(screen.getByTestId('shop-delete-dialog')).toHaveTextContent('Удалить магазин «Mint Lab»?');
    expect(screen.getByTestId('shop-delete-dialog')).toHaveTextContent('полностью и безвозвратно');
    expect(screen.getByTestId('shop-delete-slug')).toHaveTextContent('mint-lab');
    expect(summary).toHaveTextContent('/s/mint-lab/');
    for (const [key, value] of [['products', '14'], ['categories', '3'], ['variants', '40'], ['media_files', '22'], ['orders', '57'], ['members', '2'], ['subscribers', '310'], ['broadcasts', '4']]) {
      expect(screen.getByTestId(`shop-delete-count-${key}`), key).toHaveTextContent(value!);
    }
    expect(screen.getByTestId('shop-delete-bot')).toHaveTextContent('@mint_lab_bot');
    expect(screen.getByTestId('shop-delete-owner')).toHaveTextContent('client@local.test');
    expect(screen.getByTestId('shop-delete-owner-warning')).toHaveTextContent('Его учётная запись и другие магазины сохранятся');
    expect(screen.getByTestId('shop-delete-confirm')).toBeDisabled();
  });

  it('needs BOTH the exact slug and a 6-digit code; the code field takes digits only', async () => {
    renderDialog();
    const slug = await screen.findByTestId('shop-delete-input');
    const code = screen.getByTestId('shop-delete-code');
    const button = screen.getByTestId('shop-delete-confirm');
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(screen.getByText(/вход с двухфакторной защитой сам по себе удаление не подтверждает/)).toBeInTheDocument();

    // The slug alone, or the code alone, is not enough.
    await userEvent.type(slug, 'mint-lab');
    expect(button).toBeDisabled();
    await userEvent.type(code, '12ab34');
    expect(code).toHaveValue('1234');
    expect(button).toBeDisabled();
    await userEvent.type(code, '56');
    expect(button).toBeEnabled();
    // A slug that is not exactly this shop's.
    await userEvent.type(slug, 'x');
    expect(button).toBeDisabled();
    await userEvent.clear(slug);
    await userEvent.type(slug, 'Mint-Lab');
    expect(button).toBeDisabled();
    expect(platform.shopDeleteChallenge).not.toHaveBeenCalled();
    expect(platform.shopDelete).not.toHaveBeenCalled();
  });

  it('deletes in the order the server requires: challenge → the code is verified by Supabase Auth → delete; the code never goes to our server', async () => {
    renderDialog();
    await confirmWith(' mint-lab ', CODE);
    await userEvent.click(screen.getByTestId('shop-delete-confirm'));

    expect(await screen.findByTestId('shop-delete-done')).toHaveTextContent('Магазин «Mint Lab» удалён полностью');
    expect(platform.shopDeleteChallenge).toHaveBeenCalledWith('id-mint-lab');
    expect(mfa.verifyTotp).toHaveBeenCalledWith('factor-1', CODE);
    expect(platform.shopDelete).toHaveBeenCalledWith('id-mint-lab', 'mint-lab');
    expect(firstCall(platform.shopDeleteChallenge)).toBeLessThan(firstCall(mfa.verifyTotp));
    expect(firstCall(mfa.verifyTotp)).toBeLessThan(firstCall(platform.shopDelete));
    expect(JSON.stringify([...platform.shopDeleteChallenge.mock.calls, ...platform.shopDelete.mock.calls])).not.toContain(CODE);
    // Nothing left to confirm.
    expect(screen.queryByTestId('shop-delete-confirm')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Готово' })).toBeInTheDocument();
  });

  it('a wrong or expired code: nothing is deleted, and the next attempt needs the current code again', async () => {
    mfa.verifyTotp.mockRejectedValue(new Error('Invalid TOTP code entered'));
    renderDialog();
    await confirmWith('mint-lab', CODE);
    await userEvent.click(screen.getByTestId('shop-delete-confirm'));

    expect(await screen.findByTestId('shop-delete-error')).toHaveTextContent('Код не подошёл или устарел');
    expect(platform.shopDelete).not.toHaveBeenCalled();
    expect(screen.getByTestId('shop-delete-code')).toHaveValue('');
    expect(screen.getByTestId('shop-delete-input')).toHaveValue('mint-lab');
    expect(screen.getByTestId('shop-delete-confirm')).toBeDisabled();
    expect(screen.queryByTestId('shop-delete-done')).not.toBeInTheDocument();
  });

  it('without a verified authenticator nothing is even started', async () => {
    mfa.listTotpFactors.mockResolvedValue([{ id: 'factor-0', status: 'unverified', created_at: '2026-10-01T10:00:00Z' }]);
    renderDialog();
    await confirmWith('mint-lab', CODE);
    await waitFor(() => expect(screen.getByTestId('shop-delete-confirm')).toBeEnabled());
    await userEvent.click(screen.getByTestId('shop-delete-confirm'));

    expect(await screen.findByTestId('shop-delete-error')).toHaveTextContent('Не найден подключённый аутентификатор');
    expect(platform.shopDeleteChallenge).not.toHaveBeenCalled();
    expect(mfa.verifyTotp).not.toHaveBeenCalled();
    expect(platform.shopDelete).not.toHaveBeenCalled();
  });

  it('when the server does not open the step-up (not a platform admin), the code is never asked to be verified', async () => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    platform.shopDeleteChallenge.mockRejectedValue(new AdminApiError(403, 'forbidden', null));
    renderDialog();
    await confirmWith('mint-lab', CODE);
    await userEvent.click(screen.getByTestId('shop-delete-confirm'));

    expect(await screen.findByTestId('shop-delete-error')).toHaveTextContent('Удалять магазины может только администратор платформы');
    expect(mfa.verifyTotp).not.toHaveBeenCalled();
    expect(platform.shopDelete).not.toHaveBeenCalled();
  });

  it.each([
    ['mfa_step_up_required', 'Удаление не подтверждено кодом'],
    ['confirmation_mismatch', 'Введённый slug не совпадает со slug магазина'],
    ['handover_in_progress', 'Сейчас идёт передача магазина клиенту'],
    ['deletion_verification_failed', 'изменения отменены'],
  ])('a refusal of the server (%s) is explained and the shop stays', async (code, text) => {
    const { AdminApiError } = await vi.importActual<typeof FunctionsApi>('../functions-api');
    platform.shopDelete.mockRejectedValue(new AdminApiError(409, code, null));
    renderDialog();
    await confirmWith('mint-lab', CODE);
    await userEvent.click(screen.getByTestId('shop-delete-confirm'));

    expect(await screen.findByTestId('shop-delete-error')).toHaveTextContent(text);
    expect(screen.queryByTestId('shop-delete-done')).not.toBeInTheDocument();
    // A code confirms one attempt only.
    expect(screen.getByTestId('shop-delete-code')).toHaveValue('');
  });

  it('a shop without an owner and without a bot: says so, and warns nobody', async () => {
    platform.shopDeletePreview.mockResolvedValue(preview({ members: [], has_owner: false, bot: null }));
    renderDialog({ ...shop, members: [] });
    expect(await screen.findByTestId('shop-delete-owner')).toHaveTextContent('не назначен');
    expect(screen.queryByTestId('shop-delete-owner-warning')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shop-delete-bot')).not.toBeInTheDocument();
  });

  it('a handover that is not finished yet is announced as cancelled by the deletion', async () => {
    platform.shopDeletePreview.mockResolvedValue(preview({ pending_handover: { email: 'new@client.test' } as ShopDeletePreview['pending_handover'] }));
    renderDialog();
    expect(await screen.findByTestId('shop-delete-pending-handover')).toHaveTextContent('new@client.test');
  });

  it('an interrupted deletion is continued without a new code (both confirmations were already checked)', async () => {
    platform.shopDeletePreview.mockResolvedValue(preview({ status: 'deleting', counts: undefined }));
    platform.demoDeleteResume.mockResolvedValue({ deletion: { status: 'deleted' } });
    renderDialog({ ...shop, status: 'deleting' });

    expect(await screen.findByTestId('shop-delete-in-progress')).toHaveTextContent('Удаление не завершено');
    expect(screen.queryByTestId('shop-delete-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('shop-delete-code')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('shop-delete-resume'));
    expect(await screen.findByTestId('shop-delete-done')).toBeInTheDocument();
    expect(platform.demoDeleteResume).toHaveBeenCalledWith('id-mint-lab');
    expect(platform.shopDeleteChallenge).not.toHaveBeenCalled();
    expect(mfa.verifyTotp).not.toHaveBeenCalled();
    expect(platform.shopDelete).not.toHaveBeenCalled();
  });

  it('«Отмена» closes the dialog without touching anything', async () => {
    const { onOpenChange } = renderDialog();
    await screen.findByTestId('shop-delete-summary');
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(platform.shopDeleteChallenge).not.toHaveBeenCalled();
    expect(platform.shopDelete).not.toHaveBeenCalled();
  });
});
