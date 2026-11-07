// POST /functions/v1/bot-connection
// The shop's own Telegram bot (admin tab «Подключение бота»), for its owner (or a platform admin in an aal2 session).
// Body: { action: 'get' | 'connect' | 'sync' | 'disconnect' | 'save-welcome', shopId, botToken?, confirmReplaceWebhook?,
//         welcome?: { welcomeText, openButtonText, managerButtonText, managerUrl } }
//
// The bot token is accepted only by `connect`, verified with getMe and stored in Supabase Vault through a service-role
// RPC. It is never returned (only a masked hint), logged, or put into any URL except the Bot API's own.
// Independent of the order notifications (notification-settings): it never reads or changes their bot or chat.
import { z } from 'npm:zod@4.6.7';
import { actorClient, telegramApiBase, verifyAdminUser } from '../_shared/admin-auth.ts';
import { BotFlowError, connectBot, disconnectBot, getBot, saveWelcome, syncBot, type BotDeps } from '../_shared/bot-connection.ts';
import { corsHeaders, errorResponse, json, requireEnv } from '../_shared/http.ts';

const bodySchema = z.object({
  action: z.enum(['get', 'connect', 'sync', 'disconnect', 'save-welcome']),
  shopId: z.uuid(),
  botToken: z.string().max(100).optional(),
  confirmReplaceWebhook: z.boolean().optional(),
  welcome: z
    .object({
      welcomeText: z.string().max(5000),
      openButtonText: z.string().max(200),
      managerButtonText: z.string().max(200),
      managerUrl: z.string().max(300),
    })
    .optional(),
});

function platformBotId(): number | null {
  const id = Number((Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '').split(':')[0]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
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

  // A platform admin acts only in an aal2 session (forwarded to the SQL); the SQL re-checks the actor for every call.
  const db = actorClient(auth);
  const deps: BotDeps = {
    rpc: (fn, args) => db.rpc(fn, args),
    apiBase: telegramApiBase(),
    publicAppUrl: Deno.env.get('PUBLIC_APP_URL'),
    functionsBaseUrl: `${requireEnv('SUPABASE_URL').replace(/\/+$/, '')}/functions/v1`,
    platformBotId: platformBotId(),
    log: (m) => console.warn(m),
  };

  try {
    switch (body.action) {
      case 'get':
        return json(req, 200, await getBot(deps, body.shopId, auth.userId));
      case 'connect':
        if (!body.botToken) return errorResponse(req, 400, 'invalid_token');
        return json(
          req,
          200,
          await connectBot(deps, { shopId: body.shopId, actor: auth.userId, botToken: body.botToken, confirmReplaceWebhook: body.confirmReplaceWebhook === true }),
        );
      case 'sync':
        return json(req, 200, await syncBot(deps, body.shopId, auth.userId));
      case 'disconnect':
        return json(req, 200, await disconnectBot(deps, body.shopId, auth.userId));
      case 'save-welcome':
        if (!body.welcome) return errorResponse(req, 400, 'invalid_body');
        return json(req, 200, await saveWelcome(deps, body.shopId, auth.userId, body.welcome));
    }
  } catch (err) {
    if (err instanceof BotFlowError) return errorResponse(req, err.status, err.code, err.details);
    // Never the error itself: it could carry request data.
    console.error('bot-connection failed', (err as Error)?.name ?? 'error');
    return errorResponse(req, 500, 'internal_error');
  }
});
