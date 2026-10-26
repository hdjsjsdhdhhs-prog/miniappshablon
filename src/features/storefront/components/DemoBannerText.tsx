import { openTelegramUrl } from '@/features/telegram/telegram';

export const DEMO_CONTACT_URL = 'https://t.me/caseypsd';

/**
 * Text of the top DEMO banner with the seller contact. The handle is a real `<a>` (new tab in a browser);
 * inside Telegram the click goes through the native openTelegramLink, so the Mini App stays reachable.
 * It never wraps inside itself and has a padded tap area that does not grow the banner.
 */
export function DemoBannerText() {
  return (
    <span className="text-balance">
      DEMO-режим: полный доступ можете приобрести у{' '}
      <a
        href={DEMO_CONTACT_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => {
          if (openTelegramUrl(DEMO_CONTACT_URL)) e.preventDefault();
        }}
        data-testid="demo-contact-link"
        className="-mx-1 -my-1 inline-block rounded-md px-1 py-1 font-semibold whitespace-nowrap text-(--telegram-link) underline decoration-(--telegram-edge) underline-offset-2 hover:decoration-(--telegram-blue) focus-visible:outline-(--telegram-blue)"
      >
        @caseypsd
      </a>
    </span>
  );
}
