import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from './edge-functions';
import {
  assertAppShell,
  assertBundleContract,
  assertCheckoutRequiresTelegram,
  assertFunctionDeployed,
  assertLegacyFrontendQuery,
  assertRpcProtected,
  assertStockStatusReadable,
  assertStorefrontQuery,
  assertSupabaseReachable,
  assetScripts,
  LEGACY_FRONTEND_QUERIES,
  LEGACY_PRODUCT_COLUMNS,
  LEGACY_VARIANT_EMBED,
  PUBLIC_PAGES,
  referencesOrigin,
  STOREFRONT_PRODUCT_COLUMNS,
  STOREFRONT_VARIANT_EMBED,
  type HttpResult,
} from './release-smoke';

/** Arguments of `release-smoke.ts web` for one app URL. */
const WEB_ARGS = (app: string) => ['web', app];

const res = (status: number, body: unknown, contentType = 'application/json'): HttpResult => ({
  status,
  contentType,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const denied = res(401, { code: '42501', message: 'permission denied for table product_variants' });

describe('contract constants follow the code', () => {
  const api = readFileSync(join(REPO_ROOT, 'src', 'features', 'storefront', 'api.ts'), 'utf8').replace(/\r\n/g, '\n');
  it('the smoke check sends exactly the storefront PRODUCT_COLUMNS', () => {
    const m = /const PRODUCT_COLUMNS =\n((?: +'[^']*'(?: \+|;)\n)+)/.exec(api);
    expect(m).not.toBeNull();
    const fromSource = [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
    expect(STOREFRONT_PRODUCT_COLUMNS).toBe(fromSource);
    expect(api).toContain(`'${STOREFRONT_VARIANT_EMBED}, '`);
  });
  it('the legacy embed is what the frontend before stock_status requested', () => {
    expect(LEGACY_VARIANT_EMBED).toBe(STOREFRONT_VARIANT_EMBED.replace('stock_status', 'stock_quantity'));
    expect(api).not.toContain(LEGACY_VARIANT_EMBED);
  });
  it('the legacy queries are exactly those of main 741d478 (PRODUCT_COLUMNS, listing filter, admin select *)', () => {
    // Verbatim from main 741d478, src/features/storefront/api.ts (PRODUCT_COLUMNS) and fetchProductsPage.
    expect(LEGACY_PRODUCT_COLUMNS).toBe(
      'id, name, base_price_minor, category_id, description, categories!inner(name, slug, is_active, archived_at), ' +
        'product_variants(id, flavor, color, stock_quantity, is_active, sort_order), ' +
        'product_images(id, storage_path, is_primary, sort_order, alt_text)',
    );
    const paths = LEGACY_FRONTEND_QUERIES.map((q) => decodeURIComponent(q.path));
    expect(paths).toEqual([
      `products?select=${LEGACY_PRODUCT_COLUMNS}&limit=5`,
      `products?select=${LEGACY_PRODUCT_COLUMNS}, in_stock:product_variants!inner(id)&in_stock.stock_quantity=gt.0&in_stock.is_active=eq.true&limit=5`,
      'product_variants?select=*&limit=5',
    ]);
  });
});

describe('smoke-api evaluators', () => {
  it('Supabase reachable only on 200', () => {
    expect(() => assertSupabaseReachable(res(200, { status: 'ok' }))).not.toThrow();
    expect(() => assertSupabaseReachable(res(503, ''))).toThrow(/503/);
  });

  it('stock_status: readable, values within the projection, no stock_quantity', () => {
    expect(assertStockStatusReadable(res(200, [{ id: '1', stock_status: 'in_stock' }, { id: '2', stock_status: 'low_stock' }, { id: '3', stock_status: 'out_of_stock' }]))).toBe(3);
    expect(assertStockStatusReadable(res(200, []))).toBe(0);
    expect(() => assertStockStatusReadable(res(400, { code: '42703', message: 'column product_variants.stock_status does not exist' }))).toThrow(/not readable/);
    expect(() => assertStockStatusReadable(res(200, [{ id: '1', stock_status: 'some' }]))).toThrow(/unexpected value/);
    expect(() => assertStockStatusReadable(res(200, [{ id: '1', stock_status: 'in_stock', stock_quantity: 4 }]))).toThrow(/leaked/);
    expect(() => assertStockStatusReadable(res(200, { id: 1 }))).toThrow(/not an array/);
    expect(() => assertStockStatusReadable(res(200, '<html>', 'text/html'))).toThrow(/not JSON/);
  });

  it('storefront queries: 200 arrays only', () => {
    expect(assertStorefrontQuery(res(200, [{ id: 'p' }]), 'q')).toBe(1);
    expect(() => assertStorefrontQuery(denied, 'q')).toThrow(/HTTP 401/);
  });

  it('RPC: must exist and be refused to anon', () => {
    expect(() => assertRpcProtected(res(401, { code: '42501', message: 'permission denied for function admin_variant_stock' }), 'admin_variant_stock')).not.toThrow();
    expect(() => assertRpcProtected(res(404, { code: 'PGRST202', message: 'Could not find the function' }), 'admin_variant_stock')).toThrow(/does not exist/);
    expect(() => assertRpcProtected(res(200, []), 'admin_variant_stock')).toThrow(/answered anon with data/);
    expect(() => assertRpcProtected(res(400, { code: 'P0001', message: 'shop_not_found' }), 'admin_variant_stock')).toThrow(/expected permission denied/);
  });

  it('Edge Function deployed: our handler answers GET with 405 method_not_allowed', () => {
    expect(() => assertFunctionDeployed(res(405, { error: { code: 'method_not_allowed', details: null } }), 'checkout')).not.toThrow();
    expect(() => assertFunctionDeployed(res(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }), 'checkout')).toThrow(/not deployed/);
    expect(() => assertFunctionDeployed(res(500, { error: { code: 'internal_error' } }), 'checkout')).toThrow(/expected 405/);
    expect(() => assertFunctionDeployed(res(401, { msg: 'Invalid JWT' }), 'checkout')).toThrow(/expected 405/);
  });

  it('checkout refuses a request without initData with 401 telegram_auth_failed', () => {
    expect(() => assertCheckoutRequiresTelegram(res(401, { error: { code: 'telegram_auth_failed', details: { reason: 'missing' } } }))).not.toThrow();
    expect(() => assertCheckoutRequiresTelegram(res(500, { error: { code: 'server_misconfigured' } }))).toThrow(/expected 401/);
    expect(() => assertCheckoutRequiresTelegram(res(201, { order: {} }))).toThrow(/expected 401/);
  });

  it('previous frontend queries fail closed: anything but 200 with numeric stock_quantity stops the release', () => {
    const product = (variants: unknown[]) => ({ id: 'p', product_variants: variants, in_stock: [{ id: 'v' }] });
    expect(assertLegacyFrontendQuery(res(200, []), 'q')).toBe(0);
    expect(assertLegacyFrontendQuery(res(200, [product([{ id: 'v', stock_quantity: 3 }, { id: 'w', stock_quantity: 0 }])]), 'q')).toBe(1);
    expect(assertLegacyFrontendQuery(res(200, [{ id: 'v', stock_quantity: 5, stock_status: 'in_stock' }]), 'q')).toBe(1);
    // Contract-style privileges: permission denied → NOT compatible (no longer a warning).
    expect(() => assertLegacyFrontendQuery(denied, 'q')).toThrow(/NOT compatible[\s\S]*HTTP 401/);
    expect(() => assertLegacyFrontendQuery(res(403, 'permission denied for table product_variants', 'text/plain'), 'q')).toThrow(/NOT compatible/);
    expect(() => assertLegacyFrontendQuery(res(400, { code: '42703', message: 'column product_variants.stock_quantity does not exist' }), 'q')).toThrow(/NOT compatible/);
    expect(() => assertLegacyFrontendQuery(res(502, 'bad gateway', 'text/plain'), 'q')).toThrow(/502/);
    expect(() => assertLegacyFrontendQuery(res(200, '<html>', 'text/html'), 'q')).toThrow(/not JSON/);
    expect(() => assertLegacyFrontendQuery(res(200, { id: 1 }), 'q')).toThrow(/not an array/);
    // A 200 that silently lost the column (e.g. a view without it) is incompatible too.
    expect(() => assertLegacyFrontendQuery(res(200, [product([{ id: 'v', stock_status: 'in_stock' }])]), 'q')).toThrow(/no numeric stock_quantity/);
    expect(() => assertLegacyFrontendQuery(res(200, [product([{ id: 'v', stock_quantity: '3' }])]), 'q')).toThrow(/no numeric stock_quantity/);
    expect(() => assertLegacyFrontendQuery(res(200, [{ id: 'v' }]), 'q')).toThrow(/no numeric stock_quantity/);
  });
});

const html = `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-Ab12.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-Cd34.js"></head><body><div id="root"></div></body></html>`;

describe('smoke-web evaluators', () => {
  it('app shell: 200 HTML with the root and module scripts', () => {
    expect(assertAppShell(res(200, html, 'text/html; charset=utf-8'), 'u')).toEqual(['/assets/index-Ab12.js', '/assets/vendor-Cd34.js']);
    expect(() => assertAppShell(res(404, html, 'text/html'), 'u')).toThrow(/404/);
    expect(() => assertAppShell(res(200, '{}', 'application/json'), 'u')).toThrow(/not HTML/);
    expect(() => assertAppShell(res(200, '<html><body>Build failed</body></html>', 'text/html'), 'u')).toThrow(/root/);
    expect(() => assertAppShell(res(200, '<div id="root"></div>', 'text/html'), 'u')).toThrow(/no \/assets/);
  });

  it('finds chunks referenced absolutely and relatively', () => {
    expect(assetScripts('import("./ProductPage-x1.js");const m=["assets/Cart-y2.js"];import"./vendor-z.js"').sort()).toEqual(
      ['/assets/Cart-y2.js', '/assets/ProductPage-x1.js', '/assets/vendor-z.js'],
    );
    expect(assetScripts('no chunks here')).toEqual([]);
  });

  it('public pages: storefront and admin routes', () => {
    expect(PUBLIC_PAGES('noir-vapor')).toEqual(['/', '/s/noir-vapor/', '/s/noir-vapor/catalog', '/admin']);
  });

  it('bundle contract: new stock_status embed, no legacy embed, expected Supabase project', () => {
    const url = 'https://xcbugcjmddtubytpvffa.supabase.co';
    const good = [{ path: '/assets/a.js', body: `const u="${url}";` }, { path: '/assets/b.js', body: `"${STOREFRONT_VARIANT_EMBED}, "` }];
    expect(() => assertBundleContract(good, url)).not.toThrow();
    expect(() => assertBundleContract([], url)).toThrow(/no JS chunk/);
    expect(() => assertBundleContract([good[0]!], url)).toThrow(/does not request/);
    expect(() => assertBundleContract([...good, { path: '/assets/c.js', body: LEGACY_VARIANT_EMBED }], url)).toThrow(/legacy/);
    expect(() => assertBundleContract(good, 'https://other.supabase.co')).toThrow(/other\.supabase\.co/);
  });

  it('bundle contract: the Supabase origin must appear as a whole origin, not as a prefix of another host', () => {
    const url = 'https://xcbugcjmddtubytpvffa.supabase.co';
    const embed = { path: '/assets/b.js', body: `"${STOREFRONT_VARIANT_EMBED}, "` };
    for (const body of [`"${url}.evil.example"`, `"${url}-evil.example"`, `"${url}:8443"`, `"${url}@evil.example"`, `"${url}_x"`, `"http://xcbugcjmddtubytpvffa.supabase.co"`, '"xcbugcjmddtubytpvffa.supabase.co"']) {
      expect(() => assertBundleContract([{ path: '/assets/a.js', body }, embed], url), body).toThrow(/does not reference the Supabase project/);
    }
    for (const body of [`"${url}"`, `'${url}/rest/v1'`, `\`${url}\``, `x=${url}`, `${url}`]) {
      expect(() => assertBundleContract([{ path: '/assets/a.js', body }, embed], url), body).not.toThrow();
    }
  });

  it('referencesOrigin: whole-origin match only', () => {
    const host = 'xcbugcjmddtubytpvffa.supabase.co';
    expect(referencesOrigin(`"https://${host}"`, host)).toBe(true);
    expect(referencesOrigin(`"https://${host}/functions/v1/x"`, host)).toBe(true);
    expect(referencesOrigin(`"https://${host}.evil.example"`, host)).toBe(false);
    expect(referencesOrigin(`"https://${host.replace('.', 'X')}"`, host)).toBe(false); // the dot is not a wildcard
  });
});

/**
 * release-smoke.ts against a local server that records every request: a SUPABASE_URL that is not exactly the
 * approved project stops the CLI before ANY request is sent (the server must see none).
 */
describe('release-smoke.ts validates SUPABASE_URL before any request', () => {
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  let local = '';
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const smoke = (args: string[], extra: Record<string, string>) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SUPABASE_')));
      const child = spawn(process.execPath, [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'scripts/release-smoke.ts', ...args], {
        cwd: process.cwd(),
        env: { ...base, SUPABASE_ANON_KEY: 'test-anon-key', ...extra },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

  const badUrls = () => [undefined, '', local, 'https://abcdefghijklmnopqrst.supabase.co', 'https://xcbugcjmddtubytpvffa.supabase.co.evil.example', 'not a url'];

  it('api: wrong, missing or malformed SUPABASE_URL → exit 1, no request', async () => {
    for (const url of badUrls()) {
      requests.length = 0;
      const r = await smoke(['api'], url === undefined ? {} : { SUPABASE_URL: url });
      expect(r.code, String(url)).toBe(1);
      expect(r.stderr, String(url)).toMatch(/Supabase URL/);
      expect(requests, String(url)).toEqual([]);
    }
  }, 120_000);

  it('web: wrong, missing or malformed SUPABASE_URL → exit 1, no request to the app either', async () => {
    for (const url of badUrls()) {
      requests.length = 0;
      const r = await smoke(WEB_ARGS(local), url === undefined ? {} : { SUPABASE_URL: url });
      expect(r.code, String(url)).toBe(1);
      expect(r.stderr, String(url)).toMatch(/Supabase URL/);
      expect(requests, String(url)).toEqual([]);
    }
  }, 120_000);
});
