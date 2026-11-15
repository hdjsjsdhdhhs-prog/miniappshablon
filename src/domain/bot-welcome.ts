/**
 * Browser side of the welcome settings of a shop's own Telegram bot (tab «Подключение бота»): validation hints and the
 * Telegram-style preview. The server (supabase/functions/_shared/bot-welcome.ts) is the authority and re-validates
 * everything; both implementations are checked against each other in bot-welcome.test.ts.
 */

export const WELCOME_TEXT_MAX = 4096;
export const BUTTON_TEXT_MAX = 64;
export const SHOP_NAME_PLACEHOLDER = '{название_магазина}';

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;
const TG_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);

/** `@username`, `t.me/username`, `https://t.me/username` → `https://t.me/username`; anything else → null. */
export function normalizeManagerUrl(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw || raw.length > 200) return null;
  if (raw.startsWith('@')) {
    const name = raw.slice(1);
    return USERNAME_RE.test(name) ? `https://t.me/${name}` : null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !TG_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || !USERNAME_RE.test(parts[0]!)) return null;
  return `https://t.me/${parts[0]}`;
}

/** The text a buyer receives (the shop name substituted). */
export function renderWelcome(template: string, shopName: string): string {
  return template.split(SHOP_NAME_PLACEHOLDER).join(shopName);
}

// ---- Premium (custom) emoji ---------------------------------------------------------------------------------------
// Written in a message text as the official Telegram tag <tg-emoji emoji-id="ID">🙂</tg-emoji>; on a button — as its
// icon_custom_emoji_id. Same rules as supabase/functions/_shared/telegram-rich.ts (checked in telegram-rich.test.ts).

/** Telegram Bot API: 0–1024 characters of a photo caption. */
export const CAPTION_TEXT_MAX = 1024;
export const CUSTOM_EMOJI_ID_RE = /^\d{5,25}$/;
const TAG_RE = /<tg-emoji\s+emoji-id="(\d{5,25})"\s*>([^<>\n]{1,16})<\/tg-emoji>/g;

/** '' is fine (no icon); otherwise the id must be a number as Telegram gives it. */
export function isEmojiIdInput(input: string): boolean {
  const raw = input.trim();
  return raw === '' || CUSTOM_EMOJI_ID_RE.test(raw);
}

/** `value` with `insert` at the caret of a text field (replacing its selection), or appended when there is no caret. */
export function insertAtCaret(field: { selectionStart: number | null; selectionEnd: number | null } | null, value: string, insert: string): string {
  if (!field || typeof field.selectionStart !== 'number') return value + insert;
  const start = Math.min(field.selectionStart, value.length);
  const end = Math.min(field.selectionEnd ?? start, value.length);
  return value.slice(0, start) + insert + value.slice(end);
}

/** The tag to put into a message text. */
export function tgEmojiTag(emojiId: string, fallback: string): string {
  return `<tg-emoji emoji-id="${emojiId.trim()}">${fallback.trim()}</tg-emoji>`;
}

export interface RichSegment {
  text: string;
  /** Set for a Premium emoji: `text` is its regular fallback emoji. */
  emojiId?: string;
}

/** A message text split into plain parts and Premium emoji, for the preview. */
export function richSegments(template: string): RichSegment[] {
  const source = template.trim();
  const out: RichSegment[] = [];
  let last = 0;
  for (const m of source.matchAll(TAG_RE)) {
    if (!m[2]!.trim()) continue;
    if (m.index > last) out.push({ text: source.slice(last, m.index) });
    out.push({ text: m[2]!, emojiId: m[1]! });
    last = m.index + m[0].length;
  }
  if (last < source.length) out.push({ text: source.slice(last) });
  return out;
}

/** The text as Telegram sends and counts it: every tag reduced to its fallback emoji. */
export function richPlainText(template: string): string {
  return richSegments(template)
    .map((s) => s.text)
    .join('');
}
