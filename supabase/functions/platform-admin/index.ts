// POST /functions/v1/platform-admin
// Platform-wide shop management for platform admins (rows of public.platform_admins, granted only by the
// operator script `pnpm owner:add --platform-admin`). Every RPC re-checks the verified actor id; nothing in the
// body can choose the actor, the DEMO flag, the owner's rights or the publication state directly.
// Body: { action: 'list' } | { action: 'find-user', email } | { action: 'transfer', shopId, userId }
//     | { action: 'create-demo', templateId, slug, name }
//     | { action: 'handover-check', shopId } | { action: 'handover', shopId, email, redirectTo }
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { z } from 'npm:zod@4.6.7';
import { RPC_ERRORS, verifyAdminUser } from '../_shared/admin-auth.ts';
import { serviceClient } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json, parseDbErrorDetails } from '../_shared/http.ts';

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
]);

type Body = z.infer<typeof bodySchema>;
type RpcError = { message: string; code?: string; details?: string | null };

function rpcError(req: Request, action: string, error: RpcError): Response {
  const status = RPC_ERRORS[error.message];
  if (status) return errorResponse(req, status, error.message, parseDbErrorDetails(error.details));
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

/**
 * "Передать клиенту": readiness + rights are checked BEFORE any account is touched; the ownership change and the
 * switch to a real shop (is_demo=false, mode=live) then happen in one SQL transaction that re-checks everything.
 */
async function handover(req: Request, db: SupabaseClient, actor: string, body: Extract<Body, { action: 'handover' }>) {
  const check = await db.rpc('platform_handover_check', { p_actor: actor, p_shop_id: body.shopId });
  if (check.error) return rpcError(req, body.action, check.error);
  const readiness = check.data as { ready: boolean; problems: string[] };
  if (!readiness.ready) return errorResponse(req, 409, 'shop_not_ready', readiness.problems);

  const email = body.email.trim().toLowerCase();
  const found = await db.rpc('platform_find_user', { p_actor: actor, p_email: email });
  if (found.error) return rpcError(req, body.action, found.error);
  const existing = found.data as { user_id: string; is_platform_admin: boolean } | null;
  if (existing?.is_platform_admin) return errorResponse(req, 409, 'owner_is_platform_admin');

  let target: { userId: string; invitation: Invitation } | null;
  if (!existing) {
    target = await invite(db, email, body.redirectTo);
  } else {
    const { data: u, error: ue } = await db.auth.admin.getUserById(existing.user_id);
    if (ue || !u.user) return errorResponse(req, 404, 'user_not_found');
    // Invited earlier but never activated: send a fresh invitation; otherwise the client signs in with their password.
    const pending = !!u.user.invited_at && !u.user.email_confirmed_at && !u.user.last_sign_in_at;
    target = pending ? await invite(db, email, body.redirectTo) : { userId: existing.user_id, invitation: { status: 'existing', link: null } };
  }
  if (!target) return errorResponse(req, 502, 'invite_failed');

  const done = await db.rpc('platform_handover_shop', {
    p_actor: actor,
    p_shop_id: body.shopId,
    p_new_owner: target.userId,
    p_invitation: target.invitation.status,
  });
  if (done.error) return rpcError(req, body.action, done.error);
  return json(req, 200, { handover: done.data, invitation: target.invitation });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return errorResponse(req, 405, 'method_not_allowed');

  const auth = await verifyAdminUser(req);
  if (!auth.ok) return auth.response;

  let body: Body;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return errorResponse(req, 400, 'invalid_body');
  }

  const db = serviceClient();
  if (body.action === 'create-demo') return createDemo(req, db, auth.userId, body);
  if (body.action === 'handover') return handover(req, db, auth.userId, body);

  const call =
    body.action === 'list'
      ? db.rpc('platform_list_shops', { p_actor: auth.userId })
      : body.action === 'find-user'
        ? db.rpc('platform_find_user', { p_actor: auth.userId, p_email: body.email })
        : body.action === 'handover-check'
          ? db.rpc('platform_handover_check', { p_actor: auth.userId, p_shop_id: body.shopId })
          : db.rpc('platform_transfer_shop', { p_actor: auth.userId, p_shop_id: body.shopId, p_new_owner: body.userId });
  const { data, error } = await call;
  if (error) return rpcError(req, body.action, error);
  if (body.action === 'list') return json(req, 200, { shops: data });
  if (body.action === 'find-user') return json(req, 200, { user: data });
  if (body.action === 'handover-check') return json(req, 200, { check: data });
  return json(req, 200, { transfer: data });
});
