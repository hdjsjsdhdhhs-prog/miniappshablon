// POST /functions/v1/owner-registration — self-registration of a shop owner by an individual one-time link.
// Public endpoint (verify_jwt = false): the credential is the 256-bit link token, only its SHA-256 reaches the database.
// Body: { action: 'preview', token }
//     | { action: 'register', token, email, password, passwordConfirm }   — a NEW account becomes the owner
//     | { action: 'claim', token }                                         — the SIGNED-IN account becomes the owner
//
// What this function does NOT do: it never sends an e-mail, never asks for e-mail confirmation and never opens public
// sign-up. The account is created with the Auth Admin API (createUser, e-mail marked confirmed — the address is NOT
// verified; the platform accepts that on purpose, see OWNER-REGISTRATION.md), so Auth stays configured exactly as it
// is (enable_signup = false). The browser then signs in with the password it just chose: the session comes from Auth,
// this function never issues or returns a token.
//
// Order (PostgreSQL and Auth share no transaction, see migration 20261119090000):
//   1. throttle (PostgreSQL counter per IP hash and per token hash) → 429 + Retry-After
//   2. owner_invite_reserve  — validates link, shop, e-mail binding; reserves the shop (one registration at a time)
//   3. Auth createUser       — a duplicate e-mail is answered with account_exists (the buyer signs in and claims)
//   4. owner_invite_complete — ONE transaction: re-validates, makes the account the only owner, consumes the link
//   5. the reservation is released on every failure (it also expires by itself after 3 minutes)
// The link is consumed only in step 4, together with the ownership change, so "link burnt but no owner" cannot occur.
// If step 4 is refused (a known, rolled-back refusal) the account created in step 3 is deleted again; after an unknown
// failure (network, timeout) it is KEPT, because the transaction may have committed — deleting an owner would cascade
// to the membership. The link then stays usable: the buyer signs in and claims.
//
// Nothing here logs the token, the password or the e-mail; error responses never echo them.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { z } from 'npm:zod@4.6.7';
import { verifyAdminUser } from '../_shared/admin-auth.ts';
import { serviceClient } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json, parseDbErrorDetails } from '../_shared/http.ts';
import {
  addressKey,
  hashInviteToken,
  INVITE_TOKEN_RE,
  isKnownRefusal,
  normalizeEmail,
  OWNER_INVITE_ERRORS,
  passwordProblem,
} from '../_shared/owner-invite.ts';

const token = z.string().max(200);
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), token }),
  z.object({
    action: z.literal('register'),
    token,
    email: z.string().trim().pipe(z.email().max(254)),
    password: z.string().max(200),
    passwordConfirm: z.string().max(200),
  }),
  z.object({ action: z.literal('claim'), token }),
]);
type Body = z.infer<typeof bodySchema>;
type RpcError = { message: string; code?: string; details?: string | null };

