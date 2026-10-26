import { assertEdgeRuntimeUsesMock, assertTelegramMockDockerNetwork, ensureTelegramMock } from '../../scripts/lib/telegram-mock.ts';

/**
 * Order notifications are exercised end-to-end through the local Edge Runtime, which must talk to the local
 * mock Bot API — never to api.telegram.org. Refuse to run otherwise, then start (or reuse) the mock.
 */
export default async function setup() {
  if (process.platform !== 'win32') {
    assertTelegramMockDockerNetwork();
  }
  assertEdgeRuntimeUsesMock();
  const mock = await ensureTelegramMock();
  return async () => {
    await mock.close();
  };
}
