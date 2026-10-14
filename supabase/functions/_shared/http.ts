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

export function initDataMaxAgeSec(): number {
  const raw = Number(Deno.env.get('TELEGRAM_INITDATA_MAX_AGE_SEC') ?? '86400');
  return Number.isFinite(raw) && raw > 0 ? raw : 86400;
}

export function parseDbErrorDetails(details: string | null | undefined): unknown {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}
