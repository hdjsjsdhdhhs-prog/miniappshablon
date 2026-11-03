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
/** PRODUCT_COLUMNS of the frontend before this release (main 741d478, src/features/storefront/api.ts), verbatim. */
export const LEGACY_PRODUCT_COLUMNS =
  'id, name, base_price_minor, category_id, description, ' +
  'categories!inner(name, slug, is_active, archived_at), ' +
  `${LEGACY_VARIANT_EMBED}, ` +
  'product_images(id, storage_path, is_primary, sort_order, alt_text)';

/**
 * Read-only PostgREST paths (relative to /rest/v1/) of the frontend before this release, sent as anon by smoke-api.
 * Expand releases must keep every one of them working (RELEASE.md); a failure stops the release before the frontend.
 */
export const LEGACY_FRONTEND_QUERIES: ReadonlyArray<{ what: string; path: string }> = [
  { what: 'previous storefront product page (stock_quantity embed)', path: `products?select=${encodeURIComponent(LEGACY_PRODUCT_COLUMNS)}&limit=5` },
  {
    what: 'previous storefront listing (filter in_stock.stock_quantity > 0)',
    path: `products?select=${encodeURIComponent(`${LEGACY_PRODUCT_COLUMNS}, in_stock:product_variants!inner(id)`)}&in_stock.stock_quantity=gt.0&in_stock.is_active=eq.true&limit=5`,
  },
  // The previous admin reads variants with select('*') as an authenticated member. Smoke has no member session (no
  // credentials, read-only); anon and authenticated share the same table privileges on product_variants, so `*` as
  // anon is refused exactly when the admin's `*` would be (a Contract-style column grant).
  { what: "previous admin select('*') on product_variants (same privilege as anon)", path: 'product_variants?select=*&limit=5' },
];

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

/** Cloudflare Pages project name: lowercase letters, digits and inner dashes, at most 58 characters. */
const PAGES_PROJECT = /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/;
/** A lowercase DNS label. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

export const WEB_USAGE = 'Usage: release-smoke.ts web --deployment-url <url> --production-url <url> --pages-project <name> [--slug <shop>]';

export function assertPagesProject(name: string | undefined): string {
  if (name === undefined || name === '') fail('the Cloudflare Pages project name is empty');
  if (!PAGES_PROJECT.test(name)) fail('the Cloudflare Pages project name is malformed');
  return name;
}

/**
 * An app address as a bare HTTPS origin: `https://<host>` (optional trailing `/`), lowercase DNS host, no userinfo,
 * port, path, query or fragment, no whitespace. Returns the origin. The configured value is never echoed.
 */
function appOrigin(raw: string | undefined, what: string): URL {
  const wrong = (reason: string): never => fail(`${what} ${reason}`);
  if (raw === undefined || raw === '') return wrong('is empty (a required smoke target must never be skipped)');
  if (/\s/.test(raw)) return wrong('contains whitespace');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return wrong('is malformed');
  }
  if (url.protocol !== 'https:') return wrong('does not use https');
  if (url.username !== '' || url.password !== '') return wrong('must not contain credentials');
  if (!HOSTNAME.test(url.hostname)) return wrong('has an invalid host');
  if (raw !== `https://${url.hostname}` && raw !== `https://${url.hostname}/`) return wrong('must be a bare https origin (no port, path, query or fragment)');
  return url;
}

/**
 * The unique URL of this deployment (wrangler-action output `deployment-url`): `https://<id>.<project>.pages.dev`,
 * exactly one label in front of the Pages project's own domain. Anything else — empty, another project, the
 * production domain itself, a custom domain — fails.
 */
export function assertDeploymentUrl(raw: string | undefined, project: string): string {
  assertPagesProject(project);
  const url = appOrigin(raw, 'deployment URL');
  const suffix = `.${project}.pages.dev`;
  const id = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : '';
  if (!new RegExp(`^${LABEL}$`).test(id)) fail(`deployment URL is not a deployment of the Cloudflare Pages project ${project} (https://<id>${suffix})`);
  return url.origin;
}

/**
 * The production address: vars.PRODUCTION_APP_URL (a custom domain) or, when that is not set, the documented default
 * `https://<project>.pages.dev`. A *.pages.dev address must be exactly the project's own domain.
 */
export function assertProductionUrl(raw: string | undefined, project: string): string {
  assertPagesProject(project);
  const url = appOrigin(raw, 'production URL');
  if ((url.hostname === 'pages.dev' || url.hostname.endsWith('.pages.dev')) && url.hostname !== `${project}.pages.dev`) {
    fail(`production URL on pages.dev must be https://${project}.pages.dev`);
  }
  return url.origin;
}

