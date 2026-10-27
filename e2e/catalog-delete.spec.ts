import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import { DARK_PREMIUM_THEME } from '../src/domain/theme.ts';
import { createAccount, deleteShops, deleteUsers, type Account } from './shops';

// Physical deletion in the owner admin, in a real browser against the LOCAL stack, on a throw-away shop (seeded
// tenants are never touched). Every UI step is checked against the database and Storage afterwards.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
let owner: Account;
let shop: { id: string; slug: string };
let orderCounter = 0;

async function must<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<NonNullable<T>> {
  const { data, error } = await p;
  if (error) throw error;
  return data as NonNullable<T>;
}

async function category(name: string) {
  return (await must(db.from('categories').insert({ shop_id: shop.id, name, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${run}` }).select('id').single())).id;
}

async function product(name: string, categoryId: string, flavors: string[]) {
  const p = await must(db.from('products').insert({ shop_id: shop.id, category_id: categoryId, name, base_price_minor: 99000, is_published: true }).select('id').single());
  const vs = await must(
    db.from('product_variants').insert(flavors.map((f, i) => ({ shop_id: shop.id, product_id: p.id, flavor: f, stock_quantity: 3, sort_order: i }))).select('id, flavor'),
  );
  return { id: p.id, variants: Object.fromEntries(vs.map((v) => [v.flavor!, v.id])) as Record<string, string> };
}

/** A stored order line for the variant (the shop's real checkout is covered by the integration tests). */
async function orderLine(productId: string, variantId: string, name: string) {
  orderCounter += 1;
  const o = await must(
    db
      .from('orders')
      .insert({
        shop_id: shop.id,
        order_number: orderCounter,
        customer_tg_id: 8_500_000_000 + orderCounter,
        currency: 'RUB',
        total_minor: 99000,
        idempotency_key: randomUUID(),
        request_hash: 'e2e',
        fulfillment_method: 'pickup',
      })
      .select('id')
      .single(),
  );
  await must(
    db.from('order_items').insert({
      shop_id: shop.id, order_id: o.id, product_id: productId, variant_id: variantId, product_name: name,
      unit_price_minor: 99000, quantity: 1, line_total_minor: 99000,
    }).select('id'),
  );
  return o.id;
}

async function login(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/admin');
  await page.getByLabel('Email').fill(owner.email);
  await page.getByLabel('Пароль').fill(owner.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

const rowExists = async (table: 'products' | 'product_variants' | 'categories', id: string) =>
  (await must(db.from(table).select('id').eq('id', id))).length === 1;

test.beforeAll(async () => {
  owner = await createAccount('catalog-delete');
  const slug = `e2e-del-${run}`;
  shop = await must(
    db.from('shops').insert({ slug, name: `Delete ${run}`, theme_config: DARK_PREMIUM_THEME, currency: 'RUB', mode: 'live' }).select('id, slug').single(),
  );
  await must(db.from('shop_memberships').insert({ shop_id: shop.id, user_id: owner.id, role: 'owner' }).select('id'));
});

test.afterAll(async () => {
  await deleteShops([shop.id]);
  await deleteUsers([owner.id]);
});

test.describe.configure({ mode: 'serial' });

test('product without orders: confirm → deleted in the DB with its variants and unused photo; list updated', async ({ page }) => {
  const cat = await category('Del Cat');
  const p = await product(`E2E удаляемый ${run}`, cat, ['Мята', 'Вишня']);
  const path = `${shop.id}/product/${p.id}/e2e.png`;
  await must(db.storage.from('shop-media').upload(path, PNG, { contentType: 'image/png' }));
  await must(db.from('product_images').insert({ shop_id: shop.id, product_id: p.id, storage_path: path, is_primary: true }).select('id'));

  await login(page);
  await page.goto(`/admin/shops/${shop.slug}/products/${p.id}`);
  await page.getByTestId('product-delete').click();
  const dialog = page.getByTestId('product-delete-dialog');
  await expect(dialog).toContainText(`Удалить «E2E удаляемый ${run}»?`);
  await expect(dialog).toContainText('вариантами (2)');
  // Cancel keeps everything.
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await rowExists('products', p.id)).toBe(true);

  await page.getByTestId('product-delete').click();
  await page.getByTestId('product-delete-dialog-confirm').click();
  await expect(page.getByText('Товар удалён')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/admin/shops/${shop.slug}/products$`));
  await expect(page.getByTestId('admin-product-link').filter({ hasText: `E2E удаляемый ${run}` })).toHaveCount(0);

  expect(await rowExists('products', p.id)).toBe(false);
  for (const v of Object.values(p.variants)) expect(await rowExists('product_variants', v)).toBe(false);
  expect(await must(db.from('product_images').select('id').eq('product_id', p.id))).toEqual([]);
  const files = await must(db.storage.from('shop-media').list(`${shop.id}/product/${p.id}`));
  expect(files.filter((f) => f.name === 'e2e.png')).toEqual([]);
});

test('product in an order: delete is refused with an explanation, archiving is offered and works, history intact', async ({ page }) => {
  const cat = await category('Ordered Cat');
  const name = `E2E проданный ${run}`;
  const p = await product(name, cat, ['Мята']);
  const orderId = await orderLine(p.id, p.variants['Мята']!, name);

  await login(page);
  await page.goto(`/admin/shops/${shop.slug}/products/${p.id}`);
  await page.getByTestId('product-delete').click();
  const dialog = page.getByTestId('product-delete-dialog');
  await page.getByTestId('product-delete-dialog-confirm').click();
  const error = page.getByTestId('product-delete-dialog-error');
  await expect(error).toContainText('Товар нельзя удалить: он уже есть в 1 заказе');
  await expect(error).toContainText('повредило бы историю продаж');
  await expect(page.getByTestId('product-delete-dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('product-delete-archive').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Вернуть из архива' })).toBeVisible();

  const row = await must(db.from('products').select('archived_at').eq('id', p.id).single());
  expect(row.archived_at).not.toBeNull();
  expect(await must(db.from('order_items').select('product_id, variant_id, product_name').eq('order_id', orderId))).toEqual([
    { product_id: p.id, variant_id: p.variants['Мята'], product_name: name },
  ]);
});

