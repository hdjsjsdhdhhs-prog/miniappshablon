// Connection of a shop's own Telegram bot: connect / replace, sync, disconnect, welcome settings, and the /start
// webhook. Runtime-agnostic (Deno Edge Functions and Node tests): the RPC and fetch are injected.
//
// Secrets: the bot token comes from the request (connect) or from Vault through a service-role RPC, is used only for
// Bot API calls (TelegramBotApi redacts it from every error) and is never returned, logged or put into a URL other
// than the Bot API's own. The webhook secret is generated here, given to Telegram once and stored only as SHA-256.
import {
  buildWelcomeKeyboard,
  generateWebhookSecret,
  isOurMenuButton,
  menuButtonFor,
  normalizeButtonText,
  normalizeManagerUrl,
  normalizeWelcomeText,
  parseStartCommand,
  renderWelcome,
  sha256Hex,
  SHOP_NAME_PLACEHOLDER,
  storefrontUrl,
  WEBHOOK_SECRET_RE,
  WELCOME_TEXT_MAX,
  webhookHost,
  webhookUrl,
  type WelcomeSettings,
} from './bot-welcome.ts';
import { BotApiError, DEFAULT_TELEGRAM_API_BASE, isValidBotToken, TelegramBotApi, type TgUser } from './telegram-bot-api.ts';

export type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;

export interface BotDeps {
  rpc: Rpc;
  /** Bot API base (TELEGRAM_API_BASE; the local mock in tests). */
  apiBase: string;
  fetchImpl?: typeof fetch;
  /** Raw PUBLIC_APP_URL (storefront origin). */
  publicAppUrl: string | null | undefined;
  /** `<SUPABASE_URL>/functions/v1` — where the telegram-webhook function is served. */
  functionsBaseUrl: string;
  /** Bot id of the platform's own TELEGRAM_BOT_TOKEN: that bot can never be connected to a shop. */
  platformBotId?: number | null;
  newConnectionId?: () => string;
  newWebhookSecret?: () => string;
  /** Receives only codes and ids — never tokens, secrets or message text. */
  log?: (message: string) => void;
}

/** Error with a stable code for the HTTP layer (status) and the admin UI (code → Russian text). */
export class BotFlowError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly details: Record<string, unknown> | null = null,
  ) {
    super(code);
  }
}

/** P0001 codes of the bot_* RPCs → HTTP status. */
const RPC_STATUS: Record<string, number> = {
  forbidden: 403,
  mfa_required: 403,
  shop_not_found: 404,
  not_connected: 404,
  bot_in_use: 409,
  bot_connect_rate_limited: 429,
  invalid_token: 400,
  invalid_connection: 400,
  invalid_welcome: 400,
};

async function call<T>(deps: BotDeps, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await deps.rpc(fn, args);
  if (error) {
    const status = RPC_STATUS[error.message];
    if (status) throw new BotFlowError(error.message, status);
    deps.log?.(`${fn} failed: ${error.code ?? 'error'}`);
    throw new BotFlowError('internal_error', 500);
  }
  return data as T;
}

function telegramFlowError(err: unknown): BotFlowError {
  if (err instanceof BotFlowError) return err;
  if (err instanceof BotApiError) {
    const status = err.code === 'telegram_unavailable' || err.code === 'network_error' ? 502 : err.code === 'telegram_rate_limited' ? 429 : 400;
    // Only the stable code: Telegram's description may mention third-party data (e.g. a foreign webhook).
    return new BotFlowError(err.code, status);
  }
  return new BotFlowError('internal_error', 500);
}

export interface BotConnectionJson {
  bot_id: number;
  bot_username: string;
  token_hint: string;
  status: 'connected' | 'error';
  last_error: string | null;
  menu_button_url: string | null;
  connected_at: string;
  updated_at: string;
}

export interface BotSettingsJson {
  shop: { id: string; slug: string; name: string };
  connection: BotConnectionJson | null;
  welcome: WelcomeSettings & { customized: boolean; updated_at: string | null };
}

interface Credentials {
  bot_token: string;
  bot_id: number;
  bot_username: string;
  connection_id: string;
  webhook_url: string;
  menu_button_url: string | null;
  menu_button_text: string | null;
}

