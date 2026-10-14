// POST /functions/v1/my-orders  { shopSlug, orderId? }
// Returns only orders that belong to the Telegram user proven by initData, in the given shop.
import { z } from 'npm:zod@4.6.7';
import { serviceClient, verifyTelegramRequest } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json } from '../_shared/http.ts';

const bodySchema = z.object({
  shopSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/),
  orderId: z.uuid().optional(),
});

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return errorResponse(req, 405, 'method_not_allowed');

  const auth = await verifyTelegramRequest(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return errorResponse(req, 400, 'invalid_body');
  }

  const { data, error } = await serviceClient().rpc('get_customer_orders', {
    p_shop_slug: body.shopSlug,
    p_customer_tg_id: auth.data.user.id,
    p_order_id: body.orderId ?? null,
    p_limit: 30,
  });
  if (error) {
    console.error('get_customer_orders failed', error);
    return errorResponse(req, 500, 'internal_error');
  }

  return json(req, 200, {
    user: {
      id: auth.data.user.id,
      first_name: auth.data.user.first_name ?? null,
      last_name: auth.data.user.last_name ?? null,
      username: auth.data.user.username ?? null,
    },
    orders: data,
  });
});
