// Pure helpers of the owner registration link (no Deno globals, unit-tested with vitest).
//
// The link carries a 256-bit random token. Only its SHA-256 reaches PostgreSQL (private.shop_owner_invites.token_hash);
// the token itself is shown once to the platform admin and is never stored, logged or echoed in an error.

/** 32 random bytes in base64url (no padding) = exactly 43 characters. */
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cryptographically strong token (CSPRNG), 256 bits. */
export function generateInviteToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** What PostgreSQL stores and looks up. */
export function hashInviteToken(token: string): Promise<string> {
  return sha256Hex(`owner-invite:${token}`);
}

/**
 * Throttle key of the caller's address. Only a hash is stored (no raw IP address in the database). The address comes
 * from the proxy headers of the Supabase edge; when none is present all such callers share one bucket.
 */
export function clientAddress(headers: Headers): string {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf.slice(0, 64);
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  return headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

export function addressKey(headers: Headers): Promise<string> {
  return sha256Hex(`owner-invite-ip:${clientAddress(headers)}`);
}

/** Same rule as [auth] minimum_password_length (supabase/config.toml); GoTrue enforces it again. */
export const OWNER_PASSWORD_MIN = 10;
/** bcrypt, used by Supabase Auth, ignores bytes after the 72nd: longer passwords are refused instead. */
export const OWNER_PASSWORD_MAX_BYTES = 72;

export function passwordProblem(password: string): 'too_short' | 'too_long' | null {
  if (password.length < OWNER_PASSWORD_MIN) return 'too_short';
  if (new TextEncoder().encode(password).length > OWNER_PASSWORD_MAX_BYTES) return 'too_long';
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** SQL exception message → [HTTP status, public error code]. Anything else is a 500 internal_error. */
export const OWNER_INVITE_ERRORS: Readonly<Record<string, readonly [number, string]>> = {
  invite_invalid: [404, 'invite_invalid'],
  invite_used: [410, 'invite_used'],
  invite_revoked: [410, 'invite_revoked'],
  invite_expired: [410, 'invite_expired'],
  invite_unavailable: [409, 'invite_unavailable'],
  invite_email_mismatch: [403, 'invite_email_mismatch'],
  // Another registration / hand-over holds the shop, or a hand-over of it is pending: try again in a moment.
  shop_busy: [409, 'invite_in_progress'],
  handover_in_progress: [409, 'invite_in_progress'],
  handover_reservation_lost: [409, 'invite_in_progress'],
  handover_reservation_mismatch: [409, 'invite_in_progress'],
  rate_limited: [429, 'rate_limited'],
  owner_is_platform_admin: [409, 'owner_not_allowed'],
  owner_blocked: [409, 'owner_not_allowed'],
  owner_unconfirmed: [409, 'owner_not_allowed'],
  invalid_email: [400, 'invalid_body'],
  user_not_found: [409, 'owner_not_allowed'],
  transfer_verification_failed: [409, 'invite_unavailable'],
  shop_not_ready: [409, 'invite_unavailable'],
  shop_deleting: [409, 'invite_unavailable'],
};

/**
 * A SQL refusal after which the transaction certainly rolled back (a raised, known exception). For any other error
 * (network, timeout, 5xx) the outcome is unknown: the Auth account created for the attempt must then NOT be deleted,
 * because the ownership change may have committed.
 */
export function isKnownRefusal(message: string): boolean {
  return Object.hasOwn(OWNER_INVITE_ERRORS, message);
}
