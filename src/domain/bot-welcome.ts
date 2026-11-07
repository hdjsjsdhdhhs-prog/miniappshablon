/**
 * Browser side of the welcome settings of a shop's own Telegram bot (tab «Подключение бота»): validation hints and the
 * Telegram-style preview. The server (supabase/functions/_shared/bot-welcome.ts) is the authority and re-validates
 * everything; both implementations are checked against each other in bot-welcome.test.ts.
 */

export const WELCOME_TEXT_MAX = 4096;
export const BUTTON_TEXT_MAX = 64;
export const SHOP_NAME_PLACEHOLDER = '{название_магазина}';

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;
const TG_HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);

/** `@username`, `t.me/username`, `https://t.me/username` → `https://t.me/username`; anything else → null. */
export function normalizeManagerUrl(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw || raw.length > 200) return null;
  if (raw.startsWith('@')) {
    const name = raw.slice(1);
    return USERNAME_RE.test(name) ? `https://t.me/${name}` : null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !TG_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (url.username || url.password || url.port || url.search || url.hash) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 1 || !USERNAME_RE.test(parts[0]!)) return null;
  return `https://t.me/${parts[0]}`;
}

/** The text a buyer receives (the shop name substituted). */
export function renderWelcome(template: string, shopName: string): string {
  return template.split(SHOP_NAME_PLACEHOLDER).join(shopName);
}
