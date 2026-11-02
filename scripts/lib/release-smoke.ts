/**
 * Read-only smoke checks of a production release (`release.yml` jobs `smoke-api` and `smoke-web`); CLI:
 * scripts/release-smoke.ts, tests: release-smoke.test.ts.
 *
 * Safety: only GET requests with the public (anon / publishable) key, plus requests the server refuses before it reads
 * or writes any data (a GET to an Edge Function → 405; a checkout POST without Telegram initData → 401, verified before
 * the body is parsed; an admin RPC as anon → permission denied). No order, no buyer data, no write of any kind.
 */

/** Public stock projection of 20261102090100_stock_status_projection.sql. */
export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock'] as const;

/**
 * Exactly the embed the storefront requests (src/features/storefront/api.ts, PRODUCT_COLUMNS); kept identical by
 * release-smoke.test.ts. The smoke check sends it as anon, i.e. it is the new frontend's API contract.
 */
export const STOREFRONT_VARIANT_EMBED = 'product_variants(id, flavor, color, stock_status, is_active, sort_order)';
/** The storefront's product columns (PRODUCT_COLUMNS in src/features/storefront/api.ts). */
export const STOREFRONT_PRODUCT_COLUMNS =
  'id, name, base_price_minor, category_id, description, ' +
  'categories!inner(name, slug, is_active, archived_at), ' +
  `${STOREFRONT_VARIANT_EMBED}, ` +
  'product_images(id, storage_path, is_primary, sort_order, alt_text)';
/** The variant embed of the frontend BEFORE this release (main, 741d478): it still reads stock_quantity. */
export const LEGACY_VARIANT_EMBED = 'product_variants(id, flavor, color, stock_quantity, is_active, sort_order)';

/** Admin-only RPC of the stock projection; anon must be refused (exists + protected), never served. */
export const STOCK_RPC = 'admin_variant_stock';

/** SPA routes that must serve the app shell (public storefront + admin entry). */
export const PUBLIC_PAGES = (slug: string) => ['/', `/s/${slug}/`, `/s/${slug}/catalog`, '/admin'];
export const DEFAULT_SMOKE_SLUG = 'noir-vapor';

export interface HttpResult {
  status: number;
  contentType: string;
  body: string;
}

function fail(reason: string): never {
  throw new Error(`Smoke: ${reason}`);
}

function parseJson(r: HttpResult, what: string): unknown {
  try {
    return JSON.parse(r.body);
  } catch {
    return fail(`${what}: HTTP ${r.status}, body is not JSON`);
  }
}

const pgCode = (body: unknown) => (body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined);
const fnErrorCode = (body: unknown) =>
  body && typeof body === 'object' ? ((body as { error?: { code?: unknown } }).error?.code ?? undefined) : undefined;

/** `GET /auth/v1/health` answered 200. */
export function assertSupabaseReachable(r: HttpResult): void {
  if (r.status !== 200) fail(`Supabase Auth health answered HTTP ${r.status}`);
}

/** `product_variants?select=id,stock_status` as anon: 200, an array, every status one of STOCK_STATUSES. */
export function assertStockStatusReadable(r: HttpResult): number {
  if (r.status !== 200) fail(`product_variants.stock_status is not readable as anon (HTTP ${r.status}: ${r.body.slice(0, 200)})`);
  const rows = parseJson(r, 'stock_status');
  if (!Array.isArray(rows)) fail('stock_status: response is not an array');
  for (const row of rows) {
    const status = (row as { stock_status?: unknown }).stock_status;
    if (!STOCK_STATUSES.includes(status as (typeof STOCK_STATUSES)[number])) fail(`stock_status has unexpected value ${JSON.stringify(status)}`);
    if ('stock_quantity' in (row as object)) fail('stock_quantity leaked into the stock_status projection');
  }
  return rows.length;
}

/** A storefront query (the new contract) as anon: 200 and an array. */
export function assertStorefrontQuery(r: HttpResult, what: string): number {
  if (r.status !== 200) fail(`${what} answered HTTP ${r.status}: ${r.body.slice(0, 200)}`);
  const rows = parseJson(r, what);
  if (!Array.isArray(rows)) fail(`${what}: response is not an array`);
  return rows.length;
}

