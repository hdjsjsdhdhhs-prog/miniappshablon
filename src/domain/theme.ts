import { z } from 'zod';

/** Theme stored in shops.theme_config. Mirrors public.is_valid_theme() in SQL. */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет в формате #RRGGBB');

export const themeSchema = z.strictObject({
  mode: z.enum(['dark', 'light']),
  radius: z.number().min(0).max(28),
  background: hex,
  foreground: hex,
  card: hex,
  cardForeground: hex,
  primary: hex,
  primaryForeground: hex,
  accent: hex,
  accentForeground: hex,
  muted: hex,
  mutedForeground: hex,
  border: hex,
});

export type ShopTheme = z.infer<typeof themeSchema>;
export type ThemeColorKey = Exclude<keyof ShopTheme, 'mode' | 'radius'>;

export const THEME_COLOR_KEYS: readonly ThemeColorKey[] = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'primary',
  'primaryForeground',
  'accent',
  'accentForeground',
  'muted',
  'mutedForeground',
  'border',
];

export const DARK_PREMIUM_THEME: ShopTheme = {
  mode: 'dark',
  radius: 14,
  background: '#0e0e10',
  foreground: '#f4f4f5',
  card: '#18181b',
  cardForeground: '#f4f4f5',
  primary: '#d4a24c',
  primaryForeground: '#141414',
  accent: '#2b2b31',
  accentForeground: '#f4f4f5',
  muted: '#232327',
  mutedForeground: '#a1a1aa',
  border: '#2e2e34',
};

/** Maps a shop theme to the CSS custom properties consumed by Tailwind tokens (src/styles/index.css). */
export function themeToCssVars(theme: ShopTheme): Record<string, string> {
  return {
    '--background': theme.background,
    '--foreground': theme.foreground,
    '--card': theme.card,
    '--card-foreground': theme.cardForeground,
    '--popover': theme.card,
    '--popover-foreground': theme.cardForeground,
    '--primary': theme.primary,
    '--primary-foreground': theme.primaryForeground,
    '--secondary': theme.muted,
    '--secondary-foreground': theme.foreground,
    '--muted': theme.muted,
    '--muted-foreground': theme.mutedForeground,
    '--accent': theme.accent,
    '--accent-foreground': theme.accentForeground,
    '--border': theme.border,
    '--input': theme.border,
    '--ring': theme.primary,
    '--radius': `${theme.radius / 16}rem`,
  };
}

/** Parses an untrusted theme (DB JSON). Falls back to the platform default when invalid. */
export function parseTheme(value: unknown): ShopTheme {
  const result = themeSchema.safeParse(value);
  return result.success ? result.data : DARK_PREMIUM_THEME;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hexColor: string): number {
  const n = Number.parseInt(hexColor.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two #RRGGBB colors. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastIssue {
  pair: [ThemeColorKey, ThemeColorKey];
  ratio: number;
  required: number;
}

/** Text/background pairs that must stay readable (WCAG AA 4.5:1 for normal text). */
export function themeContrastIssues(theme: ShopTheme): ContrastIssue[] {
  const pairs: Array<[ThemeColorKey, ThemeColorKey, number]> = [
    ['foreground', 'background', 4.5],
    ['cardForeground', 'card', 4.5],
    ['primaryForeground', 'primary', 4.5],
    ['accentForeground', 'accent', 4.5],
    ['mutedForeground', 'background', 4.5],
  ];
  return pairs
    .map(([fg, bg, required]) => ({
      pair: [fg, bg] as [ThemeColorKey, ThemeColorKey],
      ratio: contrastRatio(theme[fg], theme[bg]),
      required,
    }))
    .filter((p) => p.ratio < p.required);
}