/** What the owner sees in addition to the settings (never a token, a secret or a foreign URL). */
export interface BotView {
  settings: BotSettingsJson;
  storefront_url: string | null;
  webhook_url_configured: boolean;
}

function api(deps: BotDeps, token: string): TelegramBotApi {
  return new TelegramBotApi(token, { baseUrl: deps.apiBase, fetchImpl: deps.fetchImpl });
}

function requireStorefront(deps: BotDeps, slug: string): string {
  const url = storefrontUrl(deps.publicAppUrl, slug);
  if (!url) throw new BotFlowError('public_url_not_configured', 503);
  return url;
}

/** Real Telegram only accepts HTTPS webhooks; the local mock (tests) accepts the local http Edge Runtime. */
function requireWebhookUrl(deps: BotDeps, connectionId: string): string {
  const url = webhookUrl(deps.functionsBaseUrl, connectionId);
  const realTelegram = deps.apiBase.replace(/\/+$/, '') === DEFAULT_TELEGRAM_API_BASE;
  if (realTelegram && !url.startsWith('https://')) throw new BotFlowError('webhook_url_insecure', 503);
  return url;
}

export function toView(deps: BotDeps, settings: BotSettingsJson): BotView {
  return { settings, storefront_url: storefrontUrl(deps.publicAppUrl, settings.shop.slug), webhook_url_configured: !!deps.functionsBaseUrl };
}

/** Removes only what the platform set on this bot: our webhook URL and our Menu Button. */
export async function cleanupBot(
  bot: TelegramBotApi,
  ours: { webhookUrl: string | null; menuButtonUrl: string | null },
): Promise<{ webhook_removed: boolean; menu_reset: boolean }> {
  let webhookRemoved = false;
  let menuReset = false;
  const info = await bot.getWebhookInfo();
  if (ours.webhookUrl && info.url === ours.webhookUrl) {
    await bot.deleteWebhook();
    webhookRemoved = true;
  }
  const menu = await bot.getChatMenuButton();
  if (isOurMenuButton(menu, ours.menuButtonUrl)) {
    await bot.setChatMenuButton({ type: 'default' });
    menuReset = true;
  }
  return { webhook_removed: webhookRemoved, menu_reset: menuReset };
}

/** Sets the web_app Menu Button and verifies it with getChatMenuButton. */
async function applyMenuButton(bot: TelegramBotApi, text: string, url: string): Promise<void> {
  await bot.setChatMenuButton(menuButtonFor(text, url));
  const check = await bot.getChatMenuButton();
  if (!isOurMenuButton(check, url)) throw new BotFlowError('menu_button_failed', 502);
}

export interface ConnectInput {
  shopId: string;
  actor: string;
  botToken: string;
  /** The owner explicitly confirmed replacing a webhook that is not ours. */
  confirmReplaceWebhook?: boolean;
}

export interface ConnectResult extends BotView {
  /** Cleanup of the previously connected bot when it was replaced by another one. */
  previous: { bot_username: string; webhook_removed: boolean; menu_reset: boolean; error: string | null } | null;
}

/**
 * Connects (or replaces) the shop's bot. Order: verify the new bot (getMe, not the platform bot, not used by another
 * shop, no foreign webhook unless confirmed) → Menu Button (verified) → webhook → atomic DB swap → cleanup of the
 * PREVIOUS bot. The old connection stays active until the new one is fully set up.
 */
