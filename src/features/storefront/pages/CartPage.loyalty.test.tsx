import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CartQuote } from '@/domain/loyalty';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { cartStore } from '@/features/cart/cart-store';
import type * as CheckoutApi from '@/features/cart/checkout-api';
import type { TelegramEnv } from '@/features/telegram/telegram';
import type { Shop } from '../api';
import { ShopContext } from '../shop-context';
import { CartPage } from './CartPage';

// The cart of a shop WITH bonuses / discounts / promo codes. The server's quote is a stub here (its arithmetic is covered by
// tests/integration/loyalty.test.ts); what is checked is what the buyer sees and what the cart sends to checkout.
let tgEnv: TelegramEnv = { inTelegram: true, rawInitData: 'user=%7B%22id%22%3A42%7D&hash=abc', startParam: null, platform: 'android' };
vi.mock('@/features/telegram/telegram', () => ({ getTelegramEnv: () => tgEnv, openTelegramUrl: () => false }));

const api = vi.hoisted(() => ({ fetchCartQuote: vi.fn(), submitCheckout: vi.fn() }));
vi.mock('@/features/cart/checkout-api', async (importOriginal) => ({
  ...(await importOriginal<typeof CheckoutApi>()),
  fetchCartQuote: api.fetchCartQuote,
  submitCheckout: api.submitCheckout,
}));

const shop = {
  id: 'shop-loyalty',
  slug: 'noir',
  name: 'Noir',
  currency: 'RUB',
  mode: 'live',
  isDemo: false,
  theme: DARK_PREMIUM_THEME,
  fulfillment: { delivery: false, pickup: true, pickupInstructions: '' },
} as Shop;

const line = { variantId: 'v1', productId: 'p1', name: 'Noir Salt', variantLabel: 'Черника', unitPriceMinor: 100_000, imagePath: null, maxQuantity: 99 };

const quote = (over: Partial<CartQuote> = {}): CartQuote => ({
  currency: 'RUB',
  features: { bonus: false, discount: false, promo: false },
  subtotal_minor: 300_000,
  threshold: null,
  next_threshold: null,
  promo: null,
  discount: { type: null, minor: 0, info: null },
  after_discount_minor: 300_000,
  bonus: { enabled: false, percent: null, balance: 0, requested: 0, applied: 0, max_spend: 0, spend_minor: 0, unit_minor: 100 },
  total_minor: 300_000,
  accrual_preview: 0,
  ...over,
});

function renderCart() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ShopContext.Provider value={shop}>
        <MemoryRouter>
          <CartPage />
        </MemoryRouter>
      </ShopContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  cartStore._resetCache();
  tgEnv = { inTelegram: true, rawInitData: 'user=%7B%22id%22%3A42%7D&hash=abc', startParam: null, platform: 'android' };
  cartStore.add(shop.id, line, 3);
  api.submitCheckout.mockResolvedValue({
    replayed: false,
    order: { id: 'o1', order_number: 12, total_minor: 270_000, currency: 'RUB', is_test: false, discount_minor: 30_000, bonus_spent: 0, items: [] },
  });
});

const plain = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim();

