import { describe, expect, it } from 'vitest';
import * as client from '../../../src/domain/bot-welcome';
import {
  buildWelcomeKeyboard,
  DEFAULT_WELCOME_TEXT,
  emojiIdsReply,
  generateWebhookSecret,
  isOurMenuButton,
  normalizeButtonText,
  normalizeManagerUrl,
  normalizePublicAppUrl,
  normalizeWelcomeText,
  parsePrivateUpdate,
  parseStartCommand,
  renderWelcome,
  sha256Hex,
  storefrontUrl,
  UNSUBSCRIBED_TEXT,
  WEBHOOK_SECRET_RE,
  webhookHost,
  webhookUrl,
} from './bot-welcome';

const STORE = 'https://miniappdemo.pages.dev/s/noir-vapor/';

describe('manager link', () => {
  it('accepts @username, t.me and https://t.me / telegram.me links and normalises them to https://t.me/<name>', () => {
    for (const input of ['@noir_manager', 't.me/noir_manager', 'https://t.me/noir_manager', 'https://telegram.me/noir_manager/', ' https://www.t.me/noir_manager ']) {
      expect(normalizeManagerUrl(input), input).toBe('https://t.me/noir_manager');
    }
  });

  it('rejects dangerous schemes, other hosts, http, invite links, paths, queries and bad usernames', () => {
    for (const input of [
      '',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://t.me/noir_manager',
      'tg://resolve?domain=noir_manager',
      'https://evil.example/noir_manager',
      'https://t.me.evil.example/noir_manager',
      'https://t.me/+AbCdEfGhIjKl',
      'https://t.me/noir_manager/12',
      'https://t.me/noir_manager?start=1',
      'https://t.me/noir_manager#x',
      'https://user:pass@t.me/noir_manager',
      'https://t.me:8443/noir_manager',
      '@abc',
      '@noir_manager_',
      '@1noir',
    ]) {
      expect(normalizeManagerUrl(input), input).toBeNull();
    }
  });

  it('the browser and the server validate exactly alike', () => {
    for (const input of ['@noir_manager', 'https://t.me/noir_manager', 'javascript:alert(1)', 'http://t.me/x_manager', 'https://t.me/+AbCdEfGhIjKl', 't.me/noir_manager', '@abc']) {
      expect(client.normalizeManagerUrl(input), input).toBe(normalizeManagerUrl(input));
    }
    expect(client.renderWelcome(DEFAULT_WELCOME_TEXT, 'Noir')).toBe(renderWelcome(DEFAULT_WELCOME_TEXT, 'Noir'));
    expect(client.WELCOME_TEXT_MAX).toBe(4096);
  });
});

describe('welcome text', () => {
  it('substitutes the shop name, keeps line breaks and emoji, never exceeds 4096 characters', () => {
    expect(renderWelcome('Привет в {название_магазина}! 🎉\n{название_магазина}', 'Noir <b>Vapor</b>')).toBe('Привет в Noir <b>Vapor</b>! 🎉\nNoir <b>Vapor</b>');
    expect(renderWelcome('{название_магазина}'.repeat(100), 'x'.repeat(80))).toHaveLength(4096);
    expect(DEFAULT_WELCOME_TEXT).toContain('Добро пожаловать в {название_магазина}');
  });

  it('normalises CRLF, strips control characters, refuses empty and too long templates', () => {
    expect(normalizeWelcomeText('a\r\nb\u0000c\u0007')).toBe('a\nbc');
    expect(normalizeWelcomeText('   \n ')).toBeNull();
    expect(normalizeWelcomeText('x'.repeat(4097))).toBeNull();
    expect(normalizeWelcomeText('x'.repeat(4096))).toHaveLength(4096);
  });

  it('button texts are trimmed, 1–64 characters', () => {
    expect(normalizeButtonText('  Открыть  приложение ')).toBe('Открыть приложение');
    expect(normalizeButtonText('')).toBeNull();
    expect(normalizeButtonText('x'.repeat(65))).toBeNull();
  });
});

