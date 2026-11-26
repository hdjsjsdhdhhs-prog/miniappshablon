import { randomBytes } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { serviceClient } from '../scripts/lib/supabase-env.ts';
import { completeMfa, createAccount, createDemoShop, deleteShops, deleteUsers, latestMailTo, localSql, mailHtml, type Account } from './shops';

// Owner self-registration by an individual one-time link, as the platform admin and the buyer experience it, and the
// password recovery of the registered owner (Supabase Auth mail, local Mailpit). LOCAL stack only (playwright.config.ts
// + global-setup.ts guards). No real mail, no real account.
const db = serviceClient();
const run = randomBytes(3).toString('hex');
const created = { shops: [] as string[], users: [] as string[] };
const tagEmail = (kind: string) => `e2e-owner-${kind}-${run}@e2e.local`;
const PASSWORD = `Pw-${randomBytes(9).toString('base64url')}`;
let platform: Account;

const shopRow = (slug: string) => `[data-testid="platform-shop"]:has-text("${slug}")`;

async function adminLogin(page: Page, a: Account) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await completeMfa(page, a);
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

async function openLinkDialog(page: Page, slug: string) {
  await page.goto('/admin/platform');
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(slug);
  await page.locator(shopRow(slug)).getByTestId('platform-owner-link').click();
  return page.getByTestId('owner-link-dialog');
}

