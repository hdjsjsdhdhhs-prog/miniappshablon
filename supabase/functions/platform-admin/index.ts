// POST /functions/v1/platform-admin
// Platform-wide shop management for platform admins (rows of public.platform_admins, granted only by the
// operator script `pnpm owner:add --platform-admin`). Every RPC re-checks the verified actor id; nothing in the
// body can choose the actor, the DEMO flag, the owner's rights or the publication state directly.
// Body: { action: 'list' } | { action: 'find-user', email } | { action: 'transfer', shopId, userId }
//     | { action: 'create-demo', templateId, slug, name }
//     | { action: 'handover-check', shopId } | { action: 'handover', shopId, email, redirectTo }
//     | { action: 'handover-cancel', shopId } | { action: 'handover-release-stale', shopId }
// A shop is given (transfer / handover) only to a CONFIRMED account; the SQL functions enforce it from auth.users
// and revoke the former owner's Telegram notification channel in the same transaction (audit F-01, F-08, S2-01).
// A hand-over is reserved in SQL (one per shop) before any account is created or invitation sent (audit S2-06).
// Each invitation e-mail is claimed in SQL first: per (shop, e-mail) one per 60 s and five per hour (429).
//     | { action: 'demo-delete-preview', shopId } | { action: 'demo-delete', shopId, confirmSlug }
//     | { action: 'demo-delete-resume', shopId }
// MFA (20261102090000): every action requires an aal2 access token. An aal1 token is refused here before any RPC,
// Auth or Storage call, and independently the SQL refuses every platform right unless the forwarded session is a
// live aal2 session of the actor (the session is forwarded only for an aal2 token).
// DEMO deletion (20261102090200): SQL deletes the data and blocks the shop, this function removes the Storage objects
// under the exact "<shop_id>/" prefix with the service role, SQL completes only once no object is left.
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { z } from 'npm:zod@4.6.7';
import { actorClient, RPC_ERRORS, verifyAdminUser, type AdminCaller } from '../_shared/admin-auth.ts';
import { serviceClient } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json, parseDbErrorDetails } from '../_shared/http.ts';
import { removeShopMedia } from '../_shared/shop-media-cleanup.ts';

const BUCKET = 'shop-media';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/** The invite link may only lead to the admin's password page (Supabase Auth also enforces its allow-list). */
const redirectSchema = z
  .url()
  .max(300)
  .refine((v) => {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.pathname === '/admin/set-password' && !u.username && !u.password;
  });

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('find-user'), email: z.email().max(254) }),
  z.object({ action: z.literal('transfer'), shopId: z.uuid(), userId: z.uuid() }),
  z.object({ action: z.literal('create-demo'), templateId: z.uuid(), slug: z.string().trim().toLowerCase().regex(SLUG), name: z.string().trim().min(1).max(80) }),
  z.object({ action: z.literal('handover-check'), shopId: z.uuid() }),
  z.object({ action: z.literal('handover'), shopId: z.uuid(), email: z.email().max(254), redirectTo: redirectSchema }),
  z.object({ action: z.literal('handover-cancel'), shopId: z.uuid() }),
  z.object({ action: z.literal('handover-release-stale'), shopId: z.uuid() }),
  z.object({ action: z.literal('demo-delete-preview'), shopId: z.uuid() }),
  // The confirmation is the exact slug, typed by the admin; the SQL compares it with the shop's slug.
  z.object({ action: z.literal('demo-delete'), shopId: z.uuid(), confirmSlug: z.string().trim().min(1).max(40) }),
  z.object({ action: z.literal('demo-delete-resume'), shopId: z.uuid() }),
]);

type Body = z.infer<typeof bodySchema>;
type RpcError = { message: string; code?: string; details?: string | null };

function rpcError(req: Request, action: string, error: RpcError): Response {
  const status = RPC_ERRORS[error.message];
  if (status) {
    const details = parseDbErrorDetails(error.details);
    const res = errorResponse(req, status, error.message, details);
    const retryAfter = (details as { retry_after_sec?: unknown } | null)?.retry_after_sec;
    if (status === 429 && typeof retryAfter === 'number') res.headers.set('Retry-After', String(retryAfter));
    return res;
  }
  console.error(`platform-admin ${action} failed`, error.code ?? '', error.message);
  return errorResponse(req, 500, 'internal_error');
}

