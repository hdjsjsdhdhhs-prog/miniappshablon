import {
  backButton,
  init,
  isTMA,
  miniApp,
  retrieveLaunchParams,
  retrieveRawInitData,
  viewport,
} from '@tma.js/sdk-react';

/**
 * Telegram Mini App bootstrap. The SDK is used for platform UX only (viewport, Back button,
 * header colors). It is NOT a security boundary: raw initData is forwarded to Edge Functions,
 * which verify the signature server-side.
 */
export interface TelegramEnv {
  inTelegram: boolean;
  rawInitData: string | null;
  startParam: string | null;
  platform: string | null;
}

let envState: TelegramEnv = { inTelegram: false, rawInitData: null, startParam: null, platform: null };
let initialized = false;

export function initTelegram(): TelegramEnv {
  if (initialized) return envState;
  initialized = true;
  try {
    if (!isTMA()) return envState;
    init();
    const lp = retrieveLaunchParams();
    envState = {
      inTelegram: true,
      rawInitData: retrieveRawInitData() ?? null,
      startParam: typeof lp.tgWebAppStartParam === 'string' ? lp.tgWebAppStartParam : null,
      platform: typeof lp.tgWebAppPlatform === 'string' ? lp.tgWebAppPlatform : null,
    };
    if (backButton.mount.isAvailable()) backButton.mount();
    if (miniApp.mount.isAvailable()) {
      miniApp.mount();
      miniApp.ready.ifAvailable();
    }
    if (viewport.mount.isAvailable()) {
      void viewport
        .mount()
        .then(() => {
          viewport.expand.ifAvailable();
          if (viewport.bindCssVars.isAvailable()) viewport.bindCssVars();
        })
        .catch(() => undefined);
    }
  } catch (err) {
    // Outside Telegram (regular browser) or an unsupported client: the storefront still works,
    // only Telegram-identity features (checkout, my orders) are disabled.
    console.warn('Telegram SDK init skipped', err);
  }
  return envState;
}

export function getTelegramEnv(): TelegramEnv {
  return envState;
}

export function setTelegramHeaderColors(background: string): void {
  if (!envState.inTelegram) return;
  try {
    if (miniApp.setHeaderColor.isAvailable()) miniApp.setHeaderColor(background as `#${string}`);
    if (miniApp.setBgColor.isAvailable()) miniApp.setBgColor(background as `#${string}`);
    if (miniApp.setBottomBarColor.isAvailable()) miniApp.setBottomBarColor(background as `#${string}`);
  } catch {
    /* optional cosmetics */
  }
}

/** Shows Telegram's native Back button while `visible`, wiring it to `onBack`. */
export function bindBackButton(visible: boolean, onBack: () => void): () => void {
  if (!envState.inTelegram) return () => undefined;
  try {
    if (!visible) {
      backButton.hide.ifAvailable();
      return () => undefined;
    }
    backButton.show.ifAvailable();
    const off = backButton.onClick.isAvailable() ? backButton.onClick(onBack) : () => undefined;
    return () => off();
  } catch {
    return () => undefined;
  }
}