test('variants: an unused flavor is deleted, an ordered one is refused and can be switched off', async ({ page }) => {
  const cat = await category('Var Cat');
  const name = `E2E варианты ${run}`;
  const p = await product(name, cat, ['Оставить', 'Удалить', 'Продан']);
  await orderLine(p.id, p.variants['Продан']!, name);

  await login(page);
  await page.goto(`/admin/shops/${shop.slug}/products/${p.id}`);
  const rows = page.getByTestId('variant-row');
  await expect(rows).toHaveCount(3);

  await page.getByRole('button', { name: 'Удалить вариант Удалить' }).click();
  await expect(page.getByTestId('variant-delete-dialog')).toContainText('Удалить вариант «Удалить»?');
  await page.getByTestId('variant-delete-dialog-confirm').click();
  await expect(page.getByText('Вариант удалён')).toBeVisible();
  await expect(rows).toHaveCount(2);
  expect(await rowExists('product_variants', p.variants['Удалить']!)).toBe(false);

  await page.getByRole('button', { name: 'Удалить вариант Продан' }).click();
  await page.getByTestId('variant-delete-dialog-confirm').click();
  await expect(page.getByTestId('variant-delete-dialog-error')).toContainText('Вариант нельзя удалить: он уже есть в 1 заказе');
  await page.getByTestId('variant-delete-deactivate').click();
  await expect(page.getByText('Вариант выключен')).toBeVisible();
  await expect(rows).toHaveCount(2);
  const sold = await must(db.from('product_variants').select('is_active').eq('id', p.variants['Продан']!).single());
  expect(sold.is_active).toBe(false);

  // The last remaining variant (after deleting nothing else) — the server explains instead of deleting.
  const solo = await product(`E2E один ${run}`, cat, ['Единственный']);
  await page.goto(`/admin/shops/${shop.slug}/products/${solo.id}`);
  await page.getByRole('button', { name: 'Удалить вариант Единственный' }).click();
  await page.getByTestId('variant-delete-dialog-confirm').click();
  await expect(page.getByTestId('variant-delete-dialog-error')).toContainText('единственный вариант товара');
  expect(await rowExists('product_variants', solo.variants['Единственный']!)).toBe(true);
});

test('categories: products must be moved first; an empty category is deleted directly', async ({ page }) => {
  const from = await category('Move From');
  const to = await category('Move To');
  const empty = await category('Empty One');
  const p = await product(`E2E переносимый ${run}`, from, ['A']);

  await login(page);
  await page.goto(`/admin/shops/${shop.slug}/categories`);
  // Each row's image picker is labelled with the category name ("Изображение <name>: выбрать файл").
  const rowOf = (name: string) => page.getByTestId('category-row').filter({ has: page.getByLabel(`Изображение ${name}: выбрать файл`, { exact: true }) });

  await rowOf('Move From').getByTestId('category-delete').click();
  const dialog = page.getByTestId('category-delete-dialog');
  await expect(dialog.getByTestId('category-delete-count')).toHaveText('В категории 1 товар (включая архивные).');
  await expect(page.getByTestId('category-delete-dialog-confirm')).toBeDisabled();
  await dialog.getByTestId('category-delete-target').click();
  await page.getByRole('option', { name: 'Move To' }).click();
  await page.getByTestId('category-delete-dialog-confirm').click();
  await expect(page.getByText('Категория удалена. 1 товар перенесён в «Move To»')).toBeVisible();
  await expect(rowOf('Move From')).toHaveCount(0);
  expect(await rowExists('categories', from)).toBe(false);
  expect((await must(db.from('products').select('category_id').eq('id', p.id).single())).category_id).toBe(to);

  await rowOf('Empty One').getByTestId('category-delete').click();
  await expect(dialog).toContainText('В категории нет товаров');
  await page.getByTestId('category-delete-dialog-confirm').click();
  await expect(page.getByText('Категория удалена', { exact: true })).toBeVisible();
  await expect(rowOf('Empty One')).toHaveCount(0);
  expect(await rowExists('categories', empty)).toBe(false);
});
