// pnpm exec tsx scripts/dev-stage4b-check.ts <command> — LOCAL ONLY. Data and helpers for a manual look at stage 4B
// (20261113090000) in a browser: deleting a LIVE shop with an authenticator code, discount prices, «Рассылка», the
// buyer's order notification and Premium emoji.
//
//   prepare                         accounts, shops, a connected FAKE bot with subscribers (safe to run again: only
//                                   what is missing is created; a shop deleted during the check is replaced by a
//                                   copy with the next number, e.g. s4b-live-delete-2, because its slug stays reserved)
//   code                            current authenticator code of the local platform admin
//   tg-start --user <telegram id>   the user presses Start in a shop's bot (delivered to the webhook like Telegram does)
//   tg-stop  --user <telegram id>   the user sends /stop (unsubscribes from broadcasts)
//                                   both: [--slug <shop>] (default s4b-shop) or [--bot-id <id>] for a bot connected by hand
//
// Accounts and FAKE bot tokens are written to e2e/.auth/stage4b-check.json (gitignored). Telegram is only ever the
// local mock Bot API (pnpm telegram:mock): the script refuses anything but the local Supabase stack and a local Edge
// Runtime that talks to the mock. Existing users and shops are never modified, except what this script created.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { fail, log, parseArgs, run } from './lib/cli.ts';
import { assertLocalSupabaseEnv, assertResolvedLocal } from './lib/local-supabase-guard.ts';
import { resolveSupabaseEnv, serviceClient, type SupabaseEnv } from './lib/supabase-env.ts';
import { assertEdgeRuntimeUsesMock, isTelegramMockRunning, mockBotState, TELEGRAM_MOCK_URL } from './lib/telegram-mock.ts';
import { totp } from './lib/totp.ts';

const FILE = join(process.cwd(), 'e2e', '.auth', 'stage4b-check.json');
const MARK = 'dev-stage4b-check';

const ADMIN_EMAIL = 'stage4b-admin@demo.local';
const OWNER_EMAIL = 'stage4b-owner@demo.local';
/** The shop for discounts, the broadcast, the buyer's notification and Premium emoji. */
const MAIN_SHOP = 's4b-shop';
const LIVE_DELETE_SHOP = 's4b-live-delete';
const DEMO_DELETE_SHOP = 's4b-demo-delete';
/** Default user of `pnpm dev:tg-link`: the buyer who started the shop's bot, so the order notification reaches them. */
const BUYER_TG_ID = 900_000_001;
const SUBSCRIBERS = [BUYER_TG_ID, 900_000_002, 900_000_003];
const UNSUBSCRIBED = 900_000_004;

interface State {
  admin?: { email: string; password: string; totpSecret: string };
  owner?: { email: string; password: string };
  /** FAKE tokens of the bots this script connected, by shop slug. */
  bots: Record<string, { botId: number; token: string }>;
}

const loadState = (): State => (existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as State) : { bots: {} });

function saveState(state: State) {
  mkdirSync(join(process.cwd(), 'e2e', '.auth'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(state, null, 2));
}

/** Every command: the local stack only, and Telegram only as the local mock. */
async function localEnv(): Promise<SupabaseEnv> {
  assertLocalSupabaseEnv();
  const env = resolveSupabaseEnv();
  assertResolvedLocal(env);
  assertEdgeRuntimeUsesMock();
  if (!(await isTelegramMockRunning())) fail('Запустите mock Bot API: pnpm telegram:mock');
  return env;
}

const anon = (env: SupabaseEnv) => createClient(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function callFunction(env: SupabaseEnv, name: string, token: string, body: Record<string, unknown>) {
  const res = await fetch(`${env.url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

let updateSeq = Math.floor(Math.random() * 1_000_000_000);

/** A private message of a Telegram user to the bot, delivered to its webhook exactly like Telegram does. */
async function tellBot(env: SupabaseEnv, botId: number, user: number, text: string) {
  const hook = (await mockBotState(botId)).webhook;
  if (!hook?.secret_token) fail(`У бота ${botId} нет webhook в mock Bot API (mock перезапускали?). Выполните: pnpm exec tsx scripts/dev-stage4b-check.ts prepare`);
  const connection = new URL(hook.url).searchParams.get('c');
  const res = await fetch(`${env.url}/functions/v1/telegram-webhook?c=${connection}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': hook.secret_token },
    body: JSON.stringify({
      update_id: updateSeq++,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), text, chat: { id: user, type: 'private' }, from: { id: user, is_bot: false, first_name: 'Покупатель' } },
    }),
  });
  if (res.status !== 200) fail(`telegram-webhook ответил ${res.status}`);
}

