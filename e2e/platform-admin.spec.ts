import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DARK_PREMIUM_THEME } from '../src/domain/theme.ts';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import { mockMessages } from '../scripts/lib/telegram-mock.ts';
import { openAsTelegramUser } from './telegram';

// Local stack only (playwright.config.ts + global-setup.ts guards). Throw-away shops and accounts; Telegram goes
// to the local mock Bot API; the bot token is fake.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const created = { users: [] as string[], shops: [] as string[] };

async function account(label: string, opts: { platformAdmin?: boolean } = {}) {
  const email = `e2e-${label}-${run}@e2e.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  created.users.push(data.user.id);
  if (opts.platformAdmin) {
    const { error: pe } = await db.from('platform_admins').insert({ user_id: data.user.id });
    if (pe) throw pe;
  }
  return { id: data.user.id, email, password };
}

async function shopOwnedBy(ownerId: string, label: string) {
  const slug = `e2e-${label}-${run}`;
  const name = `E2E ${label} ${run}`;
  const { data: shop, error } = await db
    .from('shops')
    .insert({ slug, name, theme_config: DARK_PREMIUM_THEME, currency: 'RUB', mode: 'live', legal_notice: '' })
    .select('id')
    .single();
  if (error) throw error;
  created.shops.push(shop.id);
  const { data: cat } = await db.from('categories').insert({ shop_id: shop.id, name: 'Жидкости', slug: 'liquids' }).select('id').single();
  const { data: product } = await db
    .from('products')
    .insert({ shop_id: shop.id, category_id: cat!.id, name: 'Liquid', base_price_minor: 69_000, is_published: true })
    .select('id')
    .single();
  await db.from('product_variants').insert({ shop_id: shop.id, product_id: product!.id, flavor: 'Mint', stock_quantity: 10 });
  await db.from('shop_memberships').insert({ shop_id: shop.id, user_id: ownerId, role: 'owner' });
  return { id: shop.id, slug, name };
}

async function login(page: Page, u: { email: string; password: string }) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Пароль').fill(u.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

async function expectNoHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

test.afterAll(async () => {
  for (const id of created.shops) {
    await db.from('orders').delete().eq('shop_id', id);
    await db.from('shops').delete().eq('id', id);
  }
  for (const id of created.users) await db.auth.admin.deleteUser(id);
});

test('creator: "Мои магазины" vs "Все магазины платформы" and a safe hand-over to a client', async ({ page, browser }) => {
  const creator = await account('creator', { platformAdmin: true });
  const client = await account('client');
  const shop = await shopOwnedBy(creator.id, 'handover');
  const productsBefore = (await db.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id)).count;

  await login(page, creator);
  const mine = page.getByTestId('my-shop').filter({ hasText: shop.name });
  await expect(mine).toBeVisible();
  await expect(mine.getByRole('link', { name: 'Уведомления' })).toHaveAttribute('href', `/admin/shops/${shop.slug}/notifications`);

  await page.getByRole('link', { name: 'Все магазины платформы' }).click();
  await expect(page).toHaveURL(/\/admin\/platform$/);
  await expect(page.getByRole('heading', { name: 'Все магазины платформы' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(shop.slug);
  const row = page.getByTestId('platform-shop');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('platform-shop-owner')).toContainText(creator.email);
  await expectNoHorizontalScroll(page);

  await row.getByTestId('platform-transfer').click();
  const dialog = page.getByTestId('transfer-dialog');
  await dialog.getByLabel('Email учётной записи нового владельца').fill(client.email);
  await dialog.getByRole('button', { name: 'Найти' }).click();
  await expect(dialog.getByTestId('transfer-review')).toContainText(`Потеряют доступ: ${creator.email}`);
  await dialog.getByTestId('transfer-confirm').click();
  await expect(dialog.getByTestId('transfer-result')).toContainText(`Владелец: ${client.email}`);
  await dialog.getByRole('button', { name: 'Готово' }).click();

  // Still in the platform list, now with the client as owner and a transfer date.
  await expect(row.getByTestId('platform-shop-owner')).toContainText(client.email);
  await expect(row).toContainText('передан');
  const members = (await db.from('shop_memberships').select('user_id, role').eq('shop_id', shop.id)).data;
  expect(members).toEqual([{ user_id: client.id, role: 'owner' }]);
  expect((await db.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id)).count).toBe(productsBefore);

  // Gone from the creator's own list; the creator can still open its admin panel from the platform list.
  await page.getByRole('link', { name: 'Мои магазины' }).click();
  await expect(page.getByTestId('my-shop').filter({ hasText: shop.name })).toHaveCount(0);
  await page.goto(`/admin/shops/${shop.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: shop.name })).toBeVisible();

  // The client sees the shop as its own, but no platform section.
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
  const cp = await ctx.newPage();
  await login(cp, client);
  await expect(cp.getByTestId('my-shop').filter({ hasText: shop.name })).toBeVisible();
  await expect(cp.getByRole('link', { name: 'Все магазины платформы' })).toHaveCount(0);
  await cp.goto('/admin/platform');
  await expect(cp.getByText('Этот раздел доступен только администратору платформы.')).toBeVisible();
  await ctx.close();
});

