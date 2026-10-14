import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { themeToCssVars, type ShopTheme } from '@/domain/theme';
import { setTelegramHeaderColors } from '@/features/telegram/telegram';
import { cn } from '@/lib/utils';

/**
 * Applies a shop palette at runtime through CSS custom properties. Changing the theme in the
 * admin updates shops.theme_config; the next fetch re-renders this scope — no rebuild needed.
 */
export function ThemeScope({ theme, children, className }: { theme: ShopTheme; children: ReactNode; className?: string }) {
  useEffect(() => {
    const vars = themeToCssVars(theme);
    const root = document.documentElement;
    Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));
    root.style.colorScheme = theme.mode;
    setTelegramHeaderColors(theme.background);
    return () => {
      Object.keys(vars).forEach((k) => root.style.removeProperty(k));
      root.style.colorScheme = '';
    };
  }, [theme]);

  return (
    <div
      data-theme-mode={theme.mode}
      className={cn(theme.mode === 'dark' && 'dark', 'min-h-dvh bg-background text-foreground', className)}
      style={themeToCssVars(theme) as CSSProperties}
    >
      {children}
    </div>
  );
}
