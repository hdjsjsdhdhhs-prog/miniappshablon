// pnpm dev:bot-check <command> — LOCAL ONLY. A separate test shop and account for a manual look at the rule «one Telegram bot,
// one purpose» (20261126090000): the bot of «Уведомления» can not be the bot of «Подключение бота» and back.
//
//   prepare [--base http://127.0.0.1:5190] [--keep]
//                   a LIVE test shop `bots-shop`, its owner, and both sections EMPTY (an earlier run's connections are removed
//                   through the real Edge Functions unless --keep). Safe to run again: only this script's shop and account
//                   are touched; nothing else is modified or deleted.
//   status          what each section has connected right now (masked, as the admin panel shows it)
//
// The bots are FAKE: the local mock Bot API (pnpm telegram:mock) answers getMe with the id inside the token, so the ids below
// are what the server sees as «the bot». Nothing is sent to Telegram. The script refuses anything but the local stack and a
// local Edge Runtime that talks to the mock. It never touches production or other shops.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DARK_PREMIUM_THEME } from '../src/domain/theme.ts';
import { fail, log, parseArgs, run } from './lib/cli.ts';
import { assertLocalSupabaseEnv, assertResolvedLocal } from './lib/local-supabase-guard.ts';
import { resolveSupabaseEnv, serviceClient, type SupabaseEnv } from './lib/supabase-env.ts';
import { assertEdgeRuntimeUsesMock, isTelegramMockRunning, TELEGRAM_MOCK_URL } from './lib/telegram-mock.ts';

const FILE = join(process.cwd(), 'e2e', '.auth', 'bot-separation-check.json');
const MARK = 'dev-bot-check';
const OWNER_EMAIL = 'bots-owner@demo.local';
const SLUG = 'bots-shop';
const NAME = 'Раздельные боты (тест)';
const DEFAULT_BASE = 'http://127.0.0.1:5190';
const CHAT = '@bots_check_orders';

/** Fake BotFather-format tokens (never valid in Telegram). The number before ":" is the Bot ID the mock's getMe returns. */
const BOTS = {
  NotificationBot: { id: 710_000_001, token: '710000001:FAKE_NotificationBot_0000000000000001', username: 'mock_710000001_bot' },
  StoreBot: { id: 710_000_002, token: '710000002:FAKE_StoreBot_00000000000000000002', username: 'mock_710000002_bot' },
  AnotherBot: { id: 710_000_003, token: '710000003:FAKE_AnotherBot_000000000000000003', username: 'mock_710000003_bot' },
} as const;

interface State {
  owner?: { email: string; password: string };
}
const loadState = (): State => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as State) : {});
function saveState(state: State) {
  mkdirSync(join(process.cwd(), 'e2e', '.auth'), { recursive: true });
  writeFileSync(FILE, JSON.stringify({ ...state, bots: BOTS, notificationChat: CHAT }, null, 2));
}

async function localEnv(): Promise<SupabaseEnv> {
  assertLocalSupabaseEnv();
  const env = resolveSupabaseEnv();
  assertResolvedLocal(env);
  assertEdgeRuntimeUsesMock();
  if (!(await isTelegramMockRunning())) fail('Запустите mock Bot API: pnpm telegram:mock');
  return env;
}

const baseOf = (args: ReturnType<typeof parseArgs>) => (typeof args.flags.base === 'string' ? args.flags.base.replace(/\/$/, '') : DEFAULT_BASE);