export async function connectBot(deps: BotDeps, input: ConnectInput): Promise<ConnectResult> {
  const actor = { p_shop_id: input.shopId, p_actor: input.actor };
  // Rights first (also for a malformed token), then the attempt is counted.
  const current = await call<BotSettingsJson>(deps, 'bot_get_settings', actor);
  const token = input.botToken.trim();
  if (!isValidBotToken(token)) throw new BotFlowError('invalid_token', 400);
  await call(deps, 'bot_register_connect_attempt', actor);

  const storefront = requireStorefront(deps, current.shop.slug);
  const bot = api(deps, token);

  let me: TgUser;
  try {
    me = await bot.getMe();
  } catch (err) {
    throw telegramFlowError(err);
  }
  if (!me.is_bot || !me.username || String(me.id) !== token.split(':')[0]) throw new BotFlowError('telegram_unauthorized', 400);
  if (deps.platformBotId && me.id === deps.platformBotId) throw new BotFlowError('bot_reserved', 409);
  await call(deps, 'bot_assert_available', { ...actor, p_bot_id: me.id });

  const old = current.connection ? await call<Credentials | null>(deps, 'bot_get_credentials', actor) : null;
  const sameBot = !!old && old.bot_id === me.id;

  try {
    const info = await bot.getWebhookInfo();
    const ours = sameBot && info.url === old!.webhook_url;
    if (info.url && !ours && !input.confirmReplaceWebhook) {
      throw new BotFlowError('webhook_conflict', 409, { host: webhookHost(info.url) });
    }

    const connectionId = (deps.newConnectionId ?? (() => crypto.randomUUID()))();
    const secret = (deps.newWebhookSecret ?? generateWebhookSecret)();
    if (!WEBHOOK_SECRET_RE.test(secret)) throw new BotFlowError('internal_error', 500);
    const hookUrl = requireWebhookUrl(deps, connectionId);
    const menuText = current.welcome.open_button_text;

    await applyMenuButton(bot, menuText, storefront);
    await bot.setWebhook({ url: hookUrl, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false });

    let saved: BotSettingsJson;
    try {
      saved = await call<BotSettingsJson>(deps, 'bot_save_connection', {
        ...actor,
        p_bot_token: token,
        p_bot_id: me.id,
        p_bot_username: me.username,
        p_connection_id: connectionId,
        p_webhook_secret_hash: await sha256Hex(secret),
        p_webhook_url: hookUrl,
        p_menu_button_url: storefront,
        p_menu_button_text: menuText,
      });
    } catch (err) {
      // Not saved: undo what was set on a bot that is not the shop's current one (best effort).
      if (!sameBot) await cleanupBot(bot, { webhookUrl: hookUrl, menuButtonUrl: storefront }).catch(() => undefined);
      throw err;
    }

    let previous: ConnectResult['previous'] = null;
    if (old && !sameBot) {
      try {
        const r = await cleanupBot(api(deps, old.bot_token), { webhookUrl: old.webhook_url, menuButtonUrl: old.menu_button_url });
        previous = { bot_username: old.bot_username, ...r, error: null };
      } catch (err) {
        previous = { bot_username: old.bot_username, webhook_removed: false, menu_reset: false, error: telegramFlowError(err).code };
      }
    }
    return { ...toView(deps, saved), previous };
  } catch (err) {
    throw telegramFlowError(err);
  }
}

export async function getBot(deps: BotDeps, shopId: string, actorId: string): Promise<BotView> {
  return toView(deps, await call<BotSettingsJson>(deps, 'bot_get_settings', { p_shop_id: shopId, p_actor: actorId }));
}

export interface SyncResult extends BotView {
  /** false: the bot's webhook was changed outside the platform (e.g. another service) — /start is not answered. */
  webhook_ok: boolean;
}

/** Re-applies the Menu Button (current storefront URL and button text) and checks that the webhook is still ours. */
export async function syncBot(deps: BotDeps, shopId: string, actorId: string): Promise<SyncResult> {
  const actor = { p_shop_id: shopId, p_actor: actorId };
  const settings = await call<BotSettingsJson>(deps, 'bot_get_settings', actor);
  const creds = await call<Credentials | null>(deps, 'bot_get_credentials', actor);
  if (!settings.connection || !creds) throw new BotFlowError('not_connected', 404);
  const storefront = requireStorefront(deps, settings.shop.slug);
  const text = settings.welcome.open_button_text;
  const bot = api(deps, creds.bot_token);
  try {
    await applyMenuButton(bot, text, storefront);
    const info = await bot.getWebhookInfo();
    const webhookOk = info.url === creds.webhook_url;
    const saved = await call<BotSettingsJson>(deps, 'bot_record_sync', {
      ...actor,
      p_ok: webhookOk,
      p_error: webhookOk ? null : 'webhook_replaced',
      p_menu_button_url: storefront,
      p_menu_button_text: text,
    });
    return { ...toView(deps, saved), webhook_ok: webhookOk };
  } catch (err) {
    const flow = telegramFlowError(err);
    // A Telegram-side failure is shown to the owner as the connection status.
    if (err instanceof BotApiError || flow.code === 'menu_button_failed') {
      await call(deps, 'bot_record_sync', { ...actor, p_ok: false, p_error: flow.code, p_menu_button_url: null, p_menu_button_text: null }).catch(() => undefined);
    }
    throw flow;
  }
}

