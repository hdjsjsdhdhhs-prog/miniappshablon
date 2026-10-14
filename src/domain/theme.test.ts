import { describe, expect, it } from 'vitest';
import { contrastRatio, DARK_PREMIUM_THEME, parseTheme, themeContrastIssues, themeSchema, themeToCssVars } from './theme';

describe('theme', () => {
  it('accepts the default palette and maps it to CSS variables', () => {
    expect(themeSchema.parse(DARK_PREMIUM_THEME)).toEqual(DARK_PREMIUM_THEME);
    const vars = themeToCssVars(DARK_PREMIUM_THEME);
    expect(vars['--background']).toBe('#0e0e10');
    expect(vars['--primary']).toBe('#d4a24c');
    expect(vars['--ring']).toBe(DARK_PREMIUM_THEME.primary);
    expect(vars['--radius']).toBe('0.875rem');
  });

  it('rejects invalid colors, unknown keys and out-of-range radius (mirrors SQL is_valid_theme)', () => {
    expect(themeSchema.safeParse({ ...DARK_PREMIUM_THEME, primary: 'red' }).success).toBe(false);
    expect(themeSchema.safeParse({ ...DARK_PREMIUM_THEME, primary: '#fff' }).success).toBe(false);
    expect(themeSchema.safeParse({ ...DARK_PREMIUM_THEME, extra: '#ffffff' }).success).toBe(false);
    expect(themeSchema.safeParse({ ...DARK_PREMIUM_THEME, radius: 40 }).success).toBe(false);
    expect(themeSchema.safeParse({ ...DARK_PREMIUM_THEME, mode: 'sepia' }).success).toBe(false);
  });

  it('falls back to the platform theme when DB JSON is invalid', () => {
    expect(parseTheme({ nope: true })).toEqual(DARK_PREMIUM_THEME);
    expect(parseTheme(null)).toEqual(DARK_PREMIUM_THEME);
  });

  it('computes WCAG contrast and flags unreadable pairs', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(themeContrastIssues(DARK_PREMIUM_THEME)).toEqual([]);
    const bad = { ...DARK_PREMIUM_THEME, foreground: '#111111' };
    expect(themeContrastIssues(bad).map((i) => i.pair)).toContainEqual(['foreground', 'background']);
  });
});
