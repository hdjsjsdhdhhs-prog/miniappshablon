// Identity of an admin-panel caller (shop owner / platform admin), proven by a Supabase Auth access token.
// The user id returned here is the ONLY actor id passed to the service-role RPCs, which re-check the actor's
// rights themselves (shop membership role or public.platform_admins). Nothing in the request body can change it.
import { serviceClient } from './auth.ts';
import { errorResponse } from './http.ts';
import { DEFAULT_TELEGRAM_API_BASE } from './telegram-bot-api.ts';

export async function verifyAdminUser(
  req: Request,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return { ok: false, response: errorResponse(req, 401, 'auth_required') };
  const { data, error } = await serviceClient().auth.getUser(match[1]);
  if (error || !data.user) return { ok: false, response: errorResponse(req, 401, 'auth_required') };
  return { ok: true, userId: data.user.id };
}

/** Bot API base URL. Server env only; locally it points at the mock Bot API (scripts/supabase-start.ts). */
export function telegramApiBase(): string {
  const value = Deno.env.get('TELEGRAM_API_BASE')?.trim();
  if (!value) return DEFAULT_TELEGRAM_API_BASE;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return value.replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  return DEFAULT_TELEGRAM_API_BASE;
}

/** Maps P0001 codes raised by the service-role RPCs to HTTP statuses. */
export const RPC_ERRORS: Record<string, number> = {
  forbidden: 403,
  not_configured: 404,
  token_required: 400,
  invalid_token: 400,
  invalid_chat: 400,
  invalid_status: 400,
  shop_not_found: 404,
  user_not_found: 404,
  transfer_verification_failed: 409,
  invalid_slug: 400,
  invalid_name: 400,
  invalid_invitation: 400,
  template_not_found: 404,
  slug_taken: 409,
  shop_not_ready: 409,
  owner_is_platform_admin: 409,
};
