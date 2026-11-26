import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminShopContext } from '../admin-context';
import type { AdminShop } from '../api';
import type * as FunctionsApi from '../functions-api';
import { AdminApiError, type LoyaltyOverview, type LoyaltyPromo } from '../functions-api';
import { LoyaltyPage } from './LoyaltyPage';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  saveSettings: vi.fn(),
  saveRule: vi.fn(),
  deleteRule: vi.fn(),
  savePromo: vi.fn(),
  setPromoActive: vi.fn(),
  deletePromo: vi.fn(),
  promoHistory: vi.fn(),
  dispatch: vi.fn(),
}));
// Alias path: a relative vi.mock('../…') is not applied reliably in every checkout (see OrdersPage.loyalty.test.tsx).
vi.mock('@/features/admin/functions-api', async (importOriginal) => ({ ...(await importOriginal<typeof FunctionsApi>()), loyaltyApi: api }));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const shop = { id: 'shop-a', slug: 'noir-vapor', name: 'Noir Vapor' } as AdminShop;

const empty: LoyaltyOverview = {
  shop: { id: 'shop-a', slug: 'noir-vapor', currency: 'RUB' },
  settings: { bonus_enabled: false, bonus_percent: 5, discount_enabled: false, promo_enabled: false, configured: false, updated_at: null },
  rules: [],
  promos: [],
  stats: { customers: 0, balance_total: 0, earned_total: 0, spent_total: 0, notifications: { pending: 0, sent: 0, dead: 0 } },
  recent: [],
};
const promo = (over: Partial<LoyaltyPromo>): LoyaltyPromo => ({
  id: 'p1',
  code: 'WELCOME300',
  discount_type: 'fixed',
  percent: null,
  fixed_minor: 30_000,
  max_activations: 100,
  used_count: 34,
  pending_count: 0,
  is_active: true,
  status: 'active',
  created_at: '2026-11-25T09:00:00Z',
  ...over,
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AdminShopContext.Provider value={shop}>
        <LoyaltyPage />
      </AdminShopContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue(empty);
  api.dispatch.mockResolvedValue({ sent: 0, failed: 0, skipped: 0 });
});

