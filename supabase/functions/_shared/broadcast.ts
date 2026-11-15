// «Рассылка»: a message (text, optional photo, optional Mini App button) to everyone who started the shop's OWN bot.
// Runtime-agnostic (Deno Edge Functions and Node tests): the RPC, fetch, the photo loader and the clock are injected.
//
// Who receives it is decided ONLY in SQL (broadcast_start): the subscribers of the shop's connected bot that are
// still active. Nothing in a request can add a chat id, and the platform bot is never used.
//
// Queue and delivery:
//   * broadcast_start snapshots the audience into private.broadcast_recipients (one row per user and broadcast);
//   * a worker step (runBroadcast) takes a lease, claims a small batch, sends it one message at a time with a minimum
//     interval (Telegram allows about 30 messages per second to different users; we stay below it) and reports every
//     outcome; it runs for a few seconds and is called again by the admin page until nothing is left;
//   * Telegram flood control (429) pauses the WHOLE broadcast for retry_after seconds; the messages not attempted go
//     back to the queue without counting an attempt;
//   * a transient failure (5xx, network) is retried with backoff, at most 3 attempts; a 403 marks the user as blocked
//     and is never retried; a send whose outcome is unknown (the worker died) is not repeated automatically.
import { api, BotFlowError, call, requireStorefront, type BotDeps } from './bot-connection.ts';
import {
  normalizeButtonText,
  normalizeWelcomeText,
  renderWelcome,
  SHOP_NAME_PLACEHOLDER,
  storefrontUrl,
  WELCOME_TEXT_MAX,
  BUTTON_TEXT_MAX,
} from './bot-welcome.ts';
import { BotApiError, type InlineKeyboardMarkup } from './telegram-bot-api.ts';
import {
  CAPTION_TEXT_MAX,
  MAX_CUSTOM_EMOJI,
  normalizeEmojiId,
  parseRichText,
  sendWithEmojiFallback,
  withoutCustomEmoji,
  type OutgoingMessage,
} from './telegram-rich.ts';

export interface BroadcastDeps extends BotDeps {
  /** Reads a broadcast photo from Storage with the service role (the path was validated by broadcast_start). */
  loadPhoto: (path: string) => Promise<Blob>;
  /** Removes the photos of broadcasts that left the history (best effort). */
  removePhotos?: (paths: string[]) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newWorkerId?: () => string;
}