/**
 * Creates a DEMO shop from a DEMO template: the catalog is cloned in one SQL transaction (shop stays preview),
 * then the media objects are copied under the new shop id, then the shop goes live. If copying fails the shop is
 * removed again, so a half-built shop is never public.
 */
async function createDemo(req: Request, db: SupabaseClient, actor: string, body: Extract<Body, { action: 'create-demo' }>) {
  const { data, error } = await db.rpc('platform_create_demo_shop', {
    p_actor: actor,
    p_template_id: body.templateId,
    p_slug: body.slug,
    p_name: body.name,
  });
  if (error) return rpcError(req, body.action, error);
  const created = data as { shop: { id: string; slug: string; name: string }; files: Array<{ from: string; to: string }> };

  const copied: string[] = [];
  const missing: string[] = [];
  for (const file of created.files) {
    const { error: copyError } = await db.storage.from(BUCKET).copy(file.from, file.to);
    if (!copyError) {
      copied.push(file.to);
      continue;
    }
    const message = copyError.message ?? '';
    if (/exists|duplicate/i.test(message)) continue;
    // The template itself lacks this object: the clone shows the same placeholder as the template does.
    if (/not.?found/i.test(message)) {
      missing.push(file.from);
      continue;
    }
    console.error('create-demo: media copy failed', message);
    if (copied.length) await db.storage.from(BUCKET).remove(copied);
    await db.rpc('platform_discard_demo_shop', { p_actor: actor, p_shop_id: created.shop.id });
    return errorResponse(req, 502, 'media_copy_failed');
  }

  const published = await db.rpc('platform_publish_demo_shop', { p_actor: actor, p_shop_id: created.shop.id });
  if (published.error) return rpcError(req, body.action, published.error);
  return json(req, 201, { shop: published.data, media: { copied: copied.length, missing: missing.length } });
}

type Invitation = { status: 'sent' | 'link' | 'existing'; link: string | null };

/** Invites a new (or not yet activated) account. Falls back to a one-time link when the e-mail cannot be sent. */
async function invite(db: SupabaseClient, email: string, redirectTo: string): Promise<{ userId: string; invitation: Invitation } | null> {
  const sent = await db.auth.admin.inviteUserByEmail(email, { redirectTo });
  if (!sent.error && sent.data.user) return { userId: sent.data.user.id, invitation: { status: 'sent', link: null } };
  console.warn('handover: invite e-mail not sent, falling back to a one-time link', sent.error?.status ?? '', sent.error?.code ?? '');
  const generated = await db.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo } });
  if (generated.error || !generated.data.user) return null;
  return { userId: generated.data.user.id, invitation: { status: 'link', link: generated.data.properties.action_link } };
}

/** Server-side account state (public.platform_find_user → private.account_state on auth.users). */
type AccountState = 'confirmed' | 'invited' | 'unconfirmed' | 'blocked' | 'missing';

/**
 * "Передать клиенту": readiness + rights are checked BEFORE any account is touched. Then, by the account state read
 * from auth.users (never from the request):
 *   * no account / invited but never activated → invitation; the SQL records a PENDING hand-over and the shop
 *     changes hands only when that account confirms its e-mail (trigger on auth.users);
 *   * confirmed account → hand-over completes now (one SQL transaction: owner, notifications revoked, DEMO → live);
 *   * unconfirmed account with its own password (self-registration) → refused, NO invitation: inviting would not
 *     remove a password set by whoever registered that e-mail;
 *   * platform admin / blocked → refused.
 * platform_handover_shop re-checks all of it, so calling the RPC directly cannot skip a step.
 */
