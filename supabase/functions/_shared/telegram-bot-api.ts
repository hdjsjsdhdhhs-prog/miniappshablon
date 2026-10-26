// Minimal, runtime-agnostic Telegram Bot API client (Deno Edge Functions and Node tests).
// The bot token is a secret: it is only ever placed in the request URL, and every error/description that
// leaves this module is passed through redactToken() so it cannot end up in logs or HTTP responses.

export const DEFAULT_TELEGRAM_API_BASE = 'https://api.telegram.org';

/** BotFather format: "<bot id>:<35+ char secret>". */
export const BOT_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;
/** "@channelusername" or a numeric chat id ("-1001234567890", "123456"). */
export const CHAT_ID_RE = /^(@[A-Za-z][A-Za-z0-9_]{3,31}|-?\d{1,20})$/;

export type BotApiErrorCode =
  | 'telegram_unauthorized'
  | 'chat_not_found'
  | 'bot_cannot_post'
  | 'telegram_bad_request'
  | 'telegram_rate_limited'
  | 'telegram_unavailable'
  | 'network_error';

export class BotApiError extends Error {
  constructor(
    readonly code: BotApiErrorCode,
    /** Telegram's description with the token removed. Safe to store and show. */
    readonly description: string,
    readonly httpStatus: number,
  ) {
    super(code);
  }

  /** Errors that retrying will not fix (bad token, missing chat, no rights). */
  get permanent(): boolean {
    return this.code === 'telegram_unauthorized' || this.code === 'chat_not_found' || this.code === 'bot_cannot_post';
  }
}

export function isValidBotToken(token: unknown): token is string {
  return typeof token === 'string' && BOT_TOKEN_RE.test(token);
}

/** "123456789:••••AbCd" — the only form of a token that is ever shown. */
export function maskToken(token: string): string {
  const [id = ''] = token.split(':');
  return `${id}:••••${token.slice(-4)}`;
}

/** Removes the token (and its secret part) from arbitrary text. */
export function redactToken(text: string, token: string | null | undefined): string {
  if (!token) return text;
  let out = text.split(token).join('<token>');
  const secret = token.split(':')[1];
  if (secret && secret.length >= 8) out = out.split(secret).join('<token>');
  return out;
}

/**
 * Accepts "@name", "name", "t.me/name", "https://t.me/name" and numeric ids; returns the Bot API chat_id
 * or null. Private invite links (t.me/+…) cannot be addressed by a bot and are rejected.
 */
export function normalizeChatId(input: string): string | null {
  const raw = input.trim();
  if (/^-?\d{1,20}$/.test(raw)) return raw;
  const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{3,31})\/?$/i.exec(raw);
  const name = m ? m[1] : raw.replace(/^@/, '');
  const chat = `@${name}`;
  return CHAT_ID_RE.test(chat) ? chat : null;
}

export interface BotApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
}

export interface TgUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TgChatMember {
  status: 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';
  can_post_messages?: boolean;
  can_send_messages?: boolean;
}

function classify(status: number, description: string): BotApiErrorCode {
  const d = description.toLowerCase();
  if (status === 401 || status === 404) return 'telegram_unauthorized';
  if (status === 429) return 'telegram_rate_limited';
  if (status >= 500) return 'telegram_unavailable';
  if (d.includes('chat not found')) return 'chat_not_found';
  if (status === 403 || d.includes('not enough rights') || d.includes('need administrator rights') || d.includes('bot is not a member')) {
    return 'bot_cannot_post';
  }
  return 'telegram_bad_request';
}

export class TelegramBotApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    options: BotApiOptions = {},
  ) {
    if (!isValidBotToken(token)) throw new BotApiError('telegram_unauthorized', 'invalid token format', 0);
    this.baseUrl = (options.baseUrl || DEFAULT_TELEGRAM_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 8000;
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
    } catch (err) {
      // fetch errors may echo the URL, which contains the token.
      throw new BotApiError('network_error', redactToken(String((err as Error)?.message ?? err), this.token), 0);
    } finally {
      clearTimeout(timer);
    }
    const body = (await res.json().catch(() => null)) as TgResponse<T> | null;
    if (!res.ok || !body?.ok) {
      const description = redactToken(String(body?.description ?? `HTTP ${res.status}`), this.token).slice(0, 200);
      const status = body?.error_code ?? res.status;
      throw new BotApiError(classify(status, description), description, status);
    }
    return body.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call<TgUser>('getMe', {});
  }

  getChat(chatId: string): Promise<TgChat> {
    return this.call<TgChat>('getChat', { chat_id: chatId });
  }

  getChatMember(chatId: string, userId: number): Promise<TgChatMember> {
    return this.call<TgChatMember>('getChatMember', { chat_id: chatId, user_id: userId });
  }

  sendMessage(chatId: string, text: string): Promise<{ message_id: number }> {
    return this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }
}

/** True when the member can publish in the chat (channel: admin with can_post_messages; groups: not muted). */
export function canPost(chat: TgChat, member: TgChatMember): boolean {
  if (member.status === 'left' || member.status === 'kicked') return false;
  if (chat.type === 'channel') {
    return member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages !== false);
  }
  if (member.status === 'restricted') return member.can_send_messages === true;
  return true;
}

/** getMe + getChat + rights check. Throws BotApiError with a stable code. */
export async function verifyConnection(api: TelegramBotApi, chatId: string) {
  const bot = await api.getMe();
  const chat = await api.getChat(chatId);
  const member = await api.getChatMember(chatId, bot.id);
  if (!canPost(chat, member)) {
    throw new BotApiError('bot_cannot_post', 'bot cannot post messages in this chat', 403);
  }
  return { bot, chat };
}
