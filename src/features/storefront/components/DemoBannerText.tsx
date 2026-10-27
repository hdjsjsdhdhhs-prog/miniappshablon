import { TelegramLogoIcon } from '@phosphor-icons/react';
import { openTelegramUrl } from '@/features/telegram/telegram';

export const DEMO_CONTACT_URL = 'https://t.me/caseypsd';
export const DEMO_CONTACT_HANDLE = 'caseypsd';
export const DEMO_BANNER_TEXT = 'DEMO-режим: приобрести полный доступ -';

/**
 * Text of the top DEMO banner: "DEMO-режим: приобрести полный доступ - [Telegram logo] caseypsd".
 * Always one line: the font size follows the viewport (≈10 px at 320 px, 13 px max), nothing wraps, and the
 * banner height never depends on the text. The logo + handle are one real `<a>` (new tab in a browser); inside
 * Telegram the click goes through the native openTelegramLink, so the Mini App stays reachable. An invisible
 * ::after enlarges the tap area without moving the layout.
 */
export function DemoBannerText() {
  return (
    <span className="min-w-0 text-[clamp(10px,3.15vw,13px)] leading-none whitespace-nowrap" data-testid="demo-banner-text">
      {DEMO_BANNER_TEXT}{' '}
      <a
        href={DEMO_CONTACT_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (openTelegramUrl(DEMO_CONTACT_URL)) e.preventDefault();
        }}
        data-testid="demo-contact-link"
        className="relative inline-flex items-center gap-[0.25em] rounded-sm align-middle font-semibold whitespace-nowrap text-(--telegram-link) after:absolute after:inset-x-0 after:-inset-y-2 after:content-[''] hover:underline hover:underline-offset-2 focus-visible:outline-(--telegram-blue)"
      >
        <TelegramLogoIcon aria-hidden weight="fill" className="size-[1.25em] shrink-0 text-(--telegram-blue)" data-testid="demo-contact-icon" />
        {DEMO_CONTACT_HANDLE}
      </a>
    </span>
  );
}
