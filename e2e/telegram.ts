import { randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { signInitData } from '../supabase/functions/_shared/telegram-init-data.ts';

/** Must match the token the local Edge Runtime was started with (scripts/supabase-start.cmd). */
export const LOCAL_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '123456789:LOCAL_TEST_TOKEN_NOT_A_SECRET';

/**
 * Opens a storefront page the way the Telegram client does: launch parameters in the URL hash.
 * initData is signed with the LOCAL test token and verified for real by the Edge Function.
 * Only the client-side native bridge is emulated (no-op TelegramWebviewProxy) — this is NOT a
 * real Telegram client and is documented as such in ACCEPTANCE.md.
 */
export async function openAsTelegramUser(page: Page, path: string, user: { id: number; first_name: string }) {
  const initData = await signInitData(
    {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: `E2E${user.id}`,
      user: JSON.stringify(user),
      // Real clients (Bot API 8.0+) always send `signature` (Ed25519, third-party validation);
      // the SDK schema requires it. It is part of the HMAC data_check_string like any other field.
      signature: randomBytes(64).toString('base64url'),
    },
    LOCAL_BOT_TOKEN,
  );
  await page.addInitScript(() => {
    (window as unknown as { TelegramWebviewProxy: { postEvent: () => void } }).TelegramWebviewProxy = { postEvent: () => undefined };
  });
  const hash = new URLSearchParams({
    tgWebAppData: initData,
    tgWebAppVersion: '8.0',
    tgWebAppPlatform: 'android',
    tgWebAppThemeParams: JSON.stringify({ bg_color: '#0e0e10', text_color: '#f4f4f5' }),
  }).toString();
  await page.goto(`${path}#${hash}`);
}
