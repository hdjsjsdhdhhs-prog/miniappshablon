import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { resolveSupabaseEnv, serviceClient } from '../scripts/lib/supabase-env.ts';
import { mockBotState, mockMessages } from '../scripts/lib/telegram-mock.ts';
import { createAccount, createLiveShop, deleteShops, deleteUsers, localSql, type Account } from './shops';
import { openAsTelegramUser } from './telegram';

// «Бонусы и промокоды» (20261125090000) in a real browser against the LOCAL stack. Telegram is the local mock Bot API and
// the bot token is fake. The path of the task's success criterion: everything is OFF in a new shop (the cart is as before) →
// the owner switches on the bonus program (5%), an automatic discount (from 3 000 ₽) and a promo code (fixed, 100 activations)
// → the buyer sees the discount and the hint in the cart, applies the code, orders → the activation is only reserved, no bonus
// yet → the owner confirms → bonuses are credited, shown in the buyer's profile and announced by the shop's own bot (mock) →
// the next order is partly paid with bonuses → cancelling it gives them back.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const slug = `e2e-loyal-${run}`;
const name = `Loyal ${run}`;
const created = { shops: [] as string[], users: [] as string[] };
let owner: Account;
let shop: Awaited<ReturnType<typeof createLiveShop>>;

/** "3 000 ₽" with any kind of space between the groups; `sign` is the minus the cart prints. */
const money = (rub: number, sign = '') => new RegExp(`^${sign}${String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s?')}\\s?₽$`);
const inText = (rub: number) => new RegExp(`${String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, '\\s?')}\\s?₽`);

async function login(page: Page, a: Account) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

