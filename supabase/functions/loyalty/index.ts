// POST /functions/v1/loyalty
// «Бонусы и промокоды» of one shop, for its owner (or a platform admin in an aal2 / MFA session): the bonus program,
// automatic discounts by order total and promo codes. Every action re-checks the actor in SQL
// (private.assert_can_manage_shop; `dispatch` accepts any shop member) — nothing in the body chooses another shop's data.
//
// Body: { action, shopId, … }
//   get                                                    → { overview }
//   save-settings  bonusEnabled? bonusPercent? discountEnabled? promoEnabled?   → { overview }
//   rule-save      ruleId? minTotalMinor percent            → { overview }
//   rule-delete    ruleId                                   → { overview }
//   promo-save     promoId? code discountType value maxActivations isActive?   → { overview }
//   promo-set-active  promoId active                        → { overview }
//   promo-delete   promoId                                  → { overview }
//   promo-history  promoId                                  → { history }
//   dispatch                                                → { sent, failed, skipped }  (bonus notifications of the shop)
import { z } from 'npm:zod@4.6.7';
import { actorClient, RPC_ERRORS, telegramApiBase, verifyAdminUser } from '../_shared/admin-auth.ts';
import type { serviceClient } from '../_shared/auth.ts';
import { dispatchBonusNotifications } from '../_shared/bonus-notification.ts';
import { corsHeaders, errorResponse, json, parseDbErrorDetails } from '../_shared/http.ts';

const shopId = z.uuid();
const percentInt = z.number().int().min(1).max(90);

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get'), shopId }),
  z.object({
    action: z.literal('save-settings'),
    shopId,
    bonusEnabled: z.boolean().optional(),
    // Up to two decimals (checked in SQL as well): 2.5 % is fine, 2.555 % is not.
    bonusPercent: z.number().gt(0).max(100).optional(),
    discountEnabled: z.boolean().optional(),
    promoEnabled: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('rule-save'),
    shopId,
    ruleId: z.uuid().optional(),
    minTotalMinor: z.number().int().min(1).max(100_000_000_000),
    percent: percentInt,
  }),
  z.object({ action: z.literal('rule-delete'), shopId, ruleId: z.uuid() }),
  z.object({
    action: z.literal('promo-save'),
    shopId,
    promoId: z.uuid().optional(),
    code: z.string().trim().max(40),
    discountType: z.enum(['percent', 'fixed']),
    value: z.number().int().min(1).max(100_000_000_000),
    maxActivations: z.number().int().min(1).max(1_000_000),
    isActive: z.boolean().optional(),
  }),
  z.object({ action: z.literal('promo-set-active'), shopId, promoId: z.uuid(), active: z.boolean() }),
  z.object({ action: z.literal('promo-delete'), shopId, promoId: z.uuid() }),
  z.object({ action: z.literal('promo-history'), shopId, promoId: z.uuid() }),
  z.object({ action: z.literal('dispatch'), shopId }),
]);

type Db = ReturnType<typeof serviceClient>;

async function rpc(db: Db, req: Request, fn: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(fn, args);
  if (error) {
    const status = RPC_ERRORS[error.message];
    if (status) return { ok: false as const, response: errorResponse(req, status, error.message, parseDbErrorDetails(error.details)) };
    console.error(`${fn} failed`, error.code ?? '', error.message);
    return { ok: false as const, response: errorResponse(req, 500, 'internal_error') };
  }
  return { ok: true as const, data };
}

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

  // A platform admin acts only in an aal2 session (forwarded to the SQL); an owner's rights do not depend on it.
  const db = actorClient(auth);
  const actor = { p_shop_id: body.shopId, p_actor: auth.userId };
  const overview = async () => {
    const res = await rpc(db, req, 'loyalty_get_overview', actor);
    return res.ok ? { ok: true as const, response: json(req, 200, { overview: res.data }) } : res;
  };

  switch (body.action) {
    case 'get': {
      const res = await overview();
      return res.response;
    }

    case 'save-settings': {
      const res = await rpc(db, req, 'loyalty_save_settings', {
        ...actor,
        p_bonus_enabled: body.bonusEnabled ?? null,
        p_bonus_percent: body.bonusPercent ?? null,
        p_discount_enabled: body.discountEnabled ?? null,
        p_promo_enabled: body.promoEnabled ?? null,
      });
      if (!res.ok) return res.response;
      return (await overview()).response;
    }

    case 'rule-save': {
      const res = await rpc(db, req, 'loyalty_save_rule', {
        ...actor,
        p_rule_id: body.ruleId ?? null,
        p_min_total_minor: body.minTotalMinor,
        p_percent: body.percent,
      });
      if (!res.ok) return res.response;
      return (await overview()).response;
    }

    case 'rule-delete': {
      const res = await rpc(db, req, 'loyalty_delete_rule', { ...actor, p_rule_id: body.ruleId });
      if (!res.ok) return res.response;
      return (await overview()).response;
    }

    case 'promo-save': {
      const res = await rpc(db, req, 'loyalty_save_promo', {
        ...actor,
        p_promo_id: body.promoId ?? null,
        p_code: body.code,
        p_discount_type: body.discountType,
        p_value: body.value,
        p_max_activations: body.maxActivations,
        p_is_active: body.isActive ?? null,
      });
      if (!res.ok) return res.response;
      return (await overview()).response;
    }

    case 'promo-set-active': {
      const res = await rpc(db, req, 'loyalty_set_promo_active', { ...actor, p_promo_id: body.promoId, p_active: body.active });
      if (!res.ok) return res.response;
      return (await overview()).response;
    }

    case 'promo-delete': {
      const res = await rpc(db, req, 'loyalty_delete_promo', { ...actor, p_promo_id: body.promoId });
      if (!res.ok) return res.response;
      return (await overview()).response;
    }

    case 'promo-history': {
      const res = await rpc(db, req, 'loyalty_promo_history', { ...actor, p_promo_id: body.promoId, p_limit: 50 });
      if (!res.ok) return res.response;
      return json(req, 200, { history: res.data });
    }

    case 'dispatch': {
      // Sends the «🎁 начислено …» messages queued by order confirmations of this shop (and retries the due ones).
      const result = await dispatchBonusNotifications((fn, args) => db.rpc(fn, args), {
        actor: auth.userId,
        shopId: body.shopId,
        limit: 20,
        apiBase: telegramApiBase(),
      });
      if (result.error) {
        const status = RPC_ERRORS[result.error];
        if (status) return errorResponse(req, status, result.error);
        return errorResponse(req, 500, 'internal_error');
      }
      return json(req, 200, result);
    }
  }
});