export interface WebArgs {
  deploymentUrl: string;
  productionUrl: string;
  pagesProject: string;
  slug: string;
}

/**
 * `web` arguments, all named. --deployment-url, --production-url and --pages-project are required and each given
 * exactly once with a value (an empty value is passed on and rejected by the URL checks); --slug is optional. Unknown
 * flags or positional arguments are refused, so a target can never be silently dropped.
 */
export function parseWebArgs(argv: readonly string[]): WebArgs {
  const known = ['--deployment-url', '--production-url', '--pages-project', '--slug'];
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (!known.includes(flag)) fail(`unexpected argument at position ${i + 1}. ${WEB_USAGE}`);
    if (values.has(flag)) fail(`${flag} is given more than once. ${WEB_USAGE}`);
    if (i + 1 >= argv.length) fail(`${flag} has no value. ${WEB_USAGE}`);
    values.set(flag, argv[i + 1]!);
  }
  for (const flag of known.slice(0, 3)) if (!values.has(flag)) fail(`missing ${flag}. ${WEB_USAGE}`);
  const pagesProject = assertPagesProject(values.get('--pages-project'));
  const slug = values.get('--slug') ?? DEFAULT_SMOKE_SLUG;
  if (!/^[a-z0-9-]+$/.test(slug)) fail(`--slug is malformed. ${WEB_USAGE}`);
  return {
    deploymentUrl: assertDeploymentUrl(values.get('--deployment-url'), pagesProject),
    productionUrl: assertProductionUrl(values.get('--production-url'), pagesProject),
    pagesProject,
    slug,
  };
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

/**
 * Backward compatibility of an Expand release, FAIL-CLOSED: a query of the frontend before this release must answer
 * 200 with an array, and every variant it returns must still carry a numeric stock_quantity. Anything else (permission
 * denied after a Contract-style grant, missing column, gateway error, unexpected shape) throws, so the release stops
 * before the frontend job and the operator restores / fixes the database (RELEASE.md). Returns the row count.
 */
export function assertLegacyFrontendQuery(r: HttpResult, what: string): number {
  const incompatible = (reason: string): never =>
    fail(`previous frontend (main 741d478) is NOT compatible with this schema — ${what}: ${reason}. The release is stopped before the frontend; see RELEASE.md`);
  if (r.status !== 200) incompatible(`HTTP ${r.status} ${r.body.slice(0, 200)}`);
  let rows: unknown;
  try {
    rows = JSON.parse(r.body);
  } catch {
    return incompatible('body is not JSON');
  }
  if (!Array.isArray(rows)) return incompatible('response is not an array');
  const hasStock = (v: unknown) => !!v && typeof v === 'object' && typeof (v as { stock_quantity?: unknown }).stock_quantity === 'number';
  for (const row of rows as Array<Record<string, unknown>>) {
    const variants = 'product_variants' in row ? row.product_variants : [row];
    if (!Array.isArray(variants) || !variants.every(hasStock)) incompatible('a returned variant has no numeric stock_quantity');
  }
  return rows.length;
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
 * `https://<host>` as a whole origin in `text`: not followed by a character that would extend the host or add a port
 * or userinfo, so `https://<host>.evil.example`, `https://<host>-x…` and `https://<host>:8443` do not count.
 */
export function referencesOrigin(text: string, host: string): boolean {
  const escaped = `https://${host}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9.:@_-])`).test(text);
}

/**
 * The deployed JS (entry + every referenced chunk) is the new frontend: it requests the stock_status embed, never the
 * legacy stock_quantity embed, and talks to the expected Supabase project (`supabaseUrl` is validated by the caller).
 */
export function assertBundleContract(chunks: ReadonlyArray<{ path: string; body: string }>, supabaseUrl: string): void {
  if (chunks.length === 0) fail('no JS chunk downloaded');
  const all = chunks.map((c) => c.body).join('\n');
  if (!all.includes(STOREFRONT_VARIANT_EMBED)) fail(`deployed bundle does not request "${STOREFRONT_VARIANT_EMBED}" (old or wrong build)`);
  if (all.includes(LEGACY_VARIANT_EMBED)) fail('deployed bundle still requests the legacy stock_quantity embed');
  const host = new URL(supabaseUrl).host;
  if (!referencesOrigin(all, host)) fail(`deployed bundle does not reference the Supabase project ${host}`);
}
