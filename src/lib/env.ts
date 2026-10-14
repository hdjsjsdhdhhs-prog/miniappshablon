/**
 * Public, build-time configuration. Only publishable values are allowed here:
 * the Supabase URL and the anon/publishable key (protected by RLS). Never add service_role or
 * Telegram bot tokens — scripts/check-bundle-secrets.ts fails the build check if they leak.
 */
function read(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string {
  const value = import.meta.env[name] as string | undefined;
  if (!value) {
    throw new Error(`${name} is not configured. See .env.example and SETUP.md.`);
  }
  return value;
}

export const env = {
  supabaseUrl: read('VITE_SUPABASE_URL'),
  supabaseAnonKey: read('VITE_SUPABASE_ANON_KEY'),
} as const;
