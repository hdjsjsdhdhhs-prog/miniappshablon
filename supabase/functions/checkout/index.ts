// POST /functions/v1/checkout
// Creates an order atomically after verifying Telegram initData. The client sends only variant ids and
// quantities; prices, ownership and stock are resolved in PostgreSQL inside one transaction.
//
// Body: { fulfillment, comment, … } → public.create_order_v2 (delivery / pickup). The pre-20261026090000 contract
// ({ contact: { name, phone, comment } } → create_order) was removed in 20261030090100 (audit F-03: it stored orders
// in DEMO shops); such a body is refused before any database call. DEMO shops, per-order size and per-buyer rate
// limits are enforced in SQL (create_order_v2 + orders trigger), so no caller can skip them.
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

type FulfillmentBody = z.infer<typeof fulfillmentBodySchema>;

/** The removed old contract is recognised explicitly (clear error), never silently mapped onto the current one. */
function isLegacyBody(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).contact !== undefined;
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
  order_too_large: 422,
  rate_limited: 429,
  too_many_open_orders: 429,
  stock_check_limited: 429,
};

type StockStatus = 'out_of_stock' | 'low_stock' | 'in_stock';

/**
 * insufficient_stock without the exact quantity (20261102090100): the SQL detail carries `available`, the buyer gets
 * only the public status of each refused variant, read from the generated column product_variants.stock_status.
 */
async function insufficientStockDetails(details: unknown): Promise<Array<{ variant_id: string; stock_status: StockStatus }>> {
  const ids = Array.isArray(details)
    ? [...new Set(details.map((d) => (d as { variant_id?: unknown })?.variant_id).filter((id): id is string => typeof id === 'string'))]
    : [];
  if (ids.length === 0) return [];
  const { data, error } = await serviceClient().from('product_variants').select('id, stock_status').in('id', ids);
  const byId = new Map((error ? [] : (data ?? [])).map((v: { id: string; stock_status: StockStatus }) => [v.id, v.stock_status]));
  // A variant that vanished meanwhile is simply not available any more.
  return ids.map((id) => ({ variant_id: id, stock_status: byId.get(id) ?? 'out_of_stock' }));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

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

  // Creating an order accepts a shorter initData age than reading the history (see http.ts).
  const auth = await verifyTelegramRequest(req, 'checkout', { shopSlug: slugFromBody });
  if (!auth.ok) return auth.response;

  let body: FulfillmentBody;
  try {
    const raw = await readBody();
    if (isLegacyBody(raw)) {
      return errorResponse(req, 400, 'invalid_body', { formErrors: ['contract_removed: send fulfillment instead of contact'], fieldErrors: {} });
    }
    body = fulfillmentBodySchema.parse(raw);
  } catch (err) {
    return errorResponse(req, 400, 'invalid_body', err instanceof z.ZodError ? z.flattenError(err) : null);
  }

  const user = auth.data.user;
  const canonicalItems = [...body.items]
    .map((i) => [i.variantId, i.quantity] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const address = body.fulfillment.method === 'delivery' ? body.fulfillment.address : null;
  const requestHash = await sha256Hex(
    JSON.stringify({ s: body.shopSlug, i: canonicalItems, f: body.fulfillment.method, a: address, c: body.comment, cur: body.currency }),
  );

  // Probing guard: a buyer who already got too many "not enough stock" answers in this shop is stopped BEFORE the
  // order is attempted, so the answer no longer reveals whether a quantity fits (20261102090100).
  const guard = await serviceClient().rpc('checkout_stock_probe_guard', { p_shop_slug: body.shopSlug, p_customer_tg_id: user.id });
  if (guard.error) {
    if (guard.error.message === 'stock_check_limited') {
      const details = parseDbErrorDetails(guard.error.details);
      const res = errorResponse(req, 429, 'stock_check_limited', details);
      const retryAfter = (details as { retry_after_sec?: unknown } | null)?.retry_after_sec;
      if (typeof retryAfter === 'number') res.headers.set('Retry-After', String(retryAfter));
      return res;
    }
    console.error('checkout_stock_probe_guard failed', guard.error);
    return errorResponse(req, 500, 'internal_error');
  }

  const { data, error } = await serviceClient().rpc('create_order_v2', {
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
    p_fulfillment_method: body.fulfillment.method,
    p_delivery_address: address,
    p_comment: body.comment,
    p_expected_currency: body.currency,
    p_expected_total_minor: body.expectedTotalMinor ?? null,
  });

  if (error) {
    const status = DB_ERRORS[error.message];
    if (status) {
      let details = parseDbErrorDetails(error.details);
      if (error.message === 'insufficient_stock') {
        // Counted for the probing guard; the exact remaining quantity never leaves the server.
        const recorded = await serviceClient().rpc('checkout_record_stock_refusal', { p_shop_slug: body.shopSlug, p_customer_tg_id: user.id });
        if (recorded.error) console.error('checkout_record_stock_refusal failed', recorded.error.code ?? '');
        details = await insufficientStockDetails(details);
      }
      const res = errorResponse(req, status, error.message, details);
      const retryAfter = (details as { retry_after_sec?: unknown } | null)?.retry_after_sec;
      if (status === 429 && typeof retryAfter === 'number') res.headers.set('Retry-After', String(retryAfter));
      return res;
    }
    console.error('create_order_v2 failed', error);
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
