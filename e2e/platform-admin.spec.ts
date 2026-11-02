import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { DARK_PREMIUM_THEME } from '../src/domain/theme.ts';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import { mockMessages } from '../scripts/lib/telegram-mock.ts';
import { totp } from '../scripts/lib/totp.ts';
import { completeMfa, createAccount, platformAdmin, type Account } from './shops';
import { openAsTelegramUser } from './telegram';

// Local stack only (playwright.config.ts + global-setup.ts guards). Throw-away shops and accounts; Telegram goes
// to the local mock Bot API; the bot token is fake.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const created = { users: [] as string[], shops: [] as string[] };

/** Client account, or a platform admin (with a verified TOTP factor unless `mfa: false`, see e2e/shops.ts). */
async function account(label: string, opts: { platformAdmin?: boolean; mfa?: boolean } = {}): Promise<Account> {
  const a = await createAccount(`${label}-${run}`, opts);
  created.users.push(a.id);
  return a;
}

async function shopOwnedBy(ownerId: string, label: string) {
  const slug = `e2e-${label}-${run}`;
  const name = `E2E ${label} ${run}`;
  const { data: shop, error } = await db
    .from('shops')
    .insert({ slug, name, theme_config: DARK_PREMIUM_THEME, currency: 'RUB', mode: 'live' })
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

async function submitPassword(page: Page, u: { email: string; password: string }) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Пароль').fill(u.password);
  await page.getByRole('button', { name: 'Войти' }).click();
}

async function login(page: Page, u: { email: string; password: string; totpSecret?: string }) {
  await submitPassword(page, u);
  // Platform admins: mandatory TOTP step (20261102090000).
  await completeMfa(page, u);
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

const pageToken = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tma-shop-auth') ?? '{}').access_token as string);

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

test('platform admin (aal2): "Все магазины платформы" and a safe transfer from one client to another', async ({ page, browser }) => {
  // Platform admin and shop owners are separate accounts (20261102090000): the admin owns no shop itself.
  const operator = await account('operator', { platformAdmin: true });
  const former = await account('former');
  const client = await account('client');
  const shop = await shopOwnedBy(former.id, 'handover');
  const productsBefore = (await db.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id)).count;

  await login(page, operator);
  await expect(page.getByTestId('my-shop')).toHaveCount(0);

  await page.getByRole('link', { name: 'Все магазины платформы' }).click();
  await expect(page).toHaveURL(/\/admin\/platform$/);
  await expect(page.getByRole('heading', { name: 'Все магазины платформы' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(shop.slug);
  const row = page.getByTestId('platform-shop');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('platform-shop-owner')).toContainText(former.email);
  // A LIVE shop offers no "Удалить DEMO".
  await expect(row.getByTestId('platform-demo-delete')).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  await row.getByTestId('platform-transfer').click();
  const dialog = page.getByTestId('transfer-dialog');
  await dialog.getByLabel('Email учётной записи нового владельца').fill(client.email);
  await dialog.getByRole('button', { name: 'Найти' }).click();
  await expect(dialog.getByTestId('transfer-review')).toContainText(`Потеряют доступ: ${former.email}`);
  await dialog.getByTestId('transfer-confirm').click();
  await expect(dialog.getByTestId('transfer-result')).toContainText(`Владелец: ${client.email}`);
  await dialog.getByRole('button', { name: 'Готово' }).click();

  // Still in the platform list, now with the client as owner and a transfer date.
  await expect(row.getByTestId('platform-shop-owner')).toContainText(client.email);
  await expect(row).toContainText('передан');
  const members = (await db.from('shop_memberships').select('user_id, role').eq('shop_id', shop.id)).data;
  expect(members).toEqual([{ user_id: client.id, role: 'owner' }]);
  expect((await db.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id)).count).toBe(productsBefore);

  // The aal2 platform admin can still open the shop's admin panel from the platform list.
  await page.goto(`/admin/shops/${shop.slug}`);
  await expect(page.getByRole('heading', { level: 1, name: shop.name })).toBeVisible();

  // The former owner lost it.
  const fctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
  const fp = await fctx.newPage();
  await login(fp, former);
  await expect(fp.getByTestId('my-shop').filter({ hasText: shop.name })).toHaveCount(0);
  await fctx.close();

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

test('MFA: first sign-in enrolls TOTP; until a code is verified nothing opens; later sign-ins need the current code', async ({ page, browser }) => {
  const pa = await account('mfa-first', { platformAdmin: true, mfa: false });
  await page.setViewportSize({ width: 390, height: 844 });

  // Password only (aal1, no factor): the only page is /admin/mfa, with the enrollment.
  await submitPassword(page, pa);
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await page.goto('/admin/platform');
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await page.getByTestId('mfa-enroll').click();
  await expect(page.getByTestId('mfa-enrollment')).toBeVisible();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  // Enrolled but not verified: the server still refuses everything.
  const before = await platformAdmin(await pageToken(page), { action: 'list' });
  expect([before.status, (before.body?.error as { code?: string } | undefined)?.code]).toEqual([403, 'mfa_required']);
  await page.getByTestId('mfa-code').fill('000000');
  await page.getByTestId('mfa-submit').click();
  await expect(page.getByTestId('mfa-error')).toBeVisible();
  await page.getByTestId('mfa-code').fill(totp(secret));
  await page.getByTestId('mfa-submit').click();
  await expect(page.getByTestId('mfa-page')).toHaveCount(0);
  await page.goto('/admin/platform');
  await expect(page.getByRole('heading', { name: 'Все магазины платформы' })).toBeVisible();
  expect((await platformAdmin(await pageToken(page), { action: 'list' })).status).toBe(200);

  // Next sign-in (another device): password → code required, no enrollment offered, platform closed until then.
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
  const p2 = await ctx.newPage();
  await submitPassword(p2, pa);
  await expect(p2.getByTestId('mfa-page')).toBeVisible();
  await expect(p2.getByTestId('mfa-enroll')).toHaveCount(0);
  await expect(p2.getByTestId('mfa-recovery')).toContainText('Обходного входа без кода нет');
  const aal1 = await platformAdmin(await pageToken(p2), { action: 'list' });
  expect((aal1.body?.error as { code?: string } | undefined)?.code).toBe('mfa_required');
  await completeMfa(p2, { totpSecret: secret });
  await p2.goto('/admin/platform');
  await expect(p2.getByRole('heading', { name: 'Все магазины платформы' })).toBeVisible();
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
  await buyer.getByTestId('fulfillment-pickup').click();
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
  expect(text).toContain('<b>Получение:</b> самовывоз');
  expect(text).not.toContain('Контакт из формы');
  expect(text).toMatch(/1\. Liquid · Mint — 1 × 690\s₽ = 690\s₽/);
  expect(text).toMatch(/Итого:<\/b> 690\s₽/);
  await buyerCtx.close();

  // Token: never in any function response, never in browser storage.
  expect(bodies.length).toBeGreaterThan(2);
  for (const b of bodies) expect(b).not.toContain(secret);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain(secret);
});
