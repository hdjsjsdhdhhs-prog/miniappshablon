import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { mockBotState } from '../scripts/lib/telegram-mock.ts';
import { createAccount, createLiveShop, deleteShops, deleteUsers, type Account } from './shops';

// One Telegram bot, one purpose (20261126090000) in a real browser against the LOCAL stack. Telegram is the local mock Bot API
// and the tokens are fake. The path of the task's manual check:
//   1. NotificationBot is connected in «Уведомления»;
//   2. the same bot in «Подключение бота» → a red error that names «Уведомления»; nothing is connected;
//   3. StoreBot in «Подключение бота» → connected;
//   4. NotificationBot saved again in «Уведомления» → saved (it is in its own section); StoreBot there → a red error;
//   5. NotificationBot removed from «Уведомления» → it can now be connected to the storefront.
const run = randomBytes(3).toString('hex');
const slug = `e2e-bots-${run}`;
const created = { shops: [] as string[], users: [] as string[] };
let owner: Account;

async function login(page: Page, a: Account) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

const fakeToken = () => {
  const id = 720_000_000 + Math.floor(Math.random() * 1e8);
  return { id, token: `${id}:FAKE_e2e_${randomBytes(16).toString('hex')}` };
};

const NOTIFICATIONS_WARNING =
  'Важно: для уведомлений необходимо использовать отдельного Telegram-бота. Не подключайте сюда бота, который используется для витрины Mini App. Для витрины создайте второго бота через @BotFather';
const BOT_WARNING =
  'Важно: бот для витрины должен быть отдельным. Не используйте бота, уже подключённого в разделе „Уведомления“. Для витрины и уведомлений нужны два разных Telegram-бота';
const REFUSED_IN_BOT_SECTION =
  'Этот Telegram-бот уже подключён в разделе „Уведомления“. Для подключения витрины необходимо создать или использовать другого Telegram-бота. Один бот не может использоваться одновременно для уведомлений и витрины';
const REFUSED_IN_NOTIFICATIONS =
  'Этот Telegram-бот уже подключён для витрины Mini App. Для уведомлений необходимо использовать отдельного Telegram-бота. Один бот не может использоваться одновременно для уведомлений и витрины';

test.beforeAll(async () => {
  owner = await createAccount('bots-owner');
  created.users.push(owner.id);
  const shop = await createLiveShop(owner.id, slug, `Bots ${run}`, { priceMinor: 100_000, stock: 5 });
  created.shops.push(shop.id);
});