async function handover(req: Request, db: SupabaseClient, actor: string, body: Extract<Body, { action: 'handover' }>) {
  const check = await db.rpc('platform_handover_check', { p_actor: actor, p_shop_id: body.shopId });
  if (check.error) return rpcError(req, body.action, check.error);
  const readiness = check.data as { ready: boolean; problems: string[] };
  if (!readiness.ready) return errorResponse(req, 409, 'shop_not_ready', readiness.problems);

  const email = body.email.trim().toLowerCase();
  const found = await db.rpc('platform_find_user', { p_actor: actor, p_email: email });
  if (found.error) return rpcError(req, body.action, found.error);
  const existing = found.data as { user_id: string; is_platform_admin: boolean; state: AccountState } | null;
  if (existing?.is_platform_admin) return errorResponse(req, 409, 'owner_is_platform_admin');
  if (existing?.state === 'blocked') return errorResponse(req, 409, 'owner_blocked');
  if (existing && existing.state !== 'confirmed' && existing.state !== 'invited') return errorResponse(req, 409, 'owner_unconfirmed');

  // S2-06: one hand-over per shop, reserved atomically in SQL BEFORE Supabase Auth creates an account or sends an
  // e-mail. A parallel request (another e-mail or an identical duplicate) gets 409 handover_in_progress here and
  // touches nothing. platform_handover_shop accepts only this token and consumes it in its own transaction.
  const reserved = await db.rpc('platform_reserve_handover', { p_actor: actor, p_shop_id: body.shopId, p_email: email });
  if (reserved.error) return rpcError(req, body.action, reserved.error);
  const token = (reserved.data as { token: string }).token;

  let finished = false;
  try {
    let target: { userId: string; invitation: Invitation } | null;
    if (!existing || existing.state === 'invited') {
      // Re-send cooldown, counted in SQL for this shop and the reservation's e-mail BEFORE Auth sends anything.
      // A refusal (429 invitation_rate_limited, Retry-After) releases the reservation in `finally`.
      const claimed = await db.rpc('platform_claim_handover_invitation', { p_actor: actor, p_shop_id: body.shopId, p_reservation: token });
      if (claimed.error) return rpcError(req, body.action, claimed.error);
      target = await invite(db, email, body.redirectTo);
      // The invitation must land on the account that was checked above (or on a brand-new one).
      if (target && existing && target.userId !== existing.user_id) return errorResponse(req, 409, 'owner_unconfirmed');
    } else {
      target = { userId: existing.user_id, invitation: { status: 'existing', link: null } };
    }
    if (!target) return errorResponse(req, 502, 'invite_failed');

    const done = await db.rpc('platform_handover_shop', {
      p_actor: actor,
      p_shop_id: body.shopId,
      p_new_owner: target.userId,
      p_invitation: target.invitation.status,
      p_reservation: token,
    });
    if (done.error) return rpcError(req, body.action, done.error);
    finished = true;
    return json(req, 200, { handover: done.data, invitation: target.invitation });
  } finally {
    // Any failure (Auth error, refused hand-over, exception) frees the shop at once. If this call fails or the
    // function dies before it, the reservation lease expires by itself (private.handover_reservation_lease).
    if (!finished) {
      const released = await db.rpc('platform_release_handover', { p_actor: actor, p_shop_id: body.shopId, p_token: token });
      if (released.error) console.error('handover: reservation release failed', released.error.code ?? '', released.error.message);
    }
  }
}

type DeletionResult = { status: 'pending' | 'deleted'; remaining?: number; shop?: { id: string; slug: string; name: string } };

/**
 * "Удалить DEMO". begin (SQL, one transaction: checks, audit, data, shop blocked) → Storage cleanup of the exact
 * prefix (service role, retries) → finalize (SQL completes only when no object is left). `confirmSlug` null = resume
 * an interrupted deletion. 200 only when the deletion is complete; 202 while objects remain (retry later).
 */
