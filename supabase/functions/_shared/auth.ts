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

export interface VerifyTelegramOptions {
  /**
   * Slug of the shop the request is for. Only called when the initData is NOT signed by the platform bot: a Mini App
   * opened from a shop's own connected bot (bot-connection) carries initData signed with THAT bot's token, which is
   * accepted for that one shop only (public.bot_initdata_token) — never for another shop.
   */
  shopSlug?: () => Promise<string | null>;
}

const SHOP_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * Verifies the raw Telegram initData from the X-Telegram-Init-Data header.
 * The buyer identity used by every downstream query comes ONLY from this result.
 * `purpose` selects the accepted initData age (see initDataMaxAgeSec); every function passes it explicitly.
 */
export async function verifyTelegramRequest(
  req: Request,
  purpose: InitDataPurpose,
  options: VerifyTelegramOptions = {},
): Promise<{ ok: true; data: VerifiedInitData } | { ok: false; response: Response }> {
  const raw = req.headers.get('x-telegram-init-data');
  const validateOptions = { maxAgeSec: initDataMaxAgeSec(purpose) };
  try {
    try {
      return { ok: true, data: await validateInitData(raw, requireEnv('TELEGRAM_BOT_TOKEN'), validateOptions) };
    } catch (err) {
      if (!(err instanceof InitDataError && err.code === 'bad_signature') || !options.shopSlug) throw err;
      const slug = await options.shopSlug();
      if (!slug || !SHOP_SLUG_RE.test(slug)) throw err;
      const { data: shopToken, error } = await serviceClient().rpc('bot_initdata_token', { p_shop_slug: slug });
      if (error) {
        console.error('bot_initdata_token failed', error.code ?? '');
        throw err;
      }
      if (typeof shopToken !== 'string' || !shopToken) throw err;
      return { ok: true, data: await validateInitData(raw, shopToken, validateOptions) };
    }
  } catch (err) {
    if (err instanceof InitDataError) {
      return { ok: false, response: errorResponse(req, 401, 'telegram_auth_failed', { reason: err.code }) };
    }
    console.error('initData verification misconfigured', err);
    return { ok: false, response: errorResponse(req, 500, 'server_misconfigured') };
  }
}
