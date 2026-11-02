// Pure helpers for the MFA session of an admin-panel caller (no runtime dependencies, unit-tested).
// The token passed here has ALREADY been verified by Supabase Auth (getUser: signature + live session).

export interface AdminCaller {
  userId: string;
  /** Authenticator assurance level of the verified access token. */
  aal: 'aal1' | 'aal2' | null;
  /** Supabase Auth session of the token (claim session_id). */
  sessionId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Payload of a JWT (base64url JSON). Returns null for anything malformed. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const payload = JSON.parse(json) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** aal / session of a verified token's claims; claims of another user (sub mismatch) give nothing. */
export function callerFromClaims(userId: string, claims: Record<string, unknown> | null): AdminCaller {
  if (!claims || claims.sub !== userId) return { userId, aal: null, sessionId: null };
  const aal = claims.aal === 'aal2' ? 'aal2' : claims.aal === 'aal1' ? 'aal1' : null;
  const sessionId = typeof claims.session_id === 'string' && UUID.test(claims.session_id) ? claims.session_id : null;
  return { userId, aal, sessionId };
}

/** Headers that let the SQL see the caller's MFA session: only for an aal2 token, never otherwise. */
export function platformSessionHeaders(caller: AdminCaller): Record<string, string> {
  return caller.aal === 'aal2' && caller.sessionId ? { 'x-platform-session': caller.sessionId } : {};
}
