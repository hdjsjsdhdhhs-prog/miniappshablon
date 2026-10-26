import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/database.types.ts';
import { DARK_PREMIUM_THEME } from '../../src/domain/theme.ts';
import { signInitData } from '../../supabase/functions/_shared/telegram-init-data.ts';
import { resolveSupabaseEnv, serviceClient } from '../../scripts/lib/supabase-env.ts';

export type Db = SupabaseClient<Database>;

/** Must equal the TELEGRAM_BOT_TOKEN the local Edge Runtime was started with (scripts/supabase-start.cmd). */
export const TEST_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '123456789:LOCAL_TEST_TOKEN_NOT_A_SECRET';

export const env = resolveSupabaseEnv();
// Hard stop before any client is created: these suites write and delete data and must never reach a
// hosted project (see also vitest.integration.config.ts).
if (!env.isLocal || !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(env.url)) {
  throw new Error(`Integration tests run only against local Supabase, got ${env.url}`);
}
export const admin = serviceClient();

export function anon(): Db {
  return createClient<Database>(env.url, env.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

const created = { shops: new Set<string>(), users: new Set<string>() };

export interface TestShop {
  id: string;
  slug: string;
  categoryId: string;
  productId: string;
  variants: Array<{ id: string; flavor: string | null; stock: number }>;
}

export async function createTestShop(opts: {
  mode?: 'live' | 'preview';
  isDemo?: boolean;
  basePrice?: number;
  variants?: Array<{ flavor: string | null; stock: number; price?: number | null }>;
} = {}): Promise<TestShop> {
  const slug = `it-${randomBytes(5).toString('hex')}`;
  const { data: shop, error } = await admin
    .from('shops')
    .insert({
      slug,
      name: `IT ${slug}`,
      theme_config: DARK_PREMIUM_THEME,
      currency: 'RUB',
      mode: opts.mode ?? 'live',
      is_demo: opts.isDemo ?? false,
      legal_notice: 'test',
    })
    .select('id')
    .single();
  if (error) throw error;
  created.shops.add(shop.id);
  const { data: cat, error: ce } = await admin
    .from('categories')
    .insert({ shop_id: shop.id, name: 'Cat', slug: 'cat' })
    .select('id')
    .single();
  if (ce) throw ce;
  const { data: product, error: pe } = await admin
    .from('products')
    .insert({ shop_id: shop.id, category_id: cat.id, name: 'Liquid', base_price_minor: opts.basePrice ?? 50000, is_published: true })
    .select('id')
    .single();
  if (pe) throw pe;
  const specs = opts.variants ?? [{ flavor: 'Mint', stock: 5 }];
  const { data: vars, error: ve } = await admin
    .from('product_variants')
    .insert(specs.map((v, i) => ({ shop_id: shop.id, product_id: product.id, flavor: v.flavor, stock_quantity: v.stock, price_override_minor: v.price ?? null, sort_order: i })))
    .select('id, flavor, stock_quantity');
  if (ve) throw ve;
  const ordered = specs.map((s) => vars.find((v) => v.flavor === s.flavor)!);
  return {
    id: shop.id,
    slug,
    categoryId: cat.id,
    productId: product.id,
    variants: ordered.map((v) => ({ id: v.id, flavor: v.flavor, stock: v.stock_quantity })),
  };
}

export async function createOwner(shopId: string): Promise<{ client: Db; userId: string; email: string; password: string }> {
  const email = `owner-${randomBytes(4).toString('hex')}@it.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  created.users.add(data.user.id);
  const { error: me } = await admin.from('shop_memberships').insert({ shop_id: shopId, user_id: data.user.id, role: 'owner' });
  if (me) throw me;
  const client = anon();
  const { error: se } = await client.auth.signInWithPassword({ email, password });
  if (se) throw se;
  return { client, userId: data.user.id, email, password };
}

/** Local-only platform admin (row in public.platform_admins, written with the service role). */
export async function createPlatformAdmin(): Promise<{ client: Db; userId: string; email: string }> {
  const email = `platform-${randomBytes(4).toString('hex')}@it.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  created.users.add(data.user.id);
  const { error: pe } = await admin.from('platform_admins').insert({ user_id: data.user.id });
  if (pe) throw pe;
  const client = anon();
  const { error: se } = await client.auth.signInWithPassword({ email, password });
  if (se) throw se;
  return { client, userId: data.user.id, email };
}

/** Adds a member with the given role to a shop and signs them in. */
export async function createMember(shopId: string, role: 'owner' | 'manager'): Promise<{ client: Db; userId: string; email: string }> {
  const email = `${role}-${randomBytes(4).toString('hex')}@it.local`;
  const password = randomBytes(12).toString('base64url');
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw error;
  created.users.add(data.user.id);
  const { error: me } = await admin.from('shop_memberships').insert({ shop_id: shopId, user_id: data.user.id, role });
  if (me) throw me;
  const client = anon();
  const { error: se } = await client.auth.signInWithPassword({ email, password });
  if (se) throw se;
  return { client, userId: data.user.id, email };
}

/** Calls an admin Edge Function as the signed-in user of `client` (or with an explicit bearer / none). */
export async function callAdminFunction(
  name: 'notification-settings' | 'platform-admin',
  as: Db | { bearer: string } | null,
  body: unknown,
) {
  let bearer: string | null = null;
  if (as && 'bearer' in as) bearer = as.bearer;
  else if (as) bearer = (await as.auth.getSession()).data.session?.access_token ?? null;
  const res = await fetch(`${env.url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: env.anonKey, ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body: json, text: JSON.stringify(json) };
}

/** Fake BotFather-format token; the local mock decides behaviour from the secret part. Never valid in Telegram. */
export function fakeBotToken(prefix = 'FAKE'): string {
  const id = 100_000_000 + Math.floor(Math.random() * 800_000_000);
  return `${id}:${prefix}_${randomBytes(18).toString('hex')}`;
}

export async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last = await fn();
  while (!ok(last) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    last = await fn();
  }
  return last;
}

let tgCounter = 0;
export function newTelegramUserId(): number {
  tgCounter += 1;
  return 7_000_000_000 + Math.floor(Math.random() * 1_000_000) * 100 + tgCounter;
}

export async function initDataFor(
  userId: number,
  opts: { authDate?: number; token?: string; user?: Record<string, unknown> } = {},
): Promise<string> {
  return signInitData(
    {
      auth_date: String(opts.authDate ?? Math.floor(Date.now() / 1000)),
      query_id: `Q${userId}`,
      user: JSON.stringify(opts.user ? { id: userId, ...opts.user } : { id: userId, first_name: 'Tester', username: `u${userId}` }),
    },
    opts.token ?? TEST_BOT_TOKEN,
  );
}

export async function callFunction(name: 'checkout' | 'my-orders', initData: string | null, body: unknown) {
  const res = await fetch(`${env.url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.anonKey,
      Authorization: `Bearer ${env.anonKey}`,
      ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body: json };
}

export function checkoutBody(shop: TestShop, items: Array<{ variantId: string; quantity: number }>, extra: Record<string, unknown> = {}) {
  return {
    shopSlug: shop.slug,
    idempotencyKey: randomUUID(),
    currency: 'RUB',
    items,
    contact: { name: 'Tester', phone: '+79000000000', comment: '' },
    ...extra,
  };
}

export async function stockOf(variantId: string): Promise<number> {
  const { data, error } = await admin.from('product_variants').select('stock_quantity').eq('id', variantId).single();
  if (error) throw error;
  return data.stock_quantity;
}

function runLocalSql(sql: string): { ok: true; out: string } | { ok: false; out: string } {
  // Privilege checks talk to PostgreSQL directly. Only ever against the LOCAL stack: `--local`
  // is hard-coded and remote credentials make this throw before any query is sent.
  if (!env.isLocal) throw new Error('SQL privilege checks run only against the local Supabase stack');
  const dir = mkdtempSync(join(tmpdir(), 'it-sql-'));
  const file = join(dir, 'q.sql');
  writeFileSync(file, sql, 'utf8');
  try {
    const out = execFileSync('pnpm', ['exec', 'supabase', 'db', 'query', '--local', '-o', 'json', '-f', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    return { ok: true, out };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs ONE SQL statement as `postgres` on the local database and returns its rows. */
export function localSql<T = Record<string, unknown>>(sql: string): T[] {
  const res = runLocalSql(sql);
  if (!res.ok) throw new Error(`local SQL failed: ${res.out}`);
  // `supabase db query -o json` prints a bare array of rows normally, but wraps it as
  // `{ boundary, rows, warning }` when it detects an AI agent environment (e.g. AI_AGENT is set).
  // Accept both so the tests behave the same locally, under an agent and in CI.
  const start = res.out.search(/[[{]/);
  const end = Math.max(res.out.lastIndexOf(']'), res.out.lastIndexOf('}'));
  const parsed = JSON.parse(res.out.slice(start, end + 1)) as T[] | { rows: T[] };
  return Array.isArray(parsed) ? parsed : parsed.rows;
}

/**
 * Runs a PL/pgSQL body as `postgres` on the local database inside a DO block that ALWAYS ends with
 * an exception, so every change (DDL included) is rolled back. The body must store its result in
 * the jsonb variable `result`; it is carried out in the exception message.
 */
export function localSqlRolledBack<T = Record<string, unknown>>(body: string): T {
  const res = runLocalSql(
    `do $it_probe$\ndeclare result jsonb;\nbegin\n${body}\nraise exception 'IT_RESULT<<%>>IT_RESULT', result;\nend\n$it_probe$;`,
  );
  const m = /IT_RESULT<<([\s\S]*?)>>IT_RESULT/.exec(res.out);
  if (!m) throw new Error(`rolled-back SQL did not produce a result: ${res.out}`);
  return JSON.parse(m[1]!) as T;
}

/** Deletes only rows/users created by this test run (safe: never touches demo tenants). */
export async function cleanup(): Promise<void> {
  for (const id of created.shops) {
    await admin.from('orders').delete().eq('shop_id', id);
    const { data: files } = await admin.storage.from('shop-media').list(id, { limit: 1000 });
    for (const dir of files ?? []) {
      const { data: inner } = await admin.storage.from('shop-media').list(`${id}/${dir.name}`, { limit: 1000 });
      const paths = (inner ?? []).map((f) => `${id}/${dir.name}/${f.name}`);
      if (paths.length) await admin.storage.from('shop-media').remove(paths);
    }
    await admin.from('shops').delete().eq('id', id);
  }
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
  created.shops.clear();
  created.users.clear();
}
