import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './edge-functions';
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
  LEGACY_VARIANT_EMBED,
  legacyCompatibility,
  PUBLIC_PAGES,
  STOREFRONT_PRODUCT_COLUMNS,
  STOREFRONT_VARIANT_EMBED,
  type HttpResult,
} from './release-smoke';

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

  it('legacy compatibility is reported, never thrown, for 200 / permission denied', () => {
    expect(legacyCompatibility(res(200, []))).toBe('compatible');
    expect(legacyCompatibility(denied)).toBe('incompatible');
    expect(legacyCompatibility(res(403, 'permission denied for table product_variants', 'text/plain'))).toBe('incompatible');
    expect(() => legacyCompatibility(res(502, 'bad gateway', 'text/plain'))).toThrow(/502/);
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
});
