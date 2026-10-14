import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serviceClient } from '../scripts/lib/supabase-env.ts';

export const AUTH_DIR = join(process.cwd(), 'e2e', '.auth');

function pnpm(args: string[]) {
  execFileSync('pnpm', ['-s', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
}

/** Ensures both demo tenants exist and are live, and creates one fresh owner per tenant. */
export default async function globalSetup(): Promise<void> {
  for (const slug of ['noir-vapor', 'mint-lab']) {
    pnpm(['tenant:seed', '--slug', slug]);
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
    if (shop.mode !== 'live') pnpm(['tenant:publish', '--slug', slug, '--yes']);
  }
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(join(AUTH_DIR, 'owners.json'), JSON.stringify(owners, null, 2));
}