/** The link as the admin copies it: created in the UI, read from the field (the copy button copies this very value). */
async function createLink(page: Page, slug: string, email?: string): Promise<string> {
  const dialog = await openLinkDialog(page, slug);
  if (email) await dialog.getByTestId('owner-link-email').fill(email);
  await dialog.getByTestId('owner-link-create').click();
  await expect(dialog.getByTestId('owner-link-copy')).toBeVisible();
  const url = await dialog.getByTestId('owner-link-url').inputValue();
  expect(url).toMatch(/\/admin\/register#[A-Za-z0-9_-]{43}$/);
  return url;
}

async function freshBuyer(browser: Browser) {
  const context = await browser.newContext({ locale: 'ru-RU' });
  return { context, page: await context.newPage() };
}

async function newDemo(slug: string, name: string) {
  const shop = await createDemoShop(platform, 'noir-vapor', slug, name);
  created.shops.push(shop.id);
  return shop;
}

test.beforeAll(async () => {
  platform = await createAccount('owner-link-admin', { platformAdmin: true });
  created.users.push(platform.id);
});

test.afterAll(async () => {
  const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  for (const u of data?.users ?? []) if (u.email?.includes(`-${run}@`)) created.users.push(u.id);
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('the admin creates a link, the buyer registers on it and lands in the admin of that shop; the admin sees who registered; the link works once', async ({ page, browser }) => {
  const slug = `e2e-own-${run}`;
  const name = `Owner Link ${run}`;
  const buyerEmail = tagEmail('buyer');
  await newDemo(slug, name);
  await page.setViewportSize({ width: 1280, height: 900 });
  await adminLogin(page, platform);
  const link = await createLink(page, slug);
  const mailsBefore = localSql(`select count(*) from auth.users where email = '${buyerEmail}';`);
  expect(mailsBefore).toBe('0');

  // ---- the buyer ---------------------------------------------------------------------------------------------
  const buyer = await freshBuyer(browser);
  await buyer.page.goto(link);
  const form = buyer.page.getByTestId('owner-reg-form');
  await expect(form).toBeVisible();
  await expect(buyer.page.getByTestId('owner-reg-shop')).toContainText(name);
  // The token leaves the address bar at once; the page shows no id and no token.
  await expect(buyer.page).toHaveURL(/\/admin\/register$/);
  expect(await buyer.page.content()).not.toContain(link.split('#')[1]!);

  // Validation: the passwords must match, the password must be strong enough.
  await buyer.page.getByTestId('owner-reg-email').fill(buyerEmail);
  await buyer.page.getByTestId('owner-reg-password').fill(PASSWORD);
  await buyer.page.getByTestId('owner-reg-repeat').fill(`${PASSWORD}x`);
  await buyer.page.getByTestId('owner-reg-submit').click();
  await expect(form).toContainText('Пароли не совпадают');
  await buyer.page.getByTestId('owner-reg-repeat').fill(PASSWORD);
  await buyer.page.getByTestId('owner-reg-password').fill('short');
  await buyer.page.getByTestId('owner-reg-submit').click();
  await expect(form).toContainText('не короче 10 символов');
  await buyer.page.getByTestId('owner-reg-password').fill(PASSWORD);

  const mailTotalBefore = Number(((await (await fetch(`http://127.0.0.1:54324/api/v1/messages?limit=1`)).json()) as { total: number }).total);
  await buyer.page.getByTestId('owner-reg-submit').click();
  // Straight into the admin of THE shop: no mail, no waiting, no confirmation by the platform admin.
  await expect(buyer.page).toHaveURL(new RegExp(`/admin/shops/${slug}$`));
  await expect(buyer.page.getByRole('heading', { name })).toBeVisible();
  expect(await latestMailTo(buyerEmail)).toBeNull();
  const mailTotalAfter = Number(((await (await fetch(`http://127.0.0.1:54324/api/v1/messages?limit=1`)).json()) as { total: number }).total);
  expect(mailTotalAfter).toBe(mailTotalBefore);
  expect(buyer.page.url()).not.toContain('#');
  // Full admin of the shop: the section pages open, the platform section does not.
  await buyer.page.goto(`/admin/shops/${slug}/products`);
  await expect(buyer.page.getByRole('heading', { name })).toBeVisible();
  await buyer.page.goto('/admin/platform');
  await expect(buyer.page.getByText('Этот раздел доступен только администратору платформы.')).toBeVisible();
  await expect(buyer.page.getByRole('link', { name: 'Все магазины платформы' })).toHaveCount(0);
  await buyer.page.goto('/admin/shops');
  await expect(buyer.page.getByTestId('my-shop')).toHaveCount(1);

  // Account facts straight from the database: confirmed without a mail, the only owner of this shop.
  expect(localSql(`select (email_confirmed_at is not null)::text from auth.users where email = '${buyerEmail}';`)).toBe('true');
  expect(localSql(`select count(*) from public.shop_memberships m join auth.users u on u.id = m.user_id where m.shop_id = (select id from public.shops where slug = '${slug}') and u.email = '${buyerEmail}' and m.role = 'owner';`)).toBe('1');
  expect(localSql(`select count(*) from public.shop_memberships where shop_id = (select id from public.shops where slug = '${slug}');`)).toBe('1');

  // ---- the admin sees the result ----------------------------------------------------------------------------
  await page.goto('/admin/platform');
  await page.getByRole('searchbox', { name: 'Поиск магазинов' }).fill(slug);
  const row = page.locator(shopRow(slug));
  await expect(row.getByTestId('platform-shop-invite')).toHaveAttribute('data-status', 'used');
  await expect(row.getByTestId('platform-shop-invite-used')).toContainText(buyerEmail);
  await expect(row.getByTestId('platform-shop-owner')).toContainText(buyerEmail);
  await row.getByTestId('platform-owner-link').click();
  await expect(page.getByTestId('owner-link-used')).toContainText(buyerEmail);

  // ---- the same link in another browser: used up ------------------------------------------------------------
  const second = await freshBuyer(browser);
  await second.page.goto(link);
  await expect(second.page.getByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'used');
  await expect(second.page.getByTestId('owner-reg-form')).toHaveCount(0);

  await buyer.context.close();
  await second.context.close();
});

test('a revoked or replaced link says so; an address that is not a link opens nothing', async ({ page, browser }) => {
  const slug = `e2e-own2-${run}`;
  await newDemo(slug, `Owner Link B ${run}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await adminLogin(page, platform);
  const first = await createLink(page, slug);

  // A new link replaces the old one.
  const dialog = page.getByTestId('owner-link-dialog');
  await expect(dialog.getByRole('button', { name: 'Создать новую ссылку взамен старой' })).toBeVisible();
  await dialog.getByTestId('owner-link-create').click();
  await expect(dialog.getByTestId('owner-link-url')).not.toHaveValue(first);
  const second = await dialog.getByTestId('owner-link-url').inputValue();

  const visitor = await freshBuyer(browser);
  await visitor.page.goto(first);
  await expect(visitor.page.getByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'revoked');

  // Revoke by hand.
  await dialog.getByTestId('owner-link-revoke').click();
  await expect(dialog.getByTestId('owner-link-status')).toHaveAttribute('data-status', 'revoked');
  await visitor.page.goto(second);
  await expect(visitor.page.getByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'revoked');

  // No token / a foreign fragment: a clear message, no form, no request that could reveal anything.
  await visitor.page.goto('/admin/register');
  await expect(visitor.page.getByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'invalid');
  await visitor.page.goto('/admin/register#abc');
  await expect(visitor.page.getByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'invalid');
  await visitor.context.close();
});

test('an expired link is refused with a clear message', async ({ page, browser }) => {
  const slug = `e2e-own3-${run}`;
  await newDemo(slug, `Owner Link C ${run}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await adminLogin(page, platform);
  const link = await createLink(page, slug);
  localSql(`update private.shop_owner_invites set created_at = now() - interval '49 hours', expires_at = now() - interval '1 hour' where shop_id = (select id from public.shops where slug = '${slug}');`);
  const visitor = await freshBuyer(browser);
  await visitor.page.goto(link);
  await expect(visitor.page.getByTestId('owner-reg-dead')).toHaveAttribute('data-status', 'expired');
  await visitor.context.close();
});

test('an existing account signs in on the link page and the link is applied to it; no second account appears', async ({ page, browser }) => {
  const slug = `e2e-own4-${run}`;
  const existing = await createAccount(`owner-existing-${run}`);
  created.users.push(existing.id);
  await newDemo(slug, `Owner Link D ${run}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await adminLogin(page, platform);
  const link = await createLink(page, slug);

  const buyer = await freshBuyer(browser);
  await buyer.page.goto(link);
  // Registering with the e-mail of an existing account: no duplicate, the page asks to sign in.
  await buyer.page.getByTestId('owner-reg-email').fill(existing.email);
  await buyer.page.getByTestId('owner-reg-password').fill(PASSWORD);
  await buyer.page.getByTestId('owner-reg-repeat').fill(PASSWORD);
  await buyer.page.getByTestId('owner-reg-submit').click();
  await expect(buyer.page.getByTestId('owner-reg-signin-form')).toBeVisible();
  await expect(buyer.page.getByTestId('owner-claim-email')).toHaveValue(existing.email);
  expect(localSql(`select count(*) from auth.users where email = '${existing.email}';`)).toBe('1');

  await buyer.page.getByTestId('owner-claim-password').fill(existing.password);
  await buyer.page.getByTestId('owner-claim-submit').click();
  await expect(buyer.page).toHaveURL(new RegExp(`/admin/shops/${slug}$`));
  expect(localSql(`select count(*) from public.shop_memberships m where m.shop_id = (select id from public.shops where slug = '${slug}') and m.user_id = '${existing.id}' and m.role = 'owner';`)).toBe('1');
  await buyer.context.close();
});

test('«Забыли пароль?»: mail from Supabase → link → new password → sign in; the old password no longer works; a used link is refused', async ({ page, browser }) => {
  const slug = `e2e-own5-${run}`;
  const buyerEmail = tagEmail('recover');
  await newDemo(slug, `Owner Link E ${run}`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await adminLogin(page, platform);
  const link = await createLink(page, slug);

  const buyer = await freshBuyer(browser);
  await buyer.page.goto(link);
  await buyer.page.getByTestId('owner-reg-email').fill(buyerEmail);
  await buyer.page.getByTestId('owner-reg-password').fill(PASSWORD);
  await buyer.page.getByTestId('owner-reg-repeat').fill(PASSWORD);
  await buyer.page.getByTestId('owner-reg-submit').click();
  await expect(buyer.page).toHaveURL(new RegExp(`/admin/shops/${slug}$`));
  expect(await latestMailTo(buyerEmail)).toBeNull(); // registration sent nothing

  // Sign out, then the recovery from the login page.
  await buyer.page.getByRole('button', { name: /Выйти/ }).click();
  await expect(buyer.page).toHaveURL(/\/admin$/);
  await buyer.page.getByTestId('forgot-password-link').click();
  await expect(buyer.page).toHaveURL(/\/admin\/forgot-password$/);
  await buyer.page.getByTestId('forgot-email').fill(buyerEmail);
  await buyer.page.getByTestId('forgot-submit').click();
  await expect(buyer.page.getByTestId('forgot-sent')).toBeVisible();
  await expect(buyer.page.getByTestId('forgot-submit')).toBeDisabled(); // waits before a repeat

  // The mail of Supabase Auth (local Mailpit).
  let message = await latestMailTo(buyerEmail);
  for (let i = 0; i < 20 && !message; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    message = await latestMailTo(buyerEmail);
  }
  expect(message, 'recovery mail').not.toBeNull();
  const html = await mailHtml(message!.ID);
  const recovery = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(html)?.[0]?.replace(/&amp;/g, '&');
  expect(recovery).toBeTruthy();

  // The link opens the set-password page with a session, the owner chooses a new password.
  const NEW_PASSWORD = `New-${randomBytes(9).toString('base64url')}`;
  await buyer.page.goto(recovery!);
  await expect(buyer.page.getByTestId('set-password')).toBeVisible();
  await expect(buyer.page.getByTestId('set-password')).toContainText('Придумайте новый пароль');
  await buyer.page.getByLabel('Новый пароль').fill(NEW_PASSWORD);
  await buyer.page.getByLabel('Повторите пароль').fill(NEW_PASSWORD);
  await buyer.page.getByTestId('set-password-submit').click();
  await expect(buyer.page).toHaveURL(/\/admin\/shops$/);

  // The old password is dead, the new one works.
  await buyer.page.getByRole('button', { name: /Выйти/ }).click();
  await buyer.page.getByLabel('Email').fill(buyerEmail);
  await buyer.page.getByLabel('Пароль').fill(PASSWORD);
  await buyer.page.getByRole('button', { name: 'Войти' }).click();
  await expect(buyer.page.getByText('Неверный email или пароль.')).toBeVisible();
  await buyer.page.getByLabel('Пароль').fill(NEW_PASSWORD);
  await buyer.page.getByRole('button', { name: 'Войти' }).click();
  await expect(buyer.page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();

  // The same mail link a second time (another browser): refused with an offer to ask for a new mail.
  const stranger = await freshBuyer(browser);
  await stranger.page.goto(recovery!);
  const invalid = stranger.page.getByTestId('set-password-invalid');
  await expect(invalid).toBeVisible();
  await expect(invalid.getByTestId('set-password-request-new')).toBeVisible();
  await stranger.context.close();
  await buyer.context.close();
});

test('«Забыли пароль?»: a recovery link that has expired is refused with an offer to request a new mail', async ({ browser }) => {
  const account = await createAccount(`owner-expired-${run}`);
  created.users.push(account.id);
  const buyer = await freshBuyer(browser);
  await buyer.page.goto('/admin/forgot-password');
  await buyer.page.getByTestId('forgot-email').fill(account.email);
  await buyer.page.getByTestId('forgot-submit').click();
  await expect(buyer.page.getByTestId('forgot-sent')).toBeVisible();
  let message = await latestMailTo(account.email);
  for (let i = 0; i < 20 && !message; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    message = await latestMailTo(account.email);
  }
  expect(message, 'recovery mail').not.toBeNull();
  const recovery = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(await mailHtml(message!.ID))?.[0]?.replace(/&amp;/g, '&');
  expect(recovery).toBeTruthy();

  // Older than the OTP lifetime ([auth.email] otp_expiry = 3600 s).
  localSql(`update auth.users set recovery_sent_at = now() - interval '3 hours' where id = '${account.id}';`);
  await buyer.page.goto(recovery!);
  const invalid = buyer.page.getByTestId('set-password-invalid');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('Срок действия ссылки истёк');
  await expect(buyer.page.getByTestId('set-password')).toHaveCount(0);
  await invalid.getByTestId('set-password-request-new').click();
  await expect(buyer.page.getByTestId('forgot-password')).toBeVisible();
  await buyer.context.close();
});
