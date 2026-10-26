// pnpm db:start — starts the local Supabase stack with LOCAL-ONLY Edge Function secrets.
// The default Telegram token below is a placeholder that is never valid in Telegram; it only lets
// local tests sign initData with the same key the local Edge Runtime verifies with.
import { execFileSync, spawn } from 'node:child_process';
import { run } from './lib/cli.ts';
import {
  assertTelegramMockDockerNetwork,
  LOCAL_TELEGRAM_API_BASE,
  TELEGRAM_MOCK_DOCKER_GATEWAY,
  TELEGRAM_MOCK_DOCKER_NETWORK,
} from './lib/telegram-mock.ts';

run(async () => {
  if (process.platform !== 'win32') {
    try {
      execFileSync('docker', ['network', 'inspect', TELEGRAM_MOCK_DOCKER_NETWORK], { stdio: 'ignore' });
    } catch {
      execFileSync(
        'docker',
        ['network', 'create', '--driver', 'bridge', '--subnet', '172.30.0.0/24', '--gateway', TELEGRAM_MOCK_DOCKER_GATEWAY, TELEGRAM_MOCK_DOCKER_NETWORK],
        { stdio: 'inherit' },
      );
    }
    assertTelegramMockDockerNetwork();
  }
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: '123456789:LOCAL_TEST_TOKEN_NOT_A_SECRET',
    TELEGRAM_INITDATA_MAX_AGE_SEC: process.env.TELEGRAM_INITDATA_MAX_AGE_SEC ?? '86400',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ?? '*',
    // Order notifications of a local stack go to the local mock Bot API (pnpm telegram:mock), never to Telegram.
    TELEGRAM_API_BASE: LOCAL_TELEGRAM_API_BASE,
  };
  const dockerNetwork = process.platform === 'win32' ? [] : ['--network-id', TELEGRAM_MOCK_DOCKER_NETWORK];
  const child = spawn('pnpm', ['exec', 'supabase', 'start', ...dockerNetwork, ...process.argv.slice(2)], {
    // `supabase start` prints its full status object, including local keys, to stdout.
    stdio: ['inherit', 'ignore', 'inherit'],
    env,
    shell: process.platform === 'win32',
  });
  return await new Promise<number>((resolve) =>
    child.on('exit', (code) => {
      if (code === 0) console.log('Локальный Supabase запущен.');
      resolve(code ?? 1);
    }),
  );
});
