// "Ваш заказ оформлен!" — the buyer's copy of a new order (20261113090000: outbox private.customer_order_notifications,
// customer_notify_* RPCs, checkout Edge Function). LOCAL ONLY; every Telegram call goes to the local mock Bot API
// (global-setup refuses to run otherwise); only fake tokens.
// Covers: who gets the message (only a buyer who started THIS shop's bot — never through the platform bot or another
// shop's bot), its content (no personal data), one message per order (replays), independence from the admin channel,
// retries with backoff, blocked buyers, a send with an unknown outcome (never repeated), a replaced bot, the 24-hour
// limit, an ownership change, an order that must survive a broken outbox, and access control.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockFailNext, mockMessages } from '../../../scripts/lib/telegram-mock.ts';
import { formatMinor } from '../../../supabase/functions/_shared/order-notification.ts';
import {
  admin,
  anon,
  callAdminFunction,
  callFunction,
  checkoutBody,
  createMember,
  createPlatformAdmin,
  createTestShop,
  fakeBotToken,
  initDataFor,
  localSqlRolledBack,
  newTelegramUserId,
  waitFor,
  type Db,
  type TestShop,
} from '../helpers';
import { botFn, botIdOf, deliver, memberStatus, privateMessage, shopWithBot, sql, starter, type BotShop } from './bot-helpers';
import { cleanupSecurity, psqlAsync, svcRpc } from './sec-helpers';

const run = randomBytes(3).toString('hex');
const rub = (minor: number) => formatMinor(minor, 'RUB');
const ORDER_TITLE = 'Ваш заказ оформлен!';

/** The order confirmations a chat received (the /start welcome is not one of them). */
const confirmations = async (user: number) => (await mockMessages(String(user))).filter((m) => m.text.includes(ORDER_TITLE));

interface OutboxRow {
  id: number;
  status: string;
  attempts: number;
  last_error: string | null;
  bot_id: number;
  tg_user_id: number;
  chat_id: number;
  telegram_message_id: number | null;
}
async function outbox(orderId: string): Promise<OutboxRow | null> {
  return JSON.parse(
    await sql(`select coalesce((select row_to_json(n)::text from private.customer_order_notifications n where n.order_id = '${orderId}'), 'null');`),
  ) as OutboxRow | null;
}
const settled = (orderId: string, status: string) => waitFor(() => outbox(orderId), (r) => r?.status === status);

interface PlacedOrder {
  id: string;
  order_number: number;
  total_minor: number;
}
/** Checkout of one variant by `buyer`. `token`: the bot that signed the Mini App's initData (default: platform bot). */
async function placeOrder(shop: TestShop, buyer: number, opts: { token?: string; key?: string; quantity?: number; extra?: Record<string, unknown> } = {}) {
  const body = checkoutBody(shop, [{ variantId: shop.variants[0]!.id, quantity: opts.quantity ?? 1 }], {
    ...(opts.key ? { idempotencyKey: opts.key } : {}),
    ...opts.extra,
  });
  const res = await callFunction('checkout', await initDataFor(buyer, opts.token ? { token: opts.token } : {}), body);
  return { res, key: body.idempotencyKey, order: res.body?.order as PlacedOrder | undefined };
}

const shopSpec = { basePrice: 69_000, variants: [{ flavor: 'Черника', stock: 200 }] };
const claim = (orderId: string) => svcRpc('customer_notify_claim', { p_order_id: orderId, p_shop_id: null, p_limit: 1 });
const due = (orderId: string) => sql(`update private.customer_order_notifications set next_attempt_at = now() where order_id = '${orderId}';`);

/** An order whose confirmation failed once (Telegram 500) and now waits for its retry time. */
async function failedOnce(S: BotShop) {
  const buyer = await starter(S.token);
  await mockFailNext(String(buyer), 1, 500);
  const placed = await placeOrder(S.shop, buyer);
  expect(placed.res.status, JSON.stringify(placed.res.body)).toBe(201);
  const row = await settled(placed.order!.id, 'failed');
  expect(row).toMatchObject({ status: 'failed', attempts: 1 });
  return { buyer, orderId: placed.order!.id, row: row! };
}

