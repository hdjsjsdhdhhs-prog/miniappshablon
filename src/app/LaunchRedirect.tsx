import { Navigate } from 'react-router';
import { EmptyState } from '@/components/state-views';
import { SLUG_RE } from '@/domain/tenant-config';
import { getTelegramEnv } from '@/features/telegram/telegram';
import { DARK_PREMIUM_THEME } from '@/domain/theme';
import { ThemeScope } from '@/features/theme/ThemeScope';

/**
 * Entry point of the shared Mini App URL. Telegram passes the shop slug as start_param
 * (t.me/<bot>/<app>?startapp=<slug>); a direct web link uses /s/<slug>/ instead.
 */
export function LaunchRedirect() {
  const { startParam } = getTelegramEnv();
  const fromQuery = new URLSearchParams(window.location.search).get('shop');
  const slug = [startParam, fromQuery].find((s): s is string => !!s && SLUG_RE.test(s));
  if (slug) return <Navigate to={`/s/${slug}/`} replace />;
  return (
    <ThemeScope theme={DARK_PREMIUM_THEME}>
      <EmptyState
        className="min-h-dvh justify-center"
        title="Откройте магазин по ссылке"
        description="Ссылка на витрину выглядит как /s/<магазин>/ или приходит из Telegram-бота магазина."
      />
    </ThemeScope>
  );
}

export function NotFoundPage() {
  return (
    <ThemeScope theme={DARK_PREMIUM_THEME}>
      <EmptyState className="min-h-dvh justify-center" title="Страница не найдена" />
    </ThemeScope>
  );
}
