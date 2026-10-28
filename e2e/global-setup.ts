import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { assertDevServerUsesSupabase, assertLocalSupabaseEnv, assertResolvedLocal } from '../scripts/lib/local-supabase-guard.ts';
import { resolveSupabaseEnv, serviceClient, type SupabaseEnv } from '../scripts/lib/supabase-env.ts';
import { assertEdgeRuntimeUsesMock, assertTelegramMockDockerNetwork, ensureTelegramMock } from '../scripts/lib/telegram-mock.ts';

export const AUTH_DIR = join(process.cwd(), 'e2e', '.auth');

/** Child scripts get the verified local stack explicitly, so they cannot resolve another project. */
function pnpm(args: string[], local: SupabaseEnv) {
  execFileSync('pnpm', ['-s', ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, SUPABASE_URL: local.url, SUPABASE_ANON_KEY: local.anonKey, SUPABASE_SERVICE_ROLE_KEY: local.serviceRoleKey },
  });
}

/** DEMO tenants: their configs carry stock, so seed + publish is enough. */
const DEMO_TENANTS = ['noir-vapor', 'mint-lab'];
/**
 * Regular (non-DEMO) live tenant for the storefront tests. Its config is a client's draft catalog with stock 0
 * everywhere, which `tenant:publish` rightly refuses — so the run puts a fixed stock on every variant through
 * the owner's own RPC (as the admin UI does), only here on the local stack. The config itself stays untouched.
 */
const REGULAR_TENANT = 'neon-district';
const REGULAR_TENANT_STOCK = 5;

/** Sets a fixed stock on every active variant of a regular shop, signed in as its owner. */
async function stockRegularTenant(local: SupabaseEnv, shopId: string, owner: { email: string; password: string }) {
  const client = createClient(local.url, local.anonKey, { auth: { persistSession: false } });
  const { error: se } = await client.auth.signInWithPassword(owner);
  if (se) throw se;
  const { data: variants, error } = await client
    .from('product_variants')
    .select('id, stock_quantity')
    .eq('shop_id', shopId)
    .eq('is_active', true);
  if (error) throw error;
  for (const v of variants) {
    if (v.stock_quantity === REGULAR_TENANT_STOCK) continue;
    const { error: re } = await client.rpc('admin_set_variant_stock', { p_variant_id: v.id, p_quantity: REGULAR_TENANT_STOCK });
    if (re) throw re;
  }
  await client.auth.signOut();
}

/** Fails the run up front (instead of 90 s locator timeouts) if a tenant's storefront would have nothing to show. */
async function assertSellableCatalog(db: ReturnType<typeof serviceClient>, slug: string, expectDemo: boolean) {
  const { data: shop, error } = await db
    .from('shops')
    .select('id, mode, is_demo, products(id, is_published, archived_at, product_variants(stock_quantity, is_active))')
    .eq('slug', slug)
    .single();
  if (error) throw error;
  const sellable = shop.products.filter(
    (p) => p.is_published && !p.archived_at && p.product_variants.some((v) => v.is_active && v.stock_quantity > 0),
  );
  if (shop.mode !== 'live' || shop.is_demo !== expectDemo || sellable.length === 0) {
    throw new Error(
      `E2E: ${slug} is not ready (mode=${shop.mode}, is_demo=${shop.is_demo}, expected is_demo=${expectDemo}, sellable products=${sellable.length})`,
    );
  }
}

/** Ensures the demo tenants and one regular tenant exist, have a sellable catalog and are live; one fresh owner per tenant. */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  // Every check runs before the first seed, publish or user creation.
  assertLocalSupabaseEnv();
  const local = resolveSupabaseEnv();
  assertResolvedLocal(local);
  if (process.platform !== 'win32') {
    assertTelegramMockDockerNetwork();
  }
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('E2E: baseURL is not configured');
  await assertDevServerUsesSupabase(baseURL, local.url);
  // Orders created by E2E trigger Telegram notifications: only ever to the local mock Bot API.
  assertEdgeRuntimeUsesMock();
  const mock = await ensureTelegramMock();

  for (const slug of [...DEMO_TENANTS, REGULAR_TENANT]) {
    pnpm(['tenant:seed', '--slug', slug], local);
  }
  const db = serviceClient();
  const owners: Record<string, { email: string; password: string; userId: string }> = {};
  for (const slug of [...DEMO_TENANTS, REGULAR_TENANT]) {
    const { data: shop, error } = await db.from('shops').select('id, mode').eq('slug', slug).single();
    if (error) throw error;
    const email = `e2e-${slug}-${randomBytes(3).toString('hex')}@e2e.local`;
    const password = randomBytes(12).toString('base64url');
    const { data: user, error: ue } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (ue) throw ue;
    await db.from('shop_memberships').insert({ shop_id: shop.id, user_id: user.user.id, role: 'owner' });
    owners[slug] = { email, password, userId: user.user.id };
    if (slug === REGULAR_TENANT) await stockRegularTenant(local, shop.id, { email, password });
    if (shop.mode !== 'live') pnpm(['tenant:publish', '--slug', slug, '--yes'], local);
    await assertSellableCatalog(db, slug, slug !== REGULAR_TENANT);
  }
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(join(AUTH_DIR, 'owners.json'), JSON.stringify(owners, null, 2));
  // Returned function = extra global teardown: stops the mock only if this run started it.
  return async () => {
    await mock.close();
  };
}
