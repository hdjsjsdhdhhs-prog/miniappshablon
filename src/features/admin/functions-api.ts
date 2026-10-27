import { env } from '@/lib/env';
import { functionsUrl, supabase } from '@/lib/supabase';

/**
 * Admin calls that need server-side secrets or cross-tenant data go through Edge Functions. The browser sends
 * only the signed-in user's access token; the function verifies it and the SQL re-checks the user's rights
 * (shop owner / platform admin). The bot token is sent once when saving and is never returned or stored here.
 */

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: unknown,
  ) {
    super(code);
  }
}

async function callAdminFunction<T>(name: 'notification-settings' | 'platform-admin', body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AdminApiError(401, 'auth_required', null);
  let res: Response;
  try {
    res = await fetch(functionsUrl(name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.supabaseAnonKey, Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AdminApiError(0, 'network_error', null);
  }
  const json = (await res.json().catch(() => null)) as ({ error?: { code: string; details: unknown } } & T) | null;
  if (!res.ok) throw new AdminApiError(res.status, json?.error?.code ?? 'unknown_error', json?.error?.details ?? null);
  return json as T;
}

// ---- Telegram notifications ------------------------------------------------------------

export type NotificationStatus = 'unverified' | 'ok' | 'error';

export interface NotificationSettings {
  configured: boolean;
  enabled: boolean;
  /** Masked: "123456789:••••AbCd". The token itself is never sent to the browser. */
  token_hint: string | null;
  bot_username: string | null;
  chat_id: string | null;
  chat_title: string | null;
  chat_type: string | null;
  status: NotificationStatus;
  last_error: string | null;
  last_checked_at: string | null;
  updated_at: string | null;
  queue: { pending: number; sent: number; dead: number };
}

type SettingsResponse = { settings: NotificationSettings };

export const notificationsApi = {
  get: (shopId: string) => callAdminFunction<SettingsResponse>('notification-settings', { action: 'get', shopId }).then((r) => r.settings),
  /** botToken omitted → the stored token is kept (only the chat changes). */
  save: (shopId: string, input: { botToken?: string; chatId: string }) =>
    callAdminFunction<SettingsResponse>('notification-settings', { action: 'save', shopId, ...input }).then((r) => r.settings),
  /** Sends a test message. With botToken/chatId: checks unsaved values; without: the stored connection. */
  check: (shopId: string, input: { botToken?: string; chatId?: string } = {}) =>
    callAdminFunction<{ ok: true; bot: { username: string | null }; chat: { title: string | null; type: string }; settings: NotificationSettings }>(
      'notification-settings',
      { action: 'check', shopId, ...input },
    ),
  setEnabled: (shopId: string, enabled: boolean) =>
    callAdminFunction<SettingsResponse>('notification-settings', { action: enabled ? 'enable' : 'disable', shopId }).then((r) => r.settings),
  remove: (shopId: string) => callAdminFunction<SettingsResponse>('notification-settings', { action: 'delete', shopId }).then((r) => r.settings),
  retry: (shopId: string) =>
    callAdminFunction<{ retried: number; sent: number; failed: number; settings: NotificationSettings | null }>('notification-settings', {
      action: 'retry',
      shopId,
    }),
};

const NOTIFICATION_ERRORS: Record<string, string> = {
  invalid_token: 'Неверный формат токена. Скопируйте токен из @BotFather целиком (вида 123456789:AA…).',
  invalid_chat: 'Укажите @username канала или группы либо числовой chat ID (например, -1001234567890).',
  token_required: 'Укажите токен бота.',
  telegram_unauthorized: 'Telegram не принял токен: бот не найден или токен отозван в @BotFather.',
  chat_not_found: 'Чат не найден. Проверьте @username или ID и что бот добавлен в эту группу или канал.',
  bot_cannot_post: 'Бот не может отправлять сообщения в этот чат. Добавьте его администратором с правом публикации сообщений.',
  telegram_bad_request: 'Telegram отклонил запрос. Проверьте настройки чата.',
  telegram_rate_limited: 'Telegram временно ограничил запросы. Повторите через минуту.',
  telegram_unavailable: 'Telegram сейчас недоступен. Повторите позже.',
  network_error: 'Нет связи с сервером. Проверьте интернет и повторите.',
  forbidden: 'Настройки уведомлений доступны только владельцу магазина.',
  not_configured: 'Уведомления ещё не настроены.',
  auth_required: 'Сессия истекла. Войдите снова.',
  notifications_disabled: 'Уведомления были выключены.',
  notifications_removed: 'Настройки уведомлений были удалены.',
};

/** Human text for an API error or a stored `last_error` ("code: description"). */
export function notificationErrorText(errorOrCode: unknown): string {
  const code =
    errorOrCode instanceof AdminApiError
      ? errorOrCode.code
      : typeof errorOrCode === 'string'
        ? errorOrCode.split(':')[0]!.trim()
        : 'unknown_error';
  return NOTIFICATION_ERRORS[code] ?? 'Не удалось выполнить действие. Повторите попытку.';
}

// ---- Platform administration -------------------------------------------------------------

export interface PlatformMember {
  user_id: string;
  email: string | null;
  role: 'owner' | 'manager';
  since: string;
}

export interface PlatformShop {
  id: string;
  slug: string;
  name: string;
  mode: 'preview' | 'live';
  status: 'active' | 'suspended';
  is_demo: boolean;
  logo_path: string | null;
  delivery_enabled: boolean;
  pickup_enabled: boolean;
  created_at: string;
  published_at: string | null;
  last_transfer_at: string | null;
  last_handover_at: string | null;
  members: PlatformMember[];
  notifications: { enabled: boolean; status: NotificationStatus } | null;
}

export interface PlatformUser {
  user_id: string;
  email: string;
  is_platform_admin: boolean;
  shops: Array<{ slug: string; name: string; role: string }>;
}

export interface TransferResult {
  shop: { id: string; slug: string; name: string };
  owner: { user_id: string; email: string };
  removed: Array<{ user_id: string; email: string | null; role: string }>;
  members: PlatformMember[];
  transferred_at: string;
}

export interface CreatedDemoShop {
  shop: { id: string; slug: string; name: string; mode: 'live' | 'preview'; is_demo: boolean };
  media: { copied: number; missing: number };
}

/** Codes of private.shop_handover_problems. */
export type HandoverProblem = 'shop_suspended' | 'not_demo' | 'age_restriction' | 'no_fulfillment' | 'no_categories' | 'no_products';

export interface HandoverCheck {
  ready: boolean;
  problems: HandoverProblem[];
  shop: { id: string; slug: string; name: string; mode: string; is_demo: boolean };
}

export interface HandoverResult {
  handover: TransferResult & { shop: { id: string; slug: string; name: string; mode: string; is_demo: boolean }; invitation: string; legacy_test_orders: number };
  /** sent: e-mail invitation sent; link: e-mail could not be sent, pass this one-time link securely; existing: no e-mail needed. */
  invitation: { status: 'sent' | 'link' | 'existing'; link: string | null };
}

export const platformApi = {
  list: () => callAdminFunction<{ shops: PlatformShop[] }>('platform-admin', { action: 'list' }).then((r) => r.shops),
  findUser: (email: string) => callAdminFunction<{ user: PlatformUser | null }>('platform-admin', { action: 'find-user', email }).then((r) => r.user),
  transfer: (shopId: string, userId: string) =>
    callAdminFunction<{ transfer: TransferResult }>('platform-admin', { action: 'transfer', shopId, userId }).then((r) => r.transfer),
  createDemo: (input: { templateId: string; slug: string; name: string }) =>
    callAdminFunction<CreatedDemoShop>('platform-admin', { action: 'create-demo', ...input }),
  handoverCheck: (shopId: string) =>
    callAdminFunction<{ check: HandoverCheck }>('platform-admin', { action: 'handover-check', shopId }).then((r) => r.check),
  /** The invitation leads the client to /admin/set-password on this same app. */
  handover: (shopId: string, email: string) =>
    callAdminFunction<HandoverResult>('platform-admin', {
      action: 'handover',
      shopId,
      email,
      redirectTo: `${window.location.origin}/admin/set-password`,
    }),
};

/** Public storefront link of a shop on the current deployment (https://miniappdemo.pages.dev/s/<slug>/ in production). */
export function publicShopUrl(slug: string, origin: string = window.location.origin): string {
  return `${origin.replace(/\/+$/, '')}/s/${slug}/`;
}

/**
 * Whether to SHOW the platform section. Purely cosmetic: RLS lets a user read only their own
 * platform_admins row, and every platform action is re-checked on the server.
 */
export async function fetchIsPlatformAdmin(): Promise<boolean> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return false;
  const { data, error } = await supabase.from('platform_admins').select('user_id').eq('user_id', auth.user.id).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data);
}