/** The owner of the test shop, signed in against the LOCAL stack; calls its Edge Functions exactly like the admin panel does. */
async function ownerSession(env: SupabaseEnv, state: State) {
  if (!state.owner) fail('Сначала: pnpm dev:bot-check prepare');
  const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email: state.owner.email, password: state.owner.password });
  if (error) throw error;
  const db = serviceClient();
  const { data: shop, error: se } = await db.from('shops').select('id').eq('slug', SLUG).maybeSingle();
  if (se) throw se;
  if (!shop) fail(`Магазин ${SLUG} не найден: pnpm dev:bot-check prepare`);
  const call = async (fn: 'notification-settings' | 'bot-connection', body: Record<string, unknown>) => {
    const res = await fetch(`${env.url}/functions/v1/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ shopId: shop.id, ...body }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  return { shopId: shop.id as string, call };
}

async function disconnectAll(call: Awaited<ReturnType<typeof ownerSession>>['call']) {
  const n = await call('notification-settings', { action: 'get' });
  if (n.status !== 200) fail(`notification-settings get: ${n.status}`);
  if ((n.body?.settings as { configured?: boolean } | undefined)?.configured) {
    const r = await call('notification-settings', { action: 'delete' });
    if (r.status !== 200) fail(`notification-settings delete: ${r.status}`);
  }
  const b = await call('bot-connection', { action: 'get' });
  if (b.status !== 200) fail(`bot-connection get: ${b.status}`);
  if ((b.body?.settings as { connection?: unknown } | undefined)?.connection) {
    const r = await call('bot-connection', { action: 'disconnect' });
    if (r.status !== 200) fail(`bot-connection disconnect: ${r.status}`);
  }
}

async function prepare() {
  const env = await localEnv();
  const db = serviceClient();
  const state = loadState();
  const args = parseArgs(process.argv.slice(3));
  const base = baseOf(args);

  // ---- Owner account (only one this script created is ever reused or replaced) ----------------------------------------
  const { data: list, error: le } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (le) throw le;
  let owner = list.users.find((u) => u.email?.toLowerCase() === OWNER_EMAIL);
  if (owner && owner.user_metadata?.created_by !== MARK) fail(`${OWNER_EMAIL} существует и создан не этим скриптом — не трогаю`);
  if (owner && state.owner?.email !== OWNER_EMAIL) {
    // The password is unknown (the state file is gone): set a new one for the account this script created.
    const password = randomBytes(12).toString('base64url');
    const { error } = await db.auth.admin.updateUserById(owner.id, { password });
    if (error) throw error;
    state.owner = { email: OWNER_EMAIL, password };
  }
  if (!owner) {
    const password = randomBytes(12).toString('base64url');
    const { data, error } = await db.auth.admin.createUser({ email: OWNER_EMAIL, password, email_confirm: true, user_metadata: { created_by: MARK } });
    if (error) throw error;
    owner = data.user;
    state.owner = { email: OWNER_EMAIL, password };
    log.ok(`Создан локальный пользователь ${OWNER_EMAIL}`);
  }
  saveState(state);

  // ---- The shop: regular (not DEMO), live --------------------------------------------------------------------------------
  const { data: existing, error: se } = await db.from('shops').select('id').eq('slug', SLUG).maybeSingle();
  if (se) throw se;
  let shopId = existing?.id;
  if (!shopId) {
    const { data: shop, error } = await db.from('shops').insert({ slug: SLUG, name: NAME, theme_config: DARK_PREMIUM_THEME, currency: 'RUB', mode: 'live' }).select('id').single();
    if (error) fail(`Не удалось создать магазин ${SLUG}: ${error.message} (slug мог быть занят удалённым магазином)`);
    shopId = shop.id;
    const { data: cat, error: ce } = await db.from('categories').insert({ shop_id: shopId, name: 'Тестовые товары', slug: 'test' }).select('id').single();
    if (ce) throw ce;
    const { data: product, error: pe } = await db
      .from('products')
      .insert({ shop_id: shopId, category_id: cat.id, name: 'Тестовый товар', base_price_minor: 100_000, is_published: true })
      .select('id')
      .single();
    if (pe) throw pe;
    const { error: ve } = await db.from('product_variants').insert({ shop_id: shopId, product_id: product.id, flavor: 'Стандарт', stock_quantity: 100 });
    if (ve) throw ve;
    log.ok(`Создан магазин ${SLUG} (LIVE, 1 товар)`);
  }
  const { data: member, error: me } = await db.from('shop_memberships').select('user_id').eq('shop_id', shopId).eq('user_id', owner.id).maybeSingle();
  if (me) throw me;
  if (!member) {
    const { error } = await db.from('shop_memberships').insert({ shop_id: shopId, user_id: owner.id, role: 'owner' });
    if (error) throw error;
  }

  // ---- Both sections start empty (through the real Edge Functions: Vault, webhook and Menu Button are cleaned up too) ------
  if (!args.flags.keep) {
    const { call } = await ownerSession(env, state);
    await disconnectAll(call);
  }

  const { password } = state.owner!;
  log.ok(`Готово. Учётные данные и токены (только локально): ${FILE}`);
  console.log('');
  console.log(`Приложение (Vite):           ${base}   (запуск: pnpm dev:local --port ${new URL(base).port || '5190'} --strictPort)`);
  console.log(`Админка:                     ${base}/admin`);
  console.log(`Раздел «Уведомления»:        ${base}/admin/shops/${SLUG}/notifications`);
  console.log(`Раздел «Подключение бота»:   ${base}/admin/shops/${SLUG}/bot`);
  console.log(`Магазин:                     ${NAME}  (slug ${SLUG})`);
  console.log(`Администратор магазина:      ${OWNER_EMAIL} / ${password}`);
  console.log('');
  console.log('Тестовые боты (фиктивные; mock getMe отвечает числом из токена как Bot ID):');
  for (const [name, bot] of Object.entries(BOTS)) console.log(`  ${name.padEnd(16)} Bot ID ${bot.id}  @${bot.username}\n  ${' '.repeat(16)} токен ${bot.token}`);
  console.log('');
  console.log(`Канал для уведомлений:       ${CHAT}  (mock принимает любой @username)`);
  console.log(`Сообщения mock Bot API:      ${TELEGRAM_MOCK_URL}/__mock/messages?chat_id=${encodeURIComponent(CHAT)}`);
  return 0;
}

async function status() {
  const env = await localEnv();
  const { call } = await ownerSession(env, loadState());
  const n = await call('notification-settings', { action: 'get' });
  const b = await call('bot-connection', { action: 'get' });
  const ns = n.body?.settings as { configured: boolean; token_hint: string | null; bot_username: string | null; chat_id: string | null } | undefined;
  const bc = (b.body?.settings as { connection: { bot_username: string; token_hint: string } | null } | undefined)?.connection;
  console.log(`Уведомления:       ${ns?.configured ? `@${ns.bot_username} (${ns.token_hint}) → ${ns.chat_id}` : 'не подключено'}`);
  console.log(`Подключение бота:  ${bc ? `@${bc.bot_username} (${bc.token_hint})` : 'не подключено'}`);
  return 0;
}

run(async () => {
  const command = process.argv[2];
  if (command === 'prepare') return prepare();
  if (command === 'status') return status();
  fail('Команды: prepare [--base …] [--keep] | status');
});
