// "Ваш заказ оформлен!" — the buyer's copy of a new order, sent through the shop's own bot. The outbox RPCs are a
// stub here (the SQL is covered by tests/integration/security/customer-notifications.test.ts); Telegram is a stubbed
// fetch. Only a fake BotFather-format token.
import { describe, expect, it, vi } from 'vitest';
import { dispatchCustomerNotifications, formatCustomerOrderMessage, type CustomerNotificationJob, type Rpc } from './customer-notification';
import { formatMinor, type NotificationOrder } from './order-notification';

const TOKEN = '123456789:FAKE_customer_notification_unit_test_0001';
const SECRET = TOKEN.split(':')[1]!;

const order: NotificationOrder = {
  order_number: 42,
  currency: 'RUB',
  total_minor: 59_000 * 2 + 189_000,
  contact_name: 'Ирина Секретная',
  contact_phone: '+79990001122',
  comment: 'Код домофона 4521',
  fulfillment_method: 'delivery',
  delivery_address: 'ул. Тайная, 7, кв. 12',
  is_test: false,
  created_at: '2026-11-13T09:05:00Z',
  items: [
    // Sold with a discount: 590 ₽ instead of 690 ₽. The buyer sees what was charged.
    { product_name: 'Noir Salt 30 мл', variant_label: 'Черника', quantity: 2, unit_price_minor: 59_000, original_unit_price_minor: 69_000, line_total_minor: 118_000 },
    { product_name: 'Obsidian <Kit> & Co', variant_label: '', quantity: 1, unit_price_minor: 189_000, line_total_minor: 189_000 },
  ],
};

describe('formatCustomerOrderMessage', () => {
  it('has the order number, every line, the total, the way of receiving it and the closing sentence', () => {
    const text = formatCustomerOrderMessage(order);
    expect(text.split('\n')).toEqual([
      '✅ <b>Ваш заказ оформлен!</b>',
      '',
      '<b>Номер заказа:</b> №42',
      '<b>Состав заказа:</b>',
      `1. Noir Salt 30 мл · Черника — 2 × ${formatMinor(59_000, 'RUB')} = ${formatMinor(118_000, 'RUB')}`,
      `2. Obsidian &lt;Kit&gt; &amp; Co — 1 × ${formatMinor(189_000, 'RUB')} = ${formatMinor(189_000, 'RUB')}`,
      `<b>Сумма:</b> ${formatMinor(307_000, 'RUB')}`,
      '<b>Способ получения:</b> доставка',
      '',
      'Ваш заказ оформлен. Скоро с вами свяжется менеджер для подтверждения заказа.',
    ]);
  });

  it('carries no personal data: no address, comment, name, phone or Telegram id', () => {
    const text = formatCustomerOrderMessage(order);
    for (const secret of ['Тайная', 'кв. 12', '4521', 'Ирина', '+7999', 'Telegram ID', 'Покупатель']) expect(text, secret).not.toContain(secret);
  });

  it('pickup is named; an order without a method (older data) simply has no such line', () => {
    expect(formatCustomerOrderMessage({ ...order, fulfillment_method: 'pickup', delivery_address: null })).toContain('<b>Способ получения:</b> самовывоз');
    expect(formatCustomerOrderMessage({ ...order, fulfillment_method: null })).not.toContain('Способ получения');
  });

  it('a very large order is shortened to fit one Telegram message and says how many lines are not shown', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      product_name: `Товар ${i + 1} ${'я'.repeat(110)}`,
      variant_label: 'вариант '.repeat(4).trim(),
      quantity: 1,
      unit_price_minor: 1000,
      line_total_minor: 1000,
    }));
    const text = formatCustomerOrderMessage({ ...order, items, total_minor: 50_000 });
    expect(text.length).toBeLessThanOrEqual(4096);
    const shown = text.split('\n').filter((l) => /^\d+\. Товар /.test(l)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(50);
    expect(text).toContain(`… и ещё ${50 - shown} поз.`);
    // Number, total and the closing sentence are never cut.
    expect(text).toContain('<b>Номер заказа:</b> №42');
    expect(text).toContain(`<b>Сумма:</b> ${formatMinor(50_000, 'RUB')}`);
    expect(text.endsWith('Скоро с вами свяжется менеджер для подтверждения заказа.')).toBe(true);
  });
});

const job = (id: number, over: Partial<CustomerNotificationJob> = {}): CustomerNotificationJob => ({
  notification_id: id,
  attempt: 1,
  bot_id: 123456789,
  shop_name: 'Noir Vapor',
  chat_id: 555000111,
  bot_token: TOKEN,
  order,
  ...over,
});

function fakeRpc(jobs: CustomerNotificationJob[], maySend: boolean | 'error' | 'throw' = true) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'customer_notify_begin_send') {
      if (maySend === 'throw') throw new Error('db down');
      return maySend === 'error' ? { data: null, error: { message: 'boom' } } : { data: maySend, error: null };
    }
    return { data: fn === 'customer_notify_claim' ? jobs : null, error: null };
  };
  return { rpc, calls };
}
const ok = (messageId: number) => vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: messageId } })));
const fails = (status: number, description: string) =>
  vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: status, description }), { status }));
const requestOf = (fetchImpl: ReturnType<typeof ok>, n = 0) => {
  const [url, init] = fetchImpl.mock.calls[n] as unknown as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};

