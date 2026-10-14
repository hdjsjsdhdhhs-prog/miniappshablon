import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

const db = serviceClient();
const owners = () => JSON.parse(readFileSync(join(process.cwd(), 'e2e', '.auth', 'owners.json'), 'utf8')) as Record<string, { email: string; password: string }>;
let original: { name: string; theme_config: unknown; logo_path: string | null } | null = null;

test.afterAll(async () => {
  if (!original) return;
  const { data: current } = await db.from('shops').select('logo_path').eq('slug', 'mint-lab').single();
  // Replacing the logo in the admin correctly deletes the now-unreferenced seed file, so restore
  // the original seed asset (content-addressed path) before pointing the shop back to it.
  if (original.logo_path) {
    const src = readFileSync(join(process.cwd(), 'tenants', 'mint-lab', 'assets', 'logo.png'));
    await db.storage.from('shop-media').upload(original.logo_path, src, { contentType: 'image/png', upsert: true });
  }
  await db.from('shops').update(original as never).eq('slug', 'mint-lab');
  if (current?.logo_path && current.logo_path !== original.logo_path) {
    await db.storage.from('shop-media').remove([current.logo_path]);
  }
});

test('owner changes name, palette and logo in the admin → storefront updates without a rebuild', async ({ page, browser }) => {
  const { data } = await db.from('shops').select('name, theme_config, logo_path').eq('slug', 'mint-lab').single();
  original = data as typeof original;

  const admin = await (await browser.newContext({ locale: 'ru-RU' })).newPage();
  await admin.goto('/admin');
  await admin.getByLabel('Email').fill(owners()['mint-lab']!.email);
  await admin.getByLabel('Пароль').fill(owners()['mint-lab']!.password);
  await admin.getByRole('button', { name: 'Войти' }).click();
  await expect(admin.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
  await admin.getByRole('link', { name: /Mint Lab/ }).click();
  await admin.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Оформление', exact: true }).click();

  await admin.getByTestId('settings-name').fill('Mint Lab Renamed');
  await admin.getByLabel('Основной (кнопки) (hex)').fill('#7c3aed');
  await admin.getByTestId('settings-save').click();
  await expect(admin.getByText(/Сохранено/)).toBeVisible();

  // Logo upload goes through browser-image-compression → Storage (policy-checked) → shops.logo_path
  await admin.getByLabel('Логотип: выбрать файл').setInputFiles(join(process.cwd(), 'tenants', 'noir-vapor', 'assets', 'logo.png'));
  await expect(admin.getByText('Изображение сохранено')).toBeVisible();
  const { data: after } = await db.from('shops').select('id, name, logo_path, theme_config').eq('slug', 'mint-lab').single();
  expect(after!.name).toBe('Mint Lab Renamed');
  expect((after!.theme_config as { primary: string }).primary).toBe('#7c3aed');
  expect(after!.logo_path).toMatch(new RegExp(`^${after!.id}/logo/.+\\.webp$`));

  await page.goto('/s/mint-lab/');
  await page.getByRole('button', { name: /Да, мне есть 18/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Mint Lab Renamed' })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Логотип Mint Lab Renamed' })).toHaveAttribute('src', new RegExp(after!.logo_path!));
  const primary = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--primary').trim());
  expect(primary).toBe('#7c3aed');
});
