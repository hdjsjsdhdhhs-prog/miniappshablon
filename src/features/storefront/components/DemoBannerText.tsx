import { TelegramLogoIcon } from '@phosphor-icons/react';
import { openTelegramUrl } from '@/features/telegram/telegram';

export const DEMO_CONTACT_URL = 'https://t.me/caseypsd';
export const DEMO_CONTACT_HANDLE = 'caseypsd';
export const DEMO_BANNER_TEXT = 'DEMO-режим: приобрести полный доступ -';

/**
 * Text of the top DEMO banner: "DEMO-режим: приобрести полный доступ - [Telegram logo] caseypsd".
 * Always one line: the font size follows the viewport (10 px at 320 px, 13 px max), nothing wraps, and the
 * banner height never depends on the text.
 *
 * Width budget: the text uses the platform's system font, whose width varies a lot — ≈26.5 em in Segoe UI / Roboto /
 * Arial, ≈30 em in DejaVu Sans (default sans on Ubuntu) or Verdana. The size (3vw, floor 10 px), the slightly tighter
 * tracking and the compact logo are chosen so that even a ≈30 em font fits the banner's inner width at 320 px
 * (320 − 12 padding − 6 dot − 4 gap = 298 px) with a few px to spare, and keeps that margin at every wider width.
 * The logo + handle are one real `<a>` (new tab in a browser); inside
 * Telegram the click goes through the native openTelegramLink, so the Mini App stays reachable. An invisible
 * ::after enlarges the tap area without moving the layout.
 */
export function DemoBannerText() {
  return (
    <span
      className="min-w-0 text-[clamp(10px,3vw,13px)] leading-none tracking-[-0.01em] whitespace-nowrap"
      data-testid="demo-banner-text"
    >
      {DEMO_BANNER_TEXT}{' '}
      <a
        href={DEMO_CONTACT_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (openTelegramUrl(DEMO_CONTACT_URL)) e.preventDefault();
        }}
        data-testid="demo-contact-link"
        className="relative inline-flex items-center gap-[0.2em] rounded-sm align-middle font-semibold whitespace-nowrap text-(--telegram-link) after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] hover:underline hover:underline-offset-2 focus-visible:outline-(--telegram-blue)"
      >
        <TelegramLogoIcon aria-hidden weight="fill" className="size-[1.1em] shrink-0 text-(--telegram-blue)" data-testid="demo-contact-icon" />
        {DEMO_CONTACT_HANDLE}
      </a>
    </span>
  );
}
