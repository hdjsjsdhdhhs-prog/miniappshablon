// Read-only smoke checks of a production release (rules and safety notes: scripts/lib/release-smoke.ts).
//
// Usage:
//   tsx scripts/release-smoke.ts api
//     env: SUPABASE_URL, SUPABASE_ANON_KEY (public values: vars.VITE_SUPABASE_URL / vars.VITE_SUPABASE_ANON_KEY).
//     Supabase reachable, stock_status readable as anon, the storefront queries of the new frontend, the stock RPC exists
//     and is refused to anon, every Edge Function deployed by supabase-deploy.yml answers, checkout requires Telegram.
//     Reports (never fails on) whether the previous frontend can still read its legacy stock_quantity embed.
//   tsx scripts/release-smoke.ts web <app-url>... [--slug <shop>]
//     env: SUPABASE_URL. Every URL: app shell on the public pages, JS bundle downloadable, new stock_status contract,
//     expected Supabase project.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployedFunctions, REPO_ROOT } from './lib/edge-functions.ts';
import {
  assertAppShell,
  assertBundleContract,
  assertCheckoutRequiresTelegram,
  assertFunctionDeployed,
  assertRpcProtected,
  assertStockStatusReadable,
  assertStorefrontQuery,
  assertSupabaseReachable,
  assetScripts,
  DEFAULT_SMOKE_SLUG,
  LEGACY_VARIANT_EMBED,
  legacyCompatibility,
  PUBLIC_PAGES,
  STOCK_RPC,
  STOREFRONT_PRODUCT_COLUMNS,
  type HttpResult,
} from './lib/release-smoke.ts';

const USAGE = 'Usage: release-smoke.ts api | web <app-url>... [--slug <shop>]';
const MAX_CHUNKS = 120;

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Smoke: environment variable ${name} is not set`);
  return value;
}

async function http(url: string, init: RequestInit = {}): Promise<HttpResult> {
  const res = await fetch(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(30_000) });
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: await res.text() };
}

const ok = (m: string) => console.log(`OK  ${m}`);

async function smokeApi(): Promise<void> {
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_ANON_KEY');
  const headers = { apikey: key };
  const rest = (path: string) => http(`${base}/rest/v1/${path}`, { headers });

  assertSupabaseReachable(await http(`${base}/auth/v1/health`, { headers }));
  ok(`Supabase reachable (${new URL(base).host})`);

  const rows = assertStockStatusReadable(await rest('product_variants?select=id,stock_status&limit=50'));
  ok(`product_variants.stock_status readable as anon (${rows} row(s) sampled, values within in_stock|low_stock|out_of_stock)`);

  const select = encodeURIComponent(STOREFRONT_PRODUCT_COLUMNS);
  assertStorefrontQuery(await rest(`products?select=${select}&limit=5`), 'storefront product query');
  const listing = encodeURIComponent(`${STOREFRONT_PRODUCT_COLUMNS}, in_stock:product_variants!inner(id)`);
  assertStorefrontQuery(
    await rest(`products?select=${listing}&in_stock.stock_status=neq.out_of_stock&in_stock.is_active=eq.true&limit=5`),
    'storefront listing filter on stock_status',
  );
  ok('storefront queries of the new frontend (stock_status embed and filter) answer as anon');

  // A random UUID: the RPC must refuse anon before looking at it (no data is read or written).
  const rpc = await http(`${base}/rest/v1/rpc/${STOCK_RPC}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_shop_id: crypto.randomUUID() }),
  });
  assertRpcProtected(rpc, STOCK_RPC);
  ok(`RPC ${STOCK_RPC} exists and is refused to anon (permission denied)`);

  const functions = deployedFunctions(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'supabase-deploy.yml'), 'utf8'));
  for (const name of functions) {
    assertFunctionDeployed(await http(`${base}/functions/v1/${name}`, { method: 'GET' }), name);
    ok(`Edge Function ${name} deployed (GET → 405 method_not_allowed from the function itself)`);
  }
  // No X-Telegram-Init-Data: the function refuses in verifyTelegramRequest, before parsing the body or touching the DB.
  assertCheckoutRequiresTelegram(
    await http(`${base}/functions/v1/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
  );
  ok('checkout refuses a request without Telegram initData (401 telegram_auth_failed)');

  const legacy = legacyCompatibility(await rest(`products?select=id,${encodeURIComponent(LEGACY_VARIANT_EMBED)}&limit=1`));
  const legacyLine =
    legacy === 'compatible'
      ? 'previous frontend compatible: its stock_quantity embed is still readable (Expand state)'
      : 'previous frontend NOT compatible: stock_quantity is no longer readable by anon — the storefront of the currently deployed frontend fails until the frontend job of this release succeeds (see RELEASE.md)';
  if (legacy === 'compatible') ok(legacyLine);
  else console.log(`::warning title=Legacy frontend::${legacyLine}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `legacy_frontend=${legacy}\n`);
}

async function smokeWeb(urls: string[], slug: string): Promise<void> {
  const supabaseUrl = env('SUPABASE_URL');
  for (const raw of urls) {
    const base = new URL(raw).origin;
    let scripts: string[] = [];
    for (const page of PUBLIC_PAGES(slug)) {
      scripts = [...new Set([...scripts, ...assertAppShell(await http(`${base}${page}`), `${base}${page}`)])];
      ok(`${base}${page} serves the app shell`);
    }
    // Entry module(s) and every chunk they reference, breadth-first, bounded.
    const queue = [...scripts];
    const seen = new Set<string>();
    const chunks: Array<{ path: string; body: string }> = [];
    while (queue.length > 0 && chunks.length < MAX_CHUNKS) {
      const path = queue.shift()!;
      if (seen.has(path)) continue;
      seen.add(path);
      const r = await http(`${base}${path}`);
      if (r.status !== 200 || !/javascript/i.test(r.contentType)) throw new Error(`Smoke: ${base}${path} answered HTTP ${r.status} (${r.contentType})`);
      chunks.push({ path, body: r.body });
      queue.push(...assetScripts(r.body).filter((p) => !seen.has(p)));
    }
    assertBundleContract(chunks, supabaseUrl);
    ok(`${base}: ${chunks.length} JS chunk(s) load; new stock_status contract, no legacy stock_quantity embed, Supabase ${new URL(supabaseUrl).host}`);
  }
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === 'api' && rest.length === 0) await smokeApi();
  else if (command === 'web') {
    const slugAt = rest.indexOf('--slug');
    const slug = slugAt >= 0 ? rest[slugAt + 1] : DEFAULT_SMOKE_SLUG;
    const urls = rest.filter((_, i) => slugAt < 0 || (i !== slugAt && i !== slugAt + 1)).filter((u) => u.trim() !== '');
    if (!slug || !/^[a-z0-9-]+$/.test(slug) || urls.length === 0) throw new Error(USAGE);
    await smokeWeb(urls, slug);
  } else throw new Error(USAGE);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
