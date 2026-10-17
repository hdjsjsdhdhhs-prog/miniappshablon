import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

const db = serviceClient();
const owners = () => JSON.parse(readFileSync(join(process.cwd(), 'e2e', '.auth', 'owners.json'), 'utf8')) as Record<string, { email: string; password: string }>;
const productName = `E2E товар ${Date.now()}`;

test.afterAll(async () => {
  await db.from('products').delete().eq('name', productName);
});

test('owner creates a product → lands on the new product card, not the shops list', async ({ page }) => {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(owners()['mint-lab']!.email);
  await page.getByLabel('Пароль').fill(owners()['mint-lab']!.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
  await page.getByRole('link', { name: /Mint Lab/ }).click();
  await page.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Товары', exact: true }).click();
  await page.getByRole('link', { name: 'Новый товар' }).click();
  await expect(page).toHaveURL(/\/admin\/shops\/mint-lab\/products\/new$/);

  await page.getByLabel('Название').fill(productName);
  await page.getByLabel('Категория').click();
  await page.getByRole('option').first().click();
  await page.getByTestId('product-price-input').fill('1290');
  await page.getByTestId('product-save').click();
  await expect(page.getByText('Товар сохранён')).toBeVisible();

  const { data: created } = await db.from('products').select('id').eq('name', productName).single();
  expect(created?.id).toBeTruthy();
  await expect(page).toHaveURL(new RegExp(`/admin/shops/mint-lab/products/${created!.id}$`));
  await expect(page.getByRole('link', { name: '← Все товары' })).toBeVisible();
  await expect(page.getByLabel('Название')).toHaveValue(productName);
});
