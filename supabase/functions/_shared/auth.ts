import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { InitDataError, validateInitData, type VerifiedInitData } from './telegram-init-data.ts';
import { errorResponse, initDataMaxAgeSec, requireEnv, type InitDataPurpose } from './http.ts';

/**
 * Service-role client. Lives only inside Edge Functions; never shipped to the browser.
 * `headers` are added to every PostgREST request (used for x-platform-session, see admin-auth.ts).
 */
export function serviceClient(headers: Record<string, string> = {}): SupabaseClient {
  return createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers },
  });
}

/**
 * Verifies the raw Telegram initData from the X-Telegram-Init-Data header.
 * The buyer identity used by every downstream query comes ONLY from this result.
 * `purpose` selects the accepted initData age (see initDataMaxAgeSec); every function passes it explicitly.
 */
export async function verifyTelegramRequest(
  req: Request,
  purpose: InitDataPurpose,
): Promise<{ ok: true; data: VerifiedInitData } | { ok: false; response: Response }> {
  const raw = req.headers.get('x-telegram-init-data');
  try {
    const data = await validateInitData(raw, requireEnv('TELEGRAM_BOT_TOKEN'), {
      maxAgeSec: initDataMaxAgeSec(purpose),
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
