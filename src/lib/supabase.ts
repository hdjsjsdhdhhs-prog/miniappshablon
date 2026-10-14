import { createClient } from '@supabase/supabase-js';
import { IMAGE_SETTINGS } from '@/config/images';
import type { Database } from './database.types';
import { env } from './env';

/**
 * Single browser client (anon key). Buyers stay anonymous: public catalog access is governed by
 * RLS, private buyer operations go through Edge Functions with Telegram initData. Owners sign in
 * with Supabase Auth; the same client then carries their JWT for RLS-protected admin writes.
 */
export const supabase = createClient<Database>(env.supabaseUrl, env.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'tma-shop-auth' },
});

export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];

export function publicImageUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  return supabase.storage.from(IMAGE_SETTINGS.bucket).getPublicUrl(path).data.publicUrl;
}

export function functionsUrl(name: string): string {
  return `${env.supabaseUrl}/functions/v1/${name}`;
}
