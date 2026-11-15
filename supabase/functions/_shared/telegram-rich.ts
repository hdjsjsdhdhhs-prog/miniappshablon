// Telegram Premium (custom) emoji in bot messages and on inline buttons, with a plain Unicode fallback.
// Runtime-agnostic (Deno Edge Functions and Node tests). Used by the welcome message and by broadcasts only.
//
// Official Bot API (checked 2026-11-13, Bot API 10.4):
//   * text: a `custom_emoji` MessageEntity (custom_emoji_id) over a regular emoji — in HTML parse mode it is written
//     <tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>. The covered emoji is what is shown wherever a custom
//     emoji can not be displayed.
//   * buttons: InlineKeyboardButton.icon_custom_emoji_id — the custom emoji shown before the button text.
//   * both "can only be used by bots that purchased additional usernames on Fragment or in the messages directly sent
//     by the bot to private, group and supergroup chats if the owner of the bot has a Telegram Premium subscription".
//
// What this module does with it:
//   * the owner types the official tag in the message text; parseRichText() turns the tags into plain text + entities
//     (sent WITHOUT parse_mode, so every other `<`, `&` or tag in the text stays literal — no HTML is interpreted);
//   * a bot that is not allowed to use custom emoji still delivers the message: Telegram shows the covered Unicode
//     emoji, and if it rejects the request instead (400), sendWithEmojiFallback() sends it once more without any
//     custom emoji id — text with the Unicode emoji, buttons without the icon.
import { BotApiError, type InlineKeyboardMarkup, type TelegramBotApi, type TgCustomEmojiEntity } from './telegram-bot-api.ts';

/** Custom emoji ids are decimal numbers (64-bit); they are always handled as strings. */
export const CUSTOM_EMOJI_ID_RE = /^\d{5,25}$/;
/** Telegram keeps at most 100 entities of a message. */
export const MAX_CUSTOM_EMOJI = 100;
/** Telegram Bot API: 0–1024 characters of a photo caption. */
export const CAPTION_TEXT_MAX = 1024;

// The fallback is one emoji: a few UTF-16 units, no tag characters, no line break.
const TAG_RE = /<tg-emoji\s+emoji-id="(\d{5,25})"\s*>([^<>\n]{1,16})<\/tg-emoji>/g;

export interface RichText {
  /** What is sent as `text` / `caption`: the tags replaced by their fallback emoji. */
  text: string;
  /** One entity per tag; offsets and lengths in UTF-16 code units, as Telegram counts them. */
  entities: TgCustomEmojiEntity[];
}

/**
 * `…<tg-emoji emoji-id="ID">🙂</tg-emoji>…` → `…🙂…` + a custom_emoji entity over the 🙂. Anything that is not exactly
 * this tag (other ids, empty fallback, nested markup) is left in the text as typed. Surrounding whitespace is removed
 * first — Telegram trims the text, which would otherwise shift the offsets.
 */
export function parseRichText(template: string): RichText {
  const source = template.trim();
  const entities: TgCustomEmojiEntity[] = [];
  let text = '';
  let last = 0;
  for (const m of source.matchAll(TAG_RE)) {
    const fallback = m[2]!;
    if (!fallback.trim()) continue;
    text += source.slice(last, m.index);
    entities.push({ type: 'custom_emoji', offset: text.length, length: fallback.length, custom_emoji_id: m[1]! });
    text += fallback;
    last = m.index + m[0].length;
  }
  text += source.slice(last);
  return { text, entities };
}

/** '' / null → null (no icon); a valid id → the id; anything else → undefined (invalid input). */
export function normalizeEmojiId(input: string | null | undefined): string | null | undefined {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  return CUSTOM_EMOJI_ID_RE.test(raw) ? raw : undefined;
}

export interface OutgoingMessage {
  text: string;
  entities: TgCustomEmojiEntity[];
  keyboard: InlineKeyboardMarkup | null;
  /** A Telegram file_id or the file to upload; absent → a text message. With a photo `text` is the caption. */
  photo?: string | Blob | null;
}

export function usesCustomEmoji(message: OutgoingMessage): boolean {
  return message.entities.length > 0 || !!message.keyboard?.inline_keyboard.some((row) => row.some((b) => !!b.icon_custom_emoji_id));
}

/** The same message with every custom emoji id removed: the text keeps its Unicode emoji, buttons lose the icon. */
export function withoutCustomEmoji(message: OutgoingMessage): OutgoingMessage {
  const keyboard = message.keyboard
    ? {
        inline_keyboard: message.keyboard.inline_keyboard.map((row) =>
          row.map((button) => {
            const plain = { ...button };
            delete plain.icon_custom_emoji_id;
            return plain;
          }),
        ),
      }
    : null;
  return { ...message, entities: [], keyboard };
}

export interface SendResult {
  message_id: number;
  /** file_id of the photo Telegram stored (re-use it for the next recipient instead of uploading again). */
  photo_file_id: string | null;
  /** true: Telegram rejected the custom emoji and the message went out with the Unicode fallback. */
  fallback: boolean;
}

async function sendOnce(bot: TelegramBotApi, chatId: number | string, message: OutgoingMessage): Promise<Omit<SendResult, 'fallback'>> {
  if (message.photo) {
    const sent = await bot.sendPhoto(chatId, {
      photo: message.photo,
      caption: message.text,
      captionEntities: message.entities,
      replyMarkup: message.keyboard,
    });
    const sizes = sent.photo ?? [];
    return { message_id: sent.message_id, photo_file_id: sizes.length ? sizes[sizes.length - 1]!.file_id : null };
  }
  const sent = await bot.sendText(chatId, { text: message.text, entities: message.entities, replyMarkup: message.keyboard });
  return { message_id: sent.message_id, photo_file_id: null };
}

/**
 * Sends the message. When it uses custom emoji and Telegram answers 400 (the bot may not use them, or an id is not a
 * custom emoji), it is sent once more without them. Every other error — and an error of the second attempt — is
 * thrown as usual, so the caller's handling of blocks, flood control and outages does not change.
 */
export async function sendWithEmojiFallback(bot: TelegramBotApi, chatId: number | string, message: OutgoingMessage): Promise<SendResult> {
  try {
    return { ...(await sendOnce(bot, chatId, message)), fallback: false };
  } catch (err) {
    if (!(err instanceof BotApiError) || err.code !== 'telegram_bad_request' || !usesCustomEmoji(message)) throw err;
    return { ...(await sendOnce(bot, chatId, withoutCustomEmoji(message))), fallback: true };
  }
}
