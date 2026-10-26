import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

// The five latest storefront changes, checked in a real browser against the local demo data:
// no age gate / age notice, "Осталось: N", Benzin brand header + compact Telegram chip, DEMO banner contact.
const db = serviceClient();
const SHOP = '/s/noir-vapor/';

async function openShop(page: Page) {
  await page.goto(SHOP);
  await expect(page.getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeVisible();
}

test('no age gate and no age notice, while the age settings stay in the data', async ({ page }) => {
  const { data: shop } = await db.from('shops').select('age_restriction, legal_notice').eq('slug', 'noir-vapor').single();
  // The legal/age configuration is kept (not deleted) — the storefront just does not show it.
  expect(shop!.age_restriction).toBeGreaterThan(0);
  await openShop(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(/Вам исполнилось|Да, мне есть/)).toHaveCount(0);
  if (shop!.legal_notice.trim()) await expect(page.getByText(shop!.legal_notice.trim(), { exact: false })).toHaveCount(0);
  await expect(page.getByText(/^18\+$/)).toHaveCount(0);
});

test('stock is written "Осталось: N" (not uppercase) in the quick sheet and on the product page', async ({ page }) => {
  await openShop(page);
  await page.getByTestId('product-card').filter({ hasText: 'Noir Salt 30 мл' }).getByTestId('quick-add').click();
  const chips = page.getByTestId('quick-option-stock');
  await expect(chips.first()).toBeVisible();
  for (const chip of await chips.all()) {
    await expect(chip).toHaveText(/^Осталось: \d+$/);
    expect(await chip.evaluate((el) => getComputedStyle(el).textTransform)).toBe('none');
    // What the user actually sees (innerText applies CSS text-transform).
    expect(await chip.evaluate((el) => (el as HTMLElement).innerText)).toMatch(/^Осталось: \d+$/);
  }
  await page.keyboard.press('Escape');
  await page.getByTestId('product-card').filter({ hasText: 'Noir Salt 30 мл' }).getByTestId('product-card-link').click();
  await page.getByRole('radio').first().click();
  const stock = page.getByTestId('product-stock');
  // (a space separates the check icon from the text)
  await expect(stock).toHaveText(/^\s?(Осталось: \d+|Нет в наличии)$/);
  expect(await stock.evaluate((el) => (el as HTMLElement).innerText)).not.toMatch(/ОСТАЛОСЬ/);
  expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/ОСТАЛОСЬ/);
});

test('brand header uses the real Benzin-Semibold font (Latin + Cyrillic) and stays inside a 320 px screen', async ({ page }) => {
  await openShop(page);
  const h1 = page.getByRole('heading', { level: 1, name: 'Noir Vapor' });
  expect(await h1.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Benzin"?,/);
  expect(await h1.evaluate((el) => getComputedStyle(el).fontWeight)).toBe('600');
  // The webfont file is actually downloaded and covers both scripts.
  const loaded = await page.evaluate(async () => {
    await document.fonts.load('600 24px Benzin', 'Noir Vapor Мятная лавка');
    await document.fonts.ready;
    return {
      faces: [...document.fonts].filter((f) => f.family.replace(/"/g, '') === 'Benzin').map((f) => f.status),
      latin: document.fonts.check('600 24px Benzin', 'Noir Vapor'),
      cyrillic: document.fonts.check('600 24px Benzin', 'Мятная лавка'),
    };
  });
  expect(loaded.faces).toContain('loaded');
  expect(loaded).toMatchObject({ latin: true, cyrillic: true });

  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 800 });
    const box = (await h1.boundingBox())!;
    expect(box.x + box.width, `h1 at ${width}px`).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});

test('DEMO banner: exact text, blue @caseypsd link to t.me, tappable on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openShop(page);
  const banner = page.getByTestId('demo-banner');
  await expect(banner).toHaveText('DEMO-режим: полный доступ можете приобрести у @caseypsd');
  const link = banner.getByRole('link', { name: '@caseypsd' });
  await expect(link).toHaveAttribute('href', 'https://t.me/caseypsd');
  const color = await link.evaluate((el) => getComputedStyle(el).color);
  const [r, g, b] = color.match(/\d+/g)!.map(Number);
  expect(b! > r! && b! > g! - 10, `link colour ${color} is blue`).toBe(true);
  const box = (await link.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  // The handle never breaks across lines.
  expect(box.height).toBeLessThan(40);
  // No real request to Telegram: the new tab is answered locally.
  await page.context().route('https://t.me/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'stub' }));
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  expect(popup.url()).toMatch(/^https:\/\/t\.me\/caseypsd/);
  await popup.close();
});