export interface DisconnectResult extends BotView {
  cleanup: { webhook_removed: boolean; menu_reset: boolean; telegram: 'ok' | 'token_revoked' };
}

/**
 * Removes the connection. In Telegram only OUR webhook and OUR Menu Button are removed (a foreign webhook or a
 * button set by someone else is left alone). A revoked token cannot clean up anything; the connection is removed
 * anyway. Notifications, the shop and the welcome settings are not touched.
 */
export async function disconnectBot(deps: BotDeps, shopId: string, actorId: string): Promise<DisconnectResult> {
  const actor = { p_shop_id: shopId, p_actor: actorId };
  const creds = await call<Credentials | null>(deps, 'bot_get_credentials', actor);
  if (!creds) throw new BotFlowError('not_connected', 404);
  let cleanup: DisconnectResult['cleanup'];
  try {
    cleanup = { ...(await cleanupBot(api(deps, creds.bot_token), { webhookUrl: creds.webhook_url, menuButtonUrl: creds.menu_button_url })), telegram: 'ok' };
  } catch (err) {
    if (!(err instanceof BotApiError && err.code === 'telegram_unauthorized')) throw telegramFlowError(err);
    cleanup = { webhook_removed: false, menu_reset: false, telegram: 'token_revoked' };
  }
  const saved = await call<BotSettingsJson>(deps, 'bot_delete_connection', { ...actor, p_connection_id: creds.connection_id });
  return { ...toView(deps, saved), cleanup };
}

export interface WelcomeInput {
  welcomeText: string;
  openButtonText: string;
  managerButtonText: string;
  /** Empty: no manager link yet. */
  managerUrl: string;
}

/** Validates and saves the welcome settings; a changed button-1 text is re-applied to the Menu Button too. */
export async function saveWelcome(deps: BotDeps, shopId: string, actorId: string, input: WelcomeInput): Promise<BotView & { menu_synced: boolean }> {
  const actor = { p_shop_id: shopId, p_actor: actorId };
  const current = await call<BotSettingsJson>(deps, 'bot_get_settings', actor);
  const welcome = normalizeWelcomeText(input.welcomeText);
  if (!welcome) throw new BotFlowError('invalid_welcome_text', 400);
  // The limit applies to the message actually sent (after the shop name is substituted).
  if (welcome.split(SHOP_NAME_PLACEHOLDER).join(current.shop.name).length > WELCOME_TEXT_MAX) throw new BotFlowError('welcome_too_long', 400);
  const openText = normalizeButtonText(input.openButtonText);
  if (!openText) throw new BotFlowError('invalid_open_button_text', 400);
  const managerText = normalizeButtonText(input.managerButtonText);
  if (!managerText) throw new BotFlowError('invalid_manager_button_text', 400);
  const managerRaw = input.managerUrl.trim();
  const managerUrl = managerRaw ? normalizeManagerUrl(managerRaw) : null;
  if (managerRaw && !managerUrl) throw new BotFlowError('invalid_manager_url', 400);

  const saved = await call<BotSettingsJson>(deps, 'bot_save_welcome', {
    ...actor,
    p_welcome_text: welcome,
    p_open_button_text: openText,
    p_manager_button_text: managerText,
    p_manager_url: managerUrl,
  });
  let menuSynced = false;
  if (saved.connection && openText !== current.welcome.open_button_text) {
    try {
      return { ...(await syncBot(deps, shopId, actorId)), menu_synced: true };
    } catch {
      // The welcome is saved; the Menu Button keeps its previous text until the next sync (status shows the error).
      menuSynced = false;
    }
  }
  return { ...toView(deps, saved), menu_synced: menuSynced };
}

