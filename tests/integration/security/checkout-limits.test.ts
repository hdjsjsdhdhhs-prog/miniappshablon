// Stage-3A regression suite for F-04 (inventory DoS: per-order size + per-buyer rate limits, enforced atomically in
// create_order_v2) and F-10 (accepted initData age per purpose). LOCAL ONLY.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { localStack } from '../../../scripts/lib/local-stack.ts';
import {
  admin,
  callFunction,
  checkoutBody,
  createOwner,
  createTestShop,
  env,
  initDataFor,
  newTelegramUserId,
  stockOf,
  type TestShop,
} from '../helpers';
import { cleanupSecurity, psqlAsync } from './sec-helpers';

afterAll(cleanupSecurity);

const now = () => Math.floor(Date.now() / 1000);
const errCode = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;

async function sql(q: string): Promise<string> {
  const r = await psqlAsync(q);
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}`);
  return r.out;
}

async function checkoutRaw(initData: string, body: unknown) {
  const res = await fetch(`${env.url}/functions/v1/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${env.anonKey}`, 'X-Telegram-Init-Data': initData },
    body: JSON.stringify(body),
  });
  return { status: res.status, retryAfter: res.headers.get('retry-after'), body: (await res.json()) as Record<string, unknown> };
}

const one = (S: TestShop, q = 1) => checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: q }]);
const bigShop = (stock = 1000) => createTestShop({ variants: [{ flavor: 'Mint', stock }] });

/** Moves this buyer's orders of the shop into the past (simulates time passing; local DB only). */
const age = (shopId: string, tg: number, interval: string) =>
  sql(`update public.orders set created_at = created_at - interval '${interval}' where shop_id = '${shopId}' and customer_tg_id = ${tg};`);
const confirmAll = (shopId: string, tg: number) =>
  sql(`update public.orders set status = 'confirmed' where shop_id = '${shopId}' and customer_tg_id = ${tg} and status = 'new';`);

/** Historical orders written directly (they only feed the counters). */
const history = (shopId: string, tg: number, n: number, ago: string, status = 'confirmed') =>
  sql(`insert into public.orders (shop_id, order_number, customer_tg_id, currency, total_minor, idempotency_key, request_hash, status, created_at, stock_state)
       select '${shopId}', 500000 + g + floor(random() * 100000)::int, ${tg}, 'RUB', 0, gen_random_uuid(), 'hist', '${status}', now() - interval '${ago}', 'restored'
       from generate_series(1, ${n}) g;`);

describe('F-04: repeated checkout by one buyer in one shop', () => {
  it('the same initData string: 3 orders in 10 minutes, then 429 rate_limited with Retry-After; stock only moves for the 3', async () => {
    const S = await bigShop(100);
    const tg = newTelegramUserId();
    const init = await initDataFor(tg);
    const res = [];
    for (let i = 0; i < 5; i++) res.push(await checkoutRaw(init, one(S, 10)));
    expect(res.map((r) => r.status)).toEqual([201, 201, 201, 429, 429]);
    expect(res[3]!.body.error).toMatchObject({ code: 'rate_limited', details: { scope: 'shop', window_sec: 600, limit: 3 } });
    const retry = Number(res[3]!.retryAfter);
    expect(retry).toBeGreaterThan(500);
    expect(retry).toBeLessThanOrEqual(600);
    expect(await stockOf(S.variants[0]!.id)).toBe(70);
  });

  it('an idempotent replay is answered even when the limit is reached (it creates nothing)', async () => {
    const S = await bigShop();
    const init = await initDataFor(newTelegramUserId());
    const bodies = [one(S), one(S), one(S)];
    for (const b of bodies) expect((await callFunction('checkout', init, b)).status).toBe(201);
    expect((await callFunction('checkout', init, one(S))).status).toBe(429);
    const replay = await callFunction('checkout', init, bodies[0]);
    expect(replay.status).toBe(200);
    expect(replay.body!.replayed).toBe(true);
    expect(await stockOf(S.variants[0]!.id)).toBe(997);
  });

  it('window boundary: 30 s before the 10-minute window ends still refused; right after it ends the next order passes', async () => {
    const S = await bigShop();
    const tg = newTelegramUserId();
    const init = await initDataFor(tg);
    for (let i = 0; i < 3; i++) expect((await callFunction('checkout', init, one(S))).status).toBe(201);
    await confirmAll(S.id, tg); // the owner processed them: only the time window is tested here
    await age(S.id, tg, '9 minutes 30 seconds');
    expect(errCode(await callFunction('checkout', init, one(S)))).toBe('rate_limited');
    await age(S.id, tg, '31 seconds');
    expect((await callFunction('checkout', init, one(S))).status).toBe(201);
  });

  it('unprocessed orders: with 3 "new" orders (outside the burst window) the 4th is refused until the owner confirms one', async () => {
    const S = await bigShop();
    const owner = await createOwner(S.id);
    const tg = newTelegramUserId();
    const init = await initDataFor(tg);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(((await callFunction('checkout', init, one(S))).body!.order as { id: string }).id);
    await age(S.id, tg, '11 minutes');
    const refused = await callFunction('checkout', init, one(S));
    expect(refused.status).toBe(429);
    expect(refused.body!.error).toMatchObject({ code: 'too_many_open_orders', details: { limit: 3, open: 3 } });
    expect((await owner.client.rpc('admin_set_order_status', { p_order_id: ids[0]!, p_status: 'confirmed' })).error).toBeNull();
    expect((await callFunction('checkout', init, one(S))).status).toBe(201);
  });

  it('daily cap: 10 orders of this buyer in this shop within 24 h → refused (window 86400)', async () => {
    const S = await bigShop();
    const tg = newTelegramUserId();
    await history(S.id, tg, 10, '2 hours');
    const res = await callFunction('checkout', await initDataFor(tg), one(S));
    expect(res.status).toBe(429);
    expect(res.body!.error).toMatchObject({ code: 'rate_limited', details: { scope: 'shop', window_sec: 86400, limit: 10 } });
    // 25 h later they no longer count.
    await age(S.id, tg, '23 hours');
    expect((await callFunction('checkout', await initDataFor(tg), one(S))).status).toBe(201);
  });
});

describe('F-04: size of one order', () => {
  it('4 950 units in one request → 422 order_too_large, nothing deducted; exactly 200 units → accepted', async () => {
    const specs = Array.from({ length: 50 }, (_, i) => ({ flavor: `F${i}`, stock: 99 }));
    const T = await createTestShop({ variants: specs });
    const all = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(T, T.variants.map((v) => ({ variantId: v.id, quantity: 99 }))));
    expect(all.status).toBe(422);
    expect(all.body!.error).toMatchObject({ code: 'order_too_large', details: { max_units: 200, units: 4950 } });
    expect(await sql(`select sum(stock_quantity) from public.product_variants where shop_id = '${T.id}';`)).toBe('4950');
    const max = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(T, [
      { variantId: T.variants[0]!.id, quantity: 99 }, { variantId: T.variants[1]!.id, quantity: 99 }, { variantId: T.variants[2]!.id, quantity: 2 },
    ]));
    expect(max.status, JSON.stringify(max.body)).toBe(201);
    const over = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(T, [
      { variantId: T.variants[3]!.id, quantity: 99 }, { variantId: T.variants[4]!.id, quantity: 99 }, { variantId: T.variants[5]!.id, quantity: 3 },
    ]));
    expect(errCode(over)).toBe('order_too_large');
  });

  it('a shop can get its own (commercial) limit without a migration: private.checkout_limits', async () => {
    const specs = Array.from({ length: 6 }, (_, i) => ({ flavor: `W${i}`, stock: 99 }));
    const W = await createTestShop({ variants: specs });
    await sql(`insert into private.checkout_limits (shop_id, max_units_per_order, note) values ('${W.id}', 594, 'wholesale (test)');`);
    const res = await callFunction('checkout', await initDataFor(newTelegramUserId()), checkoutBody(W, W.variants.map((v) => ({ variantId: v.id, quantity: 99 }))));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe('F-04: concurrency and tenants', () => {
  it('10 parallel checkouts of ONE buyer (different idempotency keys): exactly 3 orders, 7 × 429, stock exact, no 500', async () => {
    const S = await bigShop(50);
    const init = await initDataFor(newTelegramUserId());
    const res = await Promise.all(Array.from({ length: 10 }, () => callFunction('checkout', init, one(S, 5))));
    const codes = res.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
    expect(await stockOf(S.variants[0]!.id)).toBe(35);
  });

  it('parallel buyers on scarce stock: never negative, never more units sold than stocked', async () => {
    const S = await bigShop(7);
    const res = await Promise.all(Array.from({ length: 10 }, async () => callFunction('checkout', await initDataFor(newTelegramUserId()), one(S, 2))));
    expect(res.filter((r) => r.status === 201)).toHaveLength(3);
    expect(res.every((r) => r.status !== 500)).toBe(true);
    expect(await stockOf(S.variants[0]!.id)).toBe(1);
  });

  it('two different Telegram users have separate quotas', async () => {
    const S = await bigShop();
    const [a, b] = [await initDataFor(newTelegramUserId()), await initDataFor(newTelegramUserId())];
    for (let i = 0; i < 3; i++) expect((await callFunction('checkout', a, one(S))).status).toBe(201);
    expect((await callFunction('checkout', a, one(S))).status).toBe(429);
    expect((await callFunction('checkout', b, one(S))).status).toBe(201);
  });

  it('two shops / one initData in several shops: quotas are per tenant (no global block of the initData)', async () => {
    const [S1, S2] = [await bigShop(), await bigShop()];
    const init = await initDataFor(newTelegramUserId());
    for (let i = 0; i < 3; i++) expect((await callFunction('checkout', init, one(S1))).status).toBe(201);
    expect((await callFunction('checkout', init, one(S1))).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await callFunction('checkout', init, one(S2))).status).toBe(201);
  });

  it('platform-wide cap: 20 orders of one buyer across shops within an hour → refused in any further shop', async () => {
    const [H, S] = [await bigShop(), await bigShop()];
    const tg = newTelegramUserId();
    await history(H.id, tg, 20, '30 minutes');
    const res = await callFunction('checkout', await initDataFor(tg), one(S));
    expect(res.status).toBe(429);
    expect(res.body!.error).toMatchObject({ code: 'rate_limited', details: { scope: 'platform', window_sec: 3600, limit: 20 } });
    expect(await stockOf(S.variants[0]!.id)).toBe(1000);
  });

  it('changing request parameters does not reset the counter; a forged user in initData is refused', async () => {
    const S = await bigShop();
    const tg = newTelegramUserId();
    const init = await initDataFor(tg);
    for (let i = 0; i < 3; i++) expect((await callFunction('checkout', init, one(S))).status).toBe(201);
    const variants = [
      one(S, 2),
      { ...one(S), comment: 'другой комментарий' },
      { ...one(S), fulfillment: { method: 'delivery', address: 'ул. Другая, 3' } },
      { ...one(S), customer_tg_id: 1, p_customer_tg_id: 1, userId: 1, user: { id: 1 } },
      { ...one(S), idempotencyKey: randomUUID() },
    ];
    for (const b of variants) expect(errCode(await callFunction('checkout', init, b)), JSON.stringify(b)).toBe('rate_limited');
    // Changing the user inside initData without the bot token breaks the signature.
    const forged = new URLSearchParams(init);
    forged.set('user', JSON.stringify({ id: newTelegramUserId(), first_name: 'Forged' }));
    const f = await callFunction('checkout', forged.toString(), one(S));
    expect(f.status).toBe(401);
    expect((await admin.from('orders').select('id').eq('shop_id', S.id)).data).toHaveLength(3);
  });

  it('positive control: ordinary LIVE checkout and buyer history keep working', async () => {
    const S = await bigShop(5);
    const tg = newTelegramUserId();
    const init = await initDataFor(tg);
    const res = await callFunction('checkout', init, checkoutBody(S, [{ variantId: S.variants[0]!.id, quantity: 2 }], { fulfillment: { method: 'delivery', address: 'пр. Мира, 1' } }));
    expect(res.status).toBe(201);
    const mine = await callFunction('my-orders', init, { shopSlug: S.slug });
    expect((mine.body!.orders as Array<{ id: string }>).map((o) => o.id)).toEqual([(res.body!.order as { id: string }).id]);
    expect(await stockOf(S.variants[0]!.id)).toBe(3);
  });
});

describe('F-10: accepted initData age (checkout 1 h, my-orders 2 h; TELEGRAM_INITDATA_MAX_AGE_SEC can only shorten)', () => {
  it('the local Edge Runtime still has the old 24 h value configured — the code cap wins', async () => {
    const r = await new Promise<string>((resolve) => {
      import('node:child_process').then(({ execFile }) =>
        execFile('docker', ['inspect', localStack().edgeRuntimeContainer, '--format', '{{range .Config.Env}}{{println .}}{{end}}'], (_e, out) => resolve(String(out))),
      );
    });
    expect(r).toContain('TELEGRAM_INITDATA_MAX_AGE_SEC=86400');
  });

  it('checkout: fresh ok; 30 s inside the 1 h limit ok; 30 s past it → 401 expired', async () => {
    const S = await bigShop();
    expect((await callFunction('checkout', await initDataFor(newTelegramUserId()), one(S))).status).toBe(201);
    expect((await callFunction('checkout', await initDataFor(newTelegramUserId(), { authDate: now() - 3600 + 30 }), one(S))).status).toBe(201);
    const old = await callFunction('checkout', await initDataFor(newTelegramUserId(), { authDate: now() - 3600 - 30 }), one(S));
    expect(old.status).toBe(401);
    expect(old.body!.error).toMatchObject({ code: 'telegram_auth_failed', details: { reason: 'expired' } });
  });

  it('my-orders: 2 h limit; an initData too old for checkout (1.5 h) still reads the history', async () => {
    const S = await bigShop();
    const tg = newTelegramUserId();
    const mid = await initDataFor(tg, { authDate: now() - 5400 });
    expect(errCode(await callFunction('checkout', mid, one(S)))).toBe('telegram_auth_failed');
    expect((await callFunction('my-orders', mid, { shopSlug: S.slug })).status).toBe(200);
    expect((await callFunction('my-orders', await initDataFor(tg, { authDate: now() - 7200 + 30 }), { shopSlug: S.slug })).status).toBe(200);
    const old = await callFunction('my-orders', await initDataFor(tg, { authDate: now() - 7200 - 30 }), { shopSlug: S.slug });
    expect(old.status).toBe(401);
    expect(old.body!.error).toMatchObject({ details: { reason: 'expired' } });
  });

  it('future auth_date: small clock skew (30 s) accepted, 2 minutes ahead → from_future (both functions)', async () => {
    const S = await bigShop();
    expect((await callFunction('checkout', await initDataFor(newTelegramUserId(), { authDate: now() + 30 }), one(S))).status).toBe(201);
    for (const fn of ['checkout', 'my-orders'] as const) {
      const res = await callFunction(fn, await initDataFor(newTelegramUserId(), { authDate: now() + 120 }), fn === 'checkout' ? one(S) : { shopSlug: S.slug });
      expect(res.status, fn).toBe(401);
      expect(res.body!.error, fn).toMatchObject({ details: { reason: 'from_future' } });
    }
  });
});
