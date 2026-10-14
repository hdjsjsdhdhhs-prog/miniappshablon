// POST /functions/v1/checkout
// Creates an order atomically via public.create_order after verifying Telegram initData.
// The client sends only variant ids and quantities; prices, ownership and stock are resolved
// in PostgreSQL inside one transaction.
import { z } from 'npm:zod@4.6.7';
import { serviceClient, verifyTelegramRequest } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json, parseDbErrorDetails } from '../_shared/http.ts';

const bodySchema = z.object({
  shopSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/),
  idempotencyKey: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  expectedTotalMinor: z.number().int().nonnegative().nullable().optional(),
  items: z
    .array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
  contact: z.object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(32).optional().default(''),
    comment: z.string().trim().max(500).optional().default(''),
  }),
});

const DB_ERRORS: Record<string, number> = {
  invalid_customer: 400,
  invalid_items: 400,
  invalid_quantity: 400,
  invalid_contact: 400,
  invalid_idempotency_key: 400,
  shop_unavailable: 404,
  shop_preview: 403,
  currency_mismatch: 409,
  item_unavailable: 409,
  insufficient_stock: 409,
  price_changed: 409,
  idempotency_conflict: 422,
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return errorResponse(req, 405, 'method_not_allowed');

  const auth = await verifyTelegramRequest(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    return errorResponse(req, 400, 'invalid_body', err instanceof z.ZodError ? z.flattenError(err) : null);
  }

  const user = auth.data.user;
  const canonicalItems = [...body.items]
    .map((i) => [i.variantId, i.quantity] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const requestHash = await sha256Hex(
    JSON.stringify({ s: body.shopSlug, i: canonicalItems, c: body.contact, cur: body.currency }),
  );

  const { data, error } = await serviceClient().rpc('create_order', {
    p_shop_slug: body.shopSlug,
    p_customer_tg_id: user.id,
    p_customer_snapshot: {
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      username: user.username ?? null,
    },
    p_items: body.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })),
    p_idempotency_key: body.idempotencyKey,
    p_request_hash: requestHash,
    p_contact_name: body.contact.name,
    p_contact_phone: body.contact.phone,
    p_comment: body.contact.comment,
    p_expected_currency: body.currency,
    p_expected_total_minor: body.expectedTotalMinor ?? null,
  });

  if (error) {
    const status = DB_ERRORS[error.message];
    if (status) return errorResponse(req, status, error.message, parseDbErrorDetails(error.details));
    console.error('create_order failed', error);
    return errorResponse(req, 500, 'internal_error');
  }

  const result = data as { replayed: boolean; order: unknown };
  return json(req, result.replayed ? 200 : 201, result);
});
