// pnpm dev:loyalty-check <command> — LOCAL ONLY. A separate test shop and accounts for a manual look at «Бонусы и промокоды»
// (20261125090000) in a browser: bonus program, discount from the order total, promo codes.
//
//   prepare [--base http://127.0.0.1:5190]   a LIVE test shop `loyalty-shop` (everything OFF, like any new shop), its owner,
//                                            a catalog with variants and one product already on sale (stage 4B), a connected
//                                            FAKE bot (local mock Bot API) and a buyer who pressed Start in it. Safe to run
//                                            again: only what is missing is created, nothing else is modified or deleted.
//   link  [--user <telegram id>] [--base …]  storefront link of that buyer (Telegram launch parameters signed with the local
//                                            placeholder token)
//   tg-start --user <telegram id>            another buyer presses Start in the shop's bot (so the bonus message reaches them)
//
// Accounts and the FAKE bot token are written to e2e/.auth/loyalty-check.json (gitignored). Telegram is only ever the local
// mock Bot API (pnpm telegram:mock): the script refuses anything but the local Supabase stack and a local Edge Runtime that
// talks to the mock. It never touches production, other shops or their data.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DARK_PREMIUM_THEME } from '../src/domain/theme.ts';
import { signInitData } from '../supabase/functions/_shared/telegram-init-data.ts';
import { fail, log, parseArgs, run } from './lib/cli.ts';
import { assertLocalSupabaseEnv, assertResolvedLocal } from './lib/local-supabase-guard.ts';
import { resolveSupabaseEnv, serviceClient, type SupabaseEnv } from './lib/supabase-env.ts';
import { assertEdgeRuntimeUsesMock, isTelegramMockRunning, mockBotState, TELEGRAM_MOCK_URL } from './lib/telegram-mock.ts';

const FILE = join(process.cwd(), 'e2e', '.auth', 'loyalty-check.json');
const MARK = 'dev-loyalty-check';
const OWNER_EMAIL = 'loyalty-owner@demo.local';
const SLUG = 'loyalty-shop';
const NAME = 'Бонусы и промокоды (тест)';
const DEFAULT_BASE = 'http://127.0.0.1:5190';
/** The buyer who has pressed Start in the shop's bot, so the message about credited bonuses reaches them. */
const BUYER_TG_ID = 900_100_001;
/** Same placeholder token as `pnpm db:start` / `pnpm dev:tg-link`. */
const LOCAL_TOKEN = '123456789:LOCAL_TEST_TOKEN_NOT_A_SECRET';

interface State {
  owner?: { email: string; password: string };
  bot?: { botId: number; token: string };
}

const loadState = (): State => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as State) : {});

