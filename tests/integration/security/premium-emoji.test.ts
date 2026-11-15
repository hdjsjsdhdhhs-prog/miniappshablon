// Telegram Premium (custom) emoji in the welcome of a shop's own bot (20261113090000: shop_bot_welcome.*_emoji_id,
// bot_save_welcome_v2; bot-connection save-welcome; telegram-webhook /start and /emoji). LOCAL ONLY; all Telegram
// traffic goes to the local mock Bot API; only fake tokens. Premium emoji in broadcasts: broadcast.test.ts.
// Covers: the tag in the text becomes a custom_emoji entity over its Unicode fallback (never HTML), icons on both
// buttons, the fallback for a bot that may not use Premium emoji, validation (Edge Function and SQL), compatibility
// with an admin page / Edge Function that does not know the icons yet, and the /emoji helper that tells the ids.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockBotState, mockMessages } from '../../../scripts/lib/telegram-mock.ts';
import { emojiIdsReply } from '../../../supabase/functions/_shared/bot-welcome.ts';
import { env, newTelegramUserId, type Db } from '../helpers';
import { botFn, botIdOf, deliver, errorCode, privateMessage, PUBLIC_APP_URL, shopWithBot, sql, starter, type BotShop } from './bot-helpers';
import { cleanupSecurity, svcRpc } from './sec-helpers';

