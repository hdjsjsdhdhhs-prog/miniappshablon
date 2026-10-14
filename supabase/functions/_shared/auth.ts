import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { InitDataError, validateInitData, type VerifiedInitData } from './telegram-init-data.ts';
import { errorResponse, initDataMaxAgeSec, requireEnv } from './http.ts';

/** Service-role client. Lives only inside Edge Functions; never shipped to the browser. */
export function serviceClient(): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Verifies the raw Telegram initData from the X-Telegram-Init-Data header.
 * The buyer identity used by every downstream query comes ONLY from this result.
 */
export async function verifyTelegramRequest(
  req: Request,
): Promise<{ ok: true; data: VerifiedInitData } | { ok: false; response: Response }> {
  const raw = req.headers.get('x-telegram-init-data');
  try {
    const data = await validateInitData(raw, requireEnv('TELEGRAM_BOT_TOKEN'), {
      maxAgeSec: initDataMaxAgeSec(),
    });
    return { ok: true, data };
  } catch (err) {
    if (err instanceof InitDataError) {
      return { ok: false, response: errorResponse(req, 401, 'telegram_auth_failed', { reason: err.code }) };
    }
    console.error('initData verification misconfigured', err);
    return { ok: false, response: errorResponse(req, 500, 'server_misconfigured') };
  }
}