function saveState(state: State) {
  mkdirSync(join(process.cwd(), 'e2e', '.auth'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
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

let updateSeq = Math.floor(Math.random() * 1_000_000_000);

/** A private message of a Telegram user to the bot, delivered to its webhook exactly like Telegram does. */
async function tellBot(env: SupabaseEnv, botId: number, user: number, text: string) {
  const hook = (await mockBotState(botId)).webhook;
  if (!hook?.secret_token) fail(`У бота ${botId} нет webhook в mock Bot API (mock перезапускали?). Выполните: pnpm dev:loyalty-check prepare`);
  const res = await fetch(`${env.url}/functions/v1/telegram-webhook?c=${new URL(hook.url).searchParams.get('c')}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': hook.secret_token },
    body: JSON.stringify({
      update_id: updateSeq++,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), text, chat: { id: user, type: 'private' }, from: { id: user, is_bot: false, first_name: 'Покупатель' } },
    }),
  });
  if (res.status !== 200) fail(`telegram-webhook ответил ${res.status}`);
}

async function storefrontLink(base: string, user: number): Promise<string> {
  const initData = await signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: `DEV${user}`,
      user: JSON.stringify({ id: user, first_name: 'Тестовый покупатель', username: `dev_${user}` }),
      signature: randomBytes(64).toString('base64url'),
    },
    process.env.TELEGRAM_BOT_TOKEN ?? LOCAL_TOKEN,
  );
  const hash = new URLSearchParams({ tgWebAppData: initData, tgWebAppVersion: '8.0', tgWebAppPlatform: 'web', tgWebAppThemeParams: JSON.stringify({}) }).toString();
  return `${base}/s/${SLUG}/#${hash}`;
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
    saveState(state);
  }
  if (!owner) {
    const password = randomBytes(12).toString('base64url');
    const { data, error } = await db.auth.admin.createUser({ email: OWNER_EMAIL, password, email_confirm: true, user_metadata: { created_by: MARK } });
    if (error) throw error;
    owner = data.user;
    state.owner = { email: OWNER_EMAIL, password };
    saveState(state);
    log.ok(`Создан локальный пользователь ${OWNER_EMAIL}`);
  }
  const ownerCreds = state.owner!;

  // ---- The shop: regular (not DEMO), live, everything of the new feature OFF ---------------------------------------------
  const { data: existing, error: se } = await db.from('shops').select('id').eq('slug', SLUG).maybeSingle();
  if (se) throw se;
  let shopId = existing?.id;
  if (!shopId) {
    const { data: shop, error } = await db.from('shops').insert({ slug: SLUG, name: NAME, theme_config: DARK_PREMIUM_THEME, currency: 'RUB', mode: 'live' }).select('id').single();
    if (error) fail(`Не удалось создать магазин ${SLUG}: ${error.message} (slug мог быть занят удалённым магазином)`);
    shopId = shop.id;
    const { data: cat, error: ce } = await db.from('categories').insert({ shop_id: shopId, name: 'Тестовые товары', slug: 'test' }).select('id').single();
    if (ce) throw ce;
    const catalog = [
      { name: 'Товар A', price: 100_000, discount: null, variants: [['Вариант 1', 200], ['Вариант 2', 200]] },
      { name: 'Товар B', price: 250_000, discount: null, variants: [['Стандарт', 200]] },
      // Stage 4B: a product already on sale; the order discounts work on top of this price, never on the struck-out one.
      { name: 'Товар со скидкой', price: 300_000, discount: 250_000, variants: [['Стандарт', 200]] },
    ] as const;
    for (const p of catalog) {
      const { data: product, error: pe } = await db
        .from('products')
        .insert({ shop_id: shopId, category_id: cat.id, name: p.name, base_price_minor: p.price, discount_price_minor: p.discount, is_published: true })
        .select('id')
        .single();
      if (pe) throw pe;
      for (const [flavor, stock] of p.variants) {
        const { error: ve } = await db.from('product_variants').insert({ shop_id: shopId, product_id: product.id, flavor, stock_quantity: stock });
        if (ve) throw ve;
      }
    }
    log.ok(`Создан магазин ${SLUG} (LIVE, 3 товара, 4 варианта; бонусы, скидки и промокоды выключены)`);
  }
  const { data: member, error: me } = await db.from('shop_memberships').select('user_id').eq('shop_id', shopId).eq('user_id', owner.id).maybeSingle();
  if (me) throw me;
  if (!member) {
    const { error } = await db.from('shop_memberships').insert({ shop_id: shopId, user_id: owner.id, role: 'owner' });
    if (error) throw error;
  }

  // ---- The shop's own bot: a FAKE token, verified and stored by the real bot-connection function against the mock -------
  const client = createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: session, error: ie } = await client.auth.signInWithPassword({ email: ownerCreds.email, password: ownerCreds.password });
  if (ie) throw ie;
  const call = async (body: Record<string, unknown>) => {
    const res = await fetch(`${env.url}/functions/v1/bot-connection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${session.session.access_token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const view = await call({ action: 'get', shopId });
  if (view.status !== 200) fail(`bot-connection get: ${view.status} ${JSON.stringify(view.body)}`);
  const connected = Boolean((view.body?.settings as { connection?: unknown } | undefined)?.connection);
  let botId = state.bot?.botId;
  // The mock keeps webhooks in memory: after its restart the bot is connected again (a new fake bot).
  if (!(connected && botId && (await mockBotState(botId)).webhook)) {
    botId = 700_000_000 + Math.floor(Math.random() * 1e8);
    const token = `${botId}:FAKE_loyalty_${randomBytes(16).toString('hex')}`;
    const res = await call({ action: 'connect', shopId, botToken: token, confirmReplaceWebhook: true });
    if (res.status !== 200) fail(`bot-connection connect: ${res.status} ${JSON.stringify(res.body)}`);
    state.bot = { botId, token };
    saveState(state);
    log.ok(`Подключён фиктивный бот @mock_${botId}_bot (mock Bot API)`);
  }
  await tellBot(env, botId!, BUYER_TG_ID, '/start');

  log.ok(`Готово. Учётные данные (только локально): ${FILE}`);
  console.log('');
  console.log(`Приложение (Vite):        ${base}   (запуск: pnpm dev:local --port ${new URL(base).port || '5190'})`);
  console.log(`Админка:                  ${base}/admin`);
  console.log(`Раздел «Бонусы и промокоды»: ${base}/admin/shops/${SLUG}/loyalty`);
  console.log(`Магазин (витрина):        ${base}/s/${SLUG}/`);
  console.log(`Администратор магазина:   ${ownerCreds.email} / ${ownerCreds.password}`);
  console.log(`Покупатель:               Telegram id ${BUYER_TG_ID} (запускал бота магазина)`);
  console.log(`Ссылка покупателя:        ${await storefrontLink(base, BUYER_TG_ID)}`);
  console.log(`Сообщения бота (mock):    ${TELEGRAM_MOCK_URL}/__mock/messages?chat_id=${BUYER_TG_ID}`);
  return 0;
}

async function link() {
  await localEnv();
  const args = parseArgs(process.argv.slice(3));
  const user = Number(args.flags.user ?? BUYER_TG_ID);
  if (!Number.isSafeInteger(user) || user <= 0) fail('Укажите --user <числовой Telegram id>');
  log.ok(`Ссылка покупателя ${user} (действует ~24 ч):`);
  console.log(await storefrontLink(baseOf(args), user));
  return 0;
}

async function tgStart() {
  const env = await localEnv();
  const args = parseArgs(process.argv.slice(3));
  const user = Number(args.flags.user);
  if (!Number.isSafeInteger(user) || user <= 0) fail('Укажите --user <числовой Telegram id>');
  const botId = loadState().bot?.botId;
  if (!botId) fail('Сначала: pnpm dev:loyalty-check prepare');
  await tellBot(env, botId, user, '/start');
  log.ok(`Пользователь ${user} нажал Start в боте магазина. Сообщения: ${TELEGRAM_MOCK_URL}/__mock/messages?chat_id=${user}`);
  return 0;
}

run(async () => {
  const command = process.argv[2];
  if (command === 'prepare') return prepare();
  if (command === 'link') return link();
  if (command === 'tg-start') return tgStart();
  fail('Команды: prepare | link [--user <id>] | tg-start --user <id>');
});
