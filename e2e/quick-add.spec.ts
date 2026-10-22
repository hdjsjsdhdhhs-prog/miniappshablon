import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

// Catalog card "В корзину" → compact flavor sheet → cart, against the real local Supabase demo data.
const db = serviceClient();
const SHOP = '/s/noir-vapor/';
const PRODUCT = 'Noir Salt 30 мл';

let restore: Array<{ id: string; stock_quantity: number }> = [];
test.afterEach(async () => {
  for (const v of restore) await db.from('product_variants').update({ stock_quantity: v.stock_quantity }).eq('id', v.id);
  restore = [];
});

async function productVariants() {
  const { data: shop } = await db.from('shops').select('id').eq('slug', 'noir-vapor').single();
  const { data: product } = await db.from('products').select('id').eq('shop_id', shop!.id).eq('name', PRODUCT).single();
  const { data } = await db
    .from('product_variants')
    .select('id, flavor, color, stock_quantity, is_active')
    .eq('product_id', product!.id);
  return { productId: product!.id, variants: data! };
}

async function openShop(page: Page) {
  await page.goto(SHOP);
  await page.getByRole('button', { name: /Да, мне есть 18/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeVisible();
}

const card = (page: Page, name = PRODUCT) => page.getByTestId('product-card').filter({ hasText: name });
const sheet = (page: Page) => page.getByTestId('quick-add-sheet');
/** Waits for the sheet's slide-in animation to finish before measuring it. */
const settled = (page: Page) =>
  sheet(page).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)).then(() => undefined));

test('every card shows "В корзину" right under the price with a finger-sized target', async ({ page }) => {
  await openShop(page);
  const cards = page.getByTestId('product-card');
  await expect(cards.first()).toBeVisible();
  const count = await cards.count();
  expect(count).toBeGreaterThan(3);
  for (let i = 0; i < count; i++) {
    const c = cards.nth(i);
    const price = await c.locator('p').last().boundingBox();
    const btn = c.getByTestId('quick-add');
    const box = (await btn.boundingBox())!;
    const cardBox = (await c.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(price!.y + price!.height); // below the price
    expect(box.y - (price!.y + price!.height)).toBeLessThan(20); // directly below
    expect(box.height).toBeLessThanOrEqual(36); // compact look
    expect(Math.abs(cardBox.width - 24 - box.width)).toBeLessThan(3); // inner card width (12 px padding)
    // Hit area (::after) ≥ 44 px tall.
    const hit = await btn.evaluate((el) => parseFloat(getComputedStyle(el, '::after').height));
    expect(hit).toBeGreaterThanOrEqual(44);
  }
});

test('button opens the compact sheet over the catalog; chosen flavor goes to the cart; repeat merges', async ({ page }) => {
  const { variants } = await productVariants();
  const purchasable = variants.filter((v) => v.is_active && v.stock_quantity > 0).map((v) => v.flavor);
  const hidden = variants.filter((v) => !v.is_active || v.stock_quantity <= 0).map((v) => v.flavor);

  await openShop(page);
  const url = page.url();
  await card(page).getByTestId('quick-add').click();
  await expect(sheet(page)).toBeVisible();
  expect(page.url()).toBe(url); // no navigation
  await expect(page.getByTestId('product-grid')).toBeAttached(); // catalog stays underneath
  await expect(page.getByTestId('cart-count')).toHaveCount(0); // opening adds nothing

  const radios = sheet(page).getByRole('radio');
  await expect(radios).toHaveCount(purchasable.length);
  for (const f of hidden) if (f) await expect(sheet(page).getByRole('radio', { name: new RegExp(f) })).toHaveCount(0);
  for (const r of await radios.all()) await expect(r).toHaveAttribute('aria-checked', 'false');
  await expect(sheet(page).getByTestId('quick-confirm')).toBeDisabled();

  await sheet(page).getByRole('radio', { name: /Черника/ }).click();
  await expect(sheet(page).getByRole('radio', { name: /Черника/ })).toHaveAttribute('aria-checked', 'true');
  // One price per product: Черника costs the same 690 ₽ as every other flavor, without "от".
  await expect(sheet(page).getByTestId('quick-price')).toHaveText(/^690\s?₽$/);

  // Not covered by the bottom nav: the confirm button is the topmost element at its own centre.
  await settled(page);
  const confirm = sheet(page).getByTestId('quick-confirm');
  expect(
    await confirm.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }),
  ).toBe(true);
  // Liquid Glass surface from the shop scene tokens: controlled backdrop blur on a translucent fill.
  const surface = await sheet(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { blur: s.backdropFilter || s.getPropertyValue('-webkit-backdrop-filter'), bg: s.backgroundColor };
  });
  expect(surface.blur).toContain('blur(');
  expect(surface.bg).not.toBe('rgba(0, 0, 0, 0)');
  await page.screenshot({ path: '.tmp-shots/quick-add-sheet.png' });

  await confirm.click();
  await expect(sheet(page)).toHaveCount(0);
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  expect(page.url()).toBe(url);

  await card(page).getByTestId('quick-add').click();
  await sheet(page).getByRole('radio', { name: /Черника/ }).click();
  await sheet(page).getByTestId('quick-confirm').click();
  await expect(page.getByTestId('cart-count')).toHaveText('2');

  await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('link', { name: /Корзина/ }).click();
  await expect(page.getByTestId('cart-line')).toHaveCount(1);
  await expect(page.getByTestId('cart-line')).toContainText('Черника');
  await expect(page.getByTestId('cart-total')).toContainText('1 380');
});