// ---------------------------------------------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------------------------------------------

export interface WebhookRequest {
  /** `c` query parameter of the webhook URL. */
  connectionId: string | null;
  /** X-Telegram-Bot-Api-Secret-Token header. */
  secretToken: string | null;
  update: unknown;
}

export interface WebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

interface WebhookContext {
  duplicate: boolean;
  bot_token: string;
  bot_id: number;
  bot_username: string;
  menu_button_url: string | null;
  menu_button_text: string | null;
  shop: { id: string; slug: string; name: string; status: string };
  welcome: WelcomeSettings;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRANSIENT = new Set(['telegram_rate_limited', 'telegram_unavailable', 'network_error']);

/**
 * One Telegram update. 401 for anything that is not proven to come from Telegram for an existing connection (unknown
 * connection and wrong secret answer the same). Each update_id is handled once; a transient Bot API failure releases
 * it and answers 503 so Telegram re-delivers it.
 */
export async function handleWebhookUpdate(deps: BotDeps, req: WebhookRequest): Promise<WebhookResponse> {
  const log = deps.log ?? (() => undefined);
  if (!req.connectionId || !UUID_RE.test(req.connectionId) || !req.secretToken || !WEBHOOK_SECRET_RE.test(req.secretToken)) {
    return { status: 401, body: { ok: false } };
  }
  const updateId = (req.update as { update_id?: unknown } | null)?.update_id;
  if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) return { status: 400, body: { ok: false } };

  const { data, error } = await deps.rpc('bot_webhook_begin', {
    p_connection_id: req.connectionId,
    p_secret_hash: await sha256Hex(req.secretToken),
    p_update_id: updateId,
  });
  if (error) {
    log(`bot_webhook_begin failed: ${error.code ?? 'error'}`);
    return { status: 503, body: { ok: false } };
  }
  const ctx = data as WebhookContext | null;
  if (!ctx) return { status: 401, body: { ok: false } };
  if (ctx.duplicate) return { status: 200, body: { ok: true, duplicate: true } };

  const start = parseStartCommand(req.update, ctx.bot_username);
  if (!start || ctx.shop.status !== 'active') return { status: 200, body: { ok: true, handled: false } };

  const release = async () => {
    await deps.rpc('bot_webhook_release', { p_connection_id: req.connectionId, p_update_id: updateId });
  };
  const storefront = storefrontUrl(deps.publicAppUrl, ctx.shop.slug);
  if (!storefront) {
    log('telegram-webhook: PUBLIC_APP_URL is not configured');
    await release();
    return { status: 503, body: { ok: false } };
  }

  const bot = api(deps, ctx.bot_token);
  const openText = ctx.welcome.open_button_text;
  // The storefront URL (or button 1 text) changed since the last sync: keep the Menu Button current.
  if (ctx.menu_button_url !== storefront || ctx.menu_button_text !== openText) {
    try {
      await bot.setChatMenuButton(menuButtonFor(openText, storefront));
      await deps.rpc('bot_webhook_record_menu', { p_connection_id: req.connectionId, p_menu_button_url: storefront, p_menu_button_text: openText });
    } catch (err) {
      log(`menu button re-sync failed: ${err instanceof BotApiError ? err.code : 'internal'}`);
    }
  }

  try {
    await bot.sendPlainMessage(
      start.chatId,
      renderWelcome(ctx.welcome.welcome_text, ctx.shop.name),
      buildWelcomeKeyboard({
        openButtonText: openText,
        storefrontUrl: storefront,
        managerButtonText: ctx.welcome.manager_button_text,
        managerUrl: ctx.welcome.manager_url,
      }),
    );
  } catch (err) {
    const code = err instanceof BotApiError ? err.code : 'internal';
    log(`welcome not sent: ${code}`);
    if (TRANSIENT.has(code)) {
      await release();
      return { status: 503, body: { ok: false } };
    }
    // Permanent (e.g. the user blocked the bot): re-delivery would not help.
    return { status: 200, body: { ok: true, handled: false } };
  }
  return { status: 200, body: { ok: true, handled: true } };
}