test.afterAll(async () => {
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('two different bots; the same bot in both sections is refused with a red error that names the section; removing it from one section frees it', async ({ browser }) => {
  test.setTimeout(240_000);
  const notificationBot = fakeToken();
  const storeBot = fakeToken();
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 900 } });
  const admin = await ctx.newPage();
  admin.on('dialog', (d) => void d.accept());
  await login(admin, owner);

  const openNotifications = async () => {
    await admin.goto(`/admin/shops/${slug}/notifications`);
    await expect(admin.getByTestId('notifications-page')).toBeVisible();
  };
  const openBot = async () => {
    await admin.goto(`/admin/shops/${slug}/bot`);
    await expect(admin.getByTestId('bot-page')).toBeVisible();
  };
  /** The notice is the project's alert in the destructive (red) variant. */
  const expectRed = async (notice: ReturnType<Page['getByTestId']>, text: string, token: string) => {
    await expect(notice).toContainText(text);
    await expect(notice).toHaveClass(/text-destructive/);
    expect(await notice.innerText()).not.toContain(token.split(':')[1]);
    const color = await notice.evaluate((el) => getComputedStyle(el).color);
    // Red-ish: the red channel clearly dominates.
    const [r, g, b] = color.match(/\d+(\.\d+)?/g)!.map(Number) as [number, number, number];
    expect(r).toBeGreaterThan(g + 40);
    expect(r).toBeGreaterThan(b + 20);
  };

  // --- 1. NotificationBot in «Уведомления»; the instruction warns about a separate bot --------------------------------
  await openNotifications();
  await expect(admin.getByTestId('notifications-separate-bot-warning')).toHaveText(NOTIFICATIONS_WARNING);
  await admin.getByTestId('notifications-token').fill(notificationBot.token);
  await admin.getByTestId('notifications-chat').fill(`@bots_${run}`);
  await admin.getByTestId('notifications-save').click();
  await expect(admin.getByTestId('notifications-status')).toHaveText('Подключено');
  await expect(admin.getByTestId('notifications-token-hint')).toContainText(`${notificationBot.id}:`);

  // --- 2. The same bot in «Подключение бота» → red error, nothing connected -------------------------------------------
  await openBot();
  await expect(admin.getByTestId('bot-separate-bot-warning')).toHaveText(BOT_WARNING);
  await admin.getByTestId('bot-token').fill(notificationBot.token);
  await admin.getByTestId('bot-connect').click();
  await expectRed(admin.getByTestId('bot-notice'), REFUSED_IN_BOT_SECTION, notificationBot.token);
  await expect(admin.getByTestId('bot-status')).toHaveText('Бот не подключён');
  // Nothing was set on the bot in Telegram (no webhook, no Menu Button).
  const untouched = await mockBotState(notificationBot.id);
  expect(untouched.webhook).toBeNull();
  expect(untouched.menu_button).toEqual({ type: 'default' });

  // --- 3. StoreBot in «Подключение бота» → connected ------------------------------------------------------------------
  await admin.getByTestId('bot-token').fill(storeBot.token);
  await admin.getByTestId('bot-connect').click();
  await expect(admin.getByTestId('bot-status')).toHaveText('Бот подключён');
  await expect(admin.getByTestId('bot-username')).toHaveText(`@mock_${storeBot.id}_bot`);

  // --- 4. NotificationBot saved again in its own section → saved; StoreBot there → red error ----------------------------
  await openNotifications();
  await admin.getByTestId('notifications-token').fill(notificationBot.token);
  await admin.getByTestId('notifications-save').click();
  await expect(admin.getByTestId('notifications-notice')).toContainText('Сохранено');
  await expect(admin.getByTestId('notifications-notice')).not.toHaveClass(/text-destructive/);
  await expect(admin.getByTestId('notifications-status')).toHaveText('Подключено');

  await admin.getByTestId('notifications-token').fill(storeBot.token);
  await admin.getByTestId('notifications-save').click();
  await expectRed(admin.getByTestId('notifications-notice'), REFUSED_IN_NOTIFICATIONS, storeBot.token);
  // The working notification connection is untouched: still NotificationBot, still connected.
  await expect(admin.getByTestId('notifications-status')).toHaveText('Подключено');
  await expect(admin.getByTestId('notifications-token-hint')).toContainText(`${notificationBot.id}:`);
  await expect(admin.getByText(`@mock_${notificationBot.id}_bot`)).toBeVisible();

  // --- 5. NotificationBot removed from «Уведомления» → it can be the storefront bot now ---------------------------------
  await admin.getByTestId('notifications-delete').click();
  await expect(admin.getByTestId('notifications-status')).toHaveText('Не настроено');
  await openBot();
  await admin.getByTestId('bot-replace').click();
  const form = admin.getByTestId('bot-replace-form');
  await expect(form.getByTestId('bot-replace-separate-bot-warning')).toBeVisible();
  await form.getByTestId('bot-token').fill(notificationBot.token);
  await form.getByTestId('bot-connect').click();
  await admin.getByTestId('bot-confirm-ok').click();
  await expect(admin.getByTestId('bot-username')).toHaveText(`@mock_${notificationBot.id}_bot`);
  await expect(admin.getByTestId('bot-notice')).toContainText(`Бот @mock_${notificationBot.id}_bot подключён`);

  // ... and it is no longer free for «Уведомления».
  await openNotifications();
  await admin.getByTestId('notifications-token').fill(notificationBot.token);
  await admin.getByTestId('notifications-chat').fill(`@bots_${run}`);
  await admin.getByTestId('notifications-save').click();
  await expectRed(admin.getByTestId('notifications-notice'), REFUSED_IN_NOTIFICATIONS, notificationBot.token);
  await expect(admin.getByTestId('notifications-status')).toHaveText('Не настроено');
  await ctx.close();
});
