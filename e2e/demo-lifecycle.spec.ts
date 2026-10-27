import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { resolveSupabaseEnv, serviceClient } from '../scripts/lib/supabase-env.ts';
import { createAccount, deleteShops, deleteUsers, latestMailTo, mailHtml, type Account } from './shops';
import { signInitData } from '../supabase/functions/_shared/telegram-init-data.ts';
import { LOCAL_BOT_TOKEN, openAsTelegramUser } from './telegram';

// The whole DEMO lifecycle in a real browser against the LOCAL stack: create DEMO in the platform admin → public
// link → DEMO storefront (banner, title, demo checkout, demo profile) → "Передать клиенту" → invitation e-mail in the
// local Mailpit → client sets a password → regular live shop with delivery / pickup settings.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const slug = `e2e-demo-${run}`;
const name = `Demo ${run}`;
const clientEmail = `e2e-client-${run}@e2e.local`;
const created = { shops: [] as string[], users: [] as string[] };
let platform: Account;

async function login(page: Page, a: { email: string; password: string }) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function shopRow() {
  const { data } = await db.from('shops').select('id, slug, is_demo, mode, status').eq('slug', slug).maybeSingle();
  return data;
}

test.beforeAll(async () => {
  platform = await createAccount('lifecycle-admin', { platformAdmin: true });
  created.users.push(platform.id);
});

test.afterAll(async () => {
  const s = await shopRow();
  if (s) created.shops.push(s.id);
  const { data: users } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const client = users?.users.find((u) => u.email === clientEmail);
  if (client) created.users.push(client.id);
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test.describe.configure({ mode: 'serial' });

test('platform admin creates a DEMO shop, gets its public link; a taken slug is refused', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, platform);
  await page.getByRole('link', { name: 'Все магазины платформы' }).click();
  const total = Number((await page.getByTestId('platform-summary').textContent())!.match(/Всего: (\d+)/)![1]);

  await page.getByTestId('platform-create-demo').click();
  const dialog = page.getByTestId('create-demo-dialog');
  await dialog.getByTestId('create-demo-name').fill(name);
  await dialog.getByTestId('create-demo-slug').fill('noir-vapor');
  await expect(dialog).toContainText('Этот slug уже занят.');
  await expect(dialog.getByTestId('create-demo-submit')).toBeDisabled();
  await dialog.getByTestId('create-demo-slug').fill(slug);
  await expect(dialog.getByTestId('create-demo-template')).toContainText('noir-vapor');
  await dialog.getByTestId('create-demo-submit').click();

  const result = dialog.getByTestId('create-demo-result');
  await expect(result).toBeVisible({ timeout: 30_000 });
  const origin = new URL(page.url()).origin;
  await expect(result.getByTestId('create-demo-url')).toHaveValue(`${origin}/s/${slug}/`);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await result.getByTestId('create-demo-copy').click();
  await expect(page.getByText('Ссылка скопирована')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${origin}/s/${slug}/`);
  await dialog.getByRole('button', { name: 'Готово' }).click();

  // In the global list with its own link; DEMO action is "Передать клиенту".
  await expect(page.getByTestId('platform-summary')).toContainText(`Всего: ${total + 1}`);
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(slug);
  const row = page.getByTestId('platform-shop');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('DEMO');
  await expect(row.getByTestId('platform-shop-url')).toHaveText(`${origin}/s/${slug}/`);
  await expect(row.getByTestId('platform-handover')).toBeVisible();

  const s = (await shopRow())!;
  expect(s).toMatchObject({ is_demo: true, mode: 'live', status: 'active' });
  const { data: tpl } = await db.from('shops').select('id').eq('slug', 'noir-vapor').single();
  expect(s.id).not.toBe(tpl!.id);
  const { count } = await db.from('products').select('id', { count: 'exact', head: true }).eq('shop_id', s.id);
  expect(count).toBeGreaterThan(0);

  // Server-side duplicate (e.g. two admins at once) is refused as well.
  const env = resolveSupabaseEnv();
  const token = await page.evaluate(() => JSON.parse(localStorage.getItem('tma-shop-auth') ?? '{}').access_token as string);
  const dup = await fetch(`${env.url}/functions/v1/platform-admin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'create-demo', templateId: tpl!.id, slug, name: 'dup' }),
  });
  expect(dup.status).toBe(409);
  expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('slug_taken');
});