let updateSeq = Math.floor(Math.random() * 1_000_000_000);
/** A private message of a Telegram user to the bot, delivered to its webhook exactly like Telegram does. */
async function tellBot(botId: number, user: number, text: string) {
  const hook = (await mockBotState(botId)).webhook;
  if (!hook) throw new Error('the bot has no webhook');
  const res = await fetch(`${resolveSupabaseEnv().url}/functions/v1/telegram-webhook?c=${new URL(hook.url).searchParams.get('c')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': hook.secret_token! },
    body: JSON.stringify({
      update_id: updateSeq++,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), text, chat: { id: user, type: 'private' }, from: { id: user, is_bot: false, first_name: 'Buyer' } },
    }),
  });
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
}

const orderRow = async (orderNumber: number) =>
  (
    await db
      .from('orders')
      .select('id, status, total_minor, items_total_minor, discount_type, discount_minor, bonus_spent, bonus_accrued, customer_tg_id')
      .eq('shop_id', shop.id)
      .eq('order_number', orderNumber)
      .single()
  ).data!;
const ledgerCount = (buyer: number) => Number(localSql(`select count(*) from private.bonus_ledger where shop_id = '${shop.id}' and customer_tg_id = ${buyer};`));
const balanceOf = (buyer: number) => Number(localSql(`select coalesce((select balance from private.customer_bonus_accounts where shop_id = '${shop.id}' and customer_tg_id = ${buyer}), 0);`));

test.beforeAll(async () => {
  owner = await createAccount('loyal-owner');
  created.users.push(owner.id);
  // 1 000 ₽ a unit, so three units reach the 3 000 ₽ threshold exactly.
  shop = await createLiveShop(owner.id, slug, name, { priceMinor: 100_000, stock: 50 });
  created.shops.push(shop.id);
});

test.afterAll(async () => {
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('bonuses, the discount from 3 000 ₽ and a promo code: off by default, set up by the owner, used by the buyer, confirmed, refunded on cancel', async ({ page, browser }) => {
  test.setTimeout(300_000);
  const botId = 710_000_000 + Math.floor(Math.random() * 1e8);
  const token = `${botId}:FAKE_e2e_${randomBytes(16).toString('hex')}`;
  const buyer = { id: 8_500_000_000 + Math.floor(Math.random() * 1_000_000_000), first_name: 'E2E' };

  const adminCtx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } });
  const admin = await adminCtx.newPage();
  await login(admin, owner);

  // --- The shop's own bot, and the buyer pressed Start in it --------------------------------------------------------
  await admin.goto(`/admin/shops/${slug}/bot`);
  await admin.getByTestId('bot-token').fill(token);
  await admin.getByTestId('bot-connect').click();
  await expect(admin.getByTestId('bot-username')).toHaveText(`@mock_${botId}_bot`);
  await tellBot(botId, buyer.id, '/start');

  // --- Everything is OFF: the cart is exactly as before -------------------------------------------------------------
  const addOne = async () => {
    await openAsTelegramUser(page, `/s/${slug}/`, buyer);
    await page.getByTestId('product-card').filter({ hasText: 'Liquid' }).getByTestId('product-card-link').click();
    const mint = page.getByRole('radio', { name: 'Mint' });
    if (await mint.count()) await mint.click();
    await page.getByTestId('add-to-cart').click();
    await page.getByRole('link', { name: /Корзина/ }).click();
    await expect(page.getByTestId('cart-line')).toHaveCount(1);
  };
  await addOne();
  await expect(page.getByTestId('cart-total')).toHaveText(money(1000));
  await expect(page.getByTestId('cart-pricing')).toHaveCount(0);
  await expect(page.getByTestId('cart-promo')).toHaveCount(0);
  await expect(page.getByTestId('cart-bonus')).toHaveCount(0);
  await page.getByRole('button', { name: 'Очистить' }).click();

  // --- Owner: the section sits right before «Подключение бота» ------------------------------------------------------
  await admin.goto(`/admin/shops/${slug}/orders`);
  const nav = admin.getByRole('navigation', { name: 'Разделы магазина' });
  await expect(nav.getByRole('link', { name: 'Подключение бота', exact: true })).toBeVisible();
  const labels = (await nav.getByRole('link').allTextContents()).map((t) => t.trim());
  const at = labels.indexOf('Бонусы и промокоды');
  expect(at).toBeGreaterThan(0);
  expect(labels[at - 1]).toBe('Уведомления');
  expect(labels[at + 1]).toBe('Подключение бота');
  await nav.getByRole('link', { name: 'Бонусы и промокоды', exact: true }).click();
  await expect(admin.getByTestId('loyalty-page')).toBeVisible();
  await expect(admin.getByTestId('bonus-current')).toContainText('выключена');

  // --- Owner: bonus program 5% -------------------------------------------------------------------------------------
  await admin.getByTestId('bonus-enabled').click();
  await expect(admin.getByTestId('bonus-current')).toContainText('включена');
  await admin.getByTestId('bonus-percent').fill('7');
  await admin.getByTestId('bonus-percent-save').click();
  await expect(admin.getByTestId('bonus-current')).toContainText('7%');
  await admin.getByTestId('bonus-percent').fill('5');
  await admin.getByTestId('bonus-percent-save').click();
  await expect(admin.getByTestId('bonus-current')).toContainText('5%');
  await expect(admin.getByTestId('bonus-example')).toContainText('150');

  // --- Owner: automatic discount, 5% from 3 000 ₽ --------------------------------------------------------------------
  await admin.getByTestId('loyalty-tab-discount').click();
  await admin.getByTestId('discount-enabled').click();
  await expect(admin.getByTestId('loyalty-discount').getByText('Включено', { exact: true })).toBeVisible();
  await admin.getByTestId('rule-min').fill('3000');
  await admin.getByTestId('rule-percent').fill('5');
  await admin.getByTestId('rule-save').click();
  const rule = admin.getByTestId('rule-row');
  await expect(rule).toHaveCount(1);
  await expect(rule).toContainText(inText(3000));
  await expect(rule).toContainText('5%');

  // --- Owner: promo code WELCOME300, 300 ₽, 100 activations -----------------------------------------------------------
  await admin.getByTestId('loyalty-tab-promo').click();
  await admin.getByTestId('promo-enabled').click();
  await expect(admin.getByTestId('loyalty-promo').getByText('Включено', { exact: true })).toBeVisible();
  await admin.getByTestId('promo-code').fill('welcome300');
  await admin.getByTestId('promo-type-fixed').click();
  await admin.getByTestId('promo-value').fill('300');
  await admin.getByTestId('promo-limit').fill('100');
  await admin.getByTestId('promo-save').click();
  const promoRow = admin.locator('[data-testid="promo-row"][data-code="WELCOME300"]');
  await expect(promoRow).toBeVisible();
  await expect(promoRow).toContainText(inText(300));
  await expect(promoRow.getByTestId('promo-used')).toHaveText('0');
  await expect(promoRow).toContainText('100');
  await expect(promoRow.getByTestId('promo-status')).toHaveText('Активен');

  // --- Buyer: 2 units → hint; 3 units → threshold discount; the better promo replaces it ------------------------------
  await addOne();
  await page.getByRole('group', { name: /Количество: Liquid/ }).getByRole('button', { name: 'Увеличить' }).click();
  await expect(page.getByTestId('cart-subtotal')).toHaveText(money(2000));
  await expect(page.getByTestId('cart-next-threshold')).toContainText(inText(1000));
  await expect(page.getByTestId('cart-next-threshold')).toContainText('5%');
  await page.getByRole('group', { name: /Количество: Liquid/ }).getByRole('button', { name: 'Увеличить' }).click();
  await expect(page.getByTestId('cart-subtotal')).toHaveText(money(3000));
  await expect(page.getByTestId('cart-summary')).toContainText('Скидка за сумму заказа 5%');
  await expect(page.getByTestId('cart-discount')).toHaveText(money(150, '−'));
  await expect(page.getByTestId('cart-total')).toHaveText(money(2850));
  await expect(page.getByTestId('cart-accrual-preview')).toContainText('142');
  await expect(page.getByTestId('cart-next-threshold')).toHaveCount(0);

  // A wrong code is refused with a clear message and changes nothing.
  await page.getByTestId('promo-input').fill('nope');
  await page.getByTestId('promo-apply').click();
  await expect(page.getByTestId('promo-message')).toBeVisible();
  await expect(page.getByTestId('cart-total')).toHaveText(money(2850));
  await page.getByTestId('promo-remove').click();
  // The right one (any case) is applied; 300 ₽ beats 150 ₽, the discounts are not added up.
  await page.getByTestId('promo-input').fill('welcome300');
  await page.getByTestId('promo-apply').click();
  await expect(page.getByTestId('promo-applied')).toContainText('WELCOME300');
  await expect(page.getByTestId('cart-discount')).toHaveText(money(300, '−'));
  await expect(page.getByTestId('cart-summary')).toContainText('Промокод WELCOME300');
  await expect(page.getByTestId('cart-total')).toHaveText(money(2700));
  await expect(page.getByTestId('promo-stacking-note')).toBeVisible();
  await expect(page.getByTestId('cart-accrual-preview')).toContainText('135');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  // --- Buyer orders: the server charged 2 700 ₽; the activation is reserved, no bonus yet ------------------------------
  await page.getByTestId('fulfillment-pickup').click();
  await page.getByTestId('checkout-submit').click();
  const success = page.getByText(/Заказ №\d+ отправлен/);
  await expect(success).toBeVisible();
  const first = Number((await success.textContent())!.match(/№(\d+)/)![1]);
  expect(await orderRow(first)).toMatchObject({
    status: 'new',
    total_minor: 270_000,
    items_total_minor: 300_000,
    discount_type: 'promo',
    discount_minor: 30_000,
    bonus_spent: 0,
    bonus_accrued: null,
    customer_tg_id: buyer.id,
  });
  expect(ledgerCount(buyer.id)).toBe(0);
  await admin.goto(`/admin/shops/${slug}/loyalty`);
  await admin.getByTestId('loyalty-tab-promo').click();
  await expect(promoRow.getByTestId('promo-used')).toContainText('ждут подтверждения: 1');

  // --- Owner confirms: 5% of the 2 700 ₽ actually paid = 135 bonuses ------------------------------------------------------
  await admin.goto(`/admin/shops/${slug}/orders`);
  const card = admin.getByTestId('admin-order').filter({ hasText: `Заказ №${first}` });
  await expect(card.getByTestId('admin-order-discount')).toContainText('WELCOME300');
  await card.getByRole('button', { name: 'Подтвердить' }).click();
  await expect(card.getByTestId('admin-order-bonus-accrued')).toContainText('Покупателю начислено 135');
  await expect.poll(async () => (await orderRow(first)).bonus_accrued).toBe(135);
  expect(ledgerCount(buyer.id)).toBe(1);
  expect(balanceOf(buyer.id)).toBe(135);

  // The buyer's profile: balance, what was received, the history with the order.
  await page.getByRole('link', { name: 'Мои заказы' }).click();
  await expect(page.getByTestId('bonus-balance-value')).toContainText('135');
  await expect(page.getByTestId('bonus-earned')).toContainText('135');
  const item = page.getByTestId('bonus-history-item').first();
  await expect(item).toContainText(`№${first}`);
  await expect(item).toContainText('135');
  await expect(page.getByTestId('my-order').filter({ hasText: `Заказ №${first}` }).getByTestId('my-order-bonus-accrued')).toBeVisible();

  // The message of THIS shop's own bot (mock), once, with the real numbers.
  await expect
    .poll(async () => (await mockMessages(String(buyer.id))).filter((m) => m.text.includes('Отличные новости')).length, { timeout: 30_000 })
    .toBe(1);
  const message = (await mockMessages(String(buyer.id))).find((m) => m.text.includes('Отличные новости'))!;
  expect(message.bot_id).toBe(botId);
  expect(message.text).toContain(`№${first}`);
  expect(message.text).toContain('135');

  // The activation is now final.
  await admin.goto(`/admin/shops/${slug}/loyalty`);
  await admin.getByTestId('loyalty-tab-promo').click();
  await expect(promoRow.getByTestId('promo-used')).toHaveText('1');
  await expect(promoRow.getByTestId('promo-status')).toHaveText('Активен');

  // --- Next order: the bonuses pay a part, never more than the balance or the order ------------------------------------------
  await addOne();
  await expect(page.getByTestId('bonus-balance')).toContainText('135');
  await page.getByTestId('bonus-toggle').click();
  await expect(page.getByTestId('bonus-input')).toHaveValue('135');
  await expect(page.getByTestId('cart-bonus-spent')).toHaveText(money(135, '−'));
  await expect(page.getByTestId('cart-total')).toHaveText(money(865));
  await page.getByTestId('bonus-input').fill('999');
  await expect(page.getByTestId('bonus-clamped')).toBeVisible();
  await expect(page.getByTestId('cart-total')).toHaveText(money(865));
  await page.getByTestId('fulfillment-pickup').click();
  await page.getByTestId('checkout-submit').click();
  const second = Number((await success.textContent())!.match(/№(\d+)/)![1]);
  expect(second).not.toBe(first);
  expect(await orderRow(second)).toMatchObject({ status: 'new', total_minor: 86_500, bonus_spent: 135, bonus_accrued: null });
  expect(balanceOf(buyer.id)).toBe(0);

  // --- Owner cancels it: the spent bonuses come back ----------------------------------------------------------------------------
  await admin.goto(`/admin/shops/${slug}/orders`);
  const second_card = admin.getByTestId('admin-order').filter({ hasText: `Заказ №${second}` });
  await expect(second_card.getByTestId('admin-order-bonus-spent')).toBeVisible();
  await second_card.getByRole('button', { name: 'Отменить' }).click();
  await admin.getByRole('button', { name: 'Отменить заказ' }).click();
  await expect.poll(async () => (await orderRow(second)).status).toBe('cancelled');
  await expect.poll(() => balanceOf(buyer.id)).toBe(135);
  await adminCtx.close();
});