test('owner connects Telegram notifications (mock) and receives the order; the token never reaches the browser', async ({ page, browser }) => {
  const owner = await account('owner');
  const shop = await shopOwnedBy(owner.id, 'notify');
  const chat = `@e2e_orders_${run}`;
  const token = `${600_000_000 + Math.floor(Math.random() * 1e8)}:FAKE_e2e_${randomBytes(16).toString('hex')}`;
  const secret = token.split(':')[1]!;
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/functions/v1/')) bodies.push(await r.text().catch(() => ''));
  });

  await login(page, owner);
  await page.getByTestId('my-shop').filter({ hasText: shop.name }).getByRole('link', { name: 'Уведомления' }).click();
  await expect(page.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Уведомления' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('notifications-status')).toHaveText('Не настроено');
  await page.getByTestId('notifications-token').fill(token);
  await page.getByTestId('notifications-chat').fill(chat);
  await page.getByTestId('notifications-save').click();
  await expect(page.getByTestId('notifications-status')).toHaveText('Подключено');
  await expect(page.getByTestId('notifications-token-hint')).toHaveText(`${token.split(':')[0]}:••••${token.slice(-4)}`);
  await expect(page.getByTestId('notifications-token')).toHaveValue('');

  await page.getByTestId('notifications-check').click();
  await expect(page.getByTestId('notifications-notice')).toContainText('Тестовое сообщение отправлено');
  await expect.poll(async () => (await mockMessages(chat)).length).toBe(1);
  await page.setViewportSize({ width: 360, height: 740 });
  await expectNoHorizontalScroll(page);

  // A Telegram buyer orders; the owner's chat gets exactly one message with the order content.
  const buyerCtx = await browser.newContext({ locale: 'ru-RU' });
  const buyer = await buyerCtx.newPage();
  await openAsTelegramUser(buyer, `/s/${shop.slug}/`, { id: 8_200_000_000 + Math.floor(Math.random() * 1e6), first_name: 'Покупатель', username: 'e2e_buyer' } as never);
  await buyer.getByTestId('product-card').filter({ hasText: 'Liquid' }).click();
  const mint = buyer.getByRole('radio', { name: 'Mint' });
  if (await mint.count()) await mint.click();
  await buyer.getByTestId('add-to-cart').click();
  await buyer.getByRole('link', { name: /Корзина/ }).click();
  await buyer.getByLabel('Имя').fill('E2E Покупатель');
  await buyer.getByTestId('checkout-submit').click();
  const success = buyer.getByText(/Заказ №\d+ отправлен/);
  await expect(success).toBeVisible();
  const n = Number((await success.textContent())!.match(/№(\d+)/)![1]);

  await expect
    .poll(async () => (await mockMessages(chat)).filter((m) => m.text.includes(`Новый заказ №${n}</b>`)).length, { timeout: 15_000 })
    .toBe(1);
  const text = (await mockMessages(chat)).find((m) => m.text.includes(`Новый заказ №${n}</b>`))!.text;
  expect(text).toContain(shop.name);
  expect(text).toContain('@e2e_buyer');
  expect(text).toMatch(/1\. Liquid · Mint — 1 × 690\s₽ = 690\s₽/);
  expect(text).toMatch(/Итого:<\/b> 690\s₽/);
  await buyerCtx.close();

  // Token: never in any function response, never in browser storage.
  expect(bodies.length).toBeGreaterThan(2);
  for (const b of bodies) expect(b).not.toContain(secret);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain(secret);
});