let A: BotShop;
let B: BotShop;

beforeAll(async () => {
  A = await shopWithBot({ shop: shopSpec });
  B = await shopWithBot({ shop: shopSpec });
});
afterAll(cleanupSecurity);

describe('who gets the confirmation and what it says', () => {
  it('a buyer who started the shop’s bot gets exactly one message, through that bot, with the order and nothing personal', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    // Sold with a discount: the buyer sees the price that was charged.
    const { error } = await admin.from('products').update({ discount_price_minor: 59_000 }).eq('id', X.shop.productId);
    expect(error).toBeNull();
    const buyer = await starter(X.token);
    // The Mini App was opened from the shop's own bot.
    const placed = await placeOrder(X.shop, buyer, {
      token: X.token,
      quantity: 2,
      extra: { fulfillment: { method: 'delivery', address: 'ул. Тайная, 7, кв. 12' }, comment: 'Код домофона 4521' },
    });
    expect(placed.res.status, JSON.stringify(placed.res.body)).toBe(201);
    const order = placed.order!;
    expect(order.total_minor).toBe(118_000);

    const row = await settled(order.id, 'sent');
    expect(row).toMatchObject({ status: 'sent', attempts: 1, last_error: null, bot_id: botIdOf(X.token), tg_user_id: buyer, chat_id: buyer });
    const [msg, ...rest] = await confirmations(buyer);
    expect(rest).toEqual([]);
    expect(msg!.bot_id).toBe(botIdOf(X.token));
    expect(msg!.message_id).toBe(row!.telegram_message_id);
    expect(msg!.parse_mode).toBe('HTML');
    expect(msg!.reply_markup).toBeNull();
    expect(msg!.text.split('\n')).toEqual([
      '✅ <b>Ваш заказ оформлен!</b>',
      '',
      `<b>Номер заказа:</b> №${order.order_number}`,
      '<b>Состав заказа:</b>',
      `1. Liquid · Черника — 2 × ${rub(59_000)} = ${rub(118_000)}`,
      `<b>Сумма:</b> ${rub(118_000)}`,
      '<b>Способ получения:</b> доставка',
      '',
      'Ваш заказ оформлен. Скоро с вами свяжется менеджер для подтверждения заказа.',
    ]);
    // Nothing the buyer typed or Telegram knows about them: no address, comment, name, username or id.
    for (const personal of ['Тайная', 'кв. 12', '4521', 'Tester', `u${buyer}`, String(buyer)]) expect(msg!.text, personal).not.toContain(personal);
  });

  it('nothing is queued or sent for a buyer who never started the bot, started ANOTHER shop’s bot, or for a shop without a bot', async () => {
    const stranger = newTelegramUserId();
    const strangerOrder = await placeOrder(A.shop, stranger);
    expect(strangerOrder.res.status).toBe(201);

    // Started shop B's bot, orders in shop A: A's bot may not write to this user.
    const fromB = await starter(B.token);
    const crossOrder = await placeOrder(A.shop, fromB);
    expect(crossOrder.res.status).toBe(201);

    const noBot = await createTestShop(shopSpec);
    const noBotOrder = await placeOrder(noBot, fromB);
    expect(noBotOrder.res.status).toBe(201);

    // The same buyer in the shop whose bot they started does get it (so the absence above is not an accident).
    const own = await placeOrder(B.shop, fromB);
    expect(own.res.status).toBe(201);
    await settled(own.order!.id, 'sent');

    for (const o of [strangerOrder, crossOrder, noBotOrder]) expect(await outbox(o.order!.id)).toBeNull();
    expect(await confirmations(stranger)).toEqual([]);
    const got = await confirmations(fromB);
    expect(got).toHaveLength(1);
    expect(got[0]!.bot_id).toBe(botIdOf(B.token));
    expect(got[0]!.text).toContain(`№${own.order!.order_number}`);
  });

  it('/stop (no broadcasts) does not stop order confirmations; a buyer who blocked the bot gets nothing', async () => {
    const unsubscribed = await starter(A.token);
    await deliver(A.token, privateMessage(unsubscribed, '/stop'));
    expect(await sql(`select status from private.bot_subscribers where shop_id = '${A.shop.id}' and tg_user_id = ${unsubscribed};`)).toBe('unsubscribed');
    const first = await placeOrder(A.shop, unsubscribed);
    expect(first.res.status).toBe(201);
    await settled(first.order!.id, 'sent');
    expect(await confirmations(unsubscribed)).toHaveLength(1);

    const blocked = await starter(A.token);
    await deliver(A.token, memberStatus(blocked, 'kicked'));
    const second = await placeOrder(A.shop, blocked);
    expect(second.res.status).toBe(201);
    expect(await outbox(second.order!.id)).toBeNull();
    expect(await confirmations(blocked)).toEqual([]);
  });

  it('a replayed checkout (same idempotency key) sends nothing new: one row and one message per order, ever', async () => {
    const buyer = await starter(A.token);
    const first = await placeOrder(A.shop, buyer);
    expect(first.res.status).toBe(201);
    await settled(first.order!.id, 'sent');
    const again = await placeOrder(A.shop, buyer, { key: first.key });
    expect([again.res.status, again.res.body!.replayed, again.order!.id]).toEqual([200, true, first.order!.id]);
    // A second dispatch for the same order finds nothing to claim.
    expect((await claim(first.order!.id)).data).toEqual([]);
    expect(await confirmations(buyer)).toHaveLength(1);
    expect(await sql(`select count(*) from private.customer_order_notifications where order_id = '${first.order!.id}';`)).toBe('1');
    const dup = await psqlAsync(
      `insert into private.customer_order_notifications (shop_id, order_id, bot_id, tg_user_id, chat_id)
       values ('${A.shop.id}', '${first.order!.id}', ${botIdOf(A.token)}, ${buyer}, ${buyer});`,
    );
    expect(dup.code).not.toBe(0);
    expect(dup.err).toMatch(/customer_order_notifications_order_id_key/);
  });

  it('the admin chat and the buyer are independent channels: a failure of one never holds back the other', async () => {
    // Admin channel broken (every send fails), buyer channel fine.
    const X = await shopWithBot({ shop: shopSpec });
    const brokenChat = `@cn_alwaysfail_${run}`;
    const saved = await callAdminFunction('notification-settings', X.owner.client, { action: 'save', shopId: X.shop.id, botToken: fakeBotToken(), chatId: brokenChat });
    expect(saved.status, saved.text).toBe(200);
    const buyer = await starter(X.token);
    const placed = await placeOrder(X.shop, buyer);
    expect(placed.res.status).toBe(201);
    await settled(placed.order!.id, 'sent');
    expect(await confirmations(buyer)).toHaveLength(1);
    expect(await mockMessages(brokenChat)).toEqual([]);
    expect(await sql(`select status from private.order_notifications where order_id = '${placed.order!.id}';`)).not.toBe('sent');

    // Buyer channel broken, admin channel fine.
    const Y = await shopWithBot({ shop: shopSpec });
    const adminChat = `@cn_orders_${run}`;
    expect((await callAdminFunction('notification-settings', Y.owner.client, { action: 'save', shopId: Y.shop.id, botToken: fakeBotToken(), chatId: adminChat })).status).toBe(200);
    const unlucky = await starter(Y.token);
    await mockFailNext(String(unlucky), 1, 500);
    const second = await placeOrder(Y.shop, unlucky);
    expect(second.res.status).toBe(201);
    await settled(second.order!.id, 'failed');
    const adminMessages = await waitFor(() => mockMessages(adminChat), (m) => m.some((x) => x.text.includes(`Новый заказ №${second.order!.order_number}</b>`)));
    expect(adminMessages.filter((x) => x.text.includes(`Новый заказ №${second.order!.order_number}</b>`))).toHaveLength(1);
    expect(await confirmations(unlucky)).toEqual([]);
  });
});

