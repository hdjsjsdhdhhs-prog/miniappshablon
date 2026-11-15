// Welcome message, inline keyboard and URLs of a shop's connected Telegram bot. Pure and runtime-agnostic
// (Deno Edge Functions and Node tests): no I/O, no imports.
//
// Three different Telegram mechanisms are involved and never mixed up:
//   1. the inline keyboard under the /start welcome (buildWelcomeKeyboard) — web_app button + url button;
//   2. the bot's Menu Button (setChatMenuButton, type web_app) — configured by the bot-connection function;
//   3. the Main Mini App / "Launch app" of the bot profile — only configurable in @BotFather, never by the Bot API.

import type { InlineKeyboardMarkup, TgMenuButton } from './telegram-bot-api.ts';

/** Telegram Bot API: 1–4096 characters of message text. */
export const WELCOME_TEXT_MAX = 4096;
export const BUTTON_TEXT_MAX = 64;
export const SHOP_NAME_PLACEHOLDER = '{название_магазина}';

export const DEFAULT_OPEN_BUTTON_TEXT = 'Открыть приложение';
export const DEFAULT_MANAGER_BUTTON_TEXT = 'Связаться с менеджером';
/** Same text as private.bot_welcome_defaults() (checked by the integration tests). */
export const DEFAULT_WELCOME_TEXT =
  'Добро пожаловать в {название_магазина}\n\n' +
  'Нажмите кнопку "Открыть приложение", чтобы просмотреть каталог и ознакомиться с товарами.\n\n' +
  'По вопросам и помощи нажмите кнопку "Связаться с менеджером" ниже.';

export interface WelcomeSettings {
  /** May contain <tg-emoji emoji-id="…">🙂</tg-emoji> tags (Premium emoji, see telegram-rich.ts). */
  welcome_text: string;
  open_button_text: string;
  manager_button_text: string;
  manager_url: string | null;
  /** icon_custom_emoji_id of the buttons (Premium emoji); absent / null: no icon. */
  open_button_emoji_id?: string | null;
  manager_button_emoji_id?: string | null;
}

// Public usernames: 5–32 chars, start with a letter, letters/digits/underscore, no trailing underscore.
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;
const TG_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);
// C0 controls except TAB and LF, DEL and C1 controls; CR is normalised away.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Manager link: `@username`, `t.me/username`, `https://t.me/username` (or telegram.me) → `https://t.me/username`.
 * Anything else — another host, http:, javascript:, data:, invite links, paths, queries — → null.
 */
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

/** Trimmed button text, or null when empty / too long. */
export function normalizeButtonText(input: string | null | undefined): string | null {
  const text = (input ?? '').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  return text.length >= 1 && text.length <= BUTTON_TEXT_MAX ? text : null;
}

