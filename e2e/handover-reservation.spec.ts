import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import {
  accessToken,
  completeMfa,
  createAccount,
  createDemoShop,
  deleteShops,
  deleteUsers,
  localSql,
  platformAdmin,
  platformService,
  type Account,
} from './shops';

// "Передать клиенту" dialog: state of a hand-over reservation (audit S2-06) left by a crashed request, its countdown,
// "Очистить просроченный резерв" once it has expired, and that handover-cancel never removes a live one (only a
// pending hand-over). LOCAL stack only (playwright.config.ts + global-setup.ts guards).
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const slug = `e2e-resv-${run}`;
const clientEmail = `e2e-resv-client-${run}@e2e.local`;
const created = { shops: [] as string[], users: [] as string[] };
let platform: Account;
let shopId: string;

async function login(page: Page, a: { email: string; password: string; totpSecret?: string }) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  // Platform admins: mandatory TOTP step (20261102090000).
  await completeMfa(page, a);
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

const reservations = () => Number(localSql(`select count(*) from private.shop_handover_reservations where shop_id = '${shopId}';`));
const reservationRow = () =>
  localSql(`select coalesce((select row_to_json(r)::text from private.shop_handover_reservations r where r.shop_id = '${shopId}'), '');`);
const pendings = () => Number(localSql(`select count(*) from private.shop_pending_handovers where shop_id = '${shopId}';`));
const cancelEvents = () =>
  Number(
    localSql(
      `select count(*) from private.shop_lifecycle_events where shop_id = '${shopId}' and action = 'handover_cancelled' and details ->> 'reason' is distinct from 'stale_reservation';`,
    ),
  );

test.beforeAll(async () => {
  platform = await createAccount('resv-admin', { platformAdmin: true });
  created.users.push(platform.id);
  shopId = (await createDemoShop(platform, 'noir-vapor', slug, `Resv ${run}`)).id;
  created.shops.push(shopId);
});

test.afterAll(async () => {
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const client = data?.users.find((u) => u.email === clientEmail);
  if (client) created.users.push(client.id);
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('a live reservation shows only its countdown and survives handover-cancel; after expiry "Очистить просроченный резерв" clears it; a pending hand-over is cancelled', async ({ page }) => {
  // A request reserved the shop and died before finishing (exactly what platform-admin does first).
  // In the admin's aal2 session, as the Edge Function calls it (a bare service-role call is refused: mfa_required).
  const { error } = await (await platformService(platform)).rpc('platform_reserve_handover', {
    p_actor: platform.id,
    p_shop_id: shopId,
    p_email: `e2e-crashed-${run}@e2e.local`,
  });
  expect(error).toBeNull();

  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, platform);
  await page.goto('/admin/platform');
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(slug);
  // Shorten the lease of THIS reservation to a few seconds so the test can watch it expire (after the sign-in,
  // which includes the MFA step, so the countdown starts right before the dialog opens).
  localSql(`update private.shop_handover_reservations set expires_at = clock_timestamp() + interval '6 seconds' where shop_id = '${shopId}';`);
  await page.getByTestId('platform-handover').click();
  const dialog = page.getByTestId('handover-dialog');
  const notice = dialog.getByTestId('handover-reservation');

  // Live: e-mail and time left, no way to remove it.
  await expect(notice).toHaveAttribute('data-state', 'active');
  await expect(notice).toContainText(`e2e-crashed-${run}@e2e.local`);
  await expect(notice.getByTestId('handover-reservation-left')).toHaveText(/^0:0[0-6]$/);
  await expect(dialog.getByTestId('handover-release-stale')).toHaveCount(0);
  // The server refuses to release it as well (the UI is not the only guard).
  const early = await platformAdmin(await accessToken(platform), { action: 'handover-release-stale', shopId });
  expect(early.status).toBe(409);
  expect((early.body!.error as { code: string }).code).toBe('handover_reservation_active');
  expect(reservations()).toBe(1);
  // handover-cancel through the API cannot remove it either: 409, the row (token, lease) is unchanged, nothing logged.
  const row = reservationRow();
  const cancelLive = await platformAdmin(await accessToken(platform), { action: 'handover-cancel', shopId });
  expect(cancelLive.status).toBe(409);
  expect((cancelLive.body!.error as { code: string }).code).toBe('handover_reservation_active');
  expect(reservationRow()).toBe(row);
  expect(cancelEvents()).toBe(0);

  // The lease runs out while the dialog is open → the state is re-read and the button appears.
  await expect(notice).toHaveAttribute('data-state', 'expired', { timeout: 15_000 });
  const release = dialog.getByTestId('handover-release-stale');
  await expect(release).toHaveText('Очистить просроченный резерв');
  await release.click();
  await expect(page.getByText('Просроченный резерв очищен')).toBeVisible();
  await expect(dialog.getByTestId('handover-reservation')).toHaveCount(0);
  expect(reservations()).toBe(0);
  expect(Number(localSql(`select count(*) from private.shop_lifecycle_events where shop_id = '${shopId}' and details ->> 'reason' = 'stale_reservation';`))).toBe(1);

  // The shop can be handed over again right away.
  await dialog.getByTestId('handover-email').fill(clientEmail);
  await dialog.getByTestId('handover-paid').click();
  await dialog.getByTestId('handover-confirm').click();
  await expect(dialog.getByTestId('handover-pending')).toContainText(`магазин перейдёт к ${clientEmail}`, { timeout: 30_000 });
  expect(reservations()).toBe(0);

  // Re-sending the invitation at once is refused by the server cooldown; the dialog explains when to retry.
  await dialog.getByRole('button', { name: 'Готово' }).click();
  await page.getByTestId('platform-handover').click();
  await expect(dialog.getByTestId('handover-pending-current')).toContainText(clientEmail);
  await dialog.getByTestId('handover-email').fill(clientEmail);
  await dialog.getByTestId('handover-paid').click();
  await dialog.getByTestId('handover-confirm').click();
  await expect(dialog.getByTestId('handover-error')).toContainText(/только что отправлено.*Повторить можно через \d+:\d{2}/);
  expect(reservations()).toBe(0);

  // The pending hand-over (no live reservation) is still cancelled the normal way from the dialog.
  expect(pendings()).toBe(1);
  await dialog.getByTestId('handover-cancel').click();
  await expect(dialog.getByTestId('handover-pending-current')).toHaveCount(0);
  await expect(dialog.getByTestId('handover-cancel-error')).toHaveCount(0);
  expect(pendings()).toBe(0);
  expect(cancelEvents()).toBe(1);
});