test('the new link opens the DEMO storefront: one-line banner at 320/375/430/desktop, smaller title', async ({ page }) => {
  await page.goto(`/s/${slug}/`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  const banner = page.getByTestId('demo-banner');
  await expect(banner).toHaveText('DEMO-режим: приобрести полный доступ - caseypsd');
  const link = banner.getByRole('link', { name: 'caseypsd' });
  await expect(link).toHaveAttribute('href', 'https://t.me/caseypsd');

  for (const width of [320, 375, 430, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const m = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="demo-banner"]')!;
      const text = document.querySelector<HTMLElement>('[data-testid="demo-banner-text"]')!;
      const dot = document.querySelector<HTMLElement>('[data-testid="demo-banner-dot"]')!;
      const a = document.querySelector<HTMLElement>('[data-testid="demo-contact-link"]')!;
      const icon = document.querySelector<SVGElement>('[data-testid="demo-contact-icon"]')!;
      const r = (el: Element) => el.getBoundingClientRect();
      const lineHeights = new Set([...text.getClientRects()].map((x) => Math.round(x.top)));
      return {
        barH: r(bar).height,
        barRight: r(bar).right,
        textOverflow: text.scrollWidth - text.clientWidth,
        textLeft: r(text).left,
        textRight: r(text).right,
        lines: lineHeights.size,
        dotRight: r(dot).right,
        dotColor: getComputedStyle(dot).backgroundColor,
        dotShadow: getComputedStyle(dot).boxShadow,
        linkRight: r(a).right,
        linkColor: getComputedStyle(a).color,
        iconColor: getComputedStyle(icon).color,
        iconBeforeHandle: r(icon).right <= r(a).right - 10,
        fontSize: parseFloat(getComputedStyle(text).fontSize),
      };
    });
    const where = `${width}px`;
    expect(m.barH, where).toBe(32);
    expect(m.lines, where).toBe(1);
    expect(m.textOverflow, where).toBeLessThanOrEqual(0);
    expect(m.dotRight, where).toBeLessThanOrEqual(m.textLeft);
    // The storefront is centred (max-w-3xl) on wide screens, so compare with the bar's right edge, not its width.
    expect(m.linkRight, where).toBeLessThanOrEqual(Math.min(width, m.barRight));
    expect(m.textRight, where).toBeLessThanOrEqual(width);
    expect(m.fontSize, where).toBeGreaterThanOrEqual(10);
    expect(m.iconBeforeHandle, where).toBe(true);
    const [dr, dg, db_] = m.dotColor.match(/\d+/g)!.map(Number);
    expect(dr! > 200 && dg! < 120 && db_! < 120, `dot ${m.dotColor} is reddish`).toBe(true);
    expect(m.dotShadow, where).toMatch(/rgba\(255, 90, 95/);
    for (const c of [m.linkColor, m.iconColor]) {
      const [r, g, b] = c.match(/\d+/g)!.map(Number);
      expect(b! > r! && b! >= g! - 10, `${c} is Telegram blue`).toBe(true);
    }
    expect(await noHorizontalScroll(page), where).toBeLessThanOrEqual(0);

    // Shop title: Benzin, 80 % of the former clamp(1.25rem, 6.4vw, 2rem), not cut off.
    const h1 = page.getByTestId('shop-title');
    const t = await h1.evaluate((el) => ({
      size: parseFloat(getComputedStyle(el).fontSize),
      family: getComputedStyle(el).fontFamily,
      overflow: el.scrollWidth - el.clientWidth,
      right: el.getBoundingClientRect().right,
    }));
    const expected = Math.min(Math.max(16, width * 0.0512), 25.6);
    expect(t.size, `title at ${where}`).toBeCloseTo(expected, 0);
    expect(t.family).toMatch(/^"?Benzin"?,/);
    expect(t.overflow, `title at ${where}`).toBeLessThanOrEqual(0);
    expect(t.right).toBeLessThanOrEqual(width);
  }
});

