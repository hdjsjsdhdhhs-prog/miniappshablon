import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import type { Shop } from './api';
import { StorefrontLayout } from './StorefrontLayout';

const tg = vi.hoisted(() => ({ openTelegramUrl: vi.fn(() => false) }));
vi.mock('@/features/telegram/telegram', () => ({
  getTelegramEnv: () => ({ inTelegram: false, rawInitData: null, startParam: null, platform: null }),
  openTelegramUrl: tg.openTelegramUrl,
  setTelegramHeaderColors: () => undefined,
  bindBackButton: () => () => undefined,
}));

let current: Shop;
vi.mock('./hooks', () => ({
  useShopQuery: () => ({ isPending: false, data: current, error: null, refetch: vi.fn() }),
}));

const shop: Shop = {
  id: 'shop-1',
  slug: 'noir-vapor',
  name: 'Noir Vapor',
  description: '',
  logoPath: null,
  coverPath: null,
  theme: DARK_PREMIUM_THEME,
  currency: 'RUB',
  mode: 'live',
  isDemo: true,
  ageRestriction: 18,
  fulfillment: { delivery: true, pickup: true, pickupInstructions: '' },
  info: { address: '', hours: '', delivery: '', payment: '', phone: '', telegram: '', telegramChannelUrl: '', telegramChannelLabel: '' },
  settings: { showFeatured: true, showInfo: true, showCategories: true },
  telegram: { botUsername: null, miniAppShortName: null },
};

function renderLayout(value: Shop) {
  current = value;
  const router = createMemoryRouter(
    [{ path: '/s/:slug', element: <StorefrontLayout />, children: [{ index: true, element: <p>content</p> }] }],
    { initialEntries: [`/s/${value.slug}`] },
  );
  return render(<RouterProvider router={router} />);
}

describe('StorefrontLayout', () => {
  beforeEach(() => tg.openTelegramUrl.mockClear());

  it('never shows an age confirmation, even when the shop declares an age restriction', () => {
    renderLayout(shop);
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Вам исполнилось/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /мне есть/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/младше 18 лет/)).not.toBeInTheDocument();
    expect(localStorage.getItem(`tma-age-ok:${shop.id}`)).toBeNull();
  });

  it('demo banner: "DEMO-режим: приобрести полный доступ - [Telegram logo] caseypsd", one line, link to t.me/caseypsd', () => {
    renderLayout(shop);
    const banner = screen.getByTestId('demo-banner');
    expect(banner).toHaveTextContent(/^DEMO-режим: приобрести полный доступ - caseypsd$/);
    expect(banner).not.toHaveTextContent('@');
    expect(banner).not.toHaveTextContent('можете приобрести у');
    // Fixed height, no wrapping: the text can never grow the bar.
    expect(banner).toHaveClass('h-8', 'whitespace-nowrap', 'overflow-hidden');
    expect(screen.getByTestId('demo-banner-text')).toHaveClass('whitespace-nowrap');
    // The reddish dot comes first, before the text.
    const dot = screen.getByTestId('demo-banner-dot');
    expect(banner.firstElementChild).toBe(dot);
    expect(dot.className).toContain('bg-[#ff5a5f]');
    const link = within(banner).getByRole('link', { name: 'caseypsd' });
    expect(link).toHaveAttribute('href', 'https://t.me/caseypsd');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveClass('whitespace-nowrap', 'text-(--telegram-link)');
    // The Telegram logo replaces "@" and is part of the same link.
    const icon = within(link).getByTestId('demo-contact-icon');
    expect(icon).toHaveClass('text-(--telegram-blue)');
    expect(link.firstElementChild).toBe(icon);
    link.click();
    expect(tg.openTelegramUrl).toHaveBeenCalledWith('https://t.me/caseypsd');
  });

  it('preview mode keeps its own banner; a regular live shop has no banner', () => {
    const { unmount } = renderLayout({ ...shop, mode: 'preview' });
    expect(screen.getByTestId('demo-banner')).toHaveTextContent('Предпросмотр: магазин не опубликован, заказы отключены');
    expect(screen.queryByTestId('demo-contact-link')).not.toBeInTheDocument();
    unmount();
    renderLayout({ ...shop, isDemo: false });
    expect(screen.queryByTestId('demo-banner')).not.toBeInTheDocument();
  });
});
