import { describe, expect, it } from 'vitest';
import { createTelegramMockServer, TELEGRAM_MOCK_DOCKER_GATEWAY, TELEGRAM_MOCK_ID, telegramMockApiBase } from './telegram-mock.ts';

describe('Telegram Bot API mock: getMe identifies the bot', () => {
  async function withMock<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const server = createTelegramMockServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('mock test did not get a TCP address');
    try {
      return await fn(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }
  const secret = (prefix: string, tail = 'a') => `${prefix}_${tail.repeat(30)}`;
  const getMe = (base: string, id: number, secretPart: string) => fetch(`${base}/bot${id}:${secretPart}/getMe`);

  it('different bots have different Bot IDs; the same bot has the same Bot ID whatever its token text is', async () => {
    await withMock(async (base) => {
      const notificationBot = (await (await getMe(base, 700000001, secret('FAKE'))).json()) as { ok: boolean; result: { id: number; is_bot: boolean; username: string } };
      const storeBot = (await (await getMe(base, 700000002, secret('FAKE'))).json()) as typeof notificationBot;
      const notificationBotReissued = (await (await getMe(base, 700000001, secret('FAKE', 'b'))).json()) as typeof notificationBot;
      expect(notificationBot).toMatchObject({ ok: true, result: { id: 700000001, is_bot: true, username: 'mock_700000001_bot' } });
      expect(storeBot.result.id).toBe(700000002);
      expect(storeBot.result.id).not.toBe(notificationBot.result.id);
      // A re-issued token (BotFather /revoke): another text, the same bot.
      expect(notificationBotReissued.result.id).toBe(notificationBot.result.id);
    });
  });

  it('answers 401 for an invalid token and 503 while the Bot API is "unavailable"', async () => {
    await withMock(async (base) => {
      const unauthorized = await getMe(base, 700000003, secret('UNAUTHORIZED'));
      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toMatchObject({ ok: false, error_code: 401 });
      const unavailable = await getMe(base, 700000004, secret('UNAVAILABLE'));
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toMatchObject({ ok: false, error_code: 503 });
    });
  });
});

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