describe('CartPage — a shop with all the new features OFF', () => {
  it('looks and behaves exactly as before: the old total, no promo field, no bonus block, checkout without extra fields', async () => {
    api.fetchCartQuote.mockResolvedValue(quote());
    renderCart();
    expect(await screen.findByTestId('cart-total')).toHaveTextContent(/3\s?000\s?₽/);
    // The submit button waits for the (empty) quote, then is the plain one.
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    expect(screen.queryByTestId('cart-pricing')).not.toBeInTheDocument();
    expect(screen.queryByTestId('promo-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cart-bonus')).not.toBeInTheDocument();
    expect(screen.getByTestId('checkout-submit')).toHaveTextContent(/Оформить заказ · 3\s?000\s?₽/);

    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => expect(api.submitCheckout).toHaveBeenCalledTimes(1));
    const [, input] = api.submitCheckout.mock.calls[0] as [string, Record<string, unknown>];
    expect(input).toMatchObject({ shopSlug: 'noir', expectedTotalMinor: 300_000, promoCode: null, bonusSpend: 0 });
  });

  it('a shop without the cart-quote function (older server) keeps working: the plain total is used', async () => {
    const { ApiError } = await import('@/features/cart/checkout-api');
    api.fetchCartQuote.mockRejectedValue(new ApiError(404, 'unknown_error', null));
    renderCart();
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    expect(screen.getByTestId('cart-total')).toHaveTextContent(/3\s?000\s?₽/);
    expect(screen.queryByTestId('cart-quote-failed')).not.toBeInTheDocument();
  });

  it('a server error while pricing blocks checkout and offers a retry (the amount would be a guess)', async () => {
    const { ApiError } = await import('@/features/cart/checkout-api');
    api.fetchCartQuote.mockRejectedValue(new ApiError(500, 'internal_error', null));
    renderCart();
    // A server error is retried once by the query itself, then shown.
    expect(await screen.findByTestId('cart-quote-failed', undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByTestId('checkout-submit')).toBeDisabled();
    api.fetchCartQuote.mockResolvedValue(quote());
    await userEvent.click(within(screen.getByTestId('cart-quote-failed')).getByRole('button', { name: 'Повторить' }));
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
  });
});

