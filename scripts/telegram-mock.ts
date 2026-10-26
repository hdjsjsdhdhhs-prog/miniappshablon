// pnpm telegram:mock — runs the local mock Telegram Bot API (see scripts/lib/telegram-mock.ts) in the
// foreground. Local Edge Functions send order notifications here; nothing reaches Telegram.
import { run, log } from './lib/cli.ts';
import { ensureTelegramMock, LOCAL_TELEGRAM_API_BASE, TELEGRAM_MOCK_URL } from './lib/telegram-mock.ts';

run(async () => {
  const mock = await ensureTelegramMock((line) => console.log(line));
  if (!mock.owned) {
    log.info(`Mock Bot API уже запущен: ${TELEGRAM_MOCK_URL}`);
    return 0;
  }
  log.ok(`Mock Bot API: ${TELEGRAM_MOCK_URL} (из Docker: ${LOCAL_TELEGRAM_API_BASE})`);
  log.info('Сообщения: GET /__mock/messages. Остановка: Ctrl+C');
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
    process.on('SIGTERM', () => resolve());
  });
  await mock.close();
  return 0;
});