export interface BroadcastJson {
  id: string;
  status: 'sending' | 'completed' | 'cancelled';
  message_text: string;
  photo_path: string | null;
  button_text: string | null;
  button_emoji_id: string | null;
  total: number;
  counts: { pending: number; sent: number; failed: number; blocked: number; cancelled: number };
  /** Set while Telegram's flood control makes the broadcast wait. */
  resume_at: string | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface BroadcastOverview {
  shop: { id: string; slug: string; name: string };
  bot: { bot_username: string; status: string } | null;
  /** Users of the CURRENT bot only. */
  audience: { active: number; unsubscribed: number; blocked: number };
  active: BroadcastJson | null;
  history: BroadcastJson[];
}

export const BROADCAST_LIMITS = { text: WELCOME_TEXT_MAX, caption: CAPTION_TEXT_MAX, button: BUTTON_TEXT_MAX } as const;

export interface BroadcastView {
  overview: BroadcastOverview;
  /** Where the button leads: <PUBLIC_APP_URL>/s/<slug>/ (null: the platform has no public URL configured). */
  storefront_url: string | null;
  limits: typeof BROADCAST_LIMITS;
}

export type WorkerState = 'send' | 'paused' | 'waiting' | 'busy' | 'done';

export interface BroadcastRunResult extends BroadcastView {
  worker: { state: WorkerState; sent: number };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One worker call sends for about this long, then answers with the progress. */
export const RUN_BUDGET_MS = 8000;
/** Past this a claimed batch is given back instead of sent (its rows are locked for 3 minutes in SQL). */
const HARD_BUDGET_MS = 25000;
const BATCH = 20;
/** ≥ 50 ms between two sends → at most 20 messages per second. */
export const MIN_SEND_INTERVAL_MS = 50;
/** Used when Telegram answers 429 without retry_after. */
const DEFAULT_RETRY_AFTER_SEC = 5;

function view(deps: BotDeps, overview: BroadcastOverview): BroadcastView {
  return { overview, storefront_url: storefrontUrl(deps.publicAppUrl, overview.shop.slug), limits: BROADCAST_LIMITS };
}

export async function getBroadcast(deps: BotDeps, shopId: string, actorId: string): Promise<BroadcastView> {
  return view(deps, await call<BroadcastOverview>(deps, 'broadcast_overview', { p_shop_id: shopId, p_actor: actorId }));
}

/** The message every recipient gets: `{название_магазина}` substituted, <tg-emoji> tags turned into entities. */
export function renderBroadcast(template: string, shopName: string) {
  return parseRichText(renderWelcome(template, shopName));
}

/** One web_app button to the shop's storefront (the URL is computed on the server, never taken from the request). */
export function buildBroadcastKeyboard(buttonText: string | null, emojiId: string | null, storefront: string | null): InlineKeyboardMarkup | null {
  if (!buttonText || !storefront) return null;
  return { inline_keyboard: [[{ text: buttonText, web_app: { url: storefront }, ...(emojiId ? { icon_custom_emoji_id: emojiId } : {}) }]] };
}

export interface StartBroadcastInput {
  shopId: string;
  actor: string;
  /** Chosen by the admin page for this "send": repeating the request never starts a second broadcast. */
  idempotencyKey: string;
  text: string;
  /** Storage path of the uploaded photo (<shop id>/broadcast/<uuid>.jpg), if any. */
  photoPath?: string | null;
  /** null / absent: no button. */
  button?: { text: string; emojiId?: string | null } | null;
}

/** Validates the content and starts the broadcast; the recipients are chosen by broadcast_start. */
export async function startBroadcast(deps: BroadcastDeps, input: StartBroadcastInput): Promise<BroadcastView & { replayed: boolean }> {
  const actor = { p_shop_id: input.shopId, p_actor: input.actor };
  const overview = await call<BroadcastOverview>(deps, 'broadcast_overview', actor);
  if (!overview.bot) throw new BotFlowError('not_connected', 404);
  if (!UUID_RE.test(input.idempotencyKey)) throw new BotFlowError('invalid_broadcast', 400);

  const text = normalizeWelcomeText(input.text);
  if (!text) throw new BotFlowError('invalid_broadcast_text', 400);
  const photo = input.photoPath?.trim() || null;
  // The limits apply to the message as sent: the shop name substituted, every <tg-emoji> tag reduced to its emoji.
  // Not renderBroadcast(): it cuts the text at Telegram's limit, which would start a broadcast with a silently
  // truncated message (possibly in the middle of a tag) instead of refusing it.
  const rendered = parseRichText(text.split(SHOP_NAME_PLACEHOLDER).join(overview.shop.name));
  const max = photo ? CAPTION_TEXT_MAX : WELCOME_TEXT_MAX;
  if (!rendered.text) throw new BotFlowError('invalid_broadcast_text', 400);
  if (rendered.text.length > max) throw new BotFlowError('broadcast_too_long', 400, { max });
  if (rendered.entities.length > MAX_CUSTOM_EMOJI) throw new BotFlowError('too_many_custom_emoji', 400, { max: MAX_CUSTOM_EMOJI });

  let buttonText: string | null = null;
  let buttonEmoji: string | null = null;
  if (input.button) {
    buttonText = normalizeButtonText(input.button.text);
    if (!buttonText) throw new BotFlowError('invalid_broadcast_button', 400);
    const emoji = normalizeEmojiId(input.button.emojiId);
    if (emoji === undefined) throw new BotFlowError('invalid_emoji_id', 400);
    buttonEmoji = emoji;
    // The button opens the storefront: without a public URL it could lead nowhere.
    requireStorefront(deps, overview.shop.slug);
  }

  const started = await call<{ replayed: boolean; broadcast: BroadcastJson; pruned_photos: string[] }>(deps, 'broadcast_start', {
    ...actor,
    p_idempotency_key: input.idempotencyKey,
    p_message_text: text,
    p_photo_path: photo,
    p_button_text: buttonText,
    p_button_emoji_id: buttonEmoji,
  });
  if (started.pruned_photos?.length && deps.removePhotos) {
    await Promise.resolve(deps.removePhotos(started.pruned_photos)).catch(() => deps.log?.('broadcast: old photos not removed'));
  }
  return { ...(await getBroadcast(deps, input.shopId, input.actor)), replayed: started.replayed };
}

interface Claim {
  state: WorkerState;
  bot_token?: string;
  shop?: { slug: string; name: string };
  broadcast?: {
    id: string;
    message_text: string;
    photo_path: string | null;
    photo_file_id: string | null;
    button_text: string | null;
    button_emoji_id: string | null;
  };
  recipients?: Array<{ tg_user_id: number; chat_id: number; attempt: number }>;
}

type Outcome = 'sent' | 'blocked' | 'failed' | 'retry' | 'release';
interface Result {
  tg_user_id: number;
  outcome: Outcome;
  message_id?: number;
  error?: string;
}

type Failure =
  | { kind: 'flood'; retryAfter: number }
  | { kind: 'fatal'; error: string }
  | { kind: 'blocked' | 'failed' | 'retry'; error: string };

function classify(err: unknown): Failure {
  if (!(err instanceof BotApiError)) return { kind: 'retry', error: 'internal' };
  if (err.code === 'telegram_rate_limited') return { kind: 'flood', retryAfter: err.retryAfter ?? DEFAULT_RETRY_AFTER_SEC };
  // The token was revoked: no recipient can be reached, the broadcast stops.
  if (err.code === 'telegram_unauthorized') return { kind: 'fatal', error: err.code };
  if (err.recipientGone) return { kind: 'blocked', error: `${err.code}: ${err.description}` };
  if (err.code === 'telegram_unavailable' || err.code === 'network_error') return { kind: 'retry', error: err.code };
  return { kind: 'failed', error: `${err.code}: ${err.description}` };
}

/**
 * One worker step for the shop's running broadcast: sends for about `budgetMs`, then returns the progress. Safe to
 * call as often as wanted and from several tabs — the SQL lease lets one worker send at a time.
 */
export async function runBroadcast(deps: BroadcastDeps, shopId: string, actorId: string, budgetMs: number = RUN_BUDGET_MS): Promise<BroadcastRunResult> {
  const actor = { p_shop_id: shopId, p_actor: actorId };
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => undefined);
  const overview = await call<BroadcastOverview>(deps, 'broadcast_overview', actor);
  if (!overview.active) return { ...view(deps, overview), worker: { state: 'done', sent: 0 } };