describe('CartPage — automatic discount by order total', () => {
  it('shows the sum, the reached threshold, the percent, the saving, the hint for the next level and the total', async () => {
    api.fetchCartQuote.mockResolvedValue(
      quote({
        features: { bonus: false, discount: true, promo: false },
        threshold: { percent: 5, min_total_minor: 300_000, discount_minor: 15_000 },
        next_threshold: { percent: 7, min_total_minor: 500_000, remaining_minor: 200_000 },
        discount: { type: 'threshold', minor: 15_000, info: { percent: 5, min_total_minor: 300_000 } },
        after_discount_minor: 285_000,
        total_minor: 285_000,
      }),
    );
    renderCart();
    expect(await screen.findByTestId('cart-pricing')).toBeInTheDocument();
    expect(plain(screen.getByTestId('cart-subtotal').parentElement!)).toMatch(/^Сумма товаров\s?3 000 ₽$/);
    expect(plain(screen.getByTestId('cart-discount').parentElement!)).toMatch(/^Скидка за сумму заказа 5% \(от 3 000 ₽\)\s?−150 ₽$/);
    expect(screen.getByTestId('cart-savings')).toHaveTextContent(/Вы экономите 150\s?₽/);
    expect(screen.getByTestId('cart-total')).toHaveTextContent(/2\s?850\s?₽/);
    expect(plain(screen.getByTestId('cart-next-threshold'))).toBe('Добавьте товаров ещё на 2 000 ₽ и получите скидку 7%.');
    // No promo field when promo codes are off, no bonus block when bonuses are off.
    expect(screen.queryByTestId('promo-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('cart-bonus')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    expect(screen.getByTestId('checkout-submit')).toHaveTextContent(/Оформить заказ · 2\s?850\s?₽/);
  });

  it('checkout sends the total the buyer saw; nothing about the discount itself is sent as an amount', async () => {
    api.fetchCartQuote.mockResolvedValue(
      quote({
        features: { bonus: false, discount: true, promo: false },
        discount: { type: 'threshold', minor: 15_000, info: { percent: 5, min_total_minor: 300_000 } },
        threshold: { percent: 5, min_total_minor: 300_000, discount_minor: 15_000 },
        total_minor: 285_000,
      }),
    );
    renderCart();
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => expect(api.submitCheckout).toHaveBeenCalledTimes(1));
    const [, input] = api.submitCheckout.mock.calls[0] as [string, Record<string, unknown>];
    expect(input).toMatchObject({ expectedTotalMinor: 285_000, promoCode: null, bonusSpend: 0 });
    expect(Object.keys(input)).not.toContain('discountMinor');
  });
});

describe('CartPage — promo code', () => {
  const promoQuote = (promo: CartQuote['promo'], over: Partial<CartQuote> = {}) =>
    quote({ features: { bonus: false, discount: false, promo: true }, promo, ...over });

  it('«Введите промокод» → «Применить»: the server answer shows the discount and the new total, and checkout carries the code', async () => {
    api.fetchCartQuote.mockImplementation(async (_init: string, input: { promoCode?: string | null }) =>
      input.promoCode === 'WELCOME300'
        ? promoQuote(
            { code: 'WELCOME300', status: 'applied', reason: null, discount_minor: 30_000, kind: 'fixed', percent: null, fixed_minor: 30_000 },
            { discount: { type: 'promo', minor: 30_000, info: { code: 'WELCOME300' } }, after_discount_minor: 270_000, total_minor: 270_000 },
          )
        : promoQuote(null),
    );
    renderCart();
    const input = await screen.findByTestId('promo-input');
    expect(screen.getByPlaceholderText('Введите промокод')).toBe(input);
    expect(screen.getByTestId('promo-apply')).toBeDisabled();
    await userEvent.type(input, 'welcome300');
    await userEvent.click(screen.getByTestId('promo-apply'));
    expect(await screen.findByTestId('promo-applied')).toHaveTextContent('WELCOME300');
    expect(screen.getByTestId('promo-applied')).toHaveTextContent(/скидка 300\s?₽/);
    await waitFor(() => expect(screen.getByTestId('cart-total')).toHaveTextContent(/2\s?700\s?₽/));
    expect(plain(screen.getByTestId('cart-discount').parentElement!)).toMatch(/^Промокод WELCOME300\s?−300 ₽$/);
    expect(api.fetchCartQuote).toHaveBeenLastCalledWith('user=%7B%22id%22%3A42%7D&hash=abc', expect.objectContaining({ shopSlug: 'noir', promoCode: 'WELCOME300' }));

    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => expect(api.submitCheckout).toHaveBeenCalledTimes(1));
    expect((api.submitCheckout.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ promoCode: 'WELCOME300', expectedTotalMinor: 270_000 });
  });

  it.each([
    ['not_found', /Такого промокода нет/],
    ['inactive', /сейчас не действует/],
    ['exhausted', /уже использовали максимальное число раз/],
  ] as const)('a refused code (%s) is explained in plain words and is NOT sent to checkout', async (reason, text) => {
    api.fetchCartQuote.mockImplementation(async (_init: string, input: { promoCode?: string | null }) =>
      promoQuote(input.promoCode ? { code: input.promoCode, status: 'invalid', reason, discount_minor: 0, kind: null, percent: null, fixed_minor: null } : null),
    );
    renderCart();
    await userEvent.type(await screen.findByTestId('promo-input'), 'bad');
    await userEvent.click(screen.getByTestId('promo-apply'));
    expect(await screen.findByTestId('promo-message')).toHaveTextContent(text);
    expect(screen.getByTestId('cart-total')).toHaveTextContent(/3\s?000\s?₽/);
    // The buyer can remove the refused code and try another one.
    await userEvent.click(screen.getByTestId('promo-remove'));
    expect(screen.getByTestId('promo-input')).toBeInTheDocument();
    await userEvent.type(screen.getByTestId('promo-input'), 'bad');
    await userEvent.click(screen.getByTestId('promo-apply'));
    await screen.findByTestId('promo-message');
    // The refused code stays out of the order.
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => expect(api.submitCheckout).toHaveBeenCalledTimes(1));
    expect((api.submitCheckout.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ promoCode: null, expectedTotalMinor: 300_000 });
  });

  it('a code that would not be better than the automatic discount says so — the two never add up', async () => {
    api.fetchCartQuote.mockImplementation(async (_init: string, input: { promoCode?: string | null }) =>
      quote({
        features: { bonus: false, discount: true, promo: true },
        threshold: { percent: 7, min_total_minor: 300_000, discount_minor: 21_000 },
        discount: { type: 'threshold', minor: 21_000, info: { percent: 7, min_total_minor: 300_000 } },
        total_minor: 279_000,
        promo: input.promoCode ? { code: input.promoCode, status: 'not_applied', reason: 'better_discount', discount_minor: 0, kind: 'fixed', percent: null, fixed_minor: 30_000 } : null,
      }),
    );
    renderCart();
    expect(await screen.findByTestId('promo-stacking-note')).toHaveTextContent('не суммируются');
    await userEvent.type(screen.getByTestId('promo-input'), 'fix10');
    await userEvent.click(screen.getByTestId('promo-apply'));
    expect(await screen.findByTestId('promo-message')).toHaveTextContent(/Скидка за сумму заказа выгоднее — промокод не применён и не потрачен/);
    expect(screen.getByTestId('cart-discount')).toHaveTextContent(/−210\s?₽/);
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => expect(api.submitCheckout).toHaveBeenCalledTimes(1));
    expect((api.submitCheckout.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ promoCode: null, expectedTotalMinor: 279_000 });
  });

  it('the server refusing the code at checkout (it ran out meanwhile) is explained, the code is dropped and the cart recalculated', async () => {
    const { ApiError } = await import('@/features/cart/checkout-api');
    api.fetchCartQuote.mockImplementation(async (_init: string, input: { promoCode?: string | null }) =>
      input.promoCode
        ? promoQuote(
            { code: input.promoCode, status: 'applied', reason: null, discount_minor: 30_000, kind: 'fixed', percent: null, fixed_minor: 30_000 },
            { discount: { type: 'promo', minor: 30_000, info: { code: input.promoCode } }, total_minor: 270_000 },
          )
        : promoQuote(null),
    );
    api.submitCheckout.mockRejectedValue(new ApiError(409, 'promo_invalid', { reason: 'exhausted' }));
    renderCart();
    await userEvent.type(await screen.findByTestId('promo-input'), 'last1');
    await userEvent.click(screen.getByTestId('promo-apply'));
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/уже использовали максимальное число раз.*Заказ не оформлен/);
    await waitFor(() => expect(screen.getByTestId('promo-input')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('cart-total')).toHaveTextContent(/3\s?000\s?₽/));
  });
});