describe('inline keyboard', () => {
  it('has exactly two buttons: web_app to the storefront, then url to the manager', () => {
    const kb = buildWelcomeKeyboard({ openButtonText: 'Открыть приложение', storefrontUrl: STORE, managerButtonText: 'Связаться с менеджером', managerUrl: 'https://t.me/noir_manager' });
    expect(kb).toEqual({
      inline_keyboard: [[{ text: 'Открыть приложение', web_app: { url: STORE } }], [{ text: 'Связаться с менеджером', url: 'https://t.me/noir_manager' }]],
    });
    expect(kb.inline_keyboard.flat()).toHaveLength(2);
  });

  it('never emits an unsafe manager URL; without a manager link only the app button is sent', () => {
    const kb = buildWelcomeKeyboard({ openButtonText: 'Open', storefrontUrl: STORE, managerButtonText: 'Manager', managerUrl: 'javascript:alert(1)' });
    expect(kb.inline_keyboard).toEqual([[{ text: 'Open', web_app: { url: STORE } }]]);
    expect(buildWelcomeKeyboard({ openButtonText: 'Open', storefrontUrl: STORE, managerButtonText: 'Manager', managerUrl: null }).inline_keyboard).toHaveLength(1);
  });

  it('a Premium emoji id becomes the icon of its button; a button without one is exactly as before', () => {
    const kb = buildWelcomeKeyboard({
      openButtonText: 'Open',
      storefrontUrl: STORE,
      managerButtonText: 'Manager',
      managerUrl: '@noir_manager',
      openButtonEmojiId: '5368324170671202286',
      managerButtonEmojiId: null,
    });
    expect(kb.inline_keyboard).toEqual([
      [{ text: 'Open', web_app: { url: STORE }, icon_custom_emoji_id: '5368324170671202286' }],
      [{ text: 'Manager', url: 'https://t.me/noir_manager' }],
    ]);
  });
});