describe('dispatchCustomerNotifications', () => {
  it('claims, re-validates, sends once through the SHOP’S bot to the buyer’s chat and records the message id', async () => {
    const { rpc, calls } = fakeRpc([job(1)]);
    const fetchImpl = ok(77);
    const res = await dispatchCustomerNotifications(rpc, { orderId: 'o1', fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock' });
    expect(res).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, body } = requestOf(fetchImpl);
    // The job's own token (the shop's bot from Vault) — never the platform bot.
    expect(url).toBe(`http://mock/bot${TOKEN}/sendMessage`);
    expect(body).toMatchObject({ chat_id: '555000111', parse_mode: 'HTML' });
    expect(body.text).toBe(formatCustomerOrderMessage(order));
    expect(calls).toEqual([
      { fn: 'customer_notify_claim', args: { p_order_id: 'o1', p_shop_id: null, p_limit: 1 } },
      { fn: 'customer_notify_begin_send', args: { p_notification_id: 1, p_attempt: 1, p_bot_id: 123456789 } },
      { fn: 'customer_notify_complete', args: { p_notification_id: 1, p_ok: true, p_message_id: 77, p_error: null, p_blocked: false } },
    ]);
  });

  it('nothing claimed → nothing sent (the buyer never started the bot, or an idempotent checkout replay)', async () => {
    const { rpc, calls } = fakeRpc([]);
    const fetchImpl = ok(1);
    expect(await dispatchCustomerNotifications(rpc, { orderId: 'o1', fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(['customer_notify_claim']);
  });

  it.each([
    ['the bot was replaced or the buyer blocked it after the claim', false],
    ['the re-validation fails (fail closed)', 'error'],
    ['the re-validation throws (fail closed)', 'throw'],
  ] as const)('does not send when %s — and completes nothing', async (_label, maySend) => {
    const { rpc, calls } = fakeRpc([job(3)], maySend);
    const fetchImpl = ok(1);
    const res = await dispatchCustomerNotifications(rpc, { fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: () => {} });
    expect(res).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(['customer_notify_claim', 'customer_notify_begin_send']);
  });

  it('the buyer blocked the bot (403): recorded as blocked, so it is never retried', async () => {
    const { rpc, calls } = fakeRpc([job(4)]);
    const fetchImpl = fails(403, 'Forbidden: bot was blocked by the user');
    const res = await dispatchCustomerNotifications(rpc, { fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: () => {} });
    expect(res).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(calls.at(-1)).toEqual({
      fn: 'customer_notify_complete',
      args: { p_notification_id: 4, p_ok: false, p_message_id: null, p_error: 'bot_cannot_post: Forbidden: bot was blocked by the user', p_blocked: true },
    });
  });

  it('a transient Telegram failure is recorded for a retry (not blocked)', async () => {
    const { rpc, calls } = fakeRpc([job(5)]);
    const fetchImpl = fails(502, 'Bad Gateway');
    await dispatchCustomerNotifications(rpc, { fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: () => {} });
    expect(calls.at(-1)!.args).toMatchObject({ p_ok: false, p_blocked: false, p_error: 'telegram_unavailable: Bad Gateway' });
  });

  it('a network error is recorded, never thrown, and neither the record nor the log contain the token', async () => {
    const { rpc, calls } = fakeRpc([job(6)]);
    const logs: string[] = [];
    const fetchImpl = async () => {
      throw new TypeError(`request to http://mock/bot${TOKEN}/sendMessage failed`);
    };
    const res = await dispatchCustomerNotifications(rpc, { fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: (m) => logs.push(m) });
    expect(res).toEqual({ sent: 0, failed: 1, skipped: 0 });
    const complete = calls.find((c) => c.fn === 'customer_notify_complete')!;
    expect(complete.args).toMatchObject({ p_notification_id: 6, p_ok: false, p_message_id: null, p_blocked: false });
    expect(String(complete.args.p_error)).toMatch(/^network_error: /);
    for (const text of [...logs, JSON.stringify(calls.filter((c) => c.fn !== 'customer_notify_claim'))]) expect(text).not.toContain(SECRET);
    // Logs name ids and codes only: no order content.
    expect(logs.join('\n')).not.toMatch(/Noir Salt|№42/);
  });

  it('one job failing does not hold back the next one', async () => {
    const { rpc, calls } = fakeRpc([job(7, { chat_id: 1 }), job(8, { chat_id: 2 })]);
    const answers = [new Response(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }), { status: 500 }), new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }))];
    const fetchImpl = vi.fn(async () => answers.shift()!);
    const res = await dispatchCustomerNotifications(rpc, { shopId: 's1', limit: 3, fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: () => {} });
    expect(res).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(calls[0]).toEqual({ fn: 'customer_notify_claim', args: { p_order_id: null, p_shop_id: 's1', p_limit: 3 } });
    expect(calls.filter((c) => c.fn === 'customer_notify_complete').map((c) => [c.args.p_notification_id, c.args.p_ok])).toEqual([[7, false], [8, true]]);
  });

  it('survives an RPC error or exception without throwing: the checkout that called it is never affected', async () => {
    const logs: string[] = [];
    await expect(dispatchCustomerNotifications(async () => ({ data: null, error: { message: 'boom' } }), { log: (m) => logs.push(m) })).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    await expect(
      dispatchCustomerNotifications(async () => {
        throw new Error('db down');
      }, { log: (m) => logs.push(m) }),
    ).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(logs).toHaveLength(2);
    // The completion RPC failing after a successful send is logged, not thrown.
    const rpc: Rpc = async (fn) => {
      if (fn === 'customer_notify_claim') return { data: [job(9)], error: null };
      if (fn === 'customer_notify_begin_send') return { data: true, error: null };
      throw new Error('db down');
    };
    await expect(dispatchCustomerNotifications(rpc, { fetchImpl: ok(5) as unknown as typeof fetch, apiBase: 'http://mock', log: (m) => logs.push(m) })).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
  });
});
