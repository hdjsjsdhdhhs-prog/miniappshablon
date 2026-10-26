// POST /functions/v1/notification-settings
// Telegram order-notification settings of one shop, for its owner (or a platform admin).
// Body: { action: 'get' | 'save' | 'check' | 'enable' | 'disable' | 'delete' | 'retry', shopId, botToken?, chatId? }
//
// The bot token is accepted here, verified against the Bot API and stored in Supabase Vault through a
// service-role RPC. It is never returned (only a masked hint) and never logged.
import { z } from 'npm:zod@4.6.7';
import { RPC_ERRORS, telegramApiBase, verifyAdminUser } from '../_shared/admin-auth.ts';
import { serviceClient } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json } from '../_shared/http.ts';
import { dispatchNotifications } from '../_shared/notify-dispatch.ts';
import { formatTestMessage } from '../_shared/order-notification.ts';
import { BotApiError, isValidBotToken, normalizeChatId, TelegramBotApi, verifyConnection } from '../_shared/telegram-bot-api.ts';

const bodySchema = z.object({
  action: z.enum(['get', 'save', 'check', 'enable', 'disable', 'delete', 'retry']),
  shopId: z.uuid(),
  botToken: z.string().trim().max(100).optional(),
  chatId: z.string().trim().max(100).optional(),
});

type Db = ReturnType<typeof serviceClient>;

async function rpc(db: Db, req: Request, fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const status = RPC_ERRORS[error.message];
    if (status) return { ok: false as const, response: errorResponse(req, status, error.message) };
    console.error(`${fn} failed`, error.code ?? '', error.message);
    return { ok: false as const, response: errorResponse(req, 500, 'internal_error') };
  }
  return { ok: true as const, data };
}

function telegramError(req: Request, err: unknown): Response {
  if (err instanceof BotApiError) {
    const status = err.code === 'telegram_unavailable' || err.code === 'network_error' ? 502 : 400;
    return errorResponse(req, status, err.code, { description: err.description });
  }
  console.error('telegram check failed', (err as Error)?.name ?? 'error');
  return errorResponse(req, 500, 'internal_error');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return errorResponse(req, 405, 'method_not_allowed');

  const auth = await verifyAdminUser(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return errorResponse(req, 400, 'invalid_body');
  }

  const db = serviceClient();
  const actor = { p_shop_id: body.shopId, p_actor: auth.userId };
  const apiBase = telegramApiBase();

  // Rights first: every action (even a dry-run check with a new token) requires owner / platform admin.
  const current = await rpc(db, req, 'notify_get_settings', actor);
  if (!current.ok) return current.response;

  switch (body.action) {
    case 'get':
      return json(req, 200, { settings: current.data });

    case 'save': {
      const token = body.botToken ? body.botToken : null;
      if (token !== null && !isValidBotToken(token)) return errorResponse(req, 400, 'invalid_token');
      const chatId = normalizeChatId(body.chatId ?? '');
      if (!chatId) return errorResponse(req, 400, 'invalid_chat');

      let tokenForCheck = token;
      if (!tokenForCheck) {
        const creds = await rpc(db, req, 'notify_get_credentials', actor);
        if (!creds.ok) return creds.response;
        tokenForCheck = (creds.data as { bot_token?: string } | null)?.bot_token ?? null;
        if (!tokenForCheck) return errorResponse(req, 400, 'token_required');
      }

      let meta: Record<string, unknown>;
      try {
        const { bot, chat } = await verifyConnection(new TelegramBotApi(tokenForCheck, { baseUrl: apiBase }), chatId);
        meta = { bot_id: bot.id, bot_username: bot.username ?? null, chat_title: chat.title ?? chat.username ?? null, chat_type: chat.type, status: 'ok' };
      } catch (err) {
        // A wrong token or an unknown chat is never stored. Missing rights are stored as "error" so the
        // owner can fix the rights in Telegram and re-check without retyping the token.
        if (!(err instanceof BotApiError) || err.code !== 'bot_cannot_post') return telegramError(req, err);
        meta = { status: 'error', last_error: `${err.code}: ${err.description}` };
      }
      const saved = await rpc(db, req, 'notify_save_settings', { ...actor, p_bot_token: token, p_chat_id: chatId, p_meta: meta });
      if (!saved.ok) return saved.response;
      return json(req, 200, { settings: saved.data });
    }

    case 'check': {
      // With botToken/chatId: dry run of unsaved values. Without: the stored connection (status is recorded).
      const dryRun = Boolean(body.botToken);
      let token: string | null = body.botToken ?? null;
      let chatId = body.chatId ? normalizeChatId(body.chatId) : null;
      let shopName = '';
      if (token !== null && !isValidBotToken(token)) return errorResponse(req, 400, 'invalid_token');
      if (body.chatId && !chatId) return errorResponse(req, 400, 'invalid_chat');
      const creds = await rpc(db, req, 'notify_get_credentials', actor);
      if (!creds.ok) return creds.response;
      const stored = creds.data as { bot_token: string; chat_id: string; shop_name: string } | null;
      token ??= stored?.bot_token ?? null;
      chatId ??= stored?.chat_id ?? null;
      if (!token || !chatId) return errorResponse(req, 404, 'not_configured');
      if (stored) shopName = stored.shop_name;
      else {
        const { data: shop } = await db.from('shops').select('name').eq('id', body.shopId).single();
        shopName = shop?.name ?? '';
      }
      try {
        const api = new TelegramBotApi(token, { baseUrl: apiBase });
        const { bot, chat } = await verifyConnection(api, chatId);
        await api.sendMessage(chatId, formatTestMessage(shopName));
        const settings = dryRun ? current.data : (await rpc(db, req, 'notify_record_check', { ...actor, p_ok: true, p_error: null })).data;
        return json(req, 200, { ok: true, bot: { username: bot.username ?? null }, chat: { title: chat.title ?? chat.username ?? null, type: chat.type }, settings });
      } catch (err) {
        if (!dryRun && err instanceof BotApiError) {
          await rpc(db, req, 'notify_record_check', { ...actor, p_ok: false, p_error: `${err.code}: ${err.description}` });
        }
        return telegramError(req, err);
      }
    }

    case 'enable':
    case 'disable': {
      const res = await rpc(db, req, 'notify_set_enabled', { ...actor, p_enabled: body.action === 'enable' });
      if (!res.ok) return res.response;
      return json(req, 200, { settings: res.data });
    }

    case 'delete': {
      const res = await rpc(db, req, 'notify_delete_settings', actor);
      if (!res.ok) return res.response;
      return json(req, 200, { settings: res.data });
    }

    case 'retry': {
      const res = await rpc(db, req, 'notify_requeue_failed', actor);
      if (!res.ok) return res.response;
      const result = await dispatchNotifications((fn, args) => db.rpc(fn, args), { shopId: body.shopId, limit: 20, apiBase });
      const after = await rpc(db, req, 'notify_get_settings', actor);
      return json(req, 200, { retried: res.data, ...result, settings: after.ok ? after.data : null });
    }
  }
});
