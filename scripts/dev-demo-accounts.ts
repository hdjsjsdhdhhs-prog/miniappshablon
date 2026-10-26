// pnpm dev:demo-accounts — LOCAL ONLY. Prepares accounts and data for a manual look at the admin:
//   creator@demo.local  platform admin ("Все магазины платформы", hand-over), owner of the local shop demo-transfer
//   client@demo.local   account without shops: the target of a demo hand-over
//   noir-vapor          Telegram notifications connected with a FAKE token to the local mock Bot API
// Passwords are random, generated once and written to e2e/.auth/demo-accounts.json (gitignored).
// Refuses to run against anything but the local Supabase stack. Existing users are never modified, except
// accounts this script created itself (marked in user_metadata).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DARK_PREMIUM_THEME } from '../src/domain/theme.ts';
import { fail, log, run } from './lib/cli.ts';
import { assertLocalSupabaseEnv, assertResolvedLocal } from './lib/local-supabase-guard.ts';
import { resolveSupabaseEnv, serviceClient } from './lib/supabase-env.ts';
import { assertEdgeRuntimeUsesMock, isTelegramMockRunning } from './lib/telegram-mock.ts';

const FILE = join(process.cwd(), 'e2e', '.auth', 'demo-accounts.json');
const MARK = 'dev-demo-accounts';
type Saved = Record<string, { email: string; password: string }>;

run(async () => {
  assertLocalSupabaseEnv();
  const env = resolveSupabaseEnv();
  assertResolvedLocal(env);
  assertEdgeRuntimeUsesMock();
  if (!(await isTelegramMockRunning())) fail('Запустите mock Bot API: pnpm telegram:mock');

  const db = serviceClient();
  const saved: Saved = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Saved) : {};

  async function ensureUser(key: string, email: string) {
    const { data: list, error } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    const existing = list.users.find((u) => u.email?.toLowerCase() === email);
    let password = saved[key]?.password;
    if (existing) {
      if (existing.user_metadata?.created_by !== MARK) fail(`${email} существует и создан не этим скриптом — не трогаю`);
      if (!password) {
        password = randomBytes(12).toString('base64url');
        const { error: ue } = await db.auth.admin.updateUserById(existing.id, { password });
        if (ue) throw ue;
      }
      saved[key] = { email, password };
      return existing.id;
    }
    password = randomBytes(12).toString('base64url');
    const { data, error: ce } = await db.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { created_by: MARK } });
    if (ce) throw ce;
    saved[key] = { email, password };
    log.ok(`Создан локальный пользователь ${email}`);
    return data.user.id;
  }

  const creatorId = await ensureUser('creator', 'creator@demo.local');
  await ensureUser('client', 'client@demo.local');
  const { error: pe } = await db.from('platform_admins').upsert({ user_id: creatorId }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (pe) throw pe;

  // A local-only shop the creator can hand over without touching the demo tenants' owners.
  let { data: shop } = await db.from('shops').select('id').eq('slug', 'demo-transfer').maybeSingle();
  if (!shop) {
    const { data, error } = await db
      .from('shops')
      .insert({ slug: 'demo-transfer', name: 'Demo Transfer', description: 'Локальный магазин для проверки передачи', theme_config: DARK_PREMIUM_THEME, currency: 'RUB', mode: 'live', is_demo: true, published_at: new Date().toISOString() })
      .select('id')
      .single();
    if (error) throw error;
    shop = data;
    const { data: cat } = await db.from('categories').insert({ shop_id: shop.id, name: 'Жидкости', slug: 'liquids' }).select('id').single();
    const { data: product } = await db
      .from('products')
      .insert({ shop_id: shop.id, category_id: cat!.id, name: 'Demo Liquid 30 мл', base_price_minor: 59_000, is_published: true })
      .select('id')
      .single();
    await db.from('product_variants').insert([
      { shop_id: shop.id, product_id: product!.id, flavor: 'Мята', stock_quantity: 7 },
      { shop_id: shop.id, product_id: product!.id, flavor: 'Манго', stock_quantity: 3, sort_order: 1 },
    ]);
    await db.from('shop_memberships').insert({ shop_id: shop.id, user_id: creatorId, role: 'owner' });
    log.ok('Создан локальный магазин demo-transfer (владелец creator@demo.local)');
  }

  mkdirSync(join(process.cwd(), 'e2e', '.auth'), { recursive: true });
  writeFileSync(FILE, JSON.stringify(saved, null, 2));

  // Fake Telegram connection for noir-vapor, through the real Edge Function (verified against the mock).
  const creator = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
  const { data: session, error: se } = await creator.auth.signInWithPassword(saved.creator!);
  if (se) throw se;
  const { data: noir } = await db.from('shops').select('id').eq('slug', 'noir-vapor').single();
  const call = (body: Record<string, unknown>) =>
    fetch(`${env.url}/functions/v1/notification-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: env.anonKey, Authorization: `Bearer ${session.session.access_token}` },
      body: JSON.stringify({ shopId: noir!.id, ...body }),
    }).then((r) => r.json() as Promise<{ settings?: { configured: boolean; status: string } }>);
  const current = await call({ action: 'get' });
  if (!current.settings?.configured) {
    const fakeToken = `${700_000_000 + Math.floor(Math.random() * 1e8)}:DEMO_FAKE_${randomBytes(14).toString('hex')}`;
    const res = await call({ action: 'save', botToken: fakeToken, chatId: '@noir_vapor_orders' });
    if (!res.settings?.configured) fail(`Не удалось подключить уведомления noir-vapor: ${JSON.stringify(res)}`);
    log.ok('noir-vapor: уведомления подключены к mock Bot API (фиктивный токен, чат @noir_vapor_orders)');
  } else {
    log.info('noir-vapor: уведомления уже подключены');
  }

  log.ok(`Учётные данные (только локально): ${FILE}`);
  return 0;
});
