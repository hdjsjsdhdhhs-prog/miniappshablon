import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

const db = serviceClient();
const owners = () => JSON.parse(readFileSync(join(process.cwd(), 'e2e', '.auth', 'owners.json'), 'utf8')) as Record<string, { email: string; password: string }>;
const originals: Record<string, unknown> = {};

async function openShop(page: Page, slug: string, path = '/') {
  await page.goto(`/s/${slug}${path}`);
  const gate = page.getByRole('button', { name: /Да, мне есть 18/ });
  if (await gate.isVisible({ timeout: 5000 }).catch(() => false)) await gate.click();
}

test.beforeAll(async () => {
  for (const slug of ['mint-lab', 'noir-vapor']) {
    const { data } = await db.from('shops').select('info').eq('slug', slug).single();
    originals[slug] = data!.info;
  }
  // Precondition for the isolation check: the other tenant starts without a channel (local data may have one).
  // afterAll restores the original `info` of both shops.
  const noirInfo = { ...(originals['noir-vapor'] as Record<string, unknown>) };
  delete noirInfo.telegramChannelUrl;
  delete noirInfo.telegramChannelLabel;
  await db.from('shops').update({ info: noirInfo } as never).eq('slug', 'noir-vapor');
});

test.afterAll(async () => {
  for (const [slug, info] of Object.entries(originals)) await db.from('shops').update({ info } as never).eq('slug', slug);
});

test('owner sets the Telegram channel button in the admin → only their storefront shows it', async ({ page, browser }) => {
  const admin = await (await browser.newContext({ locale: 'ru-RU' })).newPage();
  await admin.goto('/admin');
  await admin.getByLabel('Email').fill(owners()['mint-lab']!.email);
  await admin.getByLabel('Пароль').fill(owners()['mint-lab']!.password);
  await admin.getByRole('button', { name: 'Войти' }).click();
  await admin.getByRole('link', { name: /Mint Lab/ }).click();
  await admin.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Оформление', exact: true }).click();

  const label = admin.getByLabel('Название кнопки');
  const url = admin.getByLabel('Ссылка на канал');
  await expect(label).toHaveValue('Наш канал в Телеграме');

  // Unsafe / foreign links are refused and nothing is stored.
  await url.fill('javascript:alert(1)');
  await expect(admin.getByText(/Нужна ссылка Telegram/)).toBeVisible();
  await admin.getByTestId('settings-save').click();
  await expect(admin.getByText(/Ссылка на канал: укажите/)).toBeVisible();
  let { data } = await db.from('shops').select('info').eq('slug', 'mint-lab').single();
  expect((data!.info as Record<string, string>).telegramChannelUrl ?? '').toBe('');

  await label.fill('Новости Mint Lab');
  await url.fill('@mint_lab_news');
  await admin.getByTestId('settings-save').click();
  await expect(admin.getByText(/Сохранено/)).toBeVisible();
  await expect(url).toHaveValue('https://t.me/mint_lab_news');
  ({ data } = await db.from('shops').select('info').eq('slug', 'mint-lab').single());
  expect(data!.info).toMatchObject({ telegramChannelUrl: 'https://t.me/mint_lab_news', telegramChannelLabel: 'Новости Mint Lab' });

  await openShop(page, 'mint-lab');
  const link = page.getByTestId('telegram-channel-link');
  await expect(link).toHaveText('Новости Mint Lab');
  await expect(link).toHaveAttribute('href', 'https://t.me/mint_lab_news');
  // Directly under the shop name in the brand header.
  await expect(page.locator('header h1 + [data-testid="telegram-channel-link"]')).toHaveCount(1);
  // Outside Telegram it is a regular new-tab link.
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  expect(popup.url()).toMatch(/^https:\/\/t\.me\/mint_lab_news/);
  await popup.close();

  // Other tenants are unaffected.
  await openShop(page, 'noir-vapor');
  await expect(page.getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeVisible();
  await expect(page.getByTestId('telegram-channel-link')).toHaveCount(0);

  // Clearing the link hides the button.
  await url.fill('');
  await admin.getByTestId('settings-save').click();
  await expect(admin.getByText(/Сохранено/).last()).toBeVisible();
  await openShop(page, 'mint-lab');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('telegram-channel-link')).toHaveCount(0);
});

test('home has no "Категории" heading; floating nav keeps insets and never covers content', async ({ page }) => {
  await openShop(page, 'noir-vapor');
  await expect(page.getByTestId('category-tile').first()).toBeVisible();
  await expect(page.getByText('Категории', { exact: true })).toHaveCount(0);

  const vw = page.viewportSize()!;
  const dock = page.getByTestId('bottom-nav').getByRole('list');
  const box = (await dock.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(vw.width - (box.x + box.width)).toBeGreaterThanOrEqual(12);
  expect(vw.height - (box.y + box.height)).toBeGreaterThanOrEqual(8);
  expect(box.height).toBeGreaterThanOrEqual(56);
  expect(box.height).toBeLessThanOrEqual(68);

  // Category filter still works on the same page.
  await page.getByRole('button', { name: 'Жидкости' }).click();
  await expect(page.getByTestId('products-title')).toHaveText('Жидкости');
  await expect(page).toHaveURL(/\/s\/noir-vapor\/\?category=liquids$/);
  await page.getByRole('button', { name: 'Все товары' }).click();
  await expect(page.getByTestId('products-title')).toHaveText('Все товары');
  await expect(page.getByTestId('product-card')).toHaveCount(7);

  // Scrolled to the very end, the last content is above the dock; no horizontal scroll.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        window.scrollTo(0, document.documentElement.scrollHeight);
        const se = document.scrollingElement!;
        return Math.abs(se.scrollHeight - se.clientHeight - se.scrollTop) < 2;
      }),
    )
    .toBe(true);
  const lastBottom = await page.evaluate(() => {
    const els = [...document.querySelectorAll('main > *')];
    return els.at(-1)!.getBoundingClientRect().bottom;
  });
  const dockTop = (await dock.boundingBox())!.y;
  expect(lastBottom).toBeLessThanOrEqual(dockTop);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);

  // Routes are unchanged.
  await page.getByRole('link', { name: /Корзина/ }).click();
  await expect(page).toHaveURL(/\/s\/noir-vapor\/cart$/);
  await page.getByRole('link', { name: /Профиль/ }).click();
  await expect(page).toHaveURL(/\/s\/noir-vapor\/profile$/);
  await page.getByRole('link', { name: /Каталог/ }).click();
  await expect(page).toHaveURL(/\/s\/noir-vapor\/$/);
});
