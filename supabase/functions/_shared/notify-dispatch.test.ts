import { describe, expect, it, vi } from 'vitest';
import { dispatchNotifications, type NotificationJob, type Rpc } from './notify-dispatch';

const TOKEN = '987654321:FAKE_dispatch_token_bbbbbbbbbbbbbbbbbbbb';
const SECRET = TOKEN.split(':')[1]!;

const job = (id: number): NotificationJob => ({
  notification_id: id,
  attempt: 1,
  shop_name: 'Noir Vapor',
  chat_id: '@orders_chat',
  bot_token: TOKEN,
  customer_tg_id: 555,
  customer: { username: 'buyer' },
  order: {
    order_number: 7,
    currency: 'RUB',
    total_minor: 69_000,
    created_at: '2026-10-25T10:00:00Z',
    items: [{ product_name: 'Noir Salt', variant_label: 'Мята', quantity: 1, unit_price_minor: 69_000, line_total_minor: 69_000 }],
  },
});

function fakeRpc(jobs: NotificationJob[]) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push({ fn, args });
    return { data: fn === 'notify_claim' ? jobs : null, error: null };
  };
  return { rpc, calls };
}

describe('dispatchNotifications', () => {
  it('claims, sends once per job and records success with the Telegram message id', async () => {
    const { rpc, calls } = fakeRpc([job(1)]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 77 } })));
    const res = await dispatchNotifications(rpc, { orderId: 'o1', fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock' });
    expect(res).toEqual({ sent: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.text).toContain('Новый заказ №7');
    expect(body.text).toContain('@buyer (Telegram ID 555)');
    expect(calls).toEqual([
      { fn: 'notify_claim', args: { p_order_id: 'o1', p_shop_id: null, p_limit: 1 } },
      { fn: 'notify_complete', args: { p_notification_id: 1, p_ok: true, p_message_id: 77, p_error: null } },
    ]);
  });

  it('a Telegram failure is recorded (for retry), never thrown, and neither the record nor the log contain the token', async () => {
    const { rpc, calls } = fakeRpc([job(2)]);
    const logs: string[] = [];
    const fetchImpl = async () => {
      throw new TypeError(`request to http://mock/bot${TOKEN}/sendMessage failed`);
    };
    const res = await dispatchNotifications(rpc, { fetchImpl: fetchImpl as unknown as typeof fetch, apiBase: 'http://mock', log: (m) => logs.push(m) });
    expect(res).toEqual({ sent: 0, failed: 1 });
    const complete = calls.find((c) => c.fn === 'notify_complete')!;
    expect(complete.args).toMatchObject({ p_notification_id: 2, p_ok: false, p_message_id: null });
    expect(String(complete.args.p_error)).toMatch(/^network_error: /);
    for (const text of [...logs, JSON.stringify(calls)]) expect(text).not.toContain(SECRET);
  });

  it('survives an RPC error or exception without throwing', async () => {
    const logs: string[] = [];
    await expect(
      dispatchNotifications(async () => ({ data: null, error: { message: 'boom' } }), { log: (m) => logs.push(m) }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    await expect(
      dispatchNotifications(async () => {
        throw new Error('db down');
      }, { log: (m) => logs.push(m) }),
    ).resolves.toEqual({ sent: 0, failed: 0 });
    expect(logs).toHaveLength(2);
  });

  it('nothing claimed → nothing sent (e.g. an idempotent checkout replay or an already sent order)', async () => {
    const { rpc, calls } = fakeRpc([]);
    const fetchImpl = vi.fn();
    expect(await dispatchNotifications(rpc, { orderId: 'o1', fetchImpl: fetchImpl as unknown as typeof fetch })).toEqual({ sent: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(['notify_claim']);
  });
});
