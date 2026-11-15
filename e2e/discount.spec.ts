import { randomBytes } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import { createAccount, createLiveShop, deleteShops, deleteUsers, type Account } from './shops';
import { openAsTelegramUser } from './telegram';

// Discount price of a product (20261113090000), in a real browser against the LOCAL stack: the owner sets it in the
// product card (an invalid one is refused), the storefront shows the discount price with the list price struck
// through — card, product page, cart — the order is charged the discount price, and the order keeps both prices
// after the owner ends the sale (buyer's profile and the owner's order list).
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const slug = `e2e-sale-${run}`;
const name = `Sale ${run}`;
const created = { shops: [] as string[], users: [] as string[] };
let owner: Account;
let shop: Awaited<ReturnType<typeof createLiveShop>>;

const LIST = /^690\s?₽$/;
const SALE = /^590\s?₽$/;

async function login(page: Page, a: Account) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

const prices = async () => (await db.from('products').select('base_price_minor, discount_price_minor').eq('id', shop.productId).single()).data;

/** The discount price first, then the list price — really struck through, not only marked up as such. */
async function expectDiscounted(scope: Locator) {
  await expect(scope.getByTestId('price-current')).toHaveText(SALE);
  const old = scope.getByTestId('price-old');
  await expect(old).toHaveText(LIST);
  await expect(old).toHaveCSS('text-decoration-line', 'line-through');
  // Screen readers get both prices named.
  await expect(scope.getByTestId('price-discounted')).toContainText('Цена со скидкой');
  await expect(scope.getByTestId('price-discounted')).toContainText('прежняя цена');
}

test.beforeAll(async () => {
  owner = await createAccount('sale-owner');
  created.users.push(owner.id);
  shop = await createLiveShop(owner.id, slug, name, { priceMinor: 69_000, stock: 10 });
  created.shops.push(shop.id);
});

test.afterAll(async () => {
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('owner sets a discount → storefront shows it with the old price struck → the order keeps both prices after the sale ends', async ({ page, browser }) => {
  // --- Owner: product card -----------------------------------------------------------------------------------
  const adminCtx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } });
  const admin = await adminCtx.newPage();
  await login(admin, owner);
  await admin.goto(`/admin/shops/${slug}/products`);
  await expect(admin.getByTestId('admin-product-price')).toHaveText(LIST);
  await admin.getByTestId('admin-product-link').filter({ hasText: 'Liquid' }).click();
  await expect(admin.getByTestId('product-price-input')).toHaveValue('690');
  const discount = admin.getByTestId('product-discount-input');
  await expect(discount).toHaveValue('');

  // Not a discount: equal to (or above) the regular price. Nothing is saved.
  await discount.fill('690');
  await admin.getByTestId('product-save').click();
  await expect(admin.getByTestId('product-discount-error')).toHaveText('Цена со скидкой должна быть ниже обычной цены');
  expect(await prices()).toEqual({ base_price_minor: 69_000, discount_price_minor: null });

  await discount.fill('590');
  await expect(admin.getByTestId('product-discount-error')).toHaveCount(0);
  await expect(admin.getByTestId('product-discount-preview')).toContainText(/590\s?₽/);
  await expect(admin.getByTestId('product-discount-preview').locator('s')).toHaveText(LIST);
  await admin.getByTestId('product-save').click();
  await expect(admin.getByText('Товар сохранён')).toBeVisible();
  await expect.poll(prices).toEqual({ base_price_minor: 69_000, discount_price_minor: 59_000 });
  // The product list shows both prices too.
  await admin.goto(`/admin/shops/${slug}/products`);
  const listed = admin.getByTestId('admin-product-price');
  await expect(listed).toContainText(/590\s?₽/);
  await expect(listed.locator('s')).toHaveText(LIST);

  // --- Buyer (Telegram): card, product page, cart ---------------------------------------------------------------
  const buyer = { id: 8_300_000_000 + Math.floor(Math.random() * 1_000_000), first_name: 'E2E' };
  await openAsTelegramUser(page, `/s/${slug}/`, buyer);
  const card = page.getByTestId('product-card').filter({ hasText: 'Liquid' });
  await expectDiscounted(card.getByTestId('product-card-price'));
  await card.getByTestId('product-card-link').click();
  await expectDiscounted(page.getByTestId('product-price'));
  const mint = page.getByRole('radio', { name: 'Mint' });
  if (await mint.count()) await mint.click();
  await page.getByTestId('add-to-cart').click();
  await page.getByRole('link', { name: /Корзина/ }).click();
  await expectDiscounted(page.getByTestId('cart-line').getByTestId('cart-line-price'));
  await expect(page.getByTestId('cart-total')).toHaveText(SALE);
  // No horizontal scroll with two prices in a line on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  await page.getByTestId('fulfillment-pickup').click();
  await page.getByTestId('checkout-submit').click();
  const success = page.getByText(/Заказ №\d+ отправлен/);
  await expect(success).toBeVisible();
  const orderNumber = Number((await success.textContent())!.match(/№(\d+)/)![1]);

  // Charged by the server: the discount price, with the list price kept next to it.
  const { data: order } = await db
    .from('orders')
    .select('total_minor, customer_tg_id, order_items(unit_price_minor, original_unit_price_minor, quantity, line_total_minor)')
    .eq('shop_id', shop.id)
    .eq('order_number', orderNumber)
    .single();
  expect(order).toEqual({
    total_minor: 59_000,
    customer_tg_id: buyer.id,
    order_items: [{ unit_price_minor: 59_000, original_unit_price_minor: 69_000, quantity: 1, line_total_minor: 59_000 }],
  });

  await page.getByRole('link', { name: 'Мои заказы' }).click();
  const myOrder = page.getByTestId('my-order').filter({ hasText: `Заказ №${orderNumber}` });
  await expectDiscounted(myOrder);

  // --- Owner: the order, then the sale ends -----------------------------------------------------------------------
  await admin.goto(`/admin/shops/${slug}/orders`);
  const adminOrder = admin.getByTestId('admin-order').filter({ hasText: `Заказ №${orderNumber}` });
  await expect(adminOrder.locator('s')).toHaveText(LIST);
  await expect(adminOrder).toContainText(/590\s?₽ × 1/);

  await admin.goto(`/admin/shops/${slug}/products/${shop.productId}`);
  await expect(admin.getByTestId('product-discount-input')).toHaveValue('590');
  await admin.getByTestId('product-discount-input').fill('');
  await admin.getByTestId('product-save').click();
  await expect.poll(prices).toEqual({ base_price_minor: 69_000, discount_price_minor: null });

  // Storefront: the regular price again, nothing struck.
  await page.goto(`/s/${slug}/product/${shop.productId}`);
  await expect(page.getByTestId('product-price')).toHaveText(LIST);
  await expect(page.getByTestId('product-price').getByTestId('price-discounted')).toHaveCount(0);
  await page.goto(`/s/${slug}/`);
  const plain = page.getByTestId('product-card').filter({ hasText: 'Liquid' }).getByTestId('product-card-price');
  await expect(plain).toHaveText(LIST);
  await expect(plain.locator('s')).toHaveCount(0);

  // The order is a snapshot: it still shows what was charged and the list price of that day.
  await admin.goto(`/admin/shops/${slug}/orders`);
  await expect(admin.getByTestId('admin-order').filter({ hasText: `Заказ №${orderNumber}` }).locator('s')).toHaveText(LIST);
  await expect(admin.getByTestId('admin-order').filter({ hasText: `Заказ №${orderNumber}` })).toContainText(/590\s?₽ × 1/);
  await adminCtx.close();
});
