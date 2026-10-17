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
  // 1) Identity data: read launch params first, so a failure of optional UI features below can
  //    never drop the raw initData (which the server verifies anyway).
  try {
    if (!isTMA()) return envState;
    const lp = retrieveLaunchParams();
    envState = {
      inTelegram: true,
      rawInitData: retrieveRawInitData() ?? null,
      startParam: typeof lp.tgWebAppStartParam === 'string' ? lp.tgWebAppStartParam : null,
      platform: typeof lp.tgWebAppPlatform === 'string' ? lp.tgWebAppPlatform : null,
    };
  } catch (err) {
    // Outside Telegram (regular browser): the storefront works, Telegram-identity features
    // (checkout, my orders) stay disabled.
    console.warn('Telegram launch params unavailable', err);
    return envState;
  }
  // 2) Platform UX (Back button, viewport, header colors): best effort.
  try {
    init();
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
    // No native bridge (e.g. a local browser preview with signed launch params): cosmetics only.
    console.warn('Telegram UI features unavailable', err);
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
