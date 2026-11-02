import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import { completeMfa, createAccount, createDemoShop, deleteShops, deleteUsers, localSql, type Account } from './shops';

// "Удалить DEMO" in the platform admin (20261102090200), in a real browser against the LOCAL stack: preview with the
// shop's data and its owner, the strong confirmation (exact slug), complete deletion incl. Storage, the old link
// showing "Магазин не найден", the client account kept. LIVE shops offer no such action.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const slug = `e2e-del-${run}`;
const name = `Delete ${run}`;
const created = { shops: [] as string[], users: [] as string[] };
let platform: Account;
let owner: Account;
let shopId: string;

async function login(page: Page, a: Account) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await completeMfa(page, a);
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

const mediaCount = () => Number(localSql(`select count(*) from storage.objects where bucket_id = 'shop-media' and starts_with(name, '${shopId}/');`));

test.beforeAll(async () => {
  platform = await createAccount('del-admin', { platformAdmin: true });
  owner = await createAccount('del-owner');
  created.users.push(platform.id, owner.id);
  shopId = (await createDemoShop(platform, 'noir-vapor', slug, name)).id;
  created.shops.push(shopId);
  const { error } = await db.from('shop_memberships').insert({ shop_id: shopId, user_id: owner.id, role: 'owner' });
  if (error) throw error;
});

test.afterAll(async () => {
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('platform admin deletes a DEMO shop completely after typing its slug; the link then shows "not found"', async ({ page }) => {
  const { data: shop } = await db.from('shops').select('id, is_demo, mode').eq('id', shopId).single();
  expect(shop).toMatchObject({ is_demo: true });
  const media = mediaCount();
  expect(media).toBeGreaterThan(0);
  await page.goto(`/s/${slug}/`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, platform);
  await page.goto('/admin/platform');
  // LIVE (non-DEMO) shops have no delete action.
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill('neon-district');
  await expect(page.getByTestId('platform-shop')).toHaveCount(1);
  await expect(page.getByTestId('platform-shop').getByTestId('platform-demo-delete')).toHaveCount(0);

  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(slug);
  const row = page.getByTestId('platform-shop');
  await expect(row).toHaveCount(1);
  await row.getByTestId('platform-demo-delete').click();
  const dialog = page.getByTestId('demo-delete-dialog');
  await expect(dialog.getByTestId('demo-delete-slug')).toHaveText(slug);
  await expect(dialog).toContainText(`/s/${slug}/`);
  for (const k of ['products', 'categories', 'variants']) {
    expect(Number(await dialog.getByTestId(`demo-delete-count-${k}`).textContent()), k).toBeGreaterThan(0);
  }
  await expect(dialog.getByTestId('demo-delete-count-media_files')).toHaveText(String(media));
  await expect(dialog.getByTestId('demo-delete-owner')).toContainText(owner.email);
  await expect(dialog.getByTestId('demo-delete-owner-warning')).toBeVisible();

  // Strong confirmation: the button stays disabled until the exact slug is typed.
  const confirm = dialog.getByTestId('demo-delete-confirm');
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId('demo-delete-input').fill(slug.slice(0, -1));
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId('demo-delete-input').fill(slug);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog.getByTestId('demo-delete-done')).toContainText(slug);
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByTestId('platform-shop')).toHaveCount(0);

  // Gone completely, files included; the owner's account stays.
  expect((await db.from('shops').select('id').eq('id', shopId)).data).toEqual([]);
  expect(mediaCount()).toBe(0);
  expect(localSql(`select private.shop_leftover_rows('${shopId}')::text;`)).toBe('{}');
  expect(localSql(`select slug || ':' || (requested_by = '${platform.id}') || ':' || (completed_at is not null) from private.shop_deletions where shop_id = '${shopId}';`)).toBe(
    `${slug}:true:true`,
  );
  const { data: u } = await db.auth.admin.getUserById(owner.id);
  expect(u.user?.email).toBe(owner.email);

  // The old link: "not found", never another shop.
  await page.goto(`/s/${slug}/`);
  await expect(page.getByText('Магазин не найден')).toBeVisible();
});
