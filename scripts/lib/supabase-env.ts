import { execFileSync } from 'node:child_process';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/database.types.ts';
import { fail } from './cli.ts';

export interface SupabaseEnv {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  isLocal: boolean;
}

let cached: SupabaseEnv | null = null;

/**
 * Remote project: SUPABASE_URL + SUPABASE_ANON_KEY + SUPABASE_SERVICE_ROLE_KEY from the shell
 * environment (never from committed files). Otherwise falls back to the running local stack
 * via `supabase status` (local development keys only).
 */
export function resolveSupabaseEnv(): SupabaseEnv {
  if (cached) return cached;
  const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    if (!SUPABASE_ANON_KEY) fail('Задайте SUPABASE_ANON_KEY вместе с SUPABASE_SERVICE_ROLE_KEY');
    cached = {
      url: SUPABASE_URL,
      anonKey: SUPABASE_ANON_KEY,
      serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY,
      isLocal: /127\.0\.0\.1|localhost/.test(SUPABASE_URL),
    };
    return cached;
  }
  let raw: string;
  try {
    raw = execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
  } catch {
    fail(
      'Supabase недоступен: запустите локальный стек (pnpm db:start) или задайте SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const status = JSON.parse(json) as Record<string, string>;
  const url = status.API_URL;
  const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  if (!url || !anonKey || !serviceRoleKey) fail('Не удалось прочитать ключи из `supabase status`');
  cached = { url, anonKey, serviceRoleKey, isLocal: true };
  return cached;
}

export function serviceClient(): SupabaseClient<Database> {
  const env = resolveSupabaseEnv();
  return createClient<Database>(env.url, env.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function anonClient(): SupabaseClient<Database> {
  const env = resolveSupabaseEnv();
  return createClient<Database>(env.url, env.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function publicObjectUrl(path: string): string {
  return `${resolveSupabaseEnv().url}/storage/v1/object/public/shop-media/${path}`;
}
