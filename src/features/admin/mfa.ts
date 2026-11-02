import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/domain/query-keys';
import { supabase } from '@/lib/supabase';
import { useSession } from './auth';

/**
 * Supabase Auth MFA (TOTP) for platform admins. Cosmetic only: the database refuses every platform right unless the
 * request comes from a live aal2 session (migration 20261102090000), whatever the browser does.
 */

/** Assurance level of the current access token (decoded locally by supabase-js; re-read when the token changes). */
export function useAssurance() {
  const { session } = useSession();
  return useQuery({
    queryKey: queryKeys.adminAssurance(session?.access_token ?? ''),
    queryFn: async () => {
      const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (error) throw error;
      return data;
    },
    enabled: !!session,
    staleTime: Infinity,
  });
}

export interface TotpFactor {
  id: string;
  friendly_name?: string;
  status: 'verified' | 'unverified';
  created_at: string;
}

export async function listTotpFactors(): Promise<TotpFactor[]> {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data.all.filter((f) => f.factor_type === 'totp') as unknown as TotpFactor[];
}

/** Starts enrolling an authenticator app. Nothing is unlocked until verifyTotp succeeds. */
export async function enrollTotp(): Promise<{ factorId: string; qrCode: string; secret: string; uri: string }> {
  // Leftovers of an abandoned enrollment would block a new one with the same name; unverified factors give no access.
  for (const f of await listTotpFactors()) {
    if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: `Аутентификатор ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
  });
  if (error) throw error;
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri };
}

/** challenge + verify; on success Supabase Auth upgrades the session to aal2 and issues a new access token. */
export async function verifyTotp(factorId: string, code: string): Promise<void> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s+/g, '') });
  if (error) throw error;
}

export const MFA_REQUIRED_TEXT = 'Для администратора платформы обязательна двухфакторная аутентификация.';
