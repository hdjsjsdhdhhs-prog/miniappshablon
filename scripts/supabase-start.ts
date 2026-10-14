// pnpm db:start — starts the local Supabase stack with LOCAL-ONLY Edge Function secrets.
// The default Telegram token below is a placeholder that is never valid in Telegram; it only lets
// local tests sign initData with the same key the local Edge Runtime verifies with.
import { spawn } from 'node:child_process';
import { run } from './lib/cli.ts';

run(async () => {
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? '123456789:LOCAL_TEST_TOKEN_NOT_A_SECRET',
    TELEGRAM_INITDATA_MAX_AGE_SEC: process.env.TELEGRAM_INITDATA_MAX_AGE_SEC ?? '86400',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '*',
  };
  const child = spawn('pnpm', ['exec', 'supabase', 'start', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  return await new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? 1)));
});