describe('LoyaltyPage — «Бонусы и промокоды»', () => {
  it('everything is off by default and the three blocks are reachable from the tabs', async () => {
    renderPage();
    expect(await screen.findByTestId('loyalty-page')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Бонусная программа', 'Скидки от суммы заказа', 'Промокоды']);
    expect(screen.getByTestId('bonus-enabled')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('bonus-current')).toHaveTextContent('Сейчас: выключена');
    await userEvent.click(screen.getByTestId('loyalty-tab-discount'));
    expect(screen.getByTestId('discount-enabled')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('rules-empty')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('loyalty-tab-promo'));
    expect(screen.getByTestId('promo-enabled')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('promos-empty')).toBeInTheDocument();
    // The combination rule is stated on the page, not hidden.
    expect(screen.getByTestId('loyalty-order-rule')).toHaveTextContent('не суммируются');
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it('turns the bonus program on at once, shows the example of the task and saves a new percent', async () => {
    api.saveSettings.mockImplementation(async (_id: string, patch: { bonusEnabled?: boolean; bonusPercent?: number }) => ({
      ...empty,
      settings: { ...empty.settings, configured: true, bonus_enabled: patch.bonusEnabled ?? true, bonus_percent: patch.bonusPercent ?? 5 },
    }));
    renderPage();
    await userEvent.click(await screen.findByTestId('bonus-enabled'));
    expect(api.saveSettings).toHaveBeenCalledWith('shop-a', { bonusEnabled: true });
    await waitFor(() => expect(screen.getByTestId('bonus-current')).toHaveTextContent('Сейчас: включена, начисляется 5% с подтверждённого заказа'));
    expect(screen.getByTestId('bonus-example')).toHaveTextContent('150 бонусов');

    const input = screen.getByTestId('bonus-percent');
    await userEvent.clear(input);
    await userEvent.type(input, '7,5');
    expect(screen.getByTestId('bonus-example')).toHaveTextContent('225 бонусов');
    await userEvent.click(screen.getByTestId('bonus-percent-save'));
    expect(api.saveSettings).toHaveBeenLastCalledWith('shop-a', { bonusPercent: 7.5 });
    await waitFor(() => expect(screen.getByTestId('bonus-current')).toHaveTextContent('7,5%'));
  });

  it('refuses a percent outside (0, 100] and shows the server error in plain words', async () => {
    api.saveSettings.mockRejectedValue(new AdminApiError(400, 'invalid_percent', null));
    renderPage();
    const input = await screen.findByTestId('bonus-percent');
    await userEvent.clear(input);
    await userEvent.type(input, '101');
    expect(screen.getByTestId('bonus-percent-save')).toBeDisabled();
    expect(screen.getByText(/Укажите число больше 0 и не больше 100/)).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, '3');
    await userEvent.click(screen.getByTestId('bonus-percent-save'));
    expect(await screen.findByText(/Процент должен быть больше 0/)).toBeInTheDocument();
  });

  it('adds, edits and deletes discount rules; the table shows the minimum and the percent', async () => {
    const rule = { id: 'r1', min_total_minor: 300_000, percent: 5 };
    api.get.mockResolvedValue({ ...empty, settings: { ...empty.settings, discount_enabled: true }, rules: [rule] });
    api.saveRule.mockImplementation(async (_id: string, r: { ruleId?: string; minTotalMinor: number; percent: number }) => ({
      ...empty,
      settings: { ...empty.settings, discount_enabled: true },
      rules: [{ id: r.ruleId ?? 'r2', min_total_minor: r.minTotalMinor, percent: r.percent }, ...(r.ruleId ? [] : [rule])],
    }));
    api.deleteRule.mockResolvedValue({ ...empty, settings: { ...empty.settings, discount_enabled: true }, rules: [] });
    renderPage();
    await userEvent.click(await screen.findByTestId('loyalty-tab-discount'));
    expect(screen.getByTestId('discount-enabled')).toHaveAttribute('aria-checked', 'true');
    const rows = screen.getAllByTestId('rule-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('5%');
    expect(rows[0]!.textContent).toMatch(/3\s?000\s?₽/);

    expect(screen.getByTestId('rule-save')).toBeDisabled();
    await userEvent.type(screen.getByTestId('rule-min'), '5 000');
    await userEvent.type(screen.getByTestId('rule-percent'), '7');
    await userEvent.click(screen.getByTestId('rule-save'));
    expect(api.saveRule).toHaveBeenCalledWith('shop-a', { ruleId: undefined, minTotalMinor: 500_000, percent: 7 });

    // Edit the first rule: the form is filled with its values, saving sends its id.
    await userEvent.click((await screen.findAllByRole('button', { name: /Изменить правило от/ }))[0]!);
    expect(screen.getByTestId('rule-percent')).toHaveValue('7');
    await userEvent.clear(screen.getByTestId('rule-percent'));
    await userEvent.type(screen.getByTestId('rule-percent'), '9');
    await userEvent.click(screen.getByTestId('rule-save'));
    expect(api.saveRule).toHaveBeenLastCalledWith('shop-a', { ruleId: 'r2', minTotalMinor: 500_000, percent: 9 });

    await userEvent.click((await screen.findAllByRole('button', { name: /Удалить правило от/ }))[0]!);
    await userEvent.click(await screen.findByTestId('rule-delete-confirm'));
    expect(api.deleteRule).toHaveBeenCalledWith('shop-a', 'r2');
  });

  it('rejects a rule with an empty amount, a zero or too large percent before sending anything', async () => {
    renderPage();
    await userEvent.click(await screen.findByTestId('loyalty-tab-discount'));
    for (const [min, pct] of [['', '5'], ['3000', '0'], ['3000', '91'], ['abc', '5']] as const) {
      await userEvent.clear(screen.getByTestId('rule-min'));
      await userEvent.clear(screen.getByTestId('rule-percent'));
      if (min) await userEvent.type(screen.getByTestId('rule-min'), min);
      await userEvent.type(screen.getByTestId('rule-percent'), pct);
      expect(screen.getByTestId('rule-save'), `${min} / ${pct}`).toBeDisabled();
    }
    expect(api.saveRule).not.toHaveBeenCalled();
  });

  it('creates a fixed-amount code with a limit, as the task describes (WELCOME300 · 300 ₽ · 100 activations)', async () => {
    api.savePromo.mockResolvedValue({ ...empty, promos: [promo({ used_count: 0 })] });
    renderPage();
    await userEvent.click(await screen.findByTestId('loyalty-tab-promo'));
    expect(screen.getByTestId('promo-save')).toBeDisabled();
    await userEvent.type(screen.getByTestId('promo-code'), 'welcome300');
    expect(screen.getByTestId('promo-type-fixed')).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByTestId('promo-value'), '300');
    expect(screen.getByTestId('promo-limit')).toHaveValue('100');
    await userEvent.click(screen.getByTestId('promo-save'));
    expect(api.savePromo).toHaveBeenCalledWith('shop-a', {
      promoId: undefined,
      code: 'WELCOME300',
      discountType: 'fixed',
      value: 30_000,
      maxActivations: 100,
      isActive: true,
    });
    expect(await screen.findByTestId('promo-row')).toHaveTextContent('WELCOME300');
  });

  it('creates a percent code; the percent is limited to 1–90 and the amount field switches meaning', async () => {
    api.savePromo.mockResolvedValue({ ...empty, promos: [promo({ code: 'SALE10', discount_type: 'percent', percent: 10, fixed_minor: null })] });
    renderPage();
    await userEvent.click(await screen.findByTestId('loyalty-tab-promo'));
    await userEvent.type(screen.getByTestId('promo-code'), 'SALE10');
    await userEvent.click(screen.getByTestId('promo-type-percent'));
    expect(screen.getByTestId('promo-type-percent')).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByTestId('promo-value'), '95');
    expect(screen.getByTestId('promo-save')).toBeDisabled();
    await userEvent.clear(screen.getByTestId('promo-value'));
    await userEvent.type(screen.getByTestId('promo-value'), '10');
    await userEvent.click(screen.getByTestId('promo-save'));
    expect(api.savePromo).toHaveBeenCalledWith('shop-a', expect.objectContaining({ code: 'SALE10', discountType: 'percent', value: 10, maxActivations: 100 }));
  });

  it('lists code, discount, used, limit and status; a finished code is marked, a disabled one can be switched on again', async () => {
    api.get.mockResolvedValue({
      ...empty,
      settings: { ...empty.settings, promo_enabled: true },
      promos: [
        promo({}),
        promo({ id: 'p2', code: 'SALE10', discount_type: 'percent', percent: 10, fixed_minor: null, used_count: 100, status: 'finished' }),
        promo({ id: 'p3', code: 'OFFLINE', is_active: false, status: 'disabled', used_count: 3, pending_count: 1 }),
      ],
    });
    api.setPromoActive.mockResolvedValue({ ...empty, settings: { ...empty.settings, promo_enabled: true }, promos: [promo({ id: 'p3', code: 'OFFLINE', used_count: 3 })] });
    renderPage();
    await userEvent.click(await screen.findByTestId('loyalty-tab-promo'));
    const rows = screen.getAllByTestId('promo-row');
    const cells = (row: HTMLElement) => [...row.querySelectorAll('td')].slice(0, 5).map((c) => c.textContent?.replace(/\s+/g, ' ').trim());
    expect(cells(rows[0]!)).toEqual(['WELCOME300', '300 ₽', '34', '100', 'Активен']);
    expect(cells(rows[1]!)).toEqual(['SALE10', '10%', '100', '100', 'Завершён']);
    expect(cells(rows[2]!)).toEqual(['OFFLINE', '300 ₽', '3 (ждут подтверждения: 1)', '100', 'Отключён']);
    await userEvent.click(within(rows[2]!).getByRole('button', { name: 'Включить промокод OFFLINE' }));
    expect(api.setPromoActive).toHaveBeenCalledWith('shop-a', 'p3', true);
  });

  it('shows the server refusal (a code that exists already) in plain words', async () => {
    api.savePromo.mockRejectedValue(new AdminApiError(409, 'promo_exists', null));
    renderPage();
    await userEvent.click(await screen.findByTestId('loyalty-tab-promo'));
    await userEvent.type(screen.getByTestId('promo-code'), 'DUPLICATE');
    await userEvent.type(screen.getByTestId('promo-value'), '100');
    await userEvent.click(screen.getByTestId('promo-save'));
    expect(await screen.findByText(/Такой промокод в вашем магазине уже есть/)).toBeInTheDocument();
  });

  it('retries the queued «начислено» messages once when it opens with some waiting', async () => {
    api.get.mockResolvedValue({ ...empty, stats: { ...empty.stats, notifications: { pending: 2, sent: 0, dead: 0 } } });
    renderPage();
    await screen.findByTestId('loyalty-page');
    await waitFor(() => expect(api.dispatch).toHaveBeenCalledTimes(1));
    expect(api.dispatch).toHaveBeenCalledWith('shop-a');
  });
});
