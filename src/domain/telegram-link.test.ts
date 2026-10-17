import { describe, expect, it } from 'vitest';
import { DEFAULT_TELEGRAM_CHANNEL_LABEL, normalizeTelegramChannelUrl, telegramChannelLabel } from './telegram-link';

describe('normalizeTelegramChannelUrl', () => {
  it.each([
    ['https://t.me/noir_vapor', 'https://t.me/noir_vapor'],
    ['https://t.me/noir_vapor/', 'https://t.me/noir_vapor'],
    ['http://t.me/noir_vapor', 'https://t.me/noir_vapor'],
    ['t.me/noir_vapor', 'https://t.me/noir_vapor'],
    ['  https://telegram.me/noir_vapor  ', 'https://t.me/noir_vapor'],
    ['https://www.t.me/noir_vapor?utm=1#x', 'https://t.me/noir_vapor'],
    ['@noir_vapor', 'https://t.me/noir_vapor'],
    ['https://t.me/+AbCdEfGhIj12-_x', 'https://t.me/+AbCdEfGhIj12-_x'],
    ['https://t.me/joinchat/AbCdEfGhIj12', 'https://t.me/+AbCdEfGhIj12'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeTelegramChannelUrl(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'javascript:alert(1)',
    'JaVaScRiPt://t.me/x',
    'data:text/html,hi',
    'tg://resolve?domain=noir_vapor',
    'ftp://t.me/noir_vapor',
    'https://evil.example/noir_vapor',
    'https://t.me.evil.example/noir_vapor',
    'https://user:pass@t.me/noir_vapor',
    'https://t.me:8443/noir_vapor',
    'https://t.me/',
    'https://t.me/abc', // too short for a username
    'https://t.me/1channel', // must start with a letter
    'https://t.me/noir_vapor/123', // a post, not a channel
    'https://t.me/+short',
    '@bad name',
    `https://t.me/${'a'.repeat(300)}`,
  ])('rejects %s', (input) => {
    expect(normalizeTelegramChannelUrl(input)).toBeNull();
  });
});

describe('telegramChannelLabel', () => {
  it('falls back to the default text and trims', () => {
    expect(telegramChannelLabel('')).toBe(DEFAULT_TELEGRAM_CHANNEL_LABEL);
    expect(telegramChannelLabel('   ')).toBe(DEFAULT_TELEGRAM_CHANNEL_LABEL);
    expect(telegramChannelLabel(undefined)).toBe(DEFAULT_TELEGRAM_CHANNEL_LABEL);
    expect(telegramChannelLabel('  Канал  ')).toBe('Канал');
  });
});