/** Responses carry link-related state: never cached by a browser or an intermediary. */
function noStore(res: Response): Response {
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

function refusal(req: Request, action: string, error: RpcError): Response {
  const mapped = OWNER_INVITE_ERRORS[error.message];
  if (mapped) {
    const [status, code] = mapped;
    const details = parseDbErrorDetails(error.details) as { reason?: unknown; retry_after_sec?: unknown } | null;
    // Only the non-sensitive reason / retry hint is passed on (never e-mail addresses from the detail text).
    const safe = details && typeof details.reason === 'string' ? { reason: details.reason } : null;
    const res = errorResponse(req, status, code, safe);
    if (status === 429 && typeof details?.retry_after_sec === 'number') res.headers.set('Retry-After', String(details.retry_after_sec));
    return noStore(res);
  }
  console.error(`owner-registration ${action} failed`, error.code ?? '', error.message);
  return noStore(errorResponse(req, 500, 'internal_error'));
}

/** Counts one attempt in PostgreSQL; fails closed when the counter itself is unavailable. */
async function throttle(req: Request, db: SupabaseClient, action: string, scope: 'ip_preview' | 'ip_action' | 'token_action', key: string) {
  const { error } = await db.rpc('owner_invite_throttle', { p_scope: scope, p_key: key });
  return error ? refusal(req, action, error) : null;
}

type Reserved = { ok: true; reservation: string } | { ok: false; response: Response };

async function reserve(req: Request, db: SupabaseClient, action: string, tokenHash: string, email: string, userId: string | null): Promise<Reserved> {
  const { data, error } = await db.rpc('owner_invite_reserve', { p_token_hash: tokenHash, p_email: email, p_user_id: userId });
  if (error) return { ok: false, response: refusal(req, action, error) };
  return { ok: true, reservation: (data as { reservation: string }).reservation };
}

async function release(db: SupabaseClient, tokenHash: string, reservation: string): Promise<void> {
  const { error } = await db.rpc('owner_invite_release', { p_token_hash: tokenHash, p_reservation: reservation });
  // Not fatal: the lease expires by itself.
  if (error) console.error('owner-registration: reservation release failed', error.code ?? '');
}

/** The shop changed hands: everything the buyer needs to open their admin (the slug is public). */
function completed(req: Request, data: unknown): Response {
  const done = data as { shop: { slug: string; name: string }; via: string };
  return noStore(json(req, 200, { status: 'completed', via: done.via, shop: done.shop }));
}

async function register(req: Request, db: SupabaseClient, tokenHash: string, body: Extract<Body, { action: 'register' }>): Promise<Response> {
  if (body.password !== body.passwordConfirm) return noStore(errorResponse(req, 400, 'password_mismatch'));
  const problem = passwordProblem(body.password);
  if (problem) return noStore(errorResponse(req, 422, 'weak_password', { reason: problem }));
  const email = normalizeEmail(body.email);

  const reserved = await reserve(req, db, body.action, tokenHash, email, null);
  if (!reserved.ok) return reserved.response;

  let finished = false;
  try {
    const created = await db.auth.admin.createUser({
      email,
      password: body.password,
      // No confirmation e-mail is sent and none is required. The address is NOT verified (documented trade-off).
      email_confirm: true,
      app_metadata: { registered_via: 'owner_invite' },
    });
    if (created.error || !created.data.user) {
      const code = created.error?.code ?? '';
      if (code === 'email_exists' || code === 'user_already_exists') return noStore(errorResponse(req, 409, 'account_exists'));
      if (code === 'weak_password') return noStore(errorResponse(req, 422, 'weak_password', { reason: 'policy' }));
      if (code === 'email_address_invalid' || code === 'validation_failed') return noStore(errorResponse(req, 400, 'invalid_body'));
      console.error('owner-registration: account not created', created.error?.status ?? '', code);
      return noStore(errorResponse(req, 502, 'auth_unavailable'));
    }
    const userId = created.data.user.id;

    const done = await db.rpc('owner_invite_complete', { p_token_hash: tokenHash, p_reservation: reserved.reservation, p_user_id: userId, p_via: 'registration' });
    if (done.error) {
      if (isKnownRefusal(done.error.message)) {
        // The transaction rolled back: the new account owns nothing and nobody else knows it. Remove it again.
        const removed = await db.auth.admin.deleteUser(userId);
        if (removed.error) console.error('owner-registration: orphan account not removed', removed.error.code ?? '');
      }
      return refusal(req, body.action, done.error);
    }
    finished = true;
    return completed(req, done.data);
  } finally {
    if (!finished) await release(db, tokenHash, reserved.reservation);
  }
}

async function claim(req: Request, db: SupabaseClient, tokenHash: string): Promise<Response> {
  // The signed-in account is proven by its own access token (verified against Auth); nothing in the body names it.
  const auth = await verifyAdminUser(req);
  if (!auth.ok) return noStore(auth.response);
  const found = await db.auth.admin.getUserById(auth.userId);
  const email = found.data.user?.email ? normalizeEmail(found.data.user.email) : '';
  if (!email) return noStore(errorResponse(req, 409, 'owner_not_allowed'));

  const reserved = await reserve(req, db, 'claim', tokenHash, email, auth.userId);
  if (!reserved.ok) return reserved.response;
  let finished = false;
  try {
    const done = await db.rpc('owner_invite_complete', { p_token_hash: tokenHash, p_reservation: reserved.reservation, p_user_id: auth.userId, p_via: 'claim' });
    if (done.error) return refusal(req, 'claim', done.error);
    finished = true;
    return completed(req, done.data);
  } finally {
    if (!finished) await release(db, tokenHash, reserved.reservation);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return noStore(errorResponse(req, 405, 'method_not_allowed'));

  let body: Body;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return noStore(errorResponse(req, 400, 'invalid_body'));
  }

  const db = serviceClient();
  const limited = await throttle(req, db, body.action, body.action === 'preview' ? 'ip_preview' : 'ip_action', await addressKey(req.headers));
  if (limited) return limited;
  if (!INVITE_TOKEN_RE.test(body.token)) return noStore(errorResponse(req, 404, 'invite_invalid'));
  const tokenHash = await hashInviteToken(body.token);

  if (body.action === 'preview') {
    const { data, error } = await db.rpc('owner_invite_preview', { p_token_hash: tokenHash });
    if (error) return refusal(req, body.action, error);
    return noStore(json(req, 200, { invite: data }));
  }

  const limitedByToken = await throttle(req, db, body.action, 'token_action', tokenHash);
  if (limitedByToken) return limitedByToken;
  return body.action === 'register' ? register(req, db, tokenHash, body) : claim(req, db, tokenHash);
});
