import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { resolveSupabaseEnv, serviceClient } from '../scripts/lib/supabase-env.ts';
import { openAsTelegramUser } from './telegram';

type Owners = Record<'noir-vapor' | 'mint-lab', { email: string; password: string }>;
const owners = () => JSON.parse(readFileSync(join(process.cwd(), 'e2e', '.auth', 'owners.json'), 'utf8')) as Owners;

const db = serviceClient();
const buyer = { id: 8_100_000_000 + Math.floor(Math.random() * 1_000_000), first_name: 'E2E' };
let createdOrderId: string | null = null;
let variantId: string | null = null;
let originalStock: number | null = null;

async function loginOwner(page: Page, slug: keyof Owners) {
  const o = owners()[slug];
  await page.goto('/admin');
  await page.getByLabel('Email').fill(o.email);
  await page.getByLabel('Пароль').fill(o.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

test.afterAll(async () => {
  // Restore demo data touched by the scenario (the test order is flagged is_test anyway).
  if (createdOrderId) await db.from('orders').delete().eq('id', createdOrderId);
  if (variantId && originalStock !== null) await db.from('product_variants').update({ stock_quantity: originalStock }).eq('id', variantId);
});

test('buyer orders a flavor variant → owner sees the order → stock change appears in catalog → other owner is isolated', async ({ page, browser }) => {
  const { data: shop } = await db.from('shops').select('id').eq('slug', 'noir-vapor').single();
  const { data: v } = await db
    .from('product_variants')
    .select('id, stock_quantity')
    .eq('shop_id', shop!.id)
    .eq('seed_key', 'var:noir-salt-30/blueberry')
    .single();
  variantId = v!.id;
  originalStock = v!.stock_quantity;
  expect(originalStock).toBeGreaterThan(0);

  // 1. Open demo tenant inside a Telegram-like launch.
  await openAsTelegramUser(page, '/s/noir-vapor/', buyer);
  await page.getByRole('button', { name: /Да, мне есть 18/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeVisible();
  await expect(page.getByTestId('demo-banner')).toContainText('DEMO');

  // 2. Category → 3. product
  // The category filters the home page in place (no separate catalog screen).
  await page.getByRole('button', { name: 'Жидкости' }).click();
  await expect(page).toHaveURL(/\/s\/noir-vapor\/\?category=liquids$/);
  await expect(page.getByTestId('products-title')).toHaveText('Жидкости');
  await page.getByTestId('product-card').filter({ hasText: 'Noir Salt 30 мл' }).click();
  await expect(page.getByRole('heading', { name: 'Noir Salt 30 мл' })).toBeVisible();

  // 4. Choose a flavor: its own stock, the one product price (690 ₽ for every flavor)
  await expect(page.getByTestId('product-price')).toHaveText(/^690\s?₽$/);
  await page.getByRole('radio', { name: 'Черника' }).click();
  await expect(page.getByTestId('product-price')).toHaveText(/^690\s?₽$/);
  await expect(page.getByTestId('product-stock')).toContainText(`В наличии: ${originalStock} шт.`);

  // 5. Add to cart
  await page.getByTestId('add-to-cart').click();
  await expect(page.getByTestId('cart-count')).toHaveText('1');
  await page.getByRole('link', { name: /Корзина/ }).click();
  await expect(page.getByTestId('cart-line')).toContainText('Черника');
  await expect(page.getByTestId('cart-total')).toContainText('690');

  // 6. Create the (test) order — the Edge Function verifies initData and runs create_order.
  await page.getByLabel('Имя').fill('E2E Покупатель');
  await page.getByTestId('checkout-submit').click();
  const success = page.getByText(/Заказ №\d+ отправлен/);
  await expect(success).toBeVisible();
  const orderNumber = Number((await success.textContent())!.match(/№(\d+)/)![1]);

  // 7. Order and price snapshot persisted
  const { data: order } = await db
    .from('orders')
    .select('id, total_minor, is_test, customer_tg_id, order_items(unit_price_minor, flavor, quantity)')
    .eq('shop_id', shop!.id)
    .eq('order_number', orderNumber)
    .single();
  createdOrderId = order!.id;
  expect(order).toMatchObject({ total_minor: 69000, is_test: true, customer_tg_id: buyer.id });
  expect(order!.order_items).toEqual([{ unit_price_minor: 69000, flavor: 'Черника', quantity: 1 }]);
  expect(originalStock - 1).toBe((await db.from('product_variants').select('stock_quantity').eq('id', variantId).single()).data!.stock_quantity);

  // Buyer profile shows only own orders
  await page.getByRole('link', { name: 'Мои заказы' }).click();
  await expect(page.getByTestId('my-order').filter({ hasText: `Заказ №${orderNumber}` })).toBeVisible();

  // 8–9. Owner logs into the admin and sees the new order
  const adminCtx = await browser.newContext({ locale: 'ru-RU' });
  const admin = await adminCtx.newPage();
  await loginOwner(admin, 'noir-vapor');
  await admin.getByRole('link', { name: /Noir Vapor/ }).click();
  await admin.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Заказы', exact: true }).click();
  const card = admin.getByTestId('admin-order').filter({ hasText: `Заказ №${orderNumber}` });
  await expect(card).toContainText('Черника');
  await expect(card).toContainText('тестовый');

  // 10. Change the stock of the variant
  await admin.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Товары', exact: true }).click();
  await admin.getByTestId('admin-product-link').filter({ hasText: 'Noir Salt 30 мл' }).click();
  await expect(admin.getByText('Опубликован', { exact: true })).toBeVisible();
  await expect(admin.getByText('Рекомендуемый', { exact: true })).toHaveCount(0);
  const row = admin.getByTestId('variant-row').filter({ has: admin.getByLabel('Вкус').and(admin.locator('[value="Черника"]')) });
  await row.getByTestId('variant-stock').fill('42');
  await row.getByTestId('variant-save').click();
  await expect(admin.getByText('Вариант сохранён')).toBeVisible();

  // 11. Catalog reflects the change without any rebuild
  await page.goto(`/s/noir-vapor/product/${(await db.from('product_variants').select('product_id').eq('id', variantId).single()).data!.product_id}`);
  await page.getByRole('radio', { name: 'Черника' }).click();
  await expect(page.getByTestId('product-stock')).toContainText('В наличии: 42 шт.');

  // 12. Owner of the second tenant sees neither the order nor can edit the product
  const otherCtx = await browser.newContext({ locale: 'ru-RU' });
  const other = await otherCtx.newPage();
  await loginOwner(other, 'mint-lab');
  await expect(other.getByRole('link', { name: /Noir Vapor/ })).toHaveCount(0);
  await other.goto('/admin/shops/noir-vapor/orders');
  await expect(other.getByText('Нет доступа к магазину')).toBeVisible();

  const env = resolveSupabaseEnv();
  const mint = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  await mint.auth.signInWithPassword({ email: owners()['mint-lab'].email, password: owners()['mint-lab'].password });
  expect((await mint.from('orders').select('id').eq('id', createdOrderId)).data).toEqual([]);
  const { data: hijack } = await mint.from('products').update({ name: 'hijacked' }).eq('shop_id', shop!.id).select('id');
  expect(hijack ?? []).toEqual([]);
  const stockRpc = await mint.rpc('admin_set_variant_stock', { p_variant_id: variantId, p_quantity: 0 });
  expect(stockRpc.error?.message).toBe('variant_not_found');

  await adminCtx.close();
  await otherCtx.close();
});
