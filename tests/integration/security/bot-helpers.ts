// Shared by the stage 4B suites (20261113090000): a shop with its own connected bot and Telegram updates delivered to
// its webhook exactly like Telegram does. LOCAL ONLY: ../helpers.ts refuses a non-loopback Supabase URL and the global
// setup refuses to run unless the local Edge Runtime talks to the mock Bot API. Only fake tokens.
import { expect } from 'vitest';
import { mockBotState } from '../../../scripts/lib/telegram-mock.ts';
import { callAdminFunction, createOwner, createTestShop, env, fakeBotToken, newTelegramUserId, type Db, type TestShop } from '../helpers';
import { psqlAsync } from './sec-helpers';

/** PUBLIC_APP_URL of the local Edge Runtime (scripts/supabase-start.ts). */
export const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL ?? 'https://miniapp.local.test';

export const botIdOf = (token: string) => Number(token.split(':')[0]);

/** SQL as `postgres` on the local database (psql -tA output); throws when the statement fails. */
export async function sql(query: string): Promise<string> {
  const r = await psqlAsync(query);
  if (r.code !== 0) throw new Error(`psql failed: ${r.err}`);
  return r.out;
}

export const botFn = (client: Db | null, body: Record<string, unknown>) => callAdminFunction('bot-connection', client, body);
export const errorCode = (r: { body: Record<string, unknown> | null }) => (r.body?.error as { code?: string } | undefined)?.code;

export interface BotShop {
  shop: TestShop;
  owner: Awaited<ReturnType<typeof createOwner>>;
  /** Fake BotFather-format token of the shop's connected bot. */
  token: string;
}

/** A shop with its owner and a connected bot. `tokenPrefix`: behaviour of the mock for this bot (e.g. NOEMOJI). */
export async function shopWithBot(opts: { tokenPrefix?: string; shop?: Parameters<typeof createTestShop>[0] } = {}): Promise<BotShop> {
  const shop = await createTestShop(opts.shop);
  const owner = await createOwner(shop.id);
  const token = fakeBotToken(opts.tokenPrefix);
  const res = await botFn(owner.client, { action: 'connect', shopId: shop.id, botToken: token });
  expect(res.status, res.text).toBe(200);
  return { shop, owner, token };
}

let updateSeq = Math.floor(Math.random() * 1_000_000_000);

/** An update delivered exactly like Telegram does: no apikey, no Authorization — only the secret header. */
export async function deliver(token: string, update: Record<string, unknown>) {
  const hook = (await mockBotState(botIdOf(token))).webhook;
  if (!hook) throw new Error('no webhook set');
  const connectionId = new URL(hook.url).searchParams.get('c')!;
  const res = await fetch(`${env.url}/functions/v1/telegram-webhook?c=${connectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': hook.secret_token! },
    body: JSON.stringify({ update_id: updateSeq++, ...update }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

/** A private message of a user to the bot (`entities`: Bot API MessageEntity list, e.g. custom_emoji). */
export const privateMessage = (user: number, text: string, entities?: unknown[]) => ({
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    text,
    ...(entities ? { entities } : {}),
    chat: { id: user, type: 'private' },
    from: { id: user, is_bot: false, first_name: 'Buyer' },
  },
});

/** my_chat_member: the user blocked ('kicked') or unblocked ('member') the bot. */
export const memberStatus = (user: number, status: 'kicked' | 'member') => ({
  my_chat_member: { chat: { id: user, type: 'private' }, from: { id: user, is_bot: false }, date: 1, old_chat_member: { status: 'member' }, new_chat_member: { status } },
});

/** A new Telegram user who pressed Start in the bot of `token`. */
export async function starter(token: string): Promise<number> {
  const user = newTelegramUserId();
  const res = await deliver(token, privateMessage(user, '/start'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return user;
}
