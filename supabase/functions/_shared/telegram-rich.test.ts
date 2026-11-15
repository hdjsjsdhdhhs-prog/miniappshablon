// @vitest-environment node
// Premium (custom) emoji: parsing of the <tg-emoji> tag into entities, the same rules in the browser preview, and the
// Unicode fallback for a bot that may not use them. Sends go to the local mock Bot API (real HTTP, no Telegram) or to
// a stubbed fetch; only fake BotFather-format tokens.
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTelegramMockServer, type MockMessage } from '../../../scripts/lib/telegram-mock';
import * as client from '../../../src/domain/bot-welcome';
import { BotApiError, TelegramBotApi } from './telegram-bot-api';
import {
  CAPTION_TEXT_MAX,
  CUSTOM_EMOJI_ID_RE,
  MAX_CUSTOM_EMOJI,
  normalizeEmojiId,
  parseRichText,
  sendWithEmojiFallback,
  usesCustomEmoji,
  withoutCustomEmoji,
  type OutgoingMessage,
} from './telegram-rich';

const FIRE = '5368324170671202286';
const HAND = '5368324170671202287';
const tag = (id: string, fallback: string) => `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;

describe('parseRichText: <tg-emoji> → text + custom_emoji entities', () => {
  it('replaces the tag by its fallback emoji and covers it with one entity (UTF-16 offsets, as Telegram counts)', () => {
    expect(parseRichText(`Скидки ${tag(FIRE, '🔥')} сегодня`)).toEqual({
      text: 'Скидки 🔥 сегодня',
      // "Скидки " is 7 code units; 🔥 is a surrogate pair (2).
      entities: [{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: FIRE }],
    });
  });

  it('keeps the offsets right after other emoji and across several tags', () => {
    const parsed = parseRichText(`A😀${tag('11111', '👍')}B${tag('22222', '❤️')}`);
    expect(parsed.text).toBe('A😀👍B❤️');
    expect(parsed.entities).toEqual([
      { type: 'custom_emoji', offset: 3, length: 2, custom_emoji_id: '11111' },
      // ❤️ = U+2764 U+FE0F: two code units.
      { type: 'custom_emoji', offset: 6, length: 2, custom_emoji_id: '22222' },
    ]);
    for (const e of parsed.entities) expect(parsed.text.slice(e.offset, e.offset + e.length)).toMatch(/^(👍|❤️)$/u);
  });

  it('removes surrounding whitespace first (Telegram trims the text, which would shift the offsets)', () => {
    expect(parseRichText(`  \n${tag(FIRE, '🔥')} hi \n`)).toEqual({ text: '🔥 hi', entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: FIRE }] });
  });

  it('interprets nothing else: other tags, HTML entities and malformed emoji tags stay in the text as typed', () => {
    for (const literal of [
      '<b>жирный</b> &amp; <a href="https://evil.example">ссылка</a>',
      '<tg-emoji emoji-id="abc">🔥</tg-emoji>',
      '<tg-emoji emoji-id="1234">🔥</tg-emoji>', // an id is at least 5 digits
      `<tg-emoji emoji-id="${'9'.repeat(26)}">🔥</tg-emoji>`,
      '<tg-emoji emoji-id="12345"></tg-emoji>',
      '<tg-emoji emoji-id="12345"> </tg-emoji>',
      '<tg-emoji emoji-id="12345"><b>x</b></tg-emoji>',
      '<tg-emoji emoji-id="12345">строка\nперенос</tg-emoji>',
      "<tg-emoji emoji-id='12345'>🔥</tg-emoji>",
      '<tg-emoji emoji-id="12345" onclick="x">🔥</tg-emoji>',
    ]) {
      expect(parseRichText(literal), literal).toEqual({ text: literal, entities: [] });
    }
  });

  it('plain text and an empty string are returned unchanged', () => {
    expect(parseRichText('Просто текст 🎉')).toEqual({ text: 'Просто текст 🎉', entities: [] });
    expect(parseRichText('   ')).toEqual({ text: '', entities: [] });
  });
});

describe('the browser preview follows the same rules as the server', () => {
  const samples = [
    `Скидки ${tag(FIRE, '🔥')} в {название_магазина} ${tag(HAND, '👋')}!`,
    '<b>не тег</b> <tg-emoji emoji-id="1">x</tg-emoji>',
    `  ${tag(FIRE, '🔥')}  `,
    'Без эмодзи',
    '',
  ];

  it('the counted text and the Premium emoji of the preview equal what the server sends', () => {
    for (const sample of samples) {
      const server = parseRichText(sample);
      expect(client.richPlainText(sample), sample).toBe(server.text);
      expect(
        client.richSegments(sample).filter((s) => s.emojiId).map((s) => [s.emojiId, s.text]),
        sample,
      ).toEqual(server.entities.map((e) => [e.custom_emoji_id, server.text.slice(e.offset, e.offset + e.length)]));
    }
  });

  it('ids, limits and the tag the admin page inserts are the same', () => {
    expect(client.CUSTOM_EMOJI_ID_RE.source).toBe(CUSTOM_EMOJI_ID_RE.source);
    expect(client.CAPTION_TEXT_MAX).toBe(CAPTION_TEXT_MAX);
    expect(CAPTION_TEXT_MAX).toBe(1024);
    expect(MAX_CUSTOM_EMOJI).toBe(100);
    expect(parseRichText(client.tgEmojiTag(` ${FIRE} `, ' 🔥 '))).toEqual({ text: '🔥', entities: [{ type: 'custom_emoji', offset: 0, length: 2, custom_emoji_id: FIRE }] });
    for (const input of ['', '  ', FIRE, ` ${FIRE} `, 'abc', '1234', '12 345', '-12345', '9'.repeat(26)]) {
      expect(client.isEmojiIdInput(input), JSON.stringify(input)).toBe(normalizeEmojiId(input) !== undefined);
    }
  });

  it('insertAtCaret puts the tag at the caret, replaces a selection, and appends without a caret', () => {
    expect(client.insertAtCaret({ selectionStart: 3, selectionEnd: 3 }, 'abcdef', 'X')).toBe('abcXdef');
    expect(client.insertAtCaret({ selectionStart: 1, selectionEnd: 4 }, 'abcdef', 'X')).toBe('aXef');
    expect(client.insertAtCaret(null, 'abc', 'X')).toBe('abcX');
    expect(client.insertAtCaret({ selectionStart: null, selectionEnd: null }, 'abc', 'X')).toBe('abcX');
    expect(client.insertAtCaret({ selectionStart: 99, selectionEnd: 99 }, 'abc', 'X')).toBe('abcX');
  });
});

describe('normalizeEmojiId', () => {
  it("'' / null → no icon; digits → the id; anything else → invalid", () => {
    expect(normalizeEmojiId('')).toBeNull();
    expect(normalizeEmojiId(null)).toBeNull();
    expect(normalizeEmojiId(undefined)).toBeNull();
    expect(normalizeEmojiId(`  ${FIRE} `)).toBe(FIRE);
    for (const bad of ['abc', '1234', '12345x', '<tg-emoji>', '9'.repeat(26)]) expect(normalizeEmojiId(bad), bad).toBeUndefined();
  });
});

const rich: OutgoingMessage = {
  text: 'Привет 👋',
  entities: [{ type: 'custom_emoji', offset: 7, length: 2, custom_emoji_id: HAND }],
  keyboard: {
    inline_keyboard: [
      [{ text: '🛍 Открыть', web_app: { url: 'https://miniappdemo.pages.dev/s/noir-vapor/' }, icon_custom_emoji_id: FIRE }],
      [{ text: 'Менеджер', url: 'https://t.me/noir_manager' }],
    ],
  },
};

describe('Unicode fallback', () => {
  it('withoutCustomEmoji keeps the text and the buttons, drops only the custom emoji ids, and does not change the original', () => {
    const snapshot = JSON.stringify(rich);
    expect(withoutCustomEmoji(rich)).toEqual({
      text: 'Привет 👋',
      entities: [],
      keyboard: {
        inline_keyboard: [[{ text: '🛍 Открыть', web_app: { url: 'https://miniappdemo.pages.dev/s/noir-vapor/' } }], [{ text: 'Менеджер', url: 'https://t.me/noir_manager' }]],
      },
    });
    expect(JSON.stringify(rich)).toBe(snapshot);
    expect(withoutCustomEmoji({ text: 'x', entities: [], keyboard: null })).toEqual({ text: 'x', entities: [], keyboard: null });
  });

  it('usesCustomEmoji: an entity in the text or an icon on any button', () => {
    expect(usesCustomEmoji(rich)).toBe(true);
    expect(usesCustomEmoji({ ...rich, keyboard: null })).toBe(true);
    expect(usesCustomEmoji({ ...rich, entities: [] })).toBe(true);
    expect(usesCustomEmoji(withoutCustomEmoji(rich))).toBe(false);
    expect(usesCustomEmoji({ text: 'x', entities: [], keyboard: null })).toBe(false);
  });
});

describe('sendWithEmojiFallback', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createTelegramMockServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no TCP address');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const token = (prefix = 'FAKE') => `${100_000_000 + Math.floor(Math.random() * 800_000_000)}:${prefix}_${randomBytes(18).toString('hex')}`;
  const newChat = () => 500_000_000 + Math.floor(Math.random() * 400_000_000);
  const messages = async (chat: number): Promise<MockMessage[]> => ((await (await fetch(`${base}/__mock/messages?chat_id=${chat}`)).json()) as { messages: MockMessage[] }).messages;

  it('a bot that may use Premium emoji sends them as entities and button icons, without any parse mode', async () => {
    const chat = newChat();
    const sent = await sendWithEmojiFallback(new TelegramBotApi(token(), { baseUrl: base }), chat, rich);
    expect(sent).toMatchObject({ fallback: false, photo_file_id: null });
    const [msg, ...rest] = await messages(chat);
    expect(rest).toEqual([]);
    expect(msg).toMatchObject({ message_id: sent.message_id, text: 'Привет 👋', parse_mode: null, entities: rich.entities, reply_markup: rich.keyboard, photo: null });
  });

  it('a bot that may not use them still delivers once: Unicode emoji in the text, buttons without the icon', async () => {
    const chat = newChat();
    const sent = await sendWithEmojiFallback(new TelegramBotApi(token('NOEMOJI'), { baseUrl: base }), chat, rich);
    expect(sent.fallback).toBe(true);
    const [msg, ...rest] = await messages(chat);
    expect(rest).toEqual([]);
    expect(msg!.text).toBe('Привет 👋');
    expect(msg!.entities).toBeNull();
    expect(msg!.reply_markup).toEqual(withoutCustomEmoji(rich).keyboard);
  });

  it('a photo: the text is the caption; the fallback works the same and the stored file_id is returned', async () => {
    const chat = newChat();
    const photo = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
    const sent = await sendWithEmojiFallback(new TelegramBotApi(token('NOEMOJI'), { baseUrl: base }), chat, { ...rich, photo });
    expect(sent.fallback).toBe(true);
    expect(sent.photo_file_id).toMatch(/^mock-photo-/);
    const [msg, ...rest] = await messages(chat);
    expect(rest).toEqual([]);
    expect(msg).toMatchObject({ text: 'Привет 👋', entities: null, photo: { upload_bytes: 4 } });
    // The next recipient gets the same photo by file_id, without an upload.
    const other = newChat();
    await sendWithEmojiFallback(new TelegramBotApi(token(), { baseUrl: base }), other, { ...rich, photo: sent.photo_file_id });
    expect((await messages(other))[0]).toMatchObject({ photo: { file_id: sent.photo_file_id }, entities: rich.entities });
  });

  const failing = (...answers: Array<[status: number, description: string]>) => {
    const fetchImpl = vi.fn(async () => {
      const [status, description] = answers.shift() ?? [500, 'unexpected call'];
      return new Response(JSON.stringify({ ok: false, error_code: status, description }), { status });
    });
    return { fetchImpl, bot: new TelegramBotApi(token(), { baseUrl: 'http://mock.invalid', fetchImpl: fetchImpl as unknown as typeof fetch }) };
  };

  it('only a 400 for a message WITH custom emoji is retried without them; every other error is thrown as it is', async () => {
    // Blocked by the user: no second attempt.
    const blocked = failing([403, 'Forbidden: bot was blocked by the user']);
    await expect(sendWithEmojiFallback(blocked.bot, 1, rich)).rejects.toMatchObject({ code: 'bot_cannot_post', httpStatus: 403 });
    expect(blocked.fetchImpl).toHaveBeenCalledTimes(1);
    // Flood control: no second attempt either (the caller pauses the broadcast).
    const flood = failing([429, 'Too Many Requests: retry after 7']);
    await expect(sendWithEmojiFallback(flood.bot, 1, rich)).rejects.toMatchObject({ code: 'telegram_rate_limited' });
    expect(flood.fetchImpl).toHaveBeenCalledTimes(1);
    // A 400 for a message without custom emoji has another cause.
    const plain = failing([400, 'Bad Request: message is too long']);
    await expect(sendWithEmojiFallback(plain.bot, 1, withoutCustomEmoji(rich))).rejects.toMatchObject({ code: 'telegram_bad_request' });
    expect(plain.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an error of the fallback attempt is thrown (never a third attempt)', async () => {
    const twice = failing([400, 'Bad Request: custom emoji are not available'], [400, 'Bad Request: message is too long']);
    const err = await sendWithEmojiFallback(twice.bot, 1, rich).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BotApiError);
    expect((err as BotApiError).description).toContain('message is too long');
    expect(twice.fetchImpl).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String((twice.fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(second.entities).toBeUndefined();
    expect(JSON.stringify(second.reply_markup)).not.toContain('icon_custom_emoji_id');
  });
});
