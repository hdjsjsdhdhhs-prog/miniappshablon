// «🎁 За ваш заказ начислено …» — the buyer's message about credited bonuses, sent through the shop's own bot. The outbox
// RPCs are a stub here (the SQL is covered by tests/integration/loyalty.test.ts); Telegram is a stubbed fetch. Only a fake
// BotFather-format token.
import { describe, expect, it, vi } from 'vitest';
import { bonusWord, dispatchBonusNotifications, formatBonusMessage, type BonusNotificationJob, type Rpc } from './bonus-notification';

const TOKEN = '123456789:FAKE_bonus_token_00000000000000001';
const SECRET = TOKEN.split(':')[1]!;

describe('bonusWord', () => {
  it.each([
    [0, 'бонусов'],
    [1, 'бонус'],
    [2, 'бонуса'],
    [4, 'бонуса'],
    [5, 'бонусов'],
    [11, 'бонусов'],
    [12, 'бонусов'],
    [14, 'бонусов'],
    [21, 'бонус'],
    [22, 'бонуса'],
    [100, 'бонусов'],
    [101, 'бонус'],
    [111, 'бонусов'],
    [150, 'бонусов'],
  ])('%i → %s', (n, word) => expect(bonusWord(n)).toBe(word));
});

describe('formatBonusMessage', () => {
  it('is the text of the task with the real order number, amount and balance', () => {
    expect(formatBonusMessage({ orderNumber: 104, amount: 150, balance: 150 }).split('\n')).toEqual([
      '🎁 Отличные новости! За ваш заказ №104 начислено 150 бонусов.',
      'Теперь ваш бонусный баланс составляет 150 бонусов. Используйте их при следующем заказе!',
    ]);
  });

  it('amounts and balance are dynamic, correctly declined and grouped', () => {
    const text = formatBonusMessage({ orderNumber: 7, amount: 1, balance: 1234 });
    expect(text).toContain('За ваш заказ №7 начислено 1 бонус.');
    expect(text).toContain('составляет 1 234 бонуса.');
    expect(formatBonusMessage({ orderNumber: 7, amount: 22, balance: 22 })).toContain('начислено 22 бонуса.');
  });

  it('carries no personal data (only numbers)', () => {
    const text = formatBonusMessage({ orderNumber: 1, amount: 5, balance: 5 });
    expect(text).not.toMatch(/[<>&]/);
  });
});

const job = (id: number, over: Partial<BonusNotificationJob> = {}): BonusNotificationJob => ({
  notification_id: id,
  attempt: 1,
  bot_id: 123456789,
  shop_name: 'Noir Vapor',
  chat_id: 555000111,
  bot_token: TOKEN,
  order_number: 104,
  amount: 150,
  balance: 150,
  ...over,
});

function fakeRpc(jobs: BonusNotificationJob[], maySend: boolean | 'error' | 'throw' = true) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    if (fn === 'bonus_notify_begin_send') {
      if (maySend === 'throw') throw new Error('db down');
      return maySend === 'error' ? { data: null, error: { message: 'boom' } } : { data: maySend, error: null };
    }
    return { data: fn === 'bonus_notify_claim' ? jobs : null, error: null };
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

describe('dispatchBonusNotifications', () => {
  it('claims, re-validates, sends once through the SHOP’S bot to the buyer’s chat and records the message id', async () => {
    const { rpc, calls } = fakeRpc([job(1)]);
    const fetchImpl = ok(77);
    const res = await dispatchBonusNotifications(rpc, { actor: 'u1', shopId: 's1', orderId: 'o1', fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock' });
    expect(res).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, body } = requestOf(fetchImpl);
    // The job's own token (the shop's bot from Vault) — never the platform bot.
    expect(url).toBe(`http://mock/bot${TOKEN}/sendMessage`);
    expect(body).toMatchObject({ chat_id: '555000111', text: formatBonusMessage({ orderNumber: 104, amount: 150, balance: 150 }) });
    expect(body).not.toHaveProperty('parse_mode');
    expect(calls).toEqual([
      { fn: 'bonus_notify_claim', args: { p_actor: 'u1', p_shop_id: 's1', p_order_id: 'o1', p_limit: 5 } },
      { fn: 'bonus_notify_begin_send', args: { p_notification_id: 1, p_attempt: 1, p_bot_id: 123456789 } },
      { fn: 'bonus_notify_complete', args: { p_notification_id: 1, p_ok: true, p_message_id: 77, p_error: null, p_blocked: false } },
    ]);
  });

  it('nothing claimed → nothing sent (the buyer never started the bot, or the message was already sent)', async () => {
    const { rpc, calls } = fakeRpc([]);
    const fetchImpl = ok(1);
    expect(await dispatchBonusNotifications(rpc, { shopId: 's1', fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(['bonus_notify_claim']);
  });

  it.each([
    ['the bot was replaced, the buyer blocked it or the order was cancelled after the claim', false],
    ['the re-validation fails (fail closed)', 'error'],
    ['the re-validation throws (fail closed)', 'throw'],
  ] as const)('does not send when %s — and completes nothing', async (_label, maySend) => {
    const { rpc, calls } = fakeRpc([job(3)], maySend);
    const fetchImpl = ok(1);
    const res = await dispatchBonusNotifications(rpc, { fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: () => {} });
    expect(res).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(['bonus_notify_claim', 'bonus_notify_begin_send']);
  });

  it('the buyer blocked the bot (403): recorded as blocked, so it is never retried', async () => {
    const { rpc, calls } = fakeRpc([job(4)]);
    const res = await dispatchBonusNotifications(rpc, { fetchImpl: fails(403, 'Forbidden: bot was blocked by the user') as unknown as typeof fetch, apiBase: 'http://mock', log: () => {} });
    expect(res).toEqual({ sent: 0, failed: 1, skipped: 0 });
    expect(calls.at(-1)!.args).toMatchObject({ p_notification_id: 4, p_ok: false, p_blocked: true });
  });

  it('a transient Telegram failure is recorded for a retry (not blocked)', async () => {
    const { rpc, calls } = fakeRpc([job(5)]);
    await dispatchBonusNotifications(rpc, { fetchImpl: fails(502, 'Bad Gateway') as unknown as typeof fetch, apiBase: 'http://mock', log: () => {} });
    expect(calls.at(-1)!.args).toMatchObject({ p_ok: false, p_blocked: false, p_error: 'telegram_unavailable: Bad Gateway' });
  });

  it('a network error is recorded, never thrown, and neither the record nor the log contain the token', async () => {
    const { rpc, calls } = fakeRpc([job(6)]);
    const logs: string[] = [];
    const fetchImpl = async () => {
      throw new TypeError(`request to http://mock/bot${TOKEN}/sendMessage failed`);
    };
    const res = await dispatchBonusNotifications(rpc, { fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: (m) => logs.push(m) });
    expect(res).toEqual({ sent: 0, failed: 1, skipped: 0 });
    for (const text of [...logs, JSON.stringify(calls.filter((c) => c.fn !== 'bonus_notify_claim'))]) expect(text).not.toContain(SECRET);
  });

  it('survives an RPC error or exception without throwing: the confirmation that triggered it is never affected', async () => {
    const logs: string[] = [];
    await expect(dispatchBonusNotifications(async () => ({ data: null, error: { message: 'boom' } }), { log: (m) => logs.push(m) })).resolves.toEqual({ sent: 0, failed: 0, skipped: 0, error: 'boom' });
    await expect(
      dispatchBonusNotifications(async () => {
        throw new Error('db down');
      }, { log: (m) => logs.push(m) }),
    ).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(logs).toHaveLength(2);
  });
});