/** Admin RPC as anon: refused with permission denied (42501) — exists and is protected. Missing → PGRST202 → fail. */
export function assertRpcProtected(r: HttpResult, name: string): void {
  const body = parseJson(r, `rpc ${name}`);
  if (pgCode(body) === 'PGRST202') fail(`RPC ${name} does not exist`);
  if (r.status === 200) fail(`RPC ${name} answered anon with data`);
  if (pgCode(body) !== '42501') fail(`RPC ${name}: expected permission denied (42501), got HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
}

/** GET to an Edge Function: our handler answers 405 method_not_allowed (the gateway answers 404 for a missing one). */
export function assertFunctionDeployed(r: HttpResult, name: string): void {
  if (r.status === 404) fail(`Edge Function ${name} is not deployed (HTTP 404)`);
  const body = parseJson(r, `function ${name}`);
  if (r.status !== 405 || fnErrorCode(body) !== 'method_not_allowed') {
    fail(`Edge Function ${name}: expected 405 method_not_allowed, got HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
}

/** checkout POST without initData: 401 telegram_auth_failed (refused before the body is read; 500 = misconfigured). */
export function assertCheckoutRequiresTelegram(r: HttpResult): void {
  const body = parseJson(r, 'checkout');
  if (r.status !== 401 || fnErrorCode(body) !== 'telegram_auth_failed') {
    fail(`checkout without initData: expected 401 telegram_auth_failed, got HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
}

export type LegacyCompatibility = 'compatible' | 'incompatible';

/**
 * Whether the frontend from BEFORE this release can still read its variant embed (stock_quantity). Informational: it
 * decides how urgent the frontend step is (RELEASE.md), it never blocks — blocking would keep the old frontend live.
 */
export function legacyCompatibility(r: HttpResult): LegacyCompatibility {
  if (r.status === 200) return 'compatible';
  const body = (() => {
    try {
      return JSON.parse(r.body) as unknown;
    } catch {
      return null;
    }
  })();
  if (pgCode(body) === '42501' || /permission denied/i.test(r.body)) return 'incompatible';
  return fail(`legacy variant query answered HTTP ${r.status}: ${r.body.slice(0, 200)}`);
}

/** The app shell: 200 HTML with the React root and at least one module script under /assets/. */
export function assertAppShell(r: HttpResult, url: string): string[] {
  if (r.status !== 200) fail(`${url} answered HTTP ${r.status}`);
  if (!/text\/html/i.test(r.contentType)) fail(`${url} is not HTML (${r.contentType})`);
  if (!r.body.includes('<div id="root"')) fail(`${url} has no <div id="root"> (not the app shell)`);
  const scripts = assetScripts(r.body);
  if (scripts.length === 0) fail(`${url} references no /assets/*.js module`);
  return scripts;
}

/**
 * `/assets/<name>.js` paths referenced by an HTML page or a JS chunk: `/assets/x.js` / `assets/x.js` (HTML, preload
 * lists) and `./x.js` (imports between chunks, which all live in /assets/).
 */
export function assetScripts(text: string): string[] {
  const absolute = [...text.matchAll(/(?:^|["'`(/])assets\/([A-Za-z0-9_.-]+\.js)\b/g)].map((m) => m[1]!);
  const relative = [...text.matchAll(/["'`]\.\/([A-Za-z0-9_.-]+\.js)["'`]/g)].map((m) => m[1]!);
  return [...new Set([...absolute, ...relative].map((name) => `/assets/${name}`))];
}

/**
 * The deployed JS (entry + every referenced chunk) is the new frontend: it requests the stock_status embed, never the
 * legacy stock_quantity embed, and talks to the expected Supabase project.
 */
export function assertBundleContract(chunks: ReadonlyArray<{ path: string; body: string }>, supabaseUrl: string): void {
  if (chunks.length === 0) fail('no JS chunk downloaded');
  const all = chunks.map((c) => c.body).join('\n');
  if (!all.includes(STOREFRONT_VARIANT_EMBED)) fail(`deployed bundle does not request "${STOREFRONT_VARIANT_EMBED}" (old or wrong build)`);
  if (all.includes(LEGACY_VARIANT_EMBED)) fail('deployed bundle still requests the legacy stock_quantity embed');
  const host = new URL(supabaseUrl).host;
  if (!all.includes(host)) fail(`deployed bundle does not reference the Supabase project ${host}`);
}