/** Welcome template: CRLF → LF, control characters removed. null when empty or longer than the Telegram limit. */
export function normalizeWelcomeText(input: string | null | undefined): string | null {
  const text = (input ?? '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  if (!text.trim() || text.length > WELCOME_TEXT_MAX) return null;
  return text;
}

/**
 * The message sent on /start: `{название_магазина}` → the shop name (plain text, sent without parse_mode, so no
 * HTML / Markdown is interpreted). Never longer than the Telegram limit.
 */
export function renderWelcome(template: string, shopName: string): string {
  return template.split(SHOP_NAME_PLACEHOLDER).join(shopName).slice(0, WELCOME_TEXT_MAX);
}

/**
 * Inline keyboard under the welcome: row 1 — web_app button to the shop's storefront (URL always computed on the
 * server, never stored or editable); row 2 — url button to the manager. Without a manager link only row 1 is sent
 * (the admin shows "Ссылка менеджера не заполнена" until the owner sets it).
 */
export function buildWelcomeKeyboard(input: {
  openButtonText: string;
  storefrontUrl: string;
  managerButtonText: string;
  managerUrl: string | null;
  /** Premium emoji shown before the button text (icon_custom_emoji_id); the text itself may carry a regular emoji. */
  openButtonEmojiId?: string | null;
  managerButtonEmojiId?: string | null;
}): InlineKeyboardMarkup {
  const icon = (id: string | null | undefined) => (id ? { icon_custom_emoji_id: id } : {});
  const rows: InlineKeyboardMarkup['inline_keyboard'] = [
    [{ text: input.openButtonText, web_app: { url: input.storefrontUrl }, ...icon(input.openButtonEmojiId) }],
  ];
  const manager = normalizeManagerUrl(input.managerUrl);
  if (manager) rows.push([{ text: input.managerButtonText, url: manager, ...icon(input.managerButtonEmojiId) }]);
  return { inline_keyboard: rows };
}

export function menuButtonFor(text: string, storefrontUrl: string): TgMenuButton {
  return { type: 'web_app', text, web_app: { url: storefrontUrl } };
}

/** True when the bot's current Menu Button is exactly the one the platform set. */
export function isOurMenuButton(button: TgMenuButton | null | undefined, storefrontUrl: string | null | undefined): boolean {
  return !!button && button.type === 'web_app' && !!storefrontUrl && button.web_app?.url === storefrontUrl;
}

function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || h === '::') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * Public origin of the storefront deployment (server env PUBLIC_APP_URL, e.g. https://miniappdemo.pages.dev).
 * https only, a public host, no path / query / credentials. null when missing or unsafe.
 */
export function normalizePublicAppUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (isPrivateHost(url.hostname)) return null;
  return url.origin;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** Public storefront of a shop: <origin>/s/<slug>/ — the same route as the admin's «Витрина» link. */
export function storefrontUrl(publicAppUrl: string | null | undefined, slug: string): string | null {
  const origin = normalizePublicAppUrl(publicAppUrl);
  if (!origin || !SLUG_RE.test(slug)) return null;
  return `${origin}/s/${slug}/`;
}

/** Webhook endpoint of one connection. The random connection id binds it; the bot token never appears in it. */
export function webhookUrl(functionsBaseUrl: string, connectionId: string): string {
  return `${functionsBaseUrl.replace(/\/+$/, '')}/telegram-webhook?c=${encodeURIComponent(connectionId)}`;
}

/** Host of a webhook URL for display (a foreign URL may carry secrets in its path or query). */
export function webhookHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Telegram secret_token: 1–256 characters A-Z a-z 0-9 _ -. */
export const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

/** 32 random bytes, base64url (43 characters). */
export function generateWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface StartCommand {
  chatId: number;
  /** Text after "/start " (deep-link parameter), if any. The tenant never depends on it. */
  payload: string | null;
}

interface TgUpdateLike {
  update_id?: unknown;
  message?: {
    text?: unknown;
    chat?: { id?: unknown; type?: unknown };
  };
}

/**
 * "/start", "/start <payload>" or "/start@<this bot> …" in a PRIVATE chat; anything else → null.
 * A "/start@other_bot" (addressed to another bot) is ignored.
 */
export function parseStartCommand(update: unknown, botUsername: string): StartCommand | null {
  const msg = (update as TgUpdateLike | null)?.message;
  if (!msg || typeof msg.text !== 'string') return null;
  if (msg.chat?.type !== 'private' || !Number.isSafeInteger(msg.chat.id)) return null;
  const m = /^\/start(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(msg.text.trim());
  if (!m) return null;
  if (m[1] && m[1].toLowerCase() !== botUsername.toLowerCase()) return null;
  const payload = m[2]?.trim() || null;
  return { chatId: msg.chat.id as number, payload: payload ? payload.slice(0, 512) : null };
}

/**
 * What an update says about a user of the bot, in a PRIVATE chat only:
 *   start      /start (the welcome is sent)            stop       /stop (no more broadcasts)
 *   message    any other message of the user           blocked / unblocked   my_chat_member: the user stopped /
 *                                                                           restarted the bot
 * Groups, channels, other bots and everything else → null.
 */
export type PrivateUpdate =
  | { kind: 'start'; userId: number; chatId: number; payload: string | null }
  // "/emoji <Premium emoji…>": the owner asks for the ids of the custom emoji in the message (see emojiIdsReply).
  | { kind: 'emoji'; userId: number; chatId: number; emoji: CustomEmojiRef[] }
  | { kind: 'stop' | 'message' | 'blocked' | 'unblocked'; userId: number; chatId: number };

/** A Premium (custom) emoji found in a message: its id and the regular emoji it covers. */
export interface CustomEmojiRef {
  id: string;
  fallback: string;
}

interface TgPrivateUpdateLike {
  message?: { text?: unknown; entities?: unknown; chat?: { id?: unknown; type?: unknown }; from?: { id?: unknown; is_bot?: unknown } };
  my_chat_member?: { chat?: { id?: unknown; type?: unknown }; new_chat_member?: { status?: unknown } };
}

const isUserId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** At most this many ids are listed in one answer to /emoji. */
const EMOJI_REPLY_MAX = 20;

/** `custom_emoji` entities of a message (Bot API MessageEntity; offsets in UTF-16 code units), without repeats. */
function customEmojiOf(text: string, entities: unknown): CustomEmojiRef[] {
  if (!Array.isArray(entities)) return [];
  const out: CustomEmojiRef[] = [];
  for (const e of entities as Array<{ type?: unknown; offset?: unknown; length?: unknown; custom_emoji_id?: unknown } | null>) {
    if (e?.type !== 'custom_emoji' || typeof e.custom_emoji_id !== 'string' || !/^\d{5,25}$/.test(e.custom_emoji_id)) continue;
    if (!Number.isSafeInteger(e.offset) || !Number.isSafeInteger(e.length) || (e.offset as number) < 0 || (e.length as number) < 1) continue;
    const id = e.custom_emoji_id;
    if (out.some((x) => x.id === id)) continue;
    out.push({ id, fallback: text.slice(e.offset as number, (e.offset as number) + (e.length as number)) });
    if (out.length >= EMOJI_REPLY_MAX) break;
  }
  return out;
}

/**
 * Answer to /emoji (plain text, no parse_mode — the tag below is shown literally): the id of every Premium emoji of
 * the message, ready to be pasted into the welcome / broadcast settings. Ids of custom emoji are public.
 */
export function emojiIdsReply(emoji: CustomEmojiRef[]): string {
  if (emoji.length === 0) {
    return 'Отправьте команду /emoji и нужные Premium Emoji в одном сообщении, например: /emoji 🔥\nВ ответ придут их ID.';
  }
  return [
    'ID Premium Emoji:',
    ...emoji.map((e) => `${e.fallback} — ${e.id}`),
    '',
    'В тексте сообщения: <tg-emoji emoji-id="ID">🙂</tg-emoji>. На кнопке: поле «Premium Emoji ID».',
  ].join('\n');
}

export function parsePrivateUpdate(update: unknown, botUsername: string): PrivateUpdate | null {
  const u = update as TgPrivateUpdateLike | null;
  const member = u?.my_chat_member;
  if (member) {
    if (member.chat?.type !== 'private' || !isUserId(member.chat.id)) return null;
    const status = member.new_chat_member?.status;
    if (status === 'kicked') return { kind: 'blocked', userId: member.chat.id, chatId: member.chat.id };
    if (status === 'member') return { kind: 'unblocked', userId: member.chat.id, chatId: member.chat.id };
    return null;
  }
  const msg = u?.message;
  if (!msg || msg.chat?.type !== 'private' || !isUserId(msg.chat.id) || msg.from?.is_bot === true) return null;
  const chatId = msg.chat.id;
  const userId = isUserId(msg.from?.id) ? msg.from.id : chatId;
  const start = parseStartCommand(update, botUsername);
  if (start) return { kind: 'start', userId, chatId, payload: start.payload };
  if (typeof msg.text === 'string') {
    const mine = (addressee: string | undefined) => !addressee || addressee.toLowerCase() === botUsername.toLowerCase();
    const stop = /^\/stop(?:@([A-Za-z0-9_]{3,64}))?$/.exec(msg.text.trim());
    if (stop && mine(stop[1])) return { kind: 'stop', userId, chatId };
    // Matched on the text as received: the entity offsets refer to it.
    const emoji = /^\/emoji(?:@([A-Za-z0-9_]{3,64}))?(?:\s|$)/.exec(msg.text);
    if (emoji && mine(emoji[1])) return { kind: 'emoji', userId, chatId, emoji: customEmojiOf(msg.text, msg.entities) };
  }
  return { kind: 'message', userId, chatId };
}

/** Answer to /stop. */
export const UNSUBSCRIBED_TEXT = 'Вы отписались от рассылки этого магазина. Чтобы снова получать сообщения, отправьте /start.';