  const broadcastId = overview.active.id;
  const workerId = (deps.newWorkerId ?? (() => crypto.randomUUID()))();
  const startedAt = now();
  let state: WorkerState = 'send';
  let sentCount = 0;
  let lastSendAt = 0;
  // Once Telegram refused the custom emoji, the rest of this run goes out with the Unicode fallback right away.
  let plainOnly = false;
  let photoBlob: Blob | null = null;

  while (now() - startedAt < budgetMs) {
    const claim = await call<Claim>(deps, 'broadcast_claim', { ...actor, p_broadcast_id: broadcastId, p_worker_id: workerId, p_limit: BATCH });
    state = claim.state;
    if (claim.state !== 'send' || !claim.broadcast || !claim.bot_token || !claim.recipients) break;

    const bot = api(deps, claim.bot_token);
    const rich = renderBroadcast(claim.broadcast.message_text, claim.shop?.name ?? overview.shop.name);
    const keyboard = buildBroadcastKeyboard(
      claim.broadcast.button_text,
      claim.broadcast.button_emoji_id,
      storefrontUrl(deps.publicAppUrl, claim.shop?.slug ?? overview.shop.slug),
    );
    const base: OutgoingMessage = { text: rich.text, entities: rich.entities, keyboard };
    let fileId = claim.broadcast.photo_file_id;
    const results: Result[] = [];
    let retryAfter: number | null = null;
    let fatal: string | null = null;

    for (const recipient of claim.recipients) {
      if (retryAfter !== null || fatal !== null || now() - startedAt > HARD_BUDGET_MS) {
        results.push({ tg_user_id: recipient.tg_user_id, outcome: 'release' });
        continue;
      }
      const wait = MIN_SEND_INTERVAL_MS - (now() - lastSendAt);
      if (wait > 0) await sleep(wait);
      lastSendAt = now();
      try {
        let photo: string | Blob | null = null;
        if (claim.broadcast.photo_path) {
          if (fileId) photo = fileId;
          else photo = photoBlob ??= await deps.loadPhoto(claim.broadcast.photo_path);
        }
        const message: OutgoingMessage = { ...(plainOnly ? withoutCustomEmoji(base) : base), photo };
        const sent = await sendWithEmojiFallback(bot, recipient.chat_id, message);
        if (sent.fallback) plainOnly = true;
        if (sent.photo_file_id) fileId = sent.photo_file_id;
        results.push({ tg_user_id: recipient.tg_user_id, outcome: 'sent', message_id: sent.message_id });
        sentCount += 1;
      } catch (err) {
        const failure = classify(err);
        if (failure.kind === 'flood') {
          retryAfter = failure.retryAfter;
          results.push({ tg_user_id: recipient.tg_user_id, outcome: 'release' });
        } else if (failure.kind === 'fatal') {
          fatal = failure.error;
          results.push({ tg_user_id: recipient.tg_user_id, outcome: 'release' });
        } else {
          results.push({ tg_user_id: recipient.tg_user_id, outcome: failure.kind, error: failure.error.slice(0, 300) });
        }
        log(`broadcast ${broadcastId}: send failed (${failure.kind})`);
      }
    }

    await call(deps, 'broadcast_report', {
      p_broadcast_id: broadcastId,
      p_worker_id: workerId,
      p_results: results,
      p_retry_after: retryAfter,
      p_photo_file_id: fileId && fileId !== claim.broadcast.photo_file_id ? fileId : null,
    });
    if (fatal !== null) {
      await call(deps, 'broadcast_cancel', { ...actor, p_broadcast_id: broadcastId, p_reason: fatal });
      state = 'done';
      break;
    }
    if (retryAfter !== null) {
      state = 'paused';
      break;
    }
  }
  return { ...(await getBroadcast(deps, shopId, actorId)), worker: { state, sent: sentCount } };
}

export async function cancelBroadcast(deps: BotDeps, shopId: string, actorId: string, broadcastId: string): Promise<BroadcastView> {
  await call(deps, 'broadcast_cancel', { p_shop_id: shopId, p_actor: actorId, p_broadcast_id: broadcastId, p_reason: null });
  return getBroadcast(deps, shopId, actorId);
}

/** Puts the failed sends of a recent broadcast back into the queue (never the blocked users). */
export async function retryBroadcast(deps: BotDeps, shopId: string, actorId: string, broadcastId: string): Promise<BroadcastView & { retried: number }> {
  const res = await call<{ retried: number }>(deps, 'broadcast_retry_failed', { p_shop_id: shopId, p_actor: actorId, p_broadcast_id: broadcastId });
  return { ...(await getBroadcast(deps, shopId, actorId)), retried: res.retried };
}
