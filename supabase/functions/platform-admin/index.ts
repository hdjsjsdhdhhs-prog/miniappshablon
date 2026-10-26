// POST /functions/v1/platform-admin
// Platform-wide shop management for platform admins (rows of public.platform_admins, granted only by the
// operator script `pnpm owner:add --platform-admin`). Every RPC re-checks the verified actor id.
// Body: { action: 'list' } | { action: 'find-user', email } | { action: 'transfer', shopId, userId }
import { z } from 'npm:zod@4.6.7';
import { RPC_ERRORS, verifyAdminUser } from '../_shared/admin-auth.ts';
import { serviceClient } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json } from '../_shared/http.ts';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }),
  z.object({ action: z.literal('find-user'), email: z.email().max(254) }),
  z.object({ action: z.literal('transfer'), shopId: z.uuid(), userId: z.uuid() }),
]);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return errorResponse(req, 405, 'method_not_allowed');

  const auth = await verifyAdminUser(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return errorResponse(req, 400, 'invalid_body');
  }

  const db = serviceClient();
  const call =
    body.action === 'list'
      ? db.rpc('platform_list_shops', { p_actor: auth.userId })
      : body.action === 'find-user'
        ? db.rpc('platform_find_user', { p_actor: auth.userId, p_email: body.email })
        : db.rpc('platform_transfer_shop', { p_actor: auth.userId, p_shop_id: body.shopId, p_new_owner: body.userId });
  const { data, error } = await call;
  if (error) {
    const status = RPC_ERRORS[error.message];
    if (status) return errorResponse(req, status, error.message);
    console.error(`platform-admin ${body.action} failed`, error.code ?? '', error.message);
    return errorResponse(req, 500, 'internal_error');
  }
  if (body.action === 'list') return json(req, 200, { shops: data });
  if (body.action === 'find-user') return json(req, 200, { user: data });
  return json(req, 200, { transfer: data });
});