describe('failures and retries', () => {
  it('a transient Telegram error is retried later with backoff, by the next checkout of the shop — delivered once', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const { buyer, orderId, row } = await failedOnce(X);
    expect(row.last_error).toMatch(/^telegram_unavailable/);
    const waitSec = Number(await sql(`select extract(epoch from next_attempt_at - now()) from private.customer_order_notifications where order_id = '${orderId}';`));
    expect(waitSec).toBeGreaterThan(20);
    expect(waitSec).toBeLessThan(31);
    expect(await confirmations(buyer)).toEqual([]);

    // Not due yet: another order of the shop does not send it.
    const early = await placeOrder(X.shop, newTelegramUserId());
    expect(early.res.status).toBe(201);
    expect(await outbox(orderId)).toMatchObject({ status: 'failed', attempts: 1 });
    // The retry time comes; the next checkout of the shop picks it up.
    await due(orderId);
    expect((await placeOrder(X.shop, newTelegramUserId())).res.status).toBe(201);
    expect(await settled(orderId, 'sent')).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
    expect(await confirmations(buyer)).toHaveLength(1);
  });

  it('the buyer blocked the bot (Telegram 403): no retry, and the buyer leaves the audience', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const buyer = await starter(X.token);
    await mockFailNext(String(buyer), 5, 403);
    const placed = await placeOrder(X.shop, buyer);
    expect(placed.res.status).toBe(201);
    const row = await settled(placed.order!.id, 'dead');
    expect(row).toMatchObject({ status: 'dead', attempts: 1 });
    expect(row!.last_error).toMatch(/blocked by the user/);
    expect(await sql(`select status from private.bot_subscribers where shop_id = '${X.shop.id}' and tg_user_id = ${buyer};`)).toBe('blocked');
    // Dead is final, and the next order of this buyer does not even queue a message.
    await due(placed.order!.id);
    expect((await claim(placed.order!.id)).data).toEqual([]);
    const next = await placeOrder(X.shop, buyer);
    expect(next.res.status).toBe(201);
    expect(await outbox(next.order!.id)).toBeNull();
    expect(await confirmations(buyer)).toEqual([]);
  });

  it('the backoff doubles and the fifth failed attempt is the last one', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const { buyer, orderId, row } = await failedOnce(X);
    await due(orderId);
    const second = (await claim(orderId)).data as Array<{ notification_id: number; attempt: number }>;
    expect(second).toMatchObject([{ notification_id: row.id, attempt: 2 }]);
    expect((await svcRpc('customer_notify_complete', { p_notification_id: row.id, p_ok: false, p_message_id: null, p_error: 'telegram_unavailable: again', p_blocked: false })).error).toBeNull();
    expect(await outbox(orderId)).toMatchObject({ status: 'failed', attempts: 2, last_error: 'telegram_unavailable: again' });
    const waitSec = Number(await sql(`select extract(epoch from next_attempt_at - now()) from private.customer_order_notifications where order_id = '${orderId}';`));
    expect(waitSec).toBeGreaterThan(50);
    expect(waitSec).toBeLessThan(61);

    await sql(`update private.customer_order_notifications set attempts = 4, next_attempt_at = now() where order_id = '${orderId}';`);
    expect((await claim(orderId)).data).toMatchObject([{ attempt: 5 }]);
    await svcRpc('customer_notify_complete', { p_notification_id: row.id, p_ok: false, p_message_id: null, p_error: 'telegram_unavailable: last', p_blocked: false });
    expect(await outbox(orderId)).toMatchObject({ status: 'dead', attempts: 5 });
    await due(orderId);
    expect((await claim(orderId)).data).toEqual([]);
    expect(await confirmations(buyer)).toEqual([]);
  });
});

