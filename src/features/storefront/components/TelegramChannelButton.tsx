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
      // Compact Telegram-blue chip (edge, icon and glow use the Telegram tokens, identical in every tenant theme).
      // It is 28 px tall; the invisible ::after extends the tap area to 44 px without moving the layout.
      className="glass-transition glass-press relative inline-flex h-7 max-w-full items-center gap-1 rounded-full border border-(--telegram-edge) bg-(--telegram-fill) py-0 pr-2.5 pl-1.5 text-xs leading-none font-medium text-foreground shadow-[0_0_14px_-6px_var(--telegram-glow)] after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] hover:border-(--telegram-blue) hover:shadow-[0_0_18px_-4px_var(--telegram-glow)] focus-visible:outline-(--telegram-blue)"
    >
      <TelegramLogoIcon aria-hidden weight="fill" className="size-4 shrink-0 text-(--telegram-blue)" />
      <span className="min-w-0 truncate">{text}</span>
    </a>
  );
}
