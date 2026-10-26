import { describe, expect, it } from 'vitest';
import { createTelegramMockServer, TELEGRAM_MOCK_DOCKER_GATEWAY, TELEGRAM_MOCK_ID, telegramMockApiBase } from './telegram-mock.ts';

describe('Telegram Bot API mock', () => {
  it('selects host routing for Windows Docker Desktop and the bridge gateway for Linux CI', () => {
    expect(telegramMockApiBase('win32')).toBe('http://host.docker.internal:54390');
    expect(telegramMockApiBase('linux')).toBe(`http://${TELEGRAM_MOCK_DOCKER_GATEWAY}:54390`);
  });

  it('serves a health response over HTTP without contacting Telegram', async () => {
    const server = createTelegramMockServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock test did not get a TCP address');

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/__mock/health`);
      expect(res.ok).toBe(true);
      expect(await res.json()).toEqual({ mock: TELEGRAM_MOCK_ID });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