async function demoDelete(req: Request, db: SupabaseClient, actor: string, shopId: string, confirmSlug: string | null, action: string) {
  if (confirmSlug !== null) {
    const begun = await db.rpc('platform_demo_delete_begin', { p_actor: actor, p_shop_id: shopId, p_confirm_slug: confirmSlug });
    if (begun.error) return rpcError(req, action, begun.error);
    if ((begun.data as DeletionResult).status === 'deleted') return json(req, 200, { deletion: begun.data });
  } else {
    const preview = await db.rpc('platform_demo_delete_preview', { p_actor: actor, p_shop_id: shopId });
    if (preview.error) return rpcError(req, action, preview.error);
    const state = (preview.data as { status: string }).status;
    if (state === 'deleted') return json(req, 200, { deletion: preview.data });
    if (state !== 'deleting') return errorResponse(req, 404, 'deletion_not_found');
  }

  const cleanup = await removeShopMedia(
    (limit) => db.rpc('platform_demo_delete_objects', { p_actor: actor, p_shop_id: shopId, p_limit: limit }),
    (paths) => db.storage.from(BUCKET).remove(paths),
    shopId,
  );
  if (cleanup.error) console.error('demo-delete: storage cleanup incomplete', cleanup.error);
  const done = await db.rpc('platform_demo_delete_finalize', { p_actor: actor, p_shop_id: shopId, p_error: cleanup.error });
  if (done.error) return rpcError(req, action, done.error);
  const result = done.data as DeletionResult;
  return json(req, result.status === 'deleted' ? 200 : 202, { deletion: result, storage: { removed: cleanup.removed, error: cleanup.error } });
}

/** Explicit MFA gate before anything else runs (the SQL enforces it again on its own). */
async function requireAal2(req: Request, caller: AdminCaller): Promise<Response | null> {
  if (caller.aal === 'aal2' && caller.sessionId) return null;
  const { data } = await serviceClient().from('platform_admins').select('user_id').eq('user_id', caller.userId).maybeSingle();
  return errorResponse(req, 403, data ? 'mfa_required' : 'forbidden');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return errorResponse(req, 405, 'method_not_allowed');

  const auth = await verifyAdminUser(req);
  if (!auth.ok) return auth.response;
  const refused = await requireAal2(req, auth);
  if (refused) return refused;

  let body: Body;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return errorResponse(req, 400, 'invalid_body');
  }

  // Service role + the caller's aal2 session (x-platform-session): every RPC re-checks both in SQL.
  const db = actorClient(auth);
  if (body.action === 'create-demo') return createDemo(req, db, auth.userId, body);
  if (body.action === 'handover') return handover(req, db, auth.userId, body);
  if (body.action === 'demo-delete') return demoDelete(req, db, auth.userId, body.shopId, body.confirmSlug, body.action);
  if (body.action === 'demo-delete-resume') return demoDelete(req, db, auth.userId, body.shopId, null, body.action);
  if (body.action === 'demo-delete-preview') {
    const { data, error } = await db.rpc('platform_demo_delete_preview', { p_actor: auth.userId, p_shop_id: body.shopId });
    if (error) return rpcError(req, body.action, error);
    return json(req, 200, { preview: data });
  }

  const call =
    body.action === 'list'
      ? db.rpc('platform_list_shops', { p_actor: auth.userId })
      : body.action === 'find-user'
        ? db.rpc('platform_find_user', { p_actor: auth.userId, p_email: body.email })
        : body.action === 'handover-check'
          ? db.rpc('platform_handover_check', { p_actor: auth.userId, p_shop_id: body.shopId })
          : body.action === 'handover-cancel'
            ? // Cancels a pending hand-over only. The SQL refuses while a reservation is live (handover_reservation_active)
              // and never removes one — this check cannot be skipped by calling the RPC directly.
              db.rpc('platform_cancel_handover', { p_actor: auth.userId, p_shop_id: body.shopId })
            : body.action === 'handover-release-stale'
              ? // The SQL refuses a reservation whose lease has not expired yet (handover_reservation_active).
                db.rpc('platform_release_stale_handover', { p_actor: auth.userId, p_shop_id: body.shopId })
              : db.rpc('platform_transfer_shop', { p_actor: auth.userId, p_shop_id: body.shopId, p_new_owner: body.userId });
  const { data, error } = await call;
  if (error) return rpcError(req, body.action, error);
  if (body.action === 'list') return json(req, 200, { shops: data });
  if (body.action === 'find-user') return json(req, 200, { user: data });
  if (body.action === 'handover-check') return json(req, 200, { check: data });
  if (body.action === 'handover-cancel' || body.action === 'handover-release-stale') return json(req, 200, data);
  return json(req, 200, { transfer: data });
});
