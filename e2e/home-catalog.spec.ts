import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

// Shop home = category tiles + in-stock product list of the selected category (no separate catalog).
const db = serviceClient();
const SHOP = '/s/noir-vapor/';
let savedStock: Array<{ id: string; stock_quantity: number }> = [];

/** Temporarily empties the stock of every variant in a category; restored in afterAll. */
async function emptyCategoryStock(categorySlug: string) {
  const { data: shop } = await db.from('shops').select('id').eq('slug', 'noir-vapor').single();
  const { data: cat } = await db.from('categories').select('id').eq('shop_id', shop!.id).eq('slug', categorySlug).single();
  const { data: products } = await db.from('products').select('id').eq('shop_id', shop!.id).eq('category_id', cat!.id);
  const { data: variants } = await db
    .from('product_variants')
    .select('id, stock_quantity')
    .in('product_id', products!.map((p) => p.id));
  savedStock = variants!;
  await db.from('product_variants').update({ stock_quantity: 0 }).in('id', savedStock.map((v) => v.id));
}

test.afterAll(async () => {
  for (const v of savedStock) await db.from('product_variants').update({ stock_quantity: v.stock_quantity }).eq('id', v.id);
});

async function openShop(page: Page) {
  await page.goto(SHOP);
  await page.getByRole('button', { name: /Да, мне есть 18/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeVisible();
}

const tiles = (page: Page) => page.getByTestId('category-tile');
const tile = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const cards = (page: Page) => page.getByTestId('product-card');

async function expectOnlyActive(page: Page, name: string) {
  for (const n of ['Жидкости', 'Pod-системы', 'Картриджи', 'Аксессуары']) {
    await expect(tile(page, n)).toHaveAttribute('aria-pressed', n === name ? 'true' : 'false');
  }
}

for (const viewport of [
  { name: 'mobile', size: null },
  { name: 'desktop', size: { width: 1280, height: 900 } },
] as const) {
  test.describe(`home catalog (${viewport.name})`, () => {
    if (viewport.size) test.use({ viewport: viewport.size, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });

    test('tiles filter the list in place, search works inside the category, no "Рекомендуем"', async ({ page }) => {
      await openShop(page);

      // 1. Tiles are visible right away; 2. no featured block anywhere on the home page.
      await expect(tiles(page)).toHaveCount(4);
      for (const t of await tiles(page).all()) await expect(t).toBeInViewport({ ratio: 0.5 });
      await expect(page.getByText('Рекомендуем')).toHaveCount(0);
      await expect(page.getByTestId('products-title')).toHaveText('Все товары');
      // Aurum Pod has stock in the demo data; the list shows only in-stock products.
      await expect(cards(page).first()).toBeVisible();

      // 3. «Жидкости»: highlighted with the theme accent, only liquids below, same page.
      await tile(page, 'Жидкости').click();
      await expect(page).toHaveURL(/\/s\/noir-vapor\/\?category=liquids$/);
      await expectOnlyActive(page, 'Жидкости');
      await expect(page.getByTestId('products-title')).toHaveText('Жидкости');
      await expect(cards(page)).toHaveText([/Noir Salt 30 мл/, /Velvet Ice 30 мл/]);
      const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
      const accentRgb = await page.evaluate((c) => {
        const el = document.createElement('div');
        el.style.color = c;
        document.body.append(el);
        const rgb = getComputedStyle(el).color;
        el.remove();
        return rgb;
      }, primary);
      // Active tile border uses the shop accent (polled: tiles animate colors); inactive ones do not.
      await expect.poll(() => tile(page, 'Жидкости').evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(accentRgb);
      await expect.poll(() => tile(page, 'Аксессуары').evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(accentRgb);

      // 4. «Pod-системы»: switches in place.
      await tile(page, 'Pod-системы').click();
      await expect(page).toHaveURL(/\?category=pods$/);
      await expectOnlyActive(page, 'Pod-системы');
      await expect(page.getByTestId('products-title')).toHaveText('Pod-системы');
      await expect(cards(page)).toHaveText([/Aurum Pod/, /Obsidian Kit/]);
      await expect(page.getByRole('heading', { name: 'Каталог', exact: true })).toHaveCount(0);

      // 5. Several switches + re-tapping the active tile: tiles stay, state stays consistent.
      await tile(page, 'Аксессуары').click();
      await tile(page, 'Жидкости').click();
      await tile(page, 'Жидкости').click();
      await expectOnlyActive(page, 'Жидкости');
      await expect(cards(page)).toHaveText([/Noir Salt 30 мл/, /Velvet Ice 30 мл/]);
      await expect(tiles(page)).toHaveCount(4);
      for (const t of await tiles(page).all()) await expect(t).toBeEnabled();

      // 6. Search inside the active category.
      await page.getByRole('searchbox', { name: 'Поиск товаров' }).fill('velvet');
      await expect(cards(page)).toHaveText([/Velvet Ice 30 мл/]);
      await expect(page).toHaveURL(/category=liquids&q=velvet$/);
      await page.getByRole('searchbox', { name: 'Поиск товаров' }).fill('чехол');
      await expect(page.getByText('Ничего не найдено по запросу «чехол»')).toBeVisible();
      await expect(cards(page)).toHaveCount(0);
      // «Все товары» drops only the category filter.
      await page.getByRole('button', { name: 'Все товары' }).click();
      await expect(page.getByTestId('products-title')).toHaveText('Все товары');
      await expect(cards(page)).toHaveText([/Чехол кожаный/]);
      await page.getByRole('button', { name: 'Очистить поиск' }).click();
      await expect(page).toHaveURL(/\/s\/noir-vapor\/$/);
      await expect(cards(page).nth(5)).toBeVisible();
    });

    test('product card, cart, profile and bottom nav keep working; category survives going back', async ({ page }) => {
      await openShop(page);
      await tile(page, 'Жидкости').click();
      await cards(page).filter({ hasText: 'Velvet Ice 30 мл' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Velvet Ice 30 мл' })).toBeVisible();
      await page.getByTestId('add-to-cart').click();
      await expect(page.getByTestId('cart-count')).toHaveText('1');

      await page.goBack();
      await expect(page).toHaveURL(/\?category=liquids$/);
      await expectOnlyActive(page, 'Жидкости');

      const nav = page.getByRole('navigation', { name: 'Основная навигация' });
      await nav.getByRole('link', { name: /Корзина/ }).click();
      await expect(page.getByTestId('cart-line')).toContainText('Velvet Ice');
      await nav.getByRole('link', { name: /Профиль/ }).click();
      await expect(page).toHaveURL(/\/profile$/);
      await nav.getByRole('link', { name: /Каталог/ }).click();
      await expect(page).toHaveURL(/\/s\/noir-vapor\/$/);
      await expect(nav.getByRole('link', { name: /Каталог/ })).toHaveAttribute('aria-current', 'page');
      await expect(tiles(page)).toHaveCount(4);

      // Old deep links to the removed catalog screen land on the home page with the same filter.
      await page.goto('/s/noir-vapor/catalog?category=pods');
      await expect(page).toHaveURL(/\/s\/noir-vapor\/\?category=pods$/);
      await expectOnlyActive(page, 'Pod-системы');
    });

    test('a category without stock shows a clear message', async ({ page }) => {
      await emptyCategoryStock('carts');
      try {
        await openShop(page);
        await tile(page, 'Картриджи').click();
        await expectOnlyActive(page, 'Картриджи');
        await expect(page.getByText('В категории «Картриджи» сейчас нет товаров в наличии')).toBeVisible();
        await expect(cards(page)).toHaveCount(0);
        await page.getByRole('button', { name: 'Показать все товары' }).click();
        await expect(page.getByTestId('products-title')).toHaveText('Все товары');
        await expect(cards(page).filter({ hasText: 'Картридж Aurum' })).toHaveCount(0);
      } finally {
        for (const v of savedStock) await db.from('product_variants').update({ stock_quantity: v.stock_quantity }).eq('id', v.id);
        savedStock = [];
      }
    });
  });
}
