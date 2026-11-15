import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import { totp } from '../scripts/lib/totp.ts';
import { completeMfa, createAccount, createDemoShop, deleteShops, deleteUsers, localSql, platformAdmin, type Account } from './shops';

// "Удалить магазин" for a LIVE shop (20261113090000), in a real browser against the LOCAL stack: the platform admin
// sees what will be lost and who owns the shop, and must confirm twice — the exact slug and the CURRENT code of the
// authenticator (being signed in with MFA is not enough; a wrong code deletes nothing). Then the shop is gone
// completely, files included, its link shows "Магазин не найден" and the client's account stays.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const slug = `e2e-live-del-${run}`;
const name = `Live delete ${run}`;
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

const pageToken = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tma-shop-auth') ?? '{}').access_token as string);
const mediaCount = () => Number(localSql(`select count(*) from storage.objects where bucket_id = 'shop-media' and starts_with(name, '${shopId}/');`));
const shopStatus = async () => (await db.from('shops').select('status, is_demo, mode').eq('id', shopId).maybeSingle()).data;

test.beforeAll(async () => {
  platform = await createAccount('live-del-admin', { platformAdmin: true });
  owner = await createAccount('live-del-owner');
  created.users.push(platform.id, owner.id);
  // A shop in real use: the Noir Vapor catalog with its media, handed over to a client (not a DEMO any more).
  shopId = (await createDemoShop(platform, 'noir-vapor', slug, name)).id;
  created.shops.push(shopId);
  const { error: de } = await db.from('shops').update({ is_demo: false }).eq('id', shopId);
  if (de) throw de;
  const { error } = await db.from('shop_memberships').insert({ shop_id: shopId, user_id: owner.id, role: 'owner' });
  if (error) throw error;
});

test.afterAll(async () => {
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('platform admin deletes a LIVE shop only after typing its slug and the current authenticator code', async ({ page }) => {
  expect(await shopStatus()).toEqual({ status: 'active', is_demo: false, mode: 'live' });
  const media = mediaCount();
  expect(media).toBeGreaterThan(0);
  await page.goto(`/s/${slug}/`);
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, platform);
  await page.goto('/admin/platform');
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(slug);
  const row = page.getByTestId('platform-shop');
  await expect(row).toHaveCount(1);
  // A LIVE shop: "Удалить магазин" (slug + code), never the DEMO action (slug only).
  await expect(row.getByTestId('platform-demo-delete')).toHaveCount(0);

  // The server itself refuses a deletion that was not confirmed with a fresh code, whatever the page does:
  // this session passed MFA at sign-in a moment ago, and that is not enough.
  const direct = await platformAdmin(await pageToken(page), { action: 'shop-delete', shopId, confirmSlug: slug });
  expect([direct.status, (direct.body?.error as { code?: string } | undefined)?.code]).toEqual([403, 'mfa_step_up_required']);

  await row.getByTestId('platform-shop-delete').click();
  const dialog = page.getByTestId('shop-delete-dialog');
  await expect(dialog.getByTestId('shop-delete-slug')).toHaveText(slug);
  await expect(dialog).toContainText(`/s/${slug}/`);
  for (const k of ['products', 'categories', 'variants']) {
    expect(Number(await dialog.getByTestId(`shop-delete-count-${k}`).textContent()), k).toBeGreaterThan(0);
  }
  await expect(dialog.getByTestId('shop-delete-count-media_files')).toHaveText(String(media));
  await expect(dialog.getByTestId('shop-delete-owner')).toContainText(owner.email);
  await expect(dialog.getByTestId('shop-delete-owner-warning')).toContainText(owner.email);

  // Both confirmations are needed before the button can be pressed at all.
  const confirm = dialog.getByTestId('shop-delete-confirm');
  const slugInput = dialog.getByTestId('shop-delete-input');
  const codeInput = dialog.getByTestId('shop-delete-code');
  await expect(confirm).toBeDisabled();
  await slugInput.fill(slug);
  await expect(confirm).toBeDisabled();
  await slugInput.fill(slug.slice(0, -1));
  await codeInput.fill(totp(platform.totpSecret!));
  await expect(confirm).toBeDisabled();
  await slugInput.fill(slug);
  await codeInput.fill('12345');
  await expect(confirm).toBeDisabled();

  // A wrong code: nothing is deleted, the code has to be typed again.
  const current = totp(platform.totpSecret!);
  await codeInput.fill(current === '000000' ? '111111' : '000000');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog.getByTestId('shop-delete-error')).toContainText('Код не подошёл или устарел');
  await expect(codeInput).toHaveValue('');
  await expect(confirm).toBeDisabled();
  expect(await shopStatus()).toEqual({ status: 'active', is_demo: false, mode: 'live' });
  expect(mediaCount()).toBe(media);
  expect(localSql(`select count(*) from private.shop_deletions where shop_id = '${shopId}';`)).toBe('0');

  // The current code.
  await codeInput.fill(totp(platform.totpSecret!));
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog.getByTestId('shop-delete-done')).toContainText(slug);
  await expect(dialog.getByTestId('shop-delete-error')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await expect(page.getByTestId('platform-shop')).toHaveCount(0);
  // Still signed in as the platform admin (the confirmation did not end or downgrade the session).
  await expect(page.getByRole('heading', { name: 'Все магазины платформы' })).toBeVisible();

  // Gone completely, files included; the audit row says it was a LIVE shop confirmed with a code.
  expect((await db.from('shops').select('id').eq('id', shopId)).data).toEqual([]);
  expect(mediaCount()).toBe(0);
  expect(localSql(`select private.shop_leftover_rows('${shopId}')::text;`)).toBe('{}');
  expect(
    localSql(
      `select slug || ':' || (requested_by = '${platform.id}') || ':' || (completed_at is not null) || ':' || was_demo || ':' || (step_up_at is not null)
       from private.shop_deletions where shop_id = '${shopId}';`,
    ),
  ).toBe(`${slug}:true:true:false:true`);
  // The client's account stays (it may own other shops).
  const { data: u } = await db.auth.admin.getUserById(owner.id);
  expect(u.user?.email).toBe(owner.email);
  expect((await db.from('shop_memberships').select('shop_id').eq('user_id', owner.id)).data).toEqual([]);

  // The old link: "not found", never another shop.
  await page.goto(`/s/${slug}/`);
  await expect(page.getByText('Магазин не найден')).toBeVisible();
});