const FIRE = '5368324170671202286';
const BAG = '5368324170671202287';
const CHAT = '5368324170671202288';
const tag = (id: string, fallback: string) => `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;

interface Welcome {
  welcome_text: string;
  open_button_text: string;
  manager_button_text: string;
  manager_url: string | null;
  open_button_emoji_id: string | null;
  manager_button_emoji_id: string | null;
}
const base = { welcomeText: 'Привет', openButtonText: 'Открыть приложение', managerButtonText: 'Связаться с менеджером', managerUrl: '@noir_manager' };
const save = (client: Db, shopId: string, welcome: Record<string, unknown>) => botFn(client, { action: 'save-welcome', shopId, welcome: { ...base, ...welcome } });
const welcomeOf = async (S: BotShop) => ((await botFn(S.owner.client, { action: 'get', shopId: S.shop.id })).body!.settings as { welcome: Welcome }).welcome;
const storedIcons = (S: BotShop) =>
  sql(`select coalesce(open_button_emoji_id, '-') || '|' || coalesce(manager_button_emoji_id, '-') from private.shop_bot_welcome where shop_id = '${S.shop.id}';`);
/** What the bot answered to a new user's /start (the only message in that chat). */
async function welcomeMessage(S: BotShop) {
  const user = await starter(S.token);
  const [msg, ...rest] = await mockMessages(String(user));
  expect(rest).toEqual([]);
  return msg!;
}

let A: BotShop;
let B: BotShop;

beforeAll(async () => {
  A = await shopWithBot();
  B = await shopWithBot();
});
afterAll(cleanupSecurity);

describe('welcome with Premium emoji', () => {
  it('the tag becomes a custom_emoji entity over its Unicode emoji and both buttons get their icon; no HTML is interpreted', async () => {
    const saved = await save(A.owner.client, A.shop.id, {
      welcomeText: `Привет ${tag(FIRE, '🔥')} в {название_магазина} <b>не тег</b>`,
      openButtonEmojiId: BAG,
      managerButtonEmojiId: CHAT,
    });
    expect(saved.status, saved.text).toBe(200);
    // Stored as typed (the template keeps the tag) with the two icon ids next to it.
    expect(await welcomeOf(A)).toMatchObject({
      welcome_text: `Привет ${tag(FIRE, '🔥')} в {название_магазина} <b>не тег</b>`,
      open_button_emoji_id: BAG,
      manager_button_emoji_id: CHAT,
    });

    const msg = await welcomeMessage(A);
    expect(msg.bot_id).toBe(botIdOf(A.token));
    expect(msg.text).toBe(`Привет 🔥 в IT ${A.shop.slug} <b>не тег</b>`);
    // Plain text: without a parse mode "<b>" stays literal and the Premium emoji is an entity (UTF-16 offsets).
    expect(msg.parse_mode).toBeNull();
    expect(msg.entities).toEqual([{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: FIRE }]);
    expect(msg.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Открыть приложение', web_app: { url: `${PUBLIC_APP_URL}/s/${A.shop.slug}/` }, icon_custom_emoji_id: BAG }],
        [{ text: 'Связаться с менеджером', url: 'https://t.me/noir_manager', icon_custom_emoji_id: CHAT }],
      ],
    });
  });

  it('several emoji keep correct offsets; another shop’s welcome is untouched', async () => {
    const saved = await save(A.owner.client, A.shop.id, { welcomeText: `${tag(FIRE, '🔥')}Новинки ${tag(BAG, '👍')} и ${tag(CHAT, '💬')}!`, openButtonEmojiId: BAG, managerButtonEmojiId: CHAT });
    expect(saved.status, saved.text).toBe(200);
    const msg = await welcomeMessage(A);
    expect(msg.text).toBe('🔥Новинки 👍 и 💬!');
    expect(msg.entities).toEqual([
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: FIRE },
      { type: 'custom_emoji', offset: 10, length: 2, custom_emoji_id: BAG },
      { type: 'custom_emoji', offset: 15, length: 2, custom_emoji_id: CHAT },
    ]);
    // Every entity covers exactly the emoji the owner typed.
    for (const e of msg.entities as Array<{ offset: number; length: number }>) expect(['🔥', '👍', '💬']).toContain(msg.text.slice(e.offset, e.offset + e.length));

    // Shop B never saved anything: default welcome, no entities, no icons.
    expect(await welcomeOf(B)).toMatchObject({ open_button_emoji_id: null, manager_button_emoji_id: null });
    const other = await welcomeMessage(B);
    expect(other.entities).toBeNull();
    expect(JSON.stringify(other.reply_markup)).not.toContain('icon_custom_emoji_id');
  });

  it('a tag that is not exactly the official one stays literal text', async () => {
    const X = await shopWithBot();
    const literal = `<tg-emoji emoji-id="12">🔥</tg-emoji> <tg-emoji emoji-id="${FIRE}"></tg-emoji> <tg-emoji id="${FIRE}">🔥</tg-emoji>`;
    expect((await save(X.owner.client, X.shop.id, { welcomeText: literal })).status).toBe(200);
    const msg = await welcomeMessage(X);
    expect(msg.text).toBe(literal);
    expect(msg.entities).toBeNull();
    expect(msg.parse_mode).toBeNull();
  });

  it('a bot that may not use Premium emoji still answers /start: Unicode emoji in the text, buttons without icons', async () => {
    const X = await shopWithBot({ tokenPrefix: 'NOEMOJI' });
    const saved = await save(X.owner.client, X.shop.id, { welcomeText: `Привет ${tag(FIRE, '👋')}`, openButtonEmojiId: BAG, managerButtonEmojiId: CHAT });
    expect(saved.status, saved.text).toBe(200);
    const msg = await welcomeMessage(X);
    expect(msg.text).toBe('Привет 👋');
    expect(msg.entities).toBeNull();
    expect(msg.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Открыть приложение', web_app: { url: `${PUBLIC_APP_URL}/s/${X.shop.slug}/` } }],
        [{ text: 'Связаться с менеджером', url: 'https://t.me/noir_manager' }],
      ],
    });
    // The settings keep the ids: the owner may get Telegram Premium later.
    expect(await storedIcons(X)).toBe(`${BAG}|${CHAT}`);
  });
});

describe('validation', () => {
  it('an id that is not a custom emoji id is refused and nothing is saved', async () => {
    const X = await shopWithBot();
    expect((await save(X.owner.client, X.shop.id, { openButtonEmojiId: BAG })).status).toBe(200);
    for (const bad of ['not-an-id', '1234', '5'.repeat(26), `${BAG}x`, '🔥']) {
      for (const field of ['openButtonEmojiId', 'managerButtonEmojiId']) {
        const res = await save(X.owner.client, X.shop.id, { welcomeText: 'Другой текст', [field]: bad });
        expect([res.status, errorCode(res)], `${field}=${bad}`).toEqual([400, 'invalid_emoji_id']);
      }
    }
    expect(await welcomeOf(X)).toMatchObject({ welcome_text: 'Привет', open_button_emoji_id: BAG, manager_button_emoji_id: null });
  });

  it('more than 100 Premium emoji in one message are refused (Telegram keeps at most 100 entities)', async () => {
    const X = await shopWithBot();
    const tooMany = await save(X.owner.client, X.shop.id, { welcomeText: tag('12345', 'x').repeat(101) });
    expect([tooMany.status, errorCode(tooMany)]).toEqual([400, 'too_many_custom_emoji']);
    expect((tooMany.body!.error as { details: unknown }).details).toEqual({ max: 100 });
    expect(await sql(`select count(*) from private.shop_bot_welcome where shop_id = '${X.shop.id}';`)).toBe('0');
    const ok = await save(X.owner.client, X.shop.id, { welcomeText: tag('12345', 'x').repeat(100) });
    expect(ok.status, ok.text).toBe(200);
    const msg = await welcomeMessage(X);
    expect(msg.text).toBe('x'.repeat(100));
    expect(msg.entities).toHaveLength(100);
  });

  it('the SQL checks the ids on its own, whatever the caller sends', async () => {
    const X = await shopWithBot();
    const args = { p_shop_id: X.shop.id, p_actor: X.owner.userId, p_welcome_text: 'x', p_open_button_text: 'x', p_manager_button_text: 'x', p_manager_url: null };
    for (const bad of ['nope', '1234', '5'.repeat(26)]) {
      expect((await svcRpc('bot_save_welcome_v2', { ...args, p_open_button_emoji_id: bad, p_manager_button_emoji_id: null })).error?.message, bad).toBe('invalid_welcome');
      expect((await svcRpc('bot_save_welcome_v2', { ...args, p_open_button_emoji_id: null, p_manager_button_emoji_id: bad })).error?.message, bad).toBe('invalid_welcome');
    }
    expect(await sql(`select count(*) from private.shop_bot_welcome where shop_id = '${X.shop.id}';`)).toBe('0');
    // Another shop's owner as the actor is refused before anything else.
    expect((await svcRpc('bot_save_welcome_v2', { ...args, p_actor: B.owner.userId, p_open_button_emoji_id: BAG, p_manager_button_emoji_id: null })).error?.message).toBe('forbidden');
    expect((await svcRpc('bot_save_welcome_v2', { ...args, p_open_button_emoji_id: ` ${BAG} `, p_manager_button_emoji_id: '' })).error).toBeNull();
    expect(await storedIcons(X)).toBe(`${BAG}|-`);
  });
});

describe('compatibility: callers that do not know the icons yet', () => {
  it('an admin page that sends no icon fields keeps the stored icons; an empty id removes one', async () => {
    const X = await shopWithBot();
    expect((await save(X.owner.client, X.shop.id, { openButtonEmojiId: BAG, managerButtonEmojiId: CHAT })).status).toBe(200);
    // The previous admin page: text and buttons only.
    expect((await save(X.owner.client, X.shop.id, { welcomeText: 'Новый текст' })).status).toBe(200);
    expect(await welcomeOf(X)).toMatchObject({ welcome_text: 'Новый текст', open_button_emoji_id: BAG, manager_button_emoji_id: CHAT });
    expect((await save(X.owner.client, X.shop.id, { welcomeText: 'Новый текст', openButtonEmojiId: '', managerButtonEmojiId: CHAT })).status).toBe(200);
    expect(await storedIcons(X)).toBe(`-|${CHAT}`);
    const msg = await welcomeMessage(X);
    expect(msg.reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'Открыть приложение', web_app: { url: `${PUBLIC_APP_URL}/s/${X.shop.slug}/` } }],
        [{ text: 'Связаться с менеджером', url: 'https://t.me/noir_manager', icon_custom_emoji_id: CHAT }],
      ],
    });
  });

  it('the previous RPC (bot_save_welcome, still called by the deployed Edge Function) leaves the icons untouched', async () => {
    const X = await shopWithBot();
    expect((await save(X.owner.client, X.shop.id, { openButtonEmojiId: BAG, managerButtonEmojiId: CHAT })).status).toBe(200);
    const old = await svcRpc('bot_save_welcome', {
      p_shop_id: X.shop.id,
      p_actor: X.owner.userId,
      p_welcome_text: 'Текст старой функции',
      p_open_button_text: 'Открыть',
      p_manager_button_text: 'Менеджер',
      p_manager_url: 'https://t.me/noir_manager',
    });
    expect(old.error).toBeNull();
    expect(await welcomeOf(X)).toMatchObject({ welcome_text: 'Текст старой функции', open_button_text: 'Открыть', open_button_emoji_id: BAG, manager_button_emoji_id: CHAT });
  });
});

describe('/emoji: the bot tells the ids of the Premium emoji in a message', () => {
  it('answers with every id (plain text, the example tag is shown literally) and with a hint when there is none', async () => {
    const user = newTelegramUserId();
    // "/emoji 🔥👍" — offsets in UTF-16 code units, exactly as Telegram sends them.
    const res = await deliver(
      A.token,
      privateMessage(user, '/emoji 🔥👍', [
        { type: 'bot_command', offset: 0, length: 6 },
        { type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: FIRE },
        { type: 'custom_emoji', offset: 9, length: 2, custom_emoji_id: BAG },
      ]),
    );
    expect(res).toEqual({ status: 200, body: { ok: true, handled: true } });
    const [answer, ...rest] = await mockMessages(String(user));
    expect(rest).toEqual([]);
    expect(answer!.bot_id).toBe(botIdOf(A.token));
    expect(answer!.text).toBe(emojiIdsReply([{ id: FIRE, fallback: '🔥' }, { id: BAG, fallback: '👍' }]));
    expect(answer!.text).toContain(`🔥 — ${FIRE}`);
    expect(answer!.text).toContain(`👍 — ${BAG}`);
    expect(answer!.parse_mode).toBeNull();
    expect(answer!.entities).toBeNull();
    expect(answer!.reply_markup).toBeNull();

    expect((await deliver(A.token, privateMessage(user, '/emoji'))).status).toBe(200);
    const hint = (await mockMessages(String(user))).at(-1)!;
    expect(hint.text).toBe(emojiIdsReply([]));
    // The sender wrote to the bot, so they are part of its audience like after any other message.
    expect(await sql(`select status from private.bot_subscribers where shop_id = '${A.shop.id}' and tg_user_id = ${user};`)).toBe('active');
  });

  it('is answered only for an update Telegram signed for this connection', async () => {
    const user = newTelegramUserId();
    const hook = (await mockBotState(botIdOf(A.token))).webhook!;
    const res = await fetch(`${env.url}/functions/v1/telegram-webhook?c=${new URL(hook.url).searchParams.get('c')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong_secret' },
      body: JSON.stringify({ update_id: 1, ...privateMessage(user, '/emoji 🔥', [{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: FIRE }]) }),
    });
    expect(res.status).toBe(401);
    expect(await mockMessages(String(user))).toEqual([]);
  });
});
