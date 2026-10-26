import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FullConfig } from '@playwright/test';
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

/** Ensures both demo tenants exist and are live, and creates one fresh owner per tenant. */
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

  for (const slug of ['noir-vapor', 'mint-lab']) {
    pnpm(['tenant:seed', '--slug', slug], local);
  }
  const db = serviceClient();
  const owners: Record<string, { email: string; password: string; userId: string }> = {};
  for (const slug of ['noir-vapor', 'mint-lab']) {
    const { data: shop, error } = await db.from('shops').select('id, mode').eq('slug', slug).single();
    if (error) throw error;
    const email = `e2e-${slug}-${randomBytes(3).toString('hex')}@e2e.local`;
    const password = randomBytes(12).toString('base64url');
    const { data: user, error: ue } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (ue) throw ue;
    await db.from('shop_memberships').insert({ shop_id: shop.id, user_id: user.user.id, role: 'owner' });
    owners[slug] = { email, password, userId: user.user.id };
    if (shop.mode !== 'live') pnpm(['tenant:publish', '--slug', slug, '--yes'], local);
  }
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(join(AUTH_DIR, 'owners.json'), JSON.stringify(owners, null, 2));
  // Returned function = extra global teardown: stops the mock only if this run started it.
  return async () => {
    await mock.close();
  };
}
