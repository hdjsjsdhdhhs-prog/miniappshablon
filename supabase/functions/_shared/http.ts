// HTTP helpers for Edge Functions (Deno).

const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allow = allowedOrigins.includes('*')
    ? '*'
    : allowedOrigins.includes(origin)
      ? origin
      : (allowedOrigins[0] ?? '');
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type, x-telegram-init-data',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorResponse(req: Request, status: number, code: string, details?: unknown): Response {
  return json(req, status, { error: { code, details: details ?? null } });
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/**
 * What the verified initData is used for. Telegram issues a fresh initData every time the Mini App is opened; it is
 * NOT refreshed while the app stays open, so the limit is "time since the buyer opened the shop".
 *   read     — my-orders (own order history): 2 h.
 *   checkout — creating an order (stock moves, owner notified): 1 h.
 */
export type InitDataPurpose = 'read' | 'checkout';

export const INITDATA_MAX_AGE_SEC: Readonly<Record<InitDataPurpose, number>> = { read: 7200, checkout: 3600 };

/**
 * Accepted age of initData for a purpose. TELEGRAM_INITDATA_MAX_AGE_SEC may only SHORTEN it (an old deployment
 * value such as 86400 can no longer extend the window); invalid or missing values fall back to the cap.
 */
export function initDataMaxAgeSec(purpose: InitDataPurpose = 'read', envValue = Deno.env.get('TELEGRAM_INITDATA_MAX_AGE_SEC')): number {
  const cap = INITDATA_MAX_AGE_SEC[purpose];
  const raw = Number(envValue ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), cap) : cap;
}

export function parseDbErrorDetails(details: string | null | undefined): unknown {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}