async function prepare() {
  const env = await localEnv();
  const db = serviceClient();
  const state = loadState();

  // ---- Accounts ---------------------------------------------------------------------------------------------------
  /** A user this script owns; recreated when its password is not in the state file any more. */
  async function ensureUser(email: string, known: boolean): Promise<{ id: string; password: string | null }> {
    const { data: list, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    const existing = list.users.find((u) => u.email?.toLowerCase() === email);
    if (existing) {
      if (existing.user_metadata?.created_by !== MARK) fail(`${email} существует и создан не этим скриптом — не трогаю`);
      if (known) return { id: existing.id, password: null };
      const { error: de } = await db.auth.admin.deleteUser(existing.id);
      if (de) throw de;
    }
    const password = randomBytes(12).toString('base64url');
    const { data, error: ce } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { created_by: MARK } });
    if (ce) throw ce;
    log.ok(`Создан локальный пользователь ${email}`);
    return { id: data.user.id, password };
  }

  const adminUser = await ensureUser(ADMIN_EMAIL, state.admin?.email === ADMIN_EMAIL);
  if (adminUser.password) {
    const { error: pe } = await db.from('platform_admins').upsert({ user_id: adminUser.id }, { onConflict: 'user_id', ignoreDuplicates: true });
    if (pe) throw pe;
    // MFA is mandatory for platform admins: a TOTP factor through the real Supabase Auth flow, its secret kept locally.
    const client = anon(env);
    const { error: se } = await client.auth.signInWithPassword({ email: ADMIN_EMAIL, password: adminUser.password });
    if (se) throw se;
    const { data: factor, error: fe } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'stage4b-check' });
    if (fe) throw fe;
    const { error: ve } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(factor.totp.secret) });
    if (ve) throw ve;
    state.admin = { email: ADMIN_EMAIL, password: adminUser.password, totpSecret: factor.totp.secret };
    saveState(state);
  }
  const ownerUser = await ensureUser(OWNER_EMAIL, state.owner?.email === OWNER_EMAIL);
  if (ownerUser.password) {
    state.owner = { email: OWNER_EMAIL, password: ownerUser.password };
    saveState(state);
  }
  const admin = state.admin!;
  const owner = state.owner!;

  /** aal2 access token of the platform admin: password + current authenticator code. */
  async function adminToken(): Promise<string> {
    const client = anon(env);
    const { error } = await client.auth.signInWithPassword({ email: admin.email, password: admin.password });
    if (error) throw error;
    const { data: factors, error: fe } = await client.auth.mfa.listFactors();
    if (fe) throw fe;
    const factor = factors.totp.find((f) => f.status === 'verified');
    if (!factor) fail(`${admin.email}: нет подтверждённого аутентификатора. Удалите ${FILE} и повторите prepare`);
    const { error: ve } = await client.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp(admin.totpSecret) });
    if (ve) throw ve;
    return (await client.auth.getSession()).data.session!.access_token;
  }

  async function ownerToken(): Promise<string> {
    const client = anon(env);
    const { data, error } = await client.auth.signInWithPassword({ email: owner.email, password: owner.password });
    if (error) throw error;
    return data.session.access_token;
  }

  // ---- Shops ------------------------------------------------------------------------------------------------------
  /**
   * A copy of a demo tenant (catalog + media) created through the real server path; `live`: handed over (not a DEMO).
   * null: the slug belonged to a deleted shop and stays reserved.
   */
  async function ensureShop(slug: string, name: string, template: string, live: boolean): Promise<{ id: string; slug: string; created: boolean } | null> {
    const { data: existing, error } = await db.from('shops').select('id').eq('slug', slug).maybeSingle();
    if (error) throw error;
    if (existing) return { id: existing.id, slug, created: false };
    const { data: tpl, error: te } = await db.from('shops').select('id').eq('slug', template).maybeSingle();
    if (te) throw te;
    if (!tpl) fail(`Нет шаблона ${template}: выполните pnpm tenant:seed --slug ${template} и pnpm tenant:publish --slug ${template} --yes`);
    const res = await callFunction(env, 'platform-admin', await adminToken(), { action: 'create-demo', templateId: tpl.id, slug, name });
    const failure = res.body?.error as { code?: string; details?: { reason?: string } } | undefined;
    if (res.status === 409 && failure?.code === 'slug_taken' && failure.details?.reason === 'deleted_shop') return null;
    if (res.status !== 201) fail(`create-demo ${slug}: ${res.status} ${JSON.stringify(res.body)}`);
    const id = (res.body!.shop as { id: string }).id;
    if (live) {
      const { error: ue } = await db.from('shops').update({ is_demo: false }).eq('id', id);
      if (ue) throw ue;
    }
    log.ok(`Создан магазин ${slug} (${live ? 'LIVE' : 'DEMO'}, копия ${template})`);
    return { id, slug, created: true };
  }

  /** A shop to delete during the check. The slug of a deleted shop stays reserved, so the next copy gets the next number. */
  async function ensureDeletable(base: string, name: string, template: string, live: boolean) {
    for (let n = 1; n <= 50; n += 1) {
      const shop = await ensureShop(n === 1 ? base : `${base}-${n}`, n === 1 ? name : `${name} ${n}`, template, live);
      if (shop) return shop;
    }
    fail(`${base}: 50 копий уже удалено, их slug зарезервированы — задайте в скрипте другой базовый slug`);
  }

  async function ensureOwner(shopId: string) {
    const { data, error } = await db.from('shop_memberships').select('user_id').eq('shop_id', shopId).eq('user_id', ownerUser.id).maybeSingle();
    if (error) throw error;
    if (data) return;
    const { error: ie } = await db.from('shop_memberships').insert({ shop_id: shopId, user_id: ownerUser.id, role: 'owner' });
    if (ie) throw ie;
  }

  /** The shop's own bot: a FAKE token, verified and stored by the real bot-connection function against the mock. */
  async function ensureBot(slug: string, shopId: string, token: string): Promise<number> {
    const view = await callFunction(env, 'bot-connection', token, { action: 'get', shopId });
    if (view.status !== 200) fail(`bot-connection get ${slug}: ${view.status} ${JSON.stringify(view.body)}`);
    const connected = Boolean((view.body?.settings as { connection?: unknown } | undefined)?.connection);
    const saved = state.bots[slug];
    // The mock keeps webhooks in memory: after its restart the bot is connected again (a new fake bot).
    if (connected && saved && (await mockBotState(saved.botId)).webhook) return saved.botId;
    const botId = 700_000_000 + Math.floor(Math.random() * 1e8);
    const botToken = `${botId}:FAKE_s4b_${randomBytes(16).toString('hex')}`;
    const res = await callFunction(env, 'bot-connection', token, { action: 'connect', shopId, botToken, confirmReplaceWebhook: true });
    if (res.status !== 200) fail(`bot-connection connect ${slug}: ${res.status} ${JSON.stringify(res.body)}`);
    state.bots[slug] = { botId, token: botToken };
    saveState(state);
    log.ok(`${slug}: подключён фиктивный бот @mock_${botId}_bot (mock Bot API)`);
    return botId;
  }

  const main = await ensureShop(MAIN_SHOP, 'Stage 4B Shop', 'noir-vapor', true);
  if (!main) fail(`Магазин ${MAIN_SHOP} был удалён, его slug зарезервирован — задайте в скрипте другой MAIN_SHOP`);
  await ensureOwner(main.id);
  if (main.created) {
    // One product already on sale (about −20%, rounded to 10 ₽); the others are left for the manual check.
    const { data: products, error } = await db.from('products').select('id, name, base_price_minor').eq('shop_id', main.id).eq('is_published', true).order('name').limit(1);
    if (error) throw error;
    const product = products[0];
    if (product) {
      const discount = Math.floor((product.base_price_minor * 0.8) / 1000) * 1000;
      if (discount > 0 && discount < product.base_price_minor) {
        const { error: ue } = await db.from('products').update({ discount_price_minor: discount }).eq('id', product.id);
        if (ue) throw ue;
        log.ok(`${MAIN_SHOP}: скидка на «${product.name}»: ${product.base_price_minor / 100} → ${discount / 100}`);
      }
    }
  }
  const mainBot = await ensureBot(MAIN_SHOP, main.id, await ownerToken());
  for (const user of [...SUBSCRIBERS, UNSUBSCRIBED]) await tellBot(env, mainBot, user, '/start');
  await tellBot(env, mainBot, UNSUBSCRIBED, '/stop');
  log.ok(`${MAIN_SHOP}: бот запустили ${SUBSCRIBERS.join(', ')}; ${UNSUBSCRIBED} отписался (/stop)`);

  const liveDelete = await ensureDeletable(LIVE_DELETE_SHOP, 'Stage 4B Live Delete', 'noir-vapor', true);
  await ensureOwner(liveDelete.id);
  const demoDelete = await ensureDeletable(DEMO_DELETE_SHOP, 'Stage 4B Demo Delete', 'mint-lab', false);
  // A DEMO with a connected bot: deleting it must also disconnect the bot.
  await ensureBot(demoDelete.slug, demoDelete.id, await adminToken());

  log.ok(`Готово. Учётные данные (только локально): ${FILE}`);
  log.info(`Администратор платформы: ${admin.email} (код: pnpm exec tsx scripts/dev-stage4b-check.ts code)`);
  log.info(`Владелец магазинов ${MAIN_SHOP}, ${liveDelete.slug}: ${owner.email}`);
  log.info(`Магазины для удаления: LIVE ${liveDelete.slug}, DEMO ${demoDelete.slug}`);
  log.info(`Сообщения ботов: ${TELEGRAM_MOCK_URL}/__mock/messages`);
  return 0;
}

