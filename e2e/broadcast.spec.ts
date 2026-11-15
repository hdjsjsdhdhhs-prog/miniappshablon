import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { resolveSupabaseEnv } from '../scripts/lib/supabase-env.ts';
import { mockBotState, mockMessages } from '../scripts/lib/telegram-mock.ts';
import { createAccount, createLiveShop, deleteShops, deleteUsers, localSql, type Account } from './shops';

// «Рассылка» (20261113090000), in a real browser against the LOCAL stack; Telegram is the local mock Bot API and the
// bot token is fake. The owner connects the shop's own bot, sees how many users started it, composes a message with
// a Premium emoji and the Mini App button, confirms — and exactly the users who started THIS bot (and did not
// unsubscribe) get it once, through that bot. The token never reaches the browser.
const run = randomBytes(3).toString('hex');
const slug = `e2e-cast-${run}`;
const name = `Cast ${run}`;
const created = { shops: [] as string[], users: [] as string[] };
/** PUBLIC_APP_URL of the local Edge Runtime (scripts/supabase-start.ts). */
const PUBLIC = process.env.PUBLIC_APP_URL ?? 'https://miniapp.local.test';
const FIRE = '5368324170671202286';
const BAG = '5368324170671202287';
let owner: Account;
let shop: Awaited<ReturnType<typeof createLiveShop>>;

async function login(page: Page, a: Account) {
  await page.goto('/admin');
  await page.getByLabel('Email').fill(a.email);
  await page.getByLabel('Пароль').fill(a.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('heading', { name: 'Мои магазины' })).toBeVisible();
}