describe('outbox contract: at most one message, only through the bot the buyer started', () => {
  it('a claim carries the shop’s bot and the order; right before sending it is re-validated', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const { buyer, orderId, row } = await failedOnce(X);
    await due(orderId);
    const jobs = (await claim(orderId)).data as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ notification_id: row.id, attempt: 2, bot_id: botIdOf(X.token), chat_id: buyer, bot_token: X.token, shop_name: `IT ${X.shop.slug}` });
    expect((jobs[0]!.order as { id: string }).id).toBe(orderId);
    // Held by this attempt: a second worker gets nothing.
    expect((await claim(orderId)).data).toEqual([]);

    const begin = async (over: Record<string, unknown> = {}) =>
      (await svcRpc('customer_notify_begin_send', { p_notification_id: row.id, p_attempt: 2, p_bot_id: botIdOf(X.token), ...over })).data;
    expect(await begin()).toBe(true);
    expect(await begin({ p_attempt: 1 })).toBe(false);
    expect(await begin({ p_bot_id: botIdOf(B.token) })).toBe(false);
    // The buyer blocks the bot between the claim and the send: nothing may be sent.
    await deliver(X.token, memberStatus(buyer, 'kicked'));
    expect(await begin()).toBe(false);
    await deliver(X.token, memberStatus(buyer, 'member'));
    expect(await begin()).toBe(true);
  });

  it('a send whose outcome is unknown (the worker died) is never repeated', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const { buyer, orderId, row } = await failedOnce(X);
    await due(orderId);
    expect((await claim(orderId)).data).toHaveLength(1);
    // The worker vanished; its claim expired.
    await sql(`update private.customer_order_notifications set locked_until = now() - interval '1 second' where order_id = '${orderId}';`);
    expect((await svcRpc('customer_notify_begin_send', { p_notification_id: row.id, p_attempt: 2, p_bot_id: botIdOf(X.token) })).data).toBe(false);
    expect((await claim(orderId)).data).toEqual([]);
    expect(await outbox(orderId)).toMatchObject({ status: 'dead', attempts: 2, last_error: 'interrupted' });
    // A late report of the lost worker changes nothing, and later checkouts of the shop do not resend it.
    await svcRpc('customer_notify_complete', { p_notification_id: row.id, p_ok: true, p_message_id: 1, p_error: null, p_blocked: false });
    expect(await outbox(orderId)).toMatchObject({ status: 'dead', telegram_message_id: null });
    expect((await placeOrder(X.shop, newTelegramUserId())).res.status).toBe(201);
    expect(await outbox(orderId)).toMatchObject({ status: 'dead' });
    expect(await confirmations(buyer)).toEqual([]);
  });

  it('a replaced bot never writes to buyers of the former bot: queued messages die, new orders queue nothing', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const { buyer, orderId } = await failedOnce(X);
    const replacement = fakeBotToken();
    expect((await botFn(X.owner.client, { action: 'connect', shopId: X.shop.id, botToken: replacement })).status).toBe(200);
    await due(orderId);
    expect((await claim(orderId)).data).toEqual([]);
    expect(await outbox(orderId)).toMatchObject({ status: 'dead', last_error: 'bot_changed' });
    const next = await placeOrder(X.shop, buyer);
    expect(next.res.status).toBe(201);
    expect(await outbox(next.order!.id)).toBeNull();
    expect(await confirmations(buyer)).toEqual([]);
    // A buyer of the new bot is served by the new bot.
    const fresh = await starter(replacement);
    const served = await placeOrder(X.shop, fresh);
    await settled(served.order!.id, 'sent');
    expect((await confirmations(fresh)).map((m) => m.bot_id)).toEqual([botIdOf(replacement)]);
  });

  it('a confirmation older than 24 hours is not sent any more', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const { buyer, orderId } = await failedOnce(X);
    await sql(`update private.customer_order_notifications set created_at = now() - interval '25 hours', next_attempt_at = now() where order_id = '${orderId}';`);
    expect((await claim(orderId)).data).toEqual([]);
    expect((await placeOrder(X.shop, newTelegramUserId())).res.status).toBe(201);
    expect(await outbox(orderId)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(await confirmations(buyer)).toEqual([]);
  });

  it('an ownership change drops what was queued for the former owner’s bot', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const { buyer, orderId } = await failedOnce(X);
    const pa = await createPlatformAdmin();
    const next = await createMember(B.shop.id, 'manager'); // any confirmed account
    const transfer = await callAdminFunction('platform-admin', pa.client, { action: 'transfer', shopId: X.shop.id, userId: next.userId });
    expect(transfer.status, transfer.text).toBe(200);
    expect(await outbox(orderId)).toMatchObject({ status: 'dead', last_error: 'owner_changed' });
    await due(orderId);
    expect((await claim(orderId)).data).toEqual([]);
    expect(await sql(`select count(*) from private.bot_subscribers where shop_id = '${X.shop.id}';`)).toBe('0');
    expect(await confirmations(buyer)).toEqual([]);
  });
});

