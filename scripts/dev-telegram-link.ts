// pnpm dev:tg-link --slug <slug> [--user-id 123] [--name Имя] [--base http://127.0.0.1:5173]
// LOCAL DEVELOPMENT ONLY. Prints a storefront URL with Telegram launch params whose initData is
// signed with the local placeholder token used by `pnpm db:start`. It lets you test checkout and
// "my orders" in a regular browser against the local stack. Such links are rejected by any
// deployment that uses a real TELEGRAM_BOT_TOKEN.
import { randomBytes } from 'node:crypto';
import { signInitData } from '../supabase/functions/_shared/telegram-init-data.ts';
import { fail, log, parseArgs, requireString, run } from './lib/cli.ts';
import { assertSlug } from './lib/tenant-fs.ts';

const LOCAL_TOKEN = '123456789:LOCAL_TEST_TOKEN_NOT_A_SECRET';

run(async () => {
  const args = parseArgs();
  const slug = requireString(args, 'slug');
  assertSlug(slug);
  const token = process.env.TELEGRAM_BOT_TOKEN ?? LOCAL_TOKEN;
  if (token !== LOCAL_TOKEN) fail('Скрипт работает только с локальным тестовым токеном (не используйте реальный токен бота).');
  const id = Number(args.flags['user-id'] ?? 900_000_001);
  const name = typeof args.flags.name === 'string' ? args.flags.name : 'Тестовый покупатель';
  const base = typeof args.flags.base === 'string' ? args.flags.base.replace(/\/$/, '') : 'http://127.0.0.1:5173';

  const initData = await signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: `DEV${id}`,
      user: JSON.stringify({ id, first_name: name, username: `dev_${id}` }),
      signature: randomBytes(64).toString('base64url'),
    },
    token,
  );
  const hash = new URLSearchParams({
    tgWebAppData: initData,
    tgWebAppVersion: '8.0',
    tgWebAppPlatform: 'web',
    tgWebAppThemeParams: JSON.stringify({}),
  }).toString();
  log.ok(`Ссылка (действует ~24 ч, user.id=${id}):`);
  console.log(`${base}/s/${slug}/#${hash}`);
});
