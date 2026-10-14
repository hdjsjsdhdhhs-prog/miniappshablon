/** Currencies supported by the platform. Mirrors public.is_supported_currency() (all exponent 2). */
export const SUPPORTED_CURRENCIES = [
  'RUB',
  'USD',
  'EUR',
  'KZT',
  'BYN',
  'UAH',
  'GEL',
  'AMD',
  'UZS',
  'KGS',
  'TRY',
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

const formatters = new Map<string, Intl.NumberFormat>();

/** Formats an integer amount in minor units (1/100). */
export function formatMoney(minor: number, currency: string, locale = 'ru-RU'): string {
  const key = `${locale}:${currency}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
    formatters.set(key, f);
  }
  return f.format(minor / 100);
}

/** Parses user input like "1 290,50" into minor units. Returns null when invalid. */
export function parseMoneyInput(input: string): number | null {
  const normalized = input.replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const [whole = '0', frac = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function minorToInput(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const frac = minor % 100;
  return frac === 0 ? String(whole) : `${whole},${String(frac).padStart(2, '0')}`;
}