describe('the order never depends on the confirmation', () => {
  it('a broken outbox does not fail the checkout transaction (the message is only skipped)', async () => {
    const X = await shopWithBot({ shop: shopSpec });
    const buyer = await starter(X.token);
    const order = (broken: boolean) =>
      localSqlRolledBack<{ replayed: boolean; status: string; queued: number }>(`
        ${broken ? 'alter table private.customer_order_notifications rename to customer_order_notifications_gone;' : ''}
        result := public.create_order_v2(
          '${X.shop.slug}', ${buyer}, '{}'::jsonb, '[{"variant_id":"${X.shop.variants[0]!.id}","quantity":1}]'::jsonb,
          gen_random_uuid(), 'it-probe', 'pickup', null, '', 'RUB', null);
        result := jsonb_build_object(
          'replayed', result -> 'replayed',
          'status', result -> 'order' -> 'status',
          'queued', (select count(*) from private.customer_order_notifications${broken ? '_gone' : ''} n where n.order_id = (result -> 'order' ->> 'id')::uuid));
      `);
    // Control: the same call queues the confirmation when the outbox works.
    expect(order(false)).toEqual({ replayed: false, status: 'new', queued: 1 });
    expect(order(true)).toEqual({ replayed: false, status: 'new', queued: 0 });
    // Both probes were rolled back.
    expect(await sql(`select count(*) from public.orders where shop_id = '${X.shop.id}';`)).toBe('0');
    expect(await sql(`select to_regclass('private.customer_order_notifications') is not null;`)).toBe('t');
  });
});