describe('CartPage — using bonuses', () => {
  const bonusQuote = (requested: number, applied: number, over: Partial<CartQuote> = {}) =>
    quote({
      features: { bonus: true, discount: false, promo: false },
      bonus: { enabled: true, percent: 5, balance: 150, requested, applied, max_spend: 150, spend_minor: applied * 100, unit_minor: 100 },
      total_minor: 300_000 - applied * 100,
      accrual_preview: Math.floor(((300_000 - applied * 100) * 5) / 10_000),
      ...over,
    });

  it('shows the balance; «Использовать бонусы» recalculates the total; checkout sends the bonuses the server accepted', async () => {
    api.fetchCartQuote.mockImplementation(async (_init: string, input: { bonusSpend?: number }) => {
      const asked = input.bonusSpend ?? 0;
      return bonusQuote(asked, Math.min(asked, 150));
    });
    renderCart();
    expect(await screen.findByTestId('bonus-balance')).toHaveTextContent('Доступно: 150 бонусов');
    expect(screen.getByTestId('cart-accrual-preview')).toHaveTextContent('вы получите 150 бонусов');
    expect(screen.queryByTestId('bonus-input')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('bonus-toggle'));
    // Switching it on offers the maximum.
    expect(screen.getByTestId('bonus-input')).toHaveValue('150');
    await waitFor(() => expect(screen.getByTestId('cart-bonus-spent')).toBeInTheDocument());
    expect(plain(screen.getByTestId('cart-bonus-spent').parentElement!)).toMatch(/^Оплачено бонусами \(150 бонусов\)\s?−150 ₽$/);
    expect(screen.getByTestId('cart-total')).toHaveTextContent(/2\s?850\s?₽/);

    await userEvent.clear(screen.getByTestId('bonus-input'));
    await userEvent.type(screen.getByTestId('bonus-input'), '50');
    await waitFor(() => expect(screen.getByTestId('cart-total')).toHaveTextContent(/2\s?950\s?₽/));
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => expect(api.submitCheckout).toHaveBeenCalledTimes(1));
    expect((api.submitCheckout.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ bonusSpend: 50, expectedTotalMinor: 295_000 });
  });

  it('a request above the balance is clamped by the server and the buyer is told how much is possible', async () => {
    api.fetchCartQuote.mockImplementation(async (_init: string, input: { bonusSpend?: number }) => {
      const asked = input.bonusSpend ?? 0;
      return bonusQuote(asked, Math.min(asked, 150));
    });
    renderCart();
    await userEvent.click(await screen.findByTestId('bonus-toggle'));
    await userEvent.clear(screen.getByTestId('bonus-input'));
    await userEvent.type(screen.getByTestId('bonus-input'), '9999');
    expect(await screen.findByTestId('bonus-clamped')).toHaveTextContent('Можно списать не больше 150 бонусов');
    await waitFor(() => expect(screen.getByTestId('cart-total')).toHaveTextContent(/2\s?850\s?₽/));
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    await waitFor(() => expect(api.submitCheckout).toHaveBeenCalledTimes(1));
    // Never more than the server accepted.
    expect((api.submitCheckout.mock.calls[0] as [string, Record<string, unknown>])[1]).toMatchObject({ bonusSpend: 150 });
  });

  it('a buyer without bonuses sees why, and spends nothing', async () => {
    api.fetchCartQuote.mockResolvedValue(bonusQuote(0, 0, { bonus: { enabled: true, percent: 5, balance: 0, requested: 0, applied: 0, max_spend: 0, spend_minor: 0, unit_minor: 100 } }));
    renderCart();
    expect(await screen.findByTestId('bonus-balance')).toHaveTextContent('Доступно: 0 бонусов');
    expect(screen.queryByTestId('bonus-toggle')).not.toBeInTheDocument();
    expect(screen.getByTestId('cart-bonus')).toHaveTextContent('Бонусов пока нет');
  });

  it('the server refusing the bonuses at checkout (the balance moved) drops them and recalculates', async () => {
    const { ApiError } = await import('@/features/cart/checkout-api');
    api.fetchCartQuote.mockImplementation(async (_init: string, input: { bonusSpend?: number }) => bonusQuote(input.bonusSpend ?? 0, Math.min(input.bonusSpend ?? 0, 150)));
    api.submitCheckout.mockRejectedValue(new ApiError(409, 'insufficient_bonus', { balance: 10 }));
    renderCart();
    await userEvent.click(await screen.findByTestId('bonus-toggle'));
    await waitFor(() => expect(screen.getByTestId('cart-bonus-spent')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('checkout-submit')).toBeEnabled());
    await userEvent.click(screen.getByTestId('fulfillment-pickup'));
    await userEvent.click(screen.getByTestId('checkout-submit'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Бонусов на балансе меньше/);
    await waitFor(() => expect(screen.queryByTestId('bonus-input')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('cart-total')).toHaveTextContent(/3\s?000\s?₽/));
  });
});

describe('CartPage — outside Telegram and DEMO', () => {
  it('asks nothing of the server when the shop is opened outside Telegram', async () => {
    tgEnv = { inTelegram: false, rawInitData: null, startParam: null, platform: null };
    renderCart();
    expect(await screen.findByTestId('cart-total')).toHaveTextContent(/3\s?000\s?₽/);
    expect(api.fetchCartQuote).not.toHaveBeenCalled();
    expect(screen.getByTestId('checkout-submit')).toBeDisabled();
  });
});