function code() {
  const state = loadState();
  if (!state.admin) fail('Сначала: pnpm exec tsx scripts/dev-stage4b-check.ts prepare');
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(`${totp(state.admin.totpSecret)}  (${state.admin.email}, действует ещё ${left} с)`);
  return 0;
}

async function tell(text: '/start' | '/stop') {
  const env = await localEnv();
  const args = parseArgs(process.argv.slice(3));
  const user = Number(args.flags.user);
  if (!Number.isSafeInteger(user) || user <= 0) fail('Укажите --user <числовой Telegram id>');
  const slug = typeof args.flags.slug === 'string' ? args.flags.slug : MAIN_SHOP;
  const botId = args.flags['bot-id'] === undefined ? loadState().bots[slug]?.botId : Number(args.flags['bot-id']);
  if (!botId || !Number.isSafeInteger(botId)) fail(`Бот магазина ${slug} этому скрипту неизвестен: укажите --bot-id <id бота> (число до двоеточия в токене)`);
  await tellBot(env, botId, user, text);
  log.ok(`Пользователь ${user} отправил ${text} боту ${botId}. Ответ бота: ${TELEGRAM_MOCK_URL}/__mock/messages?chat_id=${user}`);
  return 0;
}

run(async () => {
  const command = process.argv[2];
  if (command === 'prepare') return prepare();
  if (command === 'code') return code();
  if (command === 'tg-start') return tell('/start');
  if (command === 'tg-stop') return tell('/stop');
  fail('Команды: prepare | code | tg-start --user <id> | tg-stop --user <id>');
});