describe('access control', () => {
  it('browsers can call no customer_notify_* RPC and read no outbox row', async () => {
    const buyer = await starter(A.token);
    const placed = await placeOrder(A.shop, buyer);
    const row = await settled(placed.order!.id, 'sent');
    for (const client of [anon(), A.owner.client] as Db[]) {
      for (const [name, args] of [
        ['customer_notify_claim', { p_order_id: placed.order!.id, p_shop_id: A.shop.id, p_limit: 5 }],
        ['customer_notify_begin_send', { p_notification_id: row!.id, p_attempt: 1, p_bot_id: botIdOf(A.token) }],
        ['customer_notify_complete', { p_notification_id: row!.id, p_ok: false, p_message_id: null, p_error: 'x', p_blocked: true }],
      ] as const) {
        const r = await client.rpc(name as never, args as never);
        expect(r.error?.message, name).toMatch(/permission denied|Could not find/i);
        expect(JSON.stringify(r.data ?? null)).not.toContain(A.token.split(':')[1]);
      }
      const t = await (client as unknown as { schema: (s: string) => Db }).schema('private').from('customer_order_notifications' as never).select('*');
      expect(t.error).not.toBeNull();
    }
    expect(await outbox(placed.order!.id)).toMatchObject({ status: 'sent' });
    expect(await sql(`select status from private.bot_subscribers where shop_id = '${A.shop.id}' and tg_user_id = ${buyer};`)).toBe('active');
  });
});