let updateSeq = Math.floor(Math.random() * 1_000_000_000);
/** A private message of a Telegram user to the bot, delivered to its webhook exactly like Telegram does. */
async function tellBot(botId: number, user: number, text: string) {
  const hook = (await mockBotState(botId)).webhook;
  if (!hook) throw new Error('the bot has no webhook');
  const res = await fetch(`${resolveSupabaseEnv().url}/functions/v1/telegram-webhook?c=${new URL(hook.url).searchParams.get('c')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': hook.secret_token! },
    body: JSON.stringify({
      update_id: updateSeq++,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), text, chat: { id: user, type: 'private' }, from: { id: user, is_bot: false, first_name: 'Buyer' } },
    }),
  });
  if (res.status !== 200) throw new Error(`webhook answered ${res.status}`);
}
const newUser = () => 8_400_000_000 + Math.floor(Math.random() * 1_000_000_000);

test.beforeAll(async () => {
  owner = await createAccount('cast-owner');
  created.users.push(owner.id);
  shop = await createLiveShop(owner.id, slug, name);
  created.shops.push(shop.id);
});

test.afterAll(async () => {
  await deleteShops(created.shops);
  await deleteUsers(created.users);
});

test('owner connects the bot, composes a broadcast with a Premium emoji and a Mini App button; only this bot’s users get it, once', async ({ page }) => {
  const botId = 700_000_000 + Math.floor(Math.random() * 1e8);
  const token = `${botId}:FAKE_e2e_${randomBytes(16).toString('hex')}`;
  const secret = token.split(':')[1]!;
  const bodies: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/functions/v1/')) bodies.push(await r.text().catch(() => ''));
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, owner);
  await page.goto(`/admin/shops/${slug}/broadcast`);
  // No bot yet: nothing to send from.
  await expect(page.getByTestId('broadcast-no-bot')).toBeVisible();
  await expect(page.getByTestId('broadcast-send')).toHaveCount(0);
  await page.getByRole('link', { name: 'Перейти к подключению бота' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/shops/${slug}/bot$`));
  await page.getByTestId('bot-token').fill(token);
  await page.getByTestId('bot-connect').click();
  await expect(page.getByTestId('bot-username')).toHaveText(`@mock_${botId}_bot`);

  await page.getByRole('navigation', { name: 'Разделы магазина' }).getByRole('link', { name: 'Рассылка', exact: true }).click();
  await expect(page.getByTestId('broadcast-page')).toBeVisible();
  // Connected, but nobody started the bot yet.
  await expect(page.getByTestId('broadcast-audience')).toHaveText('0');
  await expect(page.getByTestId('broadcast-empty-audience')).toBeVisible();
  await page.getByTestId('broadcast-text').fill('Текст');
  await expect(page.getByTestId('broadcast-send')).toBeDisabled();

  // Three people press Start in the bot; one of them unsubscribes. Someone who never started it stays unknown.
  const [first, second, left] = [newUser(), newUser(), newUser()];
  const stranger = newUser();
  for (const u of [first, second, left]) await tellBot(botId, u, '/start');
  await tellBot(botId, left, '/stop');
  await page.reload();
  await expect(page.getByTestId('broadcast-audience')).toHaveText('2');
  await expect(page.getByTestId('broadcast-audience-rest')).toContainText('отписались: 1');

  // Compose: text with the shop name placeholder, a Premium emoji inserted by its ID, a button with a Premium icon.
  const text = page.getByTestId('broadcast-text');
  await text.fill('Новинки недели в {название_магазина} ');
  await text.press('Control+End');
  await page.getByTestId('broadcast-emoji-insert-id').fill(FIRE);
  await page.getByTestId('broadcast-emoji-insert-fallback').fill('🔥');
  await page.getByTestId('broadcast-emoji-insert-add').click();
  await expect(text).toHaveValue(`Новинки недели в {название_магазина} <tg-emoji emoji-id="${FIRE}">🔥</tg-emoji>`);
  const sent = `Новинки недели в ${name} 🔥`;
  // The counter counts what Telegram will get, not the tag.
  await expect(page.getByTestId('broadcast-counter')).toHaveText(`${sent.length} / 4096`);
  await expect(page.getByTestId('broadcast-button-text')).toHaveValue('Открыть магазин');
  // An icon id must be a number.
  await page.getByTestId('broadcast-button-emoji').fill('not-an-id');
  await expect(page.getByTestId('broadcast-button-emoji-error')).toBeVisible();
  await expect(page.getByTestId('broadcast-send')).toBeDisabled();
  await page.getByTestId('broadcast-button-emoji').fill(BAG);
  await expect(page.getByTestId('broadcast-button-emoji-error')).toHaveCount(0);

  // The preview shows the message as the recipient will see it.
  const preview = page.getByTestId('broadcast-preview');
  await expect(preview.getByTestId('broadcast-preview-text')).toHaveText(sent);
  await expect(preview.getByTestId('broadcast-preview-premium-emoji')).toHaveText('🔥');
  await expect(preview.getByTestId('broadcast-preview-button-1')).toContainText('Открыть магазин');
  await expect(preview.getByTestId('broadcast-preview-button-1-premium')).toBeVisible();

  // Sending needs an explicit confirmation that names the audience and the bot.
  await page.getByTestId('broadcast-send').click();
  const confirm = page.getByTestId('broadcast-confirm');
  await expect(confirm).toContainText(`Сообщение получат 2 пользователей бота @mock_${botId}_bot`);
  expect(localSql(`select count(*) from private.shop_broadcasts where shop_id = '${shop.id}';`)).toBe('0');
  await confirm.getByTestId('broadcast-confirm-ok').click();

  // The page itself drives the sending and shows the result.
  const item = page.getByTestId('broadcast-history-item').first();
  await expect(item).toContainText('Завершена', { timeout: 30_000 });
  await expect(item).toContainText('получателей: 2');
  await expect(item.getByTestId('broadcast-count-sent')).toHaveText('2');
  await expect(item.getByTestId('broadcast-count-failed')).toHaveCount(0);
  await expect(page.getByTestId('broadcast-progress')).toHaveCount(0);
  // The composed message is cleared: a second click cannot send it again.
  await expect(page.getByTestId('broadcast-text')).toHaveValue('');
  await expect(page.getByTestId('broadcast-send')).toBeDisabled();

  // Telegram's side: both subscribers got exactly one message through this bot — plain text with a custom_emoji
  // entity over the 🔥 and a web_app button to this shop with the Premium icon.
  for (const u of [first, second]) {
    const got = (await mockMessages(String(u))).filter((m) => m.text === sent);
    expect(got, String(u)).toHaveLength(1);
    expect(got[0]!.bot_id).toBe(botId);
    expect(got[0]!.parse_mode).toBeNull();
    expect(got[0]!.entities).toEqual([{ type: 'custom_emoji', offset: sent.length - 2, length: 2, custom_emoji_id: FIRE }]);
    expect(got[0]!.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Открыть магазин', web_app: { url: `${PUBLIC}/s/${slug}/` }, icon_custom_emoji_id: BAG }]],
    });
  }
  // The one who sent /stop and the one who never started the bot got nothing.
  expect((await mockMessages(String(left))).filter((m) => m.text === sent)).toEqual([]);
  expect(await mockMessages(String(stranger))).toEqual([]);
  expect(localSql(`select status || ':' || total from private.shop_broadcasts where shop_id = '${shop.id}';`)).toBe('completed:2');
  expect(localSql(`select string_agg(status, ',' order by tg_user_id) from private.broadcast_recipients where shop_id = '${shop.id}';`)).toBe('sent,sent');

  // After a reload the result is still there and nothing is sent again.
  await page.reload();
  await expect(page.getByTestId('broadcast-history-item')).toHaveCount(1);
  await expect(page.getByTestId('broadcast-history-item').getByTestId('broadcast-count-sent')).toHaveText('2');
  for (const u of [first, second]) expect((await mockMessages(String(u))).filter((m) => m.text === sent)).toHaveLength(1);

  // The token: never in any function response, never in browser storage.
  expect(bodies.length).toBeGreaterThan(3);
  for (const b of bodies) expect(b).not.toContain(secret);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(storage).not.toContain(secret);
});