describe('public storefront URL', () => {
  it('is <PUBLIC_APP_URL>/s/<slug>/ of exactly that shop', () => {
    expect(storefrontUrl('https://miniappdemo.pages.dev', 'noir-vapor')).toBe(STORE);
    expect(storefrontUrl('https://miniappdemo.pages.dev/', 'mint-lab')).toBe('https://miniappdemo.pages.dev/s/mint-lab/');
    expect(storefrontUrl('https://miniappdemo.pages.dev', 'Bad Slug')).toBeNull();
  });

  it('refuses missing, http, localhost / private hosts, paths and queries', () => {
    for (const raw of [undefined, '', 'http://miniappdemo.pages.dev', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.5', 'https://192.168.1.2', 'https://[::1]', 'https://app.localhost', 'https://x.dev/admin', 'https://x.dev/?a=1', 'https://u:p@x.dev']) {
      expect(normalizePublicAppUrl(raw), String(raw)).toBeNull();
    }
  });
});

describe('webhook', () => {
  it('URL carries only the connection id (never a token); display shows only the host', () => {
    const url = webhookUrl('https://ref.supabase.co/functions/v1/', 'c3d1b8a0-0000-4000-8000-000000000001');
    expect(url).toBe('https://ref.supabase.co/functions/v1/telegram-webhook?c=c3d1b8a0-0000-4000-8000-000000000001');
    expect(webhookHost('https://other.example/bot123:SECRET/hook?x=1')).toBe('other.example');
  });

  it('secrets are random, Telegram-compatible, and hashed with SHA-256', async () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(WEBHOOK_SECRET_RE);
    expect(a).toHaveLength(43);
    expect(generateWebhookSecret()).not.toBe(a);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('Menu Button ownership is recognised only for the exact web_app URL the platform set', () => {
    expect(isOurMenuButton({ type: 'web_app', text: 'x', web_app: { url: STORE } }, STORE)).toBe(true);
    expect(isOurMenuButton({ type: 'web_app', text: 'x', web_app: { url: 'https://other.app/' } }, STORE)).toBe(false);
    expect(isOurMenuButton({ type: 'commands' }, STORE)).toBe(false);
    expect(isOurMenuButton({ type: 'web_app', text: 'x', web_app: { url: STORE } }, null)).toBe(false);
  });
});

describe('/start parsing', () => {
  const upd = (text: unknown, type = 'private', id: unknown = 42) => ({ update_id: 1, message: { text, chat: { id, type } } });

  it('recognises /start, /start <payload> and /start@this_bot in a private chat', () => {
    expect(parseStartCommand(upd('/start'), 'noir_bot')).toEqual({ chatId: 42, payload: null });
    expect(parseStartCommand(upd('/start promo_1'), 'noir_bot')).toEqual({ chatId: 42, payload: 'promo_1' });
    expect(parseStartCommand(upd('/start@Noir_Bot'), 'noir_bot')).toEqual({ chatId: 42, payload: null });
  });

  it('ignores other commands, other bots, groups, channels and malformed updates', () => {
    expect(parseStartCommand(upd('/help'), 'noir_bot')).toBeNull();
    expect(parseStartCommand(upd('/started'), 'noir_bot')).toBeNull();
    expect(parseStartCommand(upd('/start@other_bot'), 'noir_bot')).toBeNull();
    expect(parseStartCommand(upd('/start', 'group'), 'noir_bot')).toBeNull();
    expect(parseStartCommand(upd('/start', 'channel'), 'noir_bot')).toBeNull();
    expect(parseStartCommand(upd(123), 'noir_bot')).toBeNull();
    expect(parseStartCommand(upd('/start', 'private', '42'), 'noir_bot')).toBeNull();
    expect(parseStartCommand(null, 'noir_bot')).toBeNull();
    expect(parseStartCommand({ update_id: 1, edited_message: { text: '/start' } }, 'noir_bot')).toBeNull();
  });
});

describe('private updates: who uses the bot', () => {
  const BOT = 'noir_bot';
  const FIRE = '5368324170671202286';
  const HAND = '5368324170671202287';
  const user = { userId: 42, chatId: 42 };
  const msg = (text: unknown, over: Record<string, unknown> = {}) => ({
    update_id: 1,
    message: { text, chat: { id: 42, type: 'private' }, from: { id: 42, is_bot: false }, ...over },
  });
  const member = (status: unknown, chat: Record<string, unknown> = { id: 42, type: 'private' }) => ({ update_id: 1, my_chat_member: { chat, new_chat_member: { status } } });

  it('/start, /stop and any other message of a user in a private chat', () => {
    expect(parsePrivateUpdate(msg('/start promo'), BOT)).toEqual({ kind: 'start', ...user, payload: 'promo' });
    expect(parsePrivateUpdate(msg('/stop'), BOT)).toEqual({ kind: 'stop', ...user });
    expect(parsePrivateUpdate(msg(' /stop@Noir_Bot '), BOT)).toEqual({ kind: 'stop', ...user });
    expect(parsePrivateUpdate(msg('Здравствуйте'), BOT)).toEqual({ kind: 'message', ...user });
    // Not a text at all (a photo, a sticker): still a message of this user.
    expect(parsePrivateUpdate(msg(undefined), BOT)).toEqual({ kind: 'message', ...user });
    // Without a sender the private chat id is the user.
    expect(parsePrivateUpdate(msg('hi', { from: undefined }), BOT)).toEqual({ kind: 'message', ...user });
    // A command for another bot, or one that only looks like /stop, unsubscribes nobody.
    for (const text of ['/stop@other_bot', '/stopped', '/stop now', '/start@other_bot']) {
      expect(parsePrivateUpdate(msg(text), BOT), text).toEqual({ kind: 'message', ...user });
    }
  });

  it('my_chat_member: kicked → blocked, member → unblocked; other statuses say nothing', () => {
    expect(parsePrivateUpdate(member('kicked'), BOT)).toEqual({ kind: 'blocked', ...user });
    expect(parsePrivateUpdate(member('member'), BOT)).toEqual({ kind: 'unblocked', ...user });
    for (const status of ['left', 'restricted', 'administrator', undefined]) expect(parsePrivateUpdate(member(status), BOT), String(status)).toBeNull();
  });

  it('groups, channels, bots and malformed updates are nobody', () => {
    expect(parsePrivateUpdate(msg('/start', { chat: { id: -100123, type: 'supergroup' } }), BOT)).toBeNull();
    expect(parsePrivateUpdate(msg('/start', { chat: { id: -100123, type: 'channel' } }), BOT)).toBeNull();
    expect(parsePrivateUpdate(msg('/start', { from: { id: 77, is_bot: true } }), BOT)).toBeNull();
    expect(parsePrivateUpdate(msg('/start', { chat: { id: '42', type: 'private' } }), BOT)).toBeNull();
    expect(parsePrivateUpdate(msg('/start', { chat: { id: 0, type: 'private' } }), BOT)).toBeNull();
    expect(parsePrivateUpdate(member('kicked', { id: -100123, type: 'supergroup' }), BOT)).toBeNull();
    expect(parsePrivateUpdate({ update_id: 1, edited_message: { text: '/stop', chat: { id: 42, type: 'private' } } }, BOT)).toBeNull();
    expect(parsePrivateUpdate(null, BOT)).toBeNull();
    expect(parsePrivateUpdate({}, BOT)).toBeNull();
  });

  it('/emoji lists the Premium emoji of the message: each id once, with the regular emoji it covers', () => {
    const entities = [
      { type: 'bot_command', offset: 0, length: 6 },
      { type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: FIRE },
      { type: 'custom_emoji', offset: 9, length: 2, custom_emoji_id: HAND },
      // Repeated, not an id, a bad offset, junk: all skipped.
      { type: 'custom_emoji', offset: 11, length: 2, custom_emoji_id: FIRE },
      { type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: 'abc' },
      { type: 'custom_emoji', offset: -1, length: 2, custom_emoji_id: '12345' },
      null,
    ];
    expect(parsePrivateUpdate(msg('/emoji 🔥👍🔥', { entities }), BOT)).toEqual({
      kind: 'emoji',
      ...user,
      emoji: [
        { id: FIRE, fallback: '🔥' },
        { id: HAND, fallback: '👍' },
      ],
    });
    expect(parsePrivateUpdate(msg('/emoji'), BOT)).toEqual({ kind: 'emoji', ...user, emoji: [] });
    expect(parsePrivateUpdate(msg('/emoji@noir_bot 🔥', { entities: 'junk' }), BOT)).toEqual({ kind: 'emoji', ...user, emoji: [] });
    // Another bot's command, or a word that only starts like it.
    expect(parsePrivateUpdate(msg('/emoji@other_bot 🔥'), BOT)).toEqual({ kind: 'message', ...user });
    expect(parsePrivateUpdate(msg('/emojis'), BOT)).toEqual({ kind: 'message', ...user });
    // One answer lists at most 20 ids.
    const many = Array.from({ length: 25 }, (_, i) => ({ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: String(10000 + i) }));
    expect(parsePrivateUpdate(msg('/emoji 🔥', { entities: many }), BOT)).toMatchObject({ kind: 'emoji', emoji: { length: 20 } });
  });

  it('the answer to /emoji gives the ids ready to paste, or explains what to send', () => {
    expect(
      emojiIdsReply([
        { id: FIRE, fallback: '🔥' },
        { id: HAND, fallback: '👍' },
      ]).split('\n'),
    ).toEqual(['ID Premium Emoji:', `🔥 — ${FIRE}`, `👍 — ${HAND}`, '', 'В тексте сообщения: <tg-emoji emoji-id="ID">🙂</tg-emoji>. На кнопке: поле «Premium Emoji ID».']);
    expect(emojiIdsReply([])).toContain('/emoji 🔥');
    // The /stop confirmation tells how to come back.
    expect(UNSUBSCRIBED_TEXT).toContain('/start');
  });
});
