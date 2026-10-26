import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

// DEMO shop opened by a plain link (no Telegram): the profile is a client-side mock-up. It must not sign in,
// create users or write orders — checked both on the network and in the local database.
const db = serviceClient();

async function counts() {
  const users = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (users.error) throw users.error;
  const orders = await db.from('orders').select('id', { count: 'exact', head: true });
  const items = await db.from('order_items').select('id', { count: 'exact', head: true });
  return { users: users.data.users.length, orders: orders.count, items: items.count };
}

/** Requests that would mean auth, a write or a private buyer call. */
function watchForbiddenRequests(page: Page): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (/\/auth\/v1\//.test(url) || /\/functions\/v1\//.test(url) || /\/rest\/v1\/rpc\//.test(url)) hits.push(`${r.method()} ${url}`);
    else if (/\/rest\/v1\//.test(url) && r.method() !== 'GET' && r.method() !== 'HEAD') hits.push(`${r.method()} ${url}`);
  });
  return hits;
}

test('demo shop outside Telegram: profile mock-up with the current shop logo/name and a "Тестовый заказ", no auth and no DB writes', async ({ page }) => {
  const before = await counts();
  const forbidden = watchForbiddenRequests(page);

  await page.goto('/s/noir-vapor/');
  await expect(page.getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const contact = page.getByTestId('demo-contact-link');
  await expect(page.getByTestId('demo-banner')).toContainText('DEMO-режим: полный доступ можете приобрести у @caseypsd');
  await expect(contact).toHaveAttribute('href', 'https://t.me/caseypsd');

  await page.getByRole('link', { name: /Профиль/ }).click();
  const profile = page.getByTestId('demo-profile');
  await expect(profile).toBeVisible();
  await expect(profile.getByRole('heading', { level: 1, name: 'Noir Vapor' })).toBeVisible();
  await expect(profile.getByTestId('demo-profile-badge')).toHaveText('Демо-профиль');
  const order = profile.getByTestId('demo-order');
  await expect(order).toContainText('Тестовый заказ');
  await expect(order).toContainText('Итого');
  await expect(page.getByTestId('my-order')).toHaveCount(0);

  // Switching shops: the mock-up uses the new shop's name, nothing of the previous tenant.
  await page.goto('/s/mint-lab/profile');
  await expect(page.getByTestId('demo-profile').getByRole('heading', { level: 1, name: 'Mint Lab' })).toBeVisible();
  await expect(page.getByTestId('demo-profile')).not.toContainText('Noir Vapor');

  // Narrow phone: the banner wraps, the contact link stays whole and tappable, no horizontal scroll.
  await page.setViewportSize({ width: 320, height: 640 });
  const box = (await contact.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(20);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  expect(forbidden).toEqual([]);
  expect(await counts()).toEqual(before);
});
