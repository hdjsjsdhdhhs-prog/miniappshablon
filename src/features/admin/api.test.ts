import { beforeEach, describe, expect, it, vi } from 'vitest';

// Records every query-builder call so the test can assert exactly what is written to which table.
type Call = { table: string; chain: Array<[string, unknown[]]> };
const calls: Call[] = [];
let results: Record<string, unknown> = {};

function builder(table: string) {
  const call: Call = { table, chain: [] };
  calls.push(call);
  const proxy: Record<string, unknown> = {};
  for (const m of ['insert', 'update', 'eq', 'not', 'select', 'single']) {
    proxy[m] = (...args: unknown[]) => {
      call.chain.push([m, args]);
      return proxy;
    };
  }
  proxy.then = (resolve: (v: unknown) => void) => resolve({ data: results[table], error: null });
  return proxy;
}

vi.mock('@/lib/supabase', () => ({ supabase: { from: (t: string) => builder(t) } }));

const { createProduct, createVariant, saveProductWithPrice, syncVariantPricesToProduct, updateVariant } = await import('./api');

const input = { name: 'Noir Salt 30 мл', description: '', category_id: 'c', base_price_minor: 69000, is_published: true, sort_order: 0 };

describe('one price per product (admin API)', () => {
  beforeEach(() => {
    calls.length = 0;
    results = { products: { id: 'p1', ...input }, product_variants: [{ id: 'v-blueberry' }] };
  });

  it('saving the product price clears the own price of every variant of THAT product', async () => {
    await saveProductWithPrice('p1', input);
    expect(calls.map((c) => c.table)).toEqual(['products', 'product_variants']);
    const [product, variants] = calls as [Call, Call];
    expect(product.chain).toContainEqual(['update', [input]]);
    expect(product.chain).toContainEqual(['eq', ['id', 'p1']]);
    // Every variant then sells at coalesce(NULL, base_price_minor) = the product price.
    expect(variants.chain).toEqual([
      ['update', [{ price_override_minor: null }]],
      ['eq', ['product_id', 'p1']],
      ['not', ['price_override_minor', 'is', null]],
      ['select', ['id']],
    ]);
  });

  it('a new product starts with a default variant that has no own price', async () => {
    results.product_variants = { id: 'v-default' };
    await createProduct('shop', input);
    expect(calls.map((c) => c.table)).toEqual(['products', 'product_variants']);
    expect(calls[1]!.chain[0]).toEqual(['insert', [{ shop_id: 'shop', product_id: 'p1', price_override_minor: null }]]);
  });

  it('a new variant is always inserted without a price, even if a caller tries to pass one', async () => {
    results.product_variants = { id: 'v-new' };
    const sneaky = { flavor: 'Персик', color: null, sku: null, is_active: true, price_override_minor: 99900 } as Parameters<typeof createVariant>[2];
    await createVariant('shop', 'p1', sneaky, 0);
    expect(calls[0]!.chain[0]).toEqual([
      'insert',
      [{ shop_id: 'shop', product_id: 'p1', flavor: 'Персик', color: null, sku: null, is_active: true, price_override_minor: null }],
    ]);
  });

  it('updating a variant never writes a price', async () => {
    results.product_variants = { id: 'v1' };
    const sneaky = { sku: 'NS-1', price_override_minor: 74000 } as Parameters<typeof updateVariant>[1];
    await updateVariant('v1', sneaky);
    expect(calls[0]!.chain[0]).toEqual(['update', [{ sku: 'NS-1' }]]);
  });

  it('reports which variants were synchronized', async () => {
    expect(await syncVariantPricesToProduct('p1')).toEqual(['v-blueberry']);
    results.product_variants = [];
    expect(await syncVariantPricesToProduct('p1')).toEqual([]);
  });
});
