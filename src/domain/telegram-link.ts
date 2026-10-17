/**
 * Telegram channel links configured by shop owners (shops.info.telegramChannelUrl).
 *
 * Only Telegram links are accepted, and they are always rebuilt as `https://t.me/...`: an owner can
 * type `@channel`, `t.me/channel` or `telegram.me/+invite`, but no other host or protocol
 * (`javascript:`, `tg:`, `http:` to a foreign site…) can ever reach an `href`.
 */

export const DEFAULT_TELEGRAM_CHANNEL_LABEL = 'Наш канал в Телеграме';
export const TELEGRAM_CHANNEL_LABEL_MAX = 60;

// Public usernames: 5–32 chars, start with a letter, letters/digits/underscore, no trailing underscore.
const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_]{3,30}[A-Za-z0-9]$/;
// Private invite hashes (`t.me/+<hash>` or legacy `t.me/joinchat/<hash>`).
const INVITE_RE = /^[A-Za-z0-9_-]{10,64}$/;
const HOSTS = new Set(['t.me', 'www.t.me', 'telegram.me', 'www.telegram.me']);

/** Returns the canonical `https://t.me/...` link, or `null` when the input is not a valid channel link. */
export function normalizeTelegramChannelUrl(input: string | null | undefined): string | null {
  const raw = (input ?? '').trim();
  if (!raw || raw.length > 200) return null;

  if (raw.startsWith('@')) {
    const name = raw.slice(1);
    return USERNAME_RE.test(name) ? `https://t.me/${name}` : null;
  }

  // Bare `t.me/...` is allowed; any other explicit scheme than http(s) is rejected.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 1) {
    const [seg] = parts as [string];
    if (seg.startsWith('+')) return INVITE_RE.test(seg.slice(1)) ? `https://t.me/${seg}` : null;
    return USERNAME_RE.test(seg) ? `https://t.me/${seg}` : null;
  }
  if (parts.length === 2 && parts[0] === 'joinchat') {
    return INVITE_RE.test(parts[1]!) ? `https://t.me/+${parts[1]}` : null;
  }
  return null;
}

export function telegramChannelLabel(label: string | null | undefined): string {
  return (label ?? '').trim().slice(0, TELEGRAM_CHANNEL_LABEL_MAX) || DEFAULT_TELEGRAM_CHANNEL_LABEL;
}
