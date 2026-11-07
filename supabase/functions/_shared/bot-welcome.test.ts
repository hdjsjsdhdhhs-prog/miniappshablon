import { describe, expect, it } from 'vitest';
import * as client from '../../../src/domain/bot-welcome';
import {
  buildWelcomeKeyboard,
  DEFAULT_WELCOME_TEXT,
  generateWebhookSecret,
  isOurMenuButton,
  normalizeButtonText,
  normalizeManagerUrl,
  normalizePublicAppUrl,
  normalizeWelcomeText,
  parseStartCommand,
  renderWelcome,
  sha256Hex,
  storefrontUrl,
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
