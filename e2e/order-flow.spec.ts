import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { expect, test, type Page } from '@playwright/test';
import { resolveSupabaseEnv, serviceClient } from '../scripts/lib/supabase-env.ts';
import { createAccount, createDemoShop, deleteShops, deleteUsers, type Account } from './shops';
import { openAsTelegramUser } from './telegram';

type Owners = Record<'noir-vapor' | 'mint-lab', { email: string; password: string }>;
const owners = () => JSON.parse(readFileSync(join(process.cwd(), 'e2e', '.auth', 'owners.json'), 'utf8')) as Owners;

const db = serviceClient();
const run = randomBytes(3).toString('hex');
const created = { shops: [] as string[], users: [] as string[] };

async function login(page: Page, a: { email: string; password: string }) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

async function orderCounts(shopId: string) {
  const orders = await db.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', shopId);
  const moves = await db.from('inventory_movements').select('id', { count: 'exact', head: true }).eq('shop_id', shopId).eq('reason', 'checkout');
  return { orders: orders.count, moves: moves.count };
}

test.afterAll(async () => {
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('DEMO inside Telegram: a "Тестовый заказ" only — no order row, no stock change, demo profile', async ({ page }) => {
  const { data: shop } = await db.from('shops').select('id').eq('slug', 'noir-vapor').single();
  const { data: v } = await db.from('product_variants').select('id, stock_quantity').eq('shop_id', shop!.id).eq('seed_key', 'var:noir-salt-30/blueberry').single();
  const before = await orderCounts(shop!.id);
  const functionCalls: string[] = [];
  page.on('request', (r) => {
    if (/\/functions\/v1\/(checkout|my-orders)/.test(r.url())) functionCalls.push(r.url());
  });

  await openAsTelegramUser(page, '/s/noir-vapor/', { id: 8_100_000_000 + Math.floor(Math.random() * 1e6), first_name: 'E2E' });
  await expect(page.getByTestId('demo-banner')).toContainText('DEMO-режим');
  await page.getByTestId('product-card').filter({ hasText: 'Noir Salt 30 мл' }).getByTestId('product-card-link').click();
  await page.getByRole('radio', { name: 'Черника' }).click();
  await page.getByTestId('add-to-cart').click();
  await page.getByRole('link', { name: /Корзина/ }).click();
  await expect(page.getByTestId('demo-checkout-note')).toContainText('Это демонстрация');
  await expect(page.getByLabel('Имя')).toHaveCount(0);
  await expect(page.getByLabel(/Телефон/)).toHaveCount(0);
  await page.getByLabel('Адрес доставки').fill('ул. Демо, 1');
  await page.getByTestId('checkout-submit').click();
  const placed = page.getByTestId('demo-order-placed');
  await expect(placed).toContainText('Тестовый заказ оформлен');
  await expect(placed).toContainText('Это демонстрация');

  await page.getByRole('link', { name: 'Демо-профиль' }).click();
  await expect(page.getByTestId('demo-profile')).toBeVisible();
  await expect(page.getByTestId('demo-order')).toContainText('Тестовый заказ');
  await expect(page.getByTestId('my-order')).toHaveCount(0);

  expect(functionCalls).toEqual([]);
  expect(await orderCounts(shop!.id)).toEqual(before);
  expect((await db.from('product_variants').select('stock_quantity').eq('id', v!.id).single()).data!.stock_quantity).toBe(v!.stock_quantity);
});

test('regular shop: buyer orders with delivery → owner sees the address → stock change appears → other owner is isolated', async ({ page, browser }) => {
  // A regular (non-DEMO) shop with the Noir Vapor catalog, created through the real create-demo path.
  const platform: Account = await createAccount('of-platform', { platformAdmin: true });
  const owner: Account = await createAccount('of-owner');
  created.users.push(platform.id, owner.id);
  const slug = `e2e-live-${run}`;
  const shop = await createDemoShop(platform, 'noir-vapor', slug, `Live ${run}`);
  created.shops.push(shop.id);
  await db.from('shops').update({ is_demo: false }).eq('id', shop.id);
  await db.from('shop_memberships').insert({ shop_id: shop.id, user_id: owner.id, role: 'owner' });

  const { data: v } = await db.from('product_variants').select('id, stock_quantity, product_id').eq('shop_id', shop.id).eq('flavor', 'Черника').limit(1).single();
  const variantId = v!.id;
  const originalStock = v!.stock_quantity;
  expect(originalStock).toBeGreaterThan(0);
  const buyer = { id: 8_100_000_000 + Math.floor(Math.random() * 1_000_000), first_name: 'E2E' };

  await openAsTelegramUser(page, `/s/${slug}/`, buyer);
  await expect(page.getByRole('heading', { level: 1, name: `Live ${run}` })).toBeVisible();
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);

  await page.getByRole('button', { name: 'Жидкости' }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${slug}/\\?category=liquids$`));
  await page.getByTestId('product-card').filter({ hasText: 'Noir Salt 30 мл' }).getByTestId('product-card-link').click();
  await expect(page.getByTestId('product-price')).toHaveText(/^690\s?₽$/);
  await page.getByRole('radio', { name: 'Черника' }).click();
  await expect(page.getByTestId('product-stock')).toHaveText(`Осталось: ${originalStock}`);
  await page.getByTestId('add-to-cart').click();
  await page.getByRole('link', { name: /Корзина/ }).click();
  await expect(page.getByTestId('cart-line')).toContainText('Черника');

  // Delivery is pre-selected; the address is required.
  await expect(page.getByTestId('fulfillment-delivery')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('checkout-submit').click();
  await expect(page.getByText('Укажите адрес доставки')).toBeVisible();
  await page.getByLabel('Адрес доставки').fill('ул. Ленина, 10, кв. 5');
  await page.getByLabel(/Комментарий/).fill('Позвоните за час');
  await page.getByTestId('checkout-submit').click();
  const success = page.getByText(/Заказ №\d+ отправлен/);
  await expect(success).toBeVisible();
  const orderNumber = Number((await success.textContent())!.match(/№(\d+)/)![1]);

  const { data: order } = await db
    .from('orders')
    .select('id, total_minor, is_test, customer_tg_id, fulfillment_method, delivery_address, contact_name, order_items(unit_price_minor, flavor, quantity)')
    .eq('shop_id', shop.id)
    .eq('order_number', orderNumber)
    .single();
  expect(order).toMatchObject({
    total_minor: 69000,
    is_test: false,
    customer_tg_id: buyer.id,
    fulfillment_method: 'delivery',
    delivery_address: 'ул. Ленина, 10, кв. 5',
    contact_name: null,
  });
  expect(order!.order_items).toEqual([{ unit_price_minor: 69000, flavor: 'Черника', quantity: 1 }]);
  expect((await db.from('product_variants').select('stock_quantity').eq('id', variantId).single()).data!.stock_quantity).toBe(originalStock - 1);

  // Real profile with the verified Telegram identity (no demo mock-up in a regular shop).
  await page.getByRole('link', { name: 'Мои заказы' }).click();
  await expect(page.getByTestId('my-order').filter({ hasText: `Заказ №${orderNumber}` })).toContainText('Доставка');
  await expect(page.getByTestId('demo-profile')).toHaveCount(0);

  // Owner sees the order with the delivery address.
  const adminCtx = await browser.newContext({ locale: 'ru-RU' });
  const admin = await adminCtx.newPage();
  await login(admin, owner);
  await admin.getByRole('link', { name: new RegExp(`Live ${run}`) }).first().click();
  await admin.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Заказы', exact: true }).click();
  const card = admin.getByTestId('admin-order').filter({ hasText: `Заказ №${orderNumber}` });
  await expect(card).toContainText('Черника');
  await expect(card.getByTestId('admin-order-fulfillment')).toHaveText('Доставка: ул. Ленина, 10, кв. 5');
  await expect(card).not.toContainText('тестовый');

  // Stock change in the admin → visible in the catalog without a rebuild.
  await admin.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Товары', exact: true }).click();
  await admin.getByTestId('admin-product-link').filter({ hasText: 'Noir Salt 30 мл' }).click();
  const row = admin.getByTestId('variant-row').filter({ has: admin.getByLabel('Вкус').and(admin.locator('[value="Черника"]')) });
  await row.getByTestId('variant-stock').fill('42');
  await row.getByTestId('variant-save').click();
  await expect(admin.getByText('Вариант сохранён')).toBeVisible();
  await page.goto(`/s/${slug}/product/${v!.product_id}`);
  await page.getByRole('radio', { name: 'Черника' }).click();
  await expect(page.getByTestId('product-stock')).toHaveText('Осталось: 42');

  // Another tenant's owner sees neither the order nor can edit the product.
  const otherCtx = await browser.newContext({ locale: 'ru-RU' });
  const other = await otherCtx.newPage();
  await login(other, owners()['mint-lab']);
  await other.goto(`/admin/shops/${slug}/orders`);
  await expect(other.getByText('Нет доступа к магазину')).toBeVisible();
  const env = resolveSupabaseEnv();
  const mint = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  await mint.auth.signInWithPassword({ email: owners()['mint-lab'].email, password: owners()['mint-lab'].password });
  expect((await mint.from('orders').select('id').eq('id', order!.id)).data).toEqual([]);
  expect((await mint.from('products').update({ name: 'hijacked' }).eq('shop_id', shop.id).select('id')).data ?? []).toEqual([]);
  expect((await mint.rpc('admin_set_variant_stock', { p_variant_id: variantId, p_quantity: 0 })).error?.message).toBe('variant_not_found');

  await adminCtx.close();
  await otherCtx.close();
});
