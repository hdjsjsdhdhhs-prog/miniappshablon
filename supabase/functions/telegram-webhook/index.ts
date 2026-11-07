// POST /functions/v1/telegram-webhook?c=<connection id>
// Incoming updates of the shops' own Telegram bots (set by bot-connection with setWebhook).
//
// Called by Telegram, not by a browser: no Supabase JWT (verify_jwt = false) and no CORS. A request is processed only
// when `c` names an existing connection AND X-Telegram-Bot-Api-Secret-Token is that connection's secret (compared as
// SHA-256 in SQL); everything else gets the same 401. Each update_id is processed once (private.bot_updates).
// Answers /start in private chats with the shop's welcome message and its two inline buttons.
import { telegramApiBase } from '../_shared/admin-auth.ts';
import { serviceClient } from '../_shared/auth.ts';
import { handleWebhookUpdate } from '../_shared/bot-connection.ts';

/** Telegram updates are small; anything bigger is not an update we handle. */
const MAX_BODY_BYTES = 256 * 1024;

function reply(status: number, body: Record<string, unknown> = { ok: status < 300 }): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

Deno.serve(async (req) => {
  // Same 405 body as every other function (the release smoke test checks it with a GET).
  if (req.method !== 'POST') return reply(405, { error: { code: 'method_not_allowed', details: null } });

  const url = new URL(req.url);
  const connectionId = url.searchParams.get('c');
  const secretToken = req.headers.get('x-telegram-bot-api-secret-token');
  // Cheap refusal before reading the body or touching the database.
  if (!connectionId || !secretToken) return reply(401, { ok: false });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return reply(413, { ok: false });
  let update: unknown;
  try {
    update = JSON.parse(raw);
  } catch {
    return reply(400, { ok: false });
  }

  const db = serviceClient();
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  try {
    const res = await handleWebhookUpdate(
      {
        rpc: (fn, args) => db.rpc(fn, args),
        apiBase: telegramApiBase(),
        publicAppUrl: Deno.env.get('PUBLIC_APP_URL'),
        functionsBaseUrl: `${supabaseUrl.replace(/\/+$/, '')}/functions/v1`,
        log: (m) => console.warn(m),
      },
      { connectionId, secretToken, update },
    );
    return reply(res.status, res.body);
  } catch (err) {
    console.error('telegram-webhook failed', (err as Error)?.name ?? 'error');
    return reply(503, { ok: false });
  }
});
