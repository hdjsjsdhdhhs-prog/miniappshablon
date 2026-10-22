import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalSupabaseEnv, assertResolvedLocal } from '../scripts/lib/local-supabase-guard.ts';
import { resolveSupabaseEnv, serviceClient } from '../scripts/lib/supabase-env.ts';

/** Removes the throw-away owner accounts created by global-setup (memberships cascade). */
export default async function globalTeardown(): Promise<void> {
  const file = join(process.cwd(), 'e2e', '.auth', 'owners.json');
  if (!existsSync(file)) return;
  assertLocalSupabaseEnv();
  assertResolvedLocal(resolveSupabaseEnv());
  const owners = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { userId: string }>;
  const db = serviceClient();
  for (const o of Object.values(owners)) await db.auth.admin.deleteUser(o.userId);
  rmSync(file);
}
