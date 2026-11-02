// MFA recovery of a platform admin (lost authenticator). Used by scripts/platform-admin-mfa-reset.ts and the tests.
// Standard Supabase mechanisms only: the Auth Admin API deletes the factors, SQL ends every session of the account
// (public.platform_admin_revoke_sessions, 20261102090300). Afterwards the account can only sign in with its password
// at aal1 and must enroll + verify a new TOTP factor before any platform right works again.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/database.types.ts';

export interface MfaResetResult {
  userId: string;
  factorsRemoved: number;
  sessionsRevoked: number;
}

export async function findUserIdByEmail(db: SupabaseClient<Database>, email: string): Promise<string | null> {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; page < 50; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === wanted);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Throws unless `userId` is a platform admin; removes ALL its MFA factors, then ends ALL its sessions. */
export async function resetPlatformAdminMfa(db: SupabaseClient<Database>, userId: string): Promise<MfaResetResult> {
  const { data: row, error: re } = await db.from('platform_admins').select('user_id').eq('user_id', userId).maybeSingle();
  if (re) throw new Error(re.message);
  if (!row) throw new Error('not_platform_admin: this command is only for platform admin accounts');

  const { data: listed, error: le } = await db.auth.admin.mfa.listFactors({ userId });
  if (le) throw new Error(le.message);
  let factorsRemoved = 0;
  for (const factor of listed.factors) {
    const { error } = await db.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
    if (error) throw new Error(`deleteFactor ${factor.id}: ${error.message}`);
    factorsRemoved += 1;
  }
  const { data: after, error: ae } = await db.auth.admin.mfa.listFactors({ userId });
  if (ae) throw new Error(ae.message);
  if (after.factors.length > 0) throw new Error('mfa_reset_incomplete: factors are still present');

  const { data: revoked, error: se } = await db.rpc('platform_admin_revoke_sessions', { p_user_id: userId });
  if (se) throw new Error(`platform_admin_revoke_sessions: ${se.message}`);
  return { userId, factorsRemoved, sessionsRevoked: revoked ?? 0 };
}