test('DEMO checkout (browser and Telegram): both methods, nothing stored; DEMO profile without Telegram sign-in', async ({ page }) => {
  const s = (await shopRow())!;
  const countOrders = async () => (await db.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', s.id)).count;
  const before = await countOrders();
  const calls: string[] = [];
  page.on('request', (r) => {
    if (/\/functions\/v1\/(checkout|my-orders)|\/auth\/v1\//.test(r.url())) calls.push(r.url());
  });

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/s/${slug}/`);
  await page.getByTestId('product-card').first().getByTestId('product-card-link').click();
  const radio = page.getByRole('radio').first();
  if (await radio.count()) await radio.click();
  await page.getByTestId('add-to-cart').click();
  await page.getByRole('link', { name: /Корзина/ }).click();
  await expect(page.getByTestId('cart-line').first()).toBeVisible();
  await expect(page.getByTestId('demo-checkout-note')).toContainText('Это демонстрация');
  await page.getByTestId('fulfillment-pickup').click();
  await expect(page.getByLabel('Адрес доставки')).toHaveCount(0);
  await expect(page.getByTestId('pickup-instructions')).toBeVisible();
  await page.getByTestId('checkout-submit').click();
  await expect(page.getByTestId('demo-order-placed')).toContainText('Тестовый заказ оформлен');
  expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

  // Inside Telegram: still the demo profile, no my-orders call.
  await openAsTelegramUser(page, `/s/${slug}/profile`, { id: 8_300_000_000 + Math.floor(Math.random() * 1e6), first_name: 'Гость' });
  await expect(page.getByTestId('demo-profile')).toBeVisible();
  await expect(page.getByTestId('demo-order')).toContainText('Тестовый заказ');
  await expect(page.getByRole('note')).toContainText('Это демонстрация');

  expect(calls).toEqual([]);
  expect(await countOrders()).toBe(before);
});

test('"Передать клиенту": invitation e-mail → client sets a password → regular live shop, no DEMO, own admin only', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, platform);
  await page.goto('/admin/platform');
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(slug);
  await page.getByTestId('platform-handover').click();
  const dialog = page.getByTestId('handover-dialog');
  await dialog.getByTestId('handover-email').fill(clientEmail);
  await expect(dialog.getByTestId('handover-confirm')).toBeDisabled();
  await dialog.getByTestId('handover-paid').click();
  await dialog.getByTestId('handover-confirm').click();
  const result = dialog.getByTestId('handover-result');
  await expect(result).toContainText(`владелец ${clientEmail}, режим live, DEMO выключен`, { timeout: 30_000 });
  await expect(result.getByTestId('handover-invitation')).toContainText('Письмо-приглашение отправлено');
  await dialog.getByRole('button', { name: 'Готово' }).click();

  const row = page.getByTestId('platform-shop');
  await expect(row.getByTestId('platform-shop-owner')).toContainText(clientEmail);
  await expect(row).not.toContainText('DEMO');
  await expect(row.getByTestId('platform-transfer')).toBeVisible();
  expect(await shopRow()).toMatchObject({ slug, is_demo: false, mode: 'live', status: 'active' });

  // The invitation arrives in the local Mailpit; its link leads to /admin/set-password.
  await expect.poll(async () => (await latestMailTo(clientEmail))?.ID ?? null, { timeout: 20_000 }).not.toBeNull();
  const html = await mailHtml((await latestMailTo(clientEmail))!.ID);
  const href = html.match(/href="([^"]+)"/)![1]!.replace(/&amp;/g, '&');
  expect(href).toContain('/auth/v1/verify');
  expect(decodeURIComponent(href)).toContain('/admin/set-password');

  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
  const cp = await ctx.newPage();
  // The verify link redirects to the E2E dev server origin configured in supabase/config.toml.
  await cp.goto(href.replace(/redirect_to=[^&]+/, `redirect_to=${encodeURIComponent(new URL('/admin/set-password', page.url()).href)}`));
  await expect(cp.getByTestId('set-password')).toBeVisible();
  await expect(cp.getByTestId('set-password')).toContainText(clientEmail);
  const password = randomBytes(12).toString('base64url');
  await cp.getByLabel('Новый пароль').fill(password);
  await cp.getByLabel('Повторите пароль').fill('different-password');
  await cp.getByTestId('set-password-submit').click();
  await expect(cp.getByText('Пароли не совпадают.')).toBeVisible();
  await cp.getByLabel('Повторите пароль').fill(password);
  await cp.getByTestId('set-password-submit').click();
  await expect(cp.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
  expect(cp.url()).not.toContain('access_token');
  await expect(cp.getByTestId('my-shop')).toHaveCount(1);
  await expect(cp.getByTestId('my-shop')).toContainText(name);
  await expect(cp.getByRole('link', { name: 'Все магазины платформы' })).toHaveCount(0);
  await cp.goto('/admin/platform');
  await expect(cp.getByText('Этот раздел доступен только администратору платформы.')).toBeVisible();
  await cp.goto('/admin/shops/noir-vapor');
  await expect(cp.getByText('Нет доступа к магазину')).toBeVisible();

  // Sign in again with the new password works.
  await ctx.clearCookies();
  await cp.evaluate(() => localStorage.clear());
  await login(cp, { email: clientEmail, password });

  // Owner settings: fulfillment switches; the old legal notice field is gone.
  await cp.goto(`/admin/shops/${slug}/settings`);
  await expect(cp.getByLabel('Юридическое уведомление')).toHaveCount(0);
  const card = cp.getByTestId('settings-fulfillment');
  await card.getByTestId('settings-pickup-instructions').fill('Самовывоз: ул. Мира, 1, ежедневно 10:00–20:00');
  await card.getByTestId('settings-delivery').click();
  await card.getByTestId('settings-pickup').click();
  await expect(card.getByTestId('settings-fulfillment-warning')).toBeVisible();
  await card.getByTestId('settings-pickup').click();
  await expect(card.getByTestId('settings-fulfillment-warning')).toHaveCount(0);
  await cp.getByTestId('settings-save').click();
  await expect(cp.getByText(/Сохранено/)).toBeVisible();
  await ctx.close();

  const { data: saved } = await db.from('shops').select('delivery_enabled, pickup_enabled, pickup_instructions').eq('slug', slug).single();
  expect(saved).toEqual({ delivery_enabled: false, pickup_enabled: true, pickup_instructions: 'Самовывоз: ул. Мира, 1, ежедневно 10:00–20:00' });
});

test('after the hand-over: no DEMO features, only pickup offered, a forged delivery is refused, a real order is stored', async ({ page }) => {
  const s = (await shopRow())!;
  const buyer = { id: 8_400_000_000 + Math.floor(Math.random() * 1e6), first_name: 'Покупатель' };
  await openAsTelegramUser(page, `/s/${slug}/`, buyer);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  await page.getByTestId('product-card').first().getByTestId('product-card-link').click();
  const radio = page.getByRole('radio').first();
  if (await radio.count()) await radio.click();
  await page.getByTestId('add-to-cart').click();
  await page.getByRole('link', { name: /Корзина/ }).click();
  await expect(page.getByTestId('demo-checkout-note')).toHaveCount(0);
  await expect(page.getByTestId('fulfillment-delivery')).toBeDisabled();
  await expect(page.getByTestId('fulfillment-pickup')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('pickup-instructions')).toHaveText('Самовывоз: ул. Мира, 1, ежедневно 10:00–20:00');

  // A forged "delivery" request from the same verified buyer is refused by the server.
  const env = resolveSupabaseEnv();
  // Same verified buyer: initData signed with the local test token, exactly like the Telegram launch above.
  const initData = await signInitData(
    { auth_date: String(Math.floor(Date.now() / 1000)), query_id: `F${buyer.id}`, user: JSON.stringify(buyer) },
    LOCAL_BOT_TOKEN,
  );
  const forged = await page.evaluate(async ({ slugValue, initData: init, url, anonKey, shopId }) => {
    const env = { supabaseUrl: url, supabaseAnonKey: anonKey };
    const lines = JSON.parse(localStorage.getItem(`tma-cart:v1:${shopId}`) ?? '[]') as Array<{ variantId: string; quantity: number }>;
    const res = await fetch(`${env.supabaseUrl}/functions/v1/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.supabaseAnonKey, Authorization: `Bearer ${env.supabaseAnonKey}`, 'X-Telegram-Init-Data': init },
      body: JSON.stringify({
        shopSlug: slugValue,
        idempotencyKey: crypto.randomUUID(),
        currency: 'RUB',
        items: lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
        fulfillment: { method: 'delivery', address: 'ул. Подмены, 1' },
      }),
    });
    return { status: res.status, body: await res.json() };
  }, { slugValue: slug, initData, url: env.url, anonKey: env.anonKey, shopId: s.id });
  expect(forged.status).toBe(409);
  expect(forged.body.error.code).toBe('fulfillment_unavailable');
  expect((await db.from('orders').select('id').eq('shop_id', s.id)).data).toEqual([]);

  await page.getByTestId('checkout-submit').click();
  await expect(page.getByText(/Заказ №\d+ отправлен/)).toBeVisible();
  const { data: orders } = await db.from('orders').select('fulfillment_method, delivery_address, is_test, customer_tg_id').eq('shop_id', s.id);
  expect(orders).toEqual([{ fulfillment_method: 'pickup', delivery_address: null, is_test: false, customer_tg_id: buyer.id }]);

  // The real profile shows the verified Telegram user's own order, not the demo mock-up.
  await page.getByRole('link', { name: 'Мои заказы' }).click();
  await expect(page.getByTestId('my-order')).toContainText('Самовывоз');
  await expect(page.getByTestId('demo-profile')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Покупатель' })).toBeVisible();
});
