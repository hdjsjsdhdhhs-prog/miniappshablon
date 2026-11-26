// POST /functions/v1/cart-quote  { shopSlug, items: [{ variantId, quantity }], promoCode?, bonusSpend? }
// The price of a cart as checkout would charge it right now: items total, the automatic discount of the reached threshold
// (and how much is missing for the next one), the promo code outcome, the bonuses that can be spent and the amount to pay.
// Everything is computed in PostgreSQL (public.loyalty_quote → private.loyalty_calc, the same calculation checkout uses);
// the browser only displays it. The buyer is the Telegram user proven by initData; the balance read is that user's, in
// that shop only. Nothing is locked or reserved here: only checkout (create_order_v3) uses up a promo code or bonuses.
import { z } from 'npm:zod@4.6.7';
import { serviceClient, verifyTelegramRequest } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json, parseDbErrorDetails } from '../_shared/http.ts';

const bodySchema = z.object({
  shopSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/),
  items: z
    .array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
  promoCode: z.string().trim().max(40).optional(),
  bonusSpend: z.number().int().min(0).max(1_000_000).optional(),
});

const DB_ERRORS: Record<string, number> = {
  invalid_customer: 400,
  invalid_items: 400,
  invalid_quantity: 400,
  invalid_bonus: 400,
  item_unavailable: 409,
  shop_unavailable: 404,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return errorResponse(req, 405, 'method_not_allowed');

  // The body is read once, lazily: only initData not signed by the platform bot needs the shop slug (shop's own bot).
  let rawBody: Promise<unknown> | null = null;
  const readBody = () => (rawBody ??= req.json());
  const slugFromBody = async () => {
    const raw = await readBody().catch(() => null);
    const slug = (raw as { shopSlug?: unknown } | null)?.shopSlug;
    return typeof slug === 'string' ? slug : null;
  };

  const auth = await verifyTelegramRequest(req, 'read', { shopSlug: slugFromBody });
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await readBody());
  } catch {
    return errorResponse(req, 400, 'invalid_body');
  }

  const { data, error } = await serviceClient().rpc('loyalty_quote', {
    p_shop_slug: body.shopSlug,
    p_customer_tg_id: auth.data.user.id,
    p_items: body.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })),
    p_promo_code: body.promoCode ?? null,
    p_bonus_spend: body.bonusSpend ?? 0,
  });
  if (error) {
    const status = DB_ERRORS[error.message];
    if (status) return errorResponse(req, status, error.message, parseDbErrorDetails(error.details));
    console.error('loyalty_quote failed', error.code ?? '', error.message);
    return errorResponse(req, 500, 'internal_error');
  }
  return json(req, 200, { quote: data });
});
