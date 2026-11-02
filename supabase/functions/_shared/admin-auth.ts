// Identity of an admin-panel caller (shop owner / platform admin), proven by a Supabase Auth access token.
// The user id returned here is the ONLY actor id passed to the service-role RPCs, which re-check the actor's
// rights themselves (shop membership role or public.platform_admins). Nothing in the request body can change it.
//
// Platform admins additionally need an aal2 (MFA-verified) session (20261102090000). The SQL checks it against
// auth.sessions using the session id this module forwards in x-platform-session — and the header is sent ONLY when
// the verified access token itself is aal2. An aal1 token therefore reaches the database without any session, and
// every platform-admin right is refused there (mfa_required), whatever the Edge Function does afterwards.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { callerFromClaims, decodeJwtPayload, platformSessionHeaders, type AdminCaller } from './admin-session.ts';
import { serviceClient } from './auth.ts';
import { errorResponse } from './http.ts';
import { DEFAULT_TELEGRAM_API_BASE } from './telegram-bot-api.ts';

export { callerFromClaims, decodeJwtPayload, platformSessionHeaders, type AdminCaller };

export async function verifyAdminUser(
  req: Request,
): Promise<({ ok: true } & AdminCaller) | { ok: false; response: Response }> {
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return { ok: false, response: errorResponse(req, 401, 'auth_required') };
  // Verifies the signature AND that the session still exists (a signed-out token is refused here).
  const { data, error } = await serviceClient().auth.getUser(match[1]);
  if (error || !data.user) return { ok: false, response: errorResponse(req, 401, 'auth_required') };
  return { ok: true, ...callerFromClaims(data.user.id, decodeJwtPayload(match[1]!)) };
}

/** Service-role client acting for this caller (the SQL re-checks the actor and, for platform rights, the session). */
export function actorClient(caller: AdminCaller): SupabaseClient {
  return serviceClient(platformSessionHeaders(caller));
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
  // Ownership only for confirmed accounts (20261030090000, audit F-01 / F-08).
  owner_unconfirmed: 409,
  owner_blocked: 409,
  handover_pending: 409,
  // One hand-over operation per shop, reserved before any Auth call (20261031090000, audit S2-06).
  invalid_email: 400,
  handover_in_progress: 409,
  handover_reservation_lost: 409,
  handover_reservation_mismatch: 409,
  // Invitation re-send cooldown and release of an expired reservation (20261101090000).
  invitation_rate_limited: 429,
  handover_reservation_active: 409,
  // Platform admins need an aal2 (MFA) session; accounts of admins and clients stay separate (20261102090000).
  mfa_required: 403,
  platform_admin_has_memberships: 409,
  // DEMO shop deletion (20261102090200).
  not_demo: 409,
  confirmation_mismatch: 400,
  deletion_not_found: 404,
  deletion_verification_failed: 409,
  shop_deleting: 409,
  notification_cleanup_failed: 409,
};
