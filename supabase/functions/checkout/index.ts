// POST /functions/v1/checkout
// Creates an order atomically after verifying Telegram initData. The client sends only variant ids and
// quantities; prices, ownership and stock are resolved in PostgreSQL inside one transaction.
//
// Two body formats (release stage 1, see 20261026090000):
//   * { fulfillment, comment }        → public.create_order_v2 (current storefront: delivery / pickup)
//   * { contact: { name, phone, comment } } → public.create_order (storefront published before 20261026090000;
//     kept unchanged until a follow-up release removes the old contract)
// A body with both or neither is rejected. Both paths share identity (initData only), validation and errors.
import { z } from 'npm:zod@4.6.7';
import { telegramApiBase } from '../_shared/admin-auth.ts';
import { serviceClient, verifyTelegramRequest } from '../_shared/auth.ts';
import { corsHeaders, errorResponse, json, parseDbErrorDetails } from '../_shared/http.ts';
import { dispatchNotifications } from '../_shared/notify-dispatch.ts';

const baseShape = {
  shopSlug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/),
  idempotencyKey: z.uuid(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  expectedTotalMinor: z.number().int().nonnegative().nullable().optional(),
  items: z
    .array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(99) }))
    .min(1)
    .max(50),
};

const fulfillmentBodySchema = z.object({
  ...baseShape,
  // Name/phone are not collected: the buyer is the verified Telegram user. The method is re-checked against the
  // shop's current settings in create_order_v2; a pickup request carries no address at all (unknown keys are dropped).
  fulfillment: z.discriminatedUnion('method', [
    z.object({ method: z.literal('delivery'), address: z.string().trim().min(1).max(300) }),
    z.object({ method: z.literal('pickup') }),
  ]),
  comment: z.string().trim().max(500).optional().default(''),
});

/** The pre-20261026090000 contract, byte-for-byte the old schema (its parsed `contact` feeds the request hash). */
const legacyBodySchema = z.object({
  ...baseShape,
  contact: z.object({
    name: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(32).optional().default(''),
    comment: z.string().trim().max(500).optional().default(''),
  }),
});

type FulfillmentBody = z.infer<typeof fulfillmentBodySchema>;
type LegacyBody = z.infer<typeof legacyBodySchema>;
type ParsedBody = { kind: 'fulfillment'; body: FulfillmentBody } | { kind: 'legacy'; body: LegacyBody };

/**
 * Picks the contract by its top-level key. `contact` alone → legacy; otherwise the current schema (which rejects a
 * body without `fulfillment`). Both keys at once is ambiguous → null (invalid body). Throws ZodError on bad input.
 */
function parseBody(raw: unknown): ParsedBody | null {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const hasFulfillment = obj.fulfillment !== undefined;
  const hasContact = obj.contact !== undefined;
  if (hasContact && hasFulfillment) return null;
  if (hasContact) return { kind: 'legacy', body: legacyBodySchema.parse(raw) };
  return { kind: 'fulfillment', body: fulfillmentBodySchema.parse(raw) };
}

const DB_ERRORS: Record<string, number> = {
  invalid_customer: 400,
  invalid_items: 400,
  invalid_quantity: 400,
  invalid_contact: 400,
  invalid_fulfillment: 400,
  invalid_address: 400,
  invalid_comment: 400,
  invalid_idempotency_key: 400,
  fulfillment_unavailable: 409,
  shop_unavailable: 404,
  shop_demo: 403,
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

  let parsed: ParsedBody | null;
  try {
    parsed = parseBody(await req.json());
  } catch (err) {
    return errorResponse(req, 400, 'invalid_body', err instanceof z.ZodError ? z.flattenError(err) : null);
  }
  if (!parsed) return errorResponse(req, 400, 'invalid_body', { formErrors: ['Send either fulfillment or contact, not both'], fieldErrors: {} });

  const user = auth.data.user;
  const { body } = parsed;
  const canonicalItems = [...body.items]
    .map((i) => [i.variantId, i.quantity] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const common = {
    p_shop_slug: body.shopSlug,
    p_customer_tg_id: user.id,
    p_customer_snapshot: {
      first_name: user.first_name ?? null,
      last_name: user.last_name ?? null,
      username: user.username ?? null,
    },
    p_items: body.items.map((i) => ({ variant_id: i.variantId, quantity: i.quantity })),
    p_idempotency_key: body.idempotencyKey,
    p_expected_currency: body.currency,
    p_expected_total_minor: body.expectedTotalMinor ?? null,
  };

  let rpcName: 'create_order' | 'create_order_v2';
  let args: Record<string, unknown>;
  if (parsed.kind === 'legacy') {
    const b = parsed.body;
    // Same hash as before the fulfillment release, so a retry of an order placed before the deploy still replays.
    const requestHash = await sha256Hex(JSON.stringify({ s: b.shopSlug, i: canonicalItems, c: b.contact, cur: b.currency }));
    rpcName = 'create_order';
    args = { ...common, p_request_hash: requestHash, p_contact_name: b.contact.name, p_contact_phone: b.contact.phone, p_comment: b.contact.comment };
  } else {
    const b = parsed.body;
    const address = b.fulfillment.method === 'delivery' ? b.fulfillment.address : null;
    const requestHash = await sha256Hex(
      JSON.stringify({ s: b.shopSlug, i: canonicalItems, f: b.fulfillment.method, a: address, c: b.comment, cur: b.currency }),
    );
    rpcName = 'create_order_v2';
    args = { ...common, p_request_hash: requestHash, p_fulfillment_method: b.fulfillment.method, p_delivery_address: address, p_comment: b.comment };
  }

  const { data, error } = await serviceClient().rpc(rpcName, args);

  if (error) {
    const status = DB_ERRORS[error.message];
    if (status) return errorResponse(req, status, error.message, parseDbErrorDetails(error.details));
    console.error(`${rpcName} failed`, error);
    return errorResponse(req, 500, 'internal_error');
  }

  const result = data as { replayed: boolean; order: { id: string; shop_id: string } };
  if (!result.replayed) scheduleNotifications(result.order.id, result.order.shop_id);
  return json(req, result.replayed ? 200 : 201, result);
});

/**
 * Telegram notification of the new order (outbox row written by create_order's transaction) plus any due
 * retries of the same shop. Runs after the response when the runtime supports it; a failure is recorded on
 * the outbox row and never affects the order or the response. A replayed checkout enqueues nothing new.
 */
function scheduleNotifications(orderId: string, shopId: string) {
  const db = serviceClient();
  const rpc = (fn: string, args: Record<string, unknown>) => db.rpc(fn, args);
  const apiBase = telegramApiBase();
  const task = (async () => {
    await dispatchNotifications(rpc, { orderId, apiBase });
    await dispatchNotifications(rpc, { shopId, limit: 3, apiBase });
  })().catch(() => console.warn('order notification dispatch failed'));
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task);
}
