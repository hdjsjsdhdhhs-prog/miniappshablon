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

async function callAdminFunction<T>(name: 'notification-settings' | 'platform-admin' | 'bot-connection', body: unknown): Promise<T> {
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
  owner_changed: 'Магазин сменил владельца: уведомления прежнего владельца отключены, неотправленные — отменены.',
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

// ---- Shop's own Telegram bot («Подключение бота») ----------------------------------------
// Independent of the notifications above: own Edge Function (bot-connection), own Vault secret, own settings.

export interface BotConnection {
  bot_id: number;
  bot_username: string;
  /** Masked: "123456789:••••AbCd". The token itself is never sent to the browser. */
  token_hint: string;
  status: 'connected' | 'error';
  last_error: string | null;
  /** Storefront URL the platform set as the bot's Menu Button. */
  menu_button_url: string | null;
  connected_at: string;
  updated_at: string;
}

export interface BotWelcome {
  welcome_text: string;
  open_button_text: string;
  manager_button_text: string;
  manager_url: string | null;
  customized: boolean;
  updated_at: string | null;
}

export interface BotView {
  settings: { shop: { id: string; slug: string; name: string }; connection: BotConnection | null; welcome: BotWelcome };
  /** <PUBLIC_APP_URL>/s/<slug>/ computed on the server; null when the platform has no public URL configured. */
  storefront_url: string | null;
}

export interface BotConnectResult extends BotView {
  previous: { bot_username: string; webhook_removed: boolean; menu_reset: boolean; error: string | null } | null;
}

export interface BotWelcomeInput {
  welcomeText: string;
  openButtonText: string;
  managerButtonText: string;
  managerUrl: string;
}

export const botApi = {
  get: (shopId: string) => callAdminFunction<BotView>('bot-connection', { action: 'get', shopId }),
  /** The token is sent once; the response never contains it. */
  connect: (shopId: string, botToken: string, confirmReplaceWebhook = false) =>
    callAdminFunction<BotConnectResult>('bot-connection', { action: 'connect', shopId, botToken, confirmReplaceWebhook }),
  sync: (shopId: string) => callAdminFunction<BotView & { webhook_ok: boolean }>('bot-connection', { action: 'sync', shopId }),
  disconnect: (shopId: string) =>
    callAdminFunction<BotView & { cleanup: { webhook_removed: boolean; menu_reset: boolean; telegram: 'ok' | 'token_revoked' } }>('bot-connection', {
      action: 'disconnect',
      shopId,
    }),
  saveWelcome: (shopId: string, welcome: BotWelcomeInput) =>
    callAdminFunction<BotView & { menu_synced: boolean }>('bot-connection', { action: 'save-welcome', shopId, welcome }),
};

const BOT_ERRORS: Record<string, string> = {
  invalid_token: 'Не удалось подключить бота. Проверьте правильность токена BotFather.',
  telegram_unauthorized: 'Не удалось подключить бота. Проверьте правильность токена BotFather.',
  bot_in_use: 'Этот Telegram-бот уже используется другим магазином платформы.',
  bot_reserved: 'Этого бота нельзя подключить к магазину. Создайте отдельного бота в @BotFather.',
  bot_connect_rate_limited: 'Слишком много попыток подключения. Подождите 15 минут и попробуйте снова.',
  webhook_conflict: 'Этот бот уже подключён к другому сервису.',
  webhook_replaced: 'Бот перестал получать сообщения через платформу: его настройки изменил другой сервис. Нажмите «Переподключить бота».',
  menu_button_failed: 'Telegram не сохранил кнопку меню. Повторите попытку.',
  public_url_not_configured: 'Публичный адрес витрины ещё не настроен на платформе. Обратитесь к администратору платформы.',
  webhook_url_insecure: 'Платформа ещё не готова принимать сообщения ботов. Обратитесь к администратору платформы.',
  not_connected: 'Бот не подключён.',
  invalid_welcome_text: 'Введите текст приветствия.',
  welcome_too_long: 'Приветствие длиннее 4096 символов — так много Telegram не отправит. Сократите текст.',
  invalid_open_button_text: 'Введите текст кнопки открытия приложения (до 64 символов).',
  invalid_manager_button_text: 'Введите текст кнопки связи с менеджером (до 64 символов).',
  invalid_manager_url: 'Укажите Telegram менеджера в виде https://t.me/username или @username.',
  invalid_welcome: 'Проверьте текст приветствия и кнопок.',
  telegram_rate_limited: 'Telegram временно ограничил запросы. Повторите через минуту.',
  telegram_unavailable: 'Telegram сейчас недоступен. Повторите позже.',
  telegram_bad_request: 'Telegram отклонил запрос. Повторите попытку.',
  network_error: 'Нет связи с сервером. Проверьте интернет и повторите.',
  forbidden: 'Подключение бота доступно только владельцу магазина.',
  auth_required: 'Сессия истекла. Войдите снова.',
};

/** Human text for an API error or a stored `last_error` code. Never a technical description. */
export function botErrorText(errorOrCode: unknown): string {
  const code =
    errorOrCode instanceof AdminApiError ? errorOrCode.code : typeof errorOrCode === 'string' ? errorOrCode.split(':')[0]!.trim() : 'unknown_error';
  return BOT_ERRORS[code] ?? 'Не удалось выполнить действие. Повторите попытку.';
}

// ---- Platform administration -------------------------------------------------------------

export interface PlatformMember {
  user_id: string;
  email: string | null;
  role: 'owner' | 'manager';
  since: string;
}

/** Audit row of a DEMO deletion (private.shop_deletions): slug, initiator, times, attempts of the Storage cleanup. */
export interface ShopDeletion {
  slug: string;
  requested_by: string;
  requested_at: string;
  completed_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
}

export interface PlatformShop {
  id: string;
  slug: string;
  name: string;
  mode: 'preview' | 'live';
  /** 'deleting': a DEMO deletion started — the shop is already gone from the storefront, files are being removed. */
  status: 'active' | 'suspended' | 'deleting';
  deletion?: ShopDeletion | null;
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
  /** Hand-over waiting for the client to confirm their e-mail (the shop stays DEMO until then). */
  pending_handover?: PendingHandover | null;
}

export interface PendingHandover {
  user_id: string;
  email: string;
  invitation: 'sent' | 'link';
  created_at: string;
  expires_at: string;
  expired: boolean;
  last_error: string | null;
}

/** Server-side account state (auth.users): only `confirmed` accounts can own a shop. */
export type AccountState = 'confirmed' | 'invited' | 'unconfirmed' | 'blocked' | 'missing';

export interface PlatformUser {
  user_id: string;
  email: string;
  is_platform_admin: boolean;
  state?: AccountState;
  email_confirmed?: boolean;
  shops: Array<{ slug: string; name: string; role: string }>;
}

/** What the ownership change did to the shop's Telegram notifications (always revoked when the owner changes). */
export interface NotificationsReset {
  settings_removed: boolean;
  queued_dropped: number;
}

export interface TransferResult {
  shop: { id: string; slug: string; name: string };
  owner: { user_id: string; email: string };
  removed: Array<{ user_id: string; email: string | null; role: string }>;
  members: PlatformMember[];
  notifications?: NotificationsReset;
  transferred_at: string;
}

export interface CreatedDemoShop {
  shop: { id: string; slug: string; name: string; mode: 'live' | 'preview'; is_demo: boolean };
  media: { copied: number; missing: number };
}

/** Codes of private.shop_handover_problems. */
export type HandoverProblem = 'shop_suspended' | 'not_demo' | 'age_restriction' | 'no_fulfillment' | 'no_categories' | 'no_products';

/**
 * Hand-over operation in progress (atomic reservation, audit S2-06). Left behind only by a crashed request; it
 * expires by itself after its lease. The token is never sent to the browser.
 */
export interface HandoverReservation {
  email: string;
  created_at: string;
  expires_at: string;
  expired: boolean;
  /** Seconds left at the time of the server response (0 once expired). */
  remaining_sec: number;
}

export interface HandoverCheck {
  ready: boolean;
  problems: HandoverProblem[];
  shop: { id: string; slug: string; name: string; mode: string; is_demo: boolean };
  pending_handover?: PendingHandover | null;
  reservation?: HandoverReservation | null;
}

type HandoverShop = { id: string; slug: string; name: string; mode: string; is_demo: boolean };

/** Completed: the client's account is confirmed; they own the shop and it is a regular live shop now. */
export interface HandoverCompleted extends TransferResult {
  status: 'completed';
  shop: HandoverShop;
  invitation: string;
  legacy_test_orders: number;
  cancelled_test_orders?: number;
}

/** Pending: invitation sent; the shop changes hands automatically once the client confirms the e-mail. */
export interface HandoverPending {
  status: 'pending';
  shop: HandoverShop;
  owner: { user_id: string; email: string };
  removed: [];
  members: PlatformMember[];
  invitation: string;
  expires_at: string;
}

export interface HandoverResult {
  handover: HandoverCompleted | HandoverPending;
  /** sent: e-mail invitation sent; link: e-mail could not be sent, pass this one-time link securely; existing: no e-mail needed. */
  invitation: { status: 'sent' | 'link' | 'existing'; link: string | null };
}

/** What "Удалить DEMO" shows before asking for the slug (platform_demo_delete_preview). */
export interface DemoDeletePreview {
  status: 'ready' | 'not_demo' | 'deleting' | 'deleted';
  shop?: { id: string; slug: string; name: string; mode: 'preview' | 'live'; status: string; is_demo: boolean; created_at: string };
  counts?: { products: number; categories: number; variants: number; images: number; media_files: number; orders: number; members: number };
  members?: PlatformMember[];
  has_owner?: boolean;
  notifications?: boolean;
  pending_handover?: PendingHandover | null;
  reservation?: HandoverReservation | null;
  deletion: ShopDeletion | null;
}

/** `deleted` only once every file is gone; `pending`: data deleted and shop blocked, files remain (resume). */
export interface DemoDeleteResult {
  deletion: { status: 'pending' | 'deleted'; remaining?: number; deletion?: ShopDeletion | null };
  storage?: { removed: number; error: string | null };
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
  /** Withdraws a pending hand-over (the invitation link then no longer transfers the shop). */
  cancelHandover: (shopId: string) => callAdminFunction<{ cancelled: boolean }>('platform-admin', { action: 'handover-cancel', shopId }),
  /** Removes an EXPIRED reservation; the server refuses a live one (handover_reservation_active). */
  releaseStaleHandover: (shopId: string) =>
    callAdminFunction<{ released: boolean; email?: string; expired_at?: string }>('platform-admin', { action: 'handover-release-stale', shopId }),
  demoDeletePreview: (shopId: string) =>
    callAdminFunction<{ preview: DemoDeletePreview }>('platform-admin', { action: 'demo-delete-preview', shopId }).then((r) => r.preview),
  /** `confirmSlug` must be exactly the shop's slug; the server compares it and refuses anything but a DEMO shop. */
  demoDelete: (shopId: string, confirmSlug: string) => callAdminFunction<DemoDeleteResult>('platform-admin', { action: 'demo-delete', shopId, confirmSlug }),
  /** Continues an interrupted deletion (Storage cleanup + completion). */
  demoDeleteResume: (shopId: string) => callAdminFunction<DemoDeleteResult>('platform-admin', { action: 'demo-delete-resume', shopId }),
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
