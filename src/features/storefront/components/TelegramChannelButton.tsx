import { TelegramLogoIcon } from '@phosphor-icons/react';
import { normalizeTelegramChannelUrl, telegramChannelLabel } from '@/domain/telegram-link';
import { openTelegramUrl } from '@/features/telegram/telegram';

/**
 * Header link to the shop's Telegram channel (shops.info.telegramChannelUrl / telegramChannelLabel).
 * Renders nothing when the stored link is empty or not a valid Telegram link.
 *
 * It is a real `<a>` (keyboard, long-press, "open in new tab"); inside Telegram the click is handed
 * to the native openTelegramLink so the channel opens in the client and the Mini App stays reachable.
 */
export function TelegramChannelButton({ url, label }: { url: string; label: string }) {
  const href = normalizeTelegramChannelUrl(url);
  if (!href) return null;
  const text = telegramChannelLabel(label);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        if (openTelegramUrl(href)) e.preventDefault();
      }}
      data-testid="telegram-channel-link"
      // Accent-tinted glass chip: same tokens as the selected category tile, no solid "Telegram blue".
      className="glass-card glass-transition glass-press inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border-[color:var(--glass-accent-edge)] bg-[color:var(--glass-accent-fill)] py-0 pr-3 pl-2 text-xs font-medium text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)] hover:border-primary hover:shadow-[inset_0_1px_0_var(--glass-highlight),0_8px_22px_-12px_var(--glass-accent-glow)] focus-visible:shadow-[inset_0_1px_0_var(--glass-highlight),0_0_0_3px_var(--glass-focus)]"
    >
      <TelegramLogoIcon aria-hidden weight="fill" className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 truncate">{text}</span>
    </a>
  );
}