test('photo, name and price open the full product page with the detailed picker', async ({ page }) => {
  await openShop(page);
  for (const target of ['img-or-placeholder', 'name', 'price'] as const) {
    const c = card(page);
    const loc =
      target === 'name' ? c.getByRole('heading', { name: PRODUCT }) : target === 'price' ? c.locator('p').last() : c.getByRole('img').first();
    await loc.click();
    await expect(page.getByRole('heading', { level: 1, name: PRODUCT })).toBeVisible();
    await expect(page.getByTestId('variant-picker')).toBeVisible();
    await expect(page.getByTestId('product-stock')).toBeVisible();
    await expect(page.getByTestId('add-to-cart')).toBeVisible();
    await page.goBack();
    await expect(card(page)).toBeVisible();
  }
});

test('stock that ran out after opening is refused and the sheet offers a refresh', async ({ page }) => {
  const { variants } = await productVariants();
  const target = variants.find((v) => v.flavor === 'Черника')!;
  await openShop(page);
  await card(page).getByTestId('quick-add').click();
  await sheet(page).getByRole('radio', { name: /Черника/ }).click();

  restore = [{ id: target.id, stock_quantity: target.stock_quantity }];
  await db.from('product_variants').update({ stock_quantity: 0 }).eq('id', target.id);

  await sheet(page).getByTestId('quick-confirm').click();
  await expect(sheet(page).getByTestId('quick-error')).toContainText('закончился');
  await expect(sheet(page).getByRole('radio', { name: /Черника/ })).toHaveCount(0);
  await expect(page.getByTestId('cart-count')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet(page)).toHaveCount(0);
});

test('sheet fits a small phone and closes by tapping outside', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openShop(page);
  await card(page).getByTestId('quick-add').click();
  await settled(page);
  const box = (await sheet(page).boundingBox())!;
  expect(box.y).toBeGreaterThan(0);
  expect(box.y + box.height).toBeLessThanOrEqual(568 + 1);
  await expect(sheet(page).getByTestId('quick-confirm')).toBeInViewport();
  await page.screenshot({ path: '.tmp-shots/quick-add-sheet-320.png' });
  await page.mouse.click(160, 20); // overlay
  await expect(sheet(page)).toHaveCount(0);
  await expect(page).toHaveURL(/\/s\/noir-vapor\/$/);
});
