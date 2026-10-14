// pnpm dev:local [-- vite args]
// Starts Vite against the LOCAL Supabase stack, passing its URL and anon key via process env
// (no .env file is written). For a remote project use `pnpm dev` with VITE_* variables.
import { spawn } from 'node:child_process';
import { run } from './lib/cli.ts';
import { resolveSupabaseEnv } from './lib/supabase-env.ts';

run(async () => {
  const env = resolveSupabaseEnv();
  const mode = process.argv.includes('--preview') ? 'preview' : 'dev';
  const extra = process.argv.slice(2).filter((a) => a !== '--preview');
  const child = spawn('pnpm', ['exec', 'vite', ...(mode === 'preview' ? ['preview'] : []), ...extra], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, VITE_SUPABASE_URL: env.url, VITE_SUPABASE_ANON_KEY: env.anonKey },
  });
  return await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 0)));
});
