import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { admin, cleanup, createOwner, createTestShop } from './helpers';

afterAll(cleanup);

describe('variants', () => {
  it('enforces one row per flavor/color combination and non-negative stock', async () => {
    const shop = await createTestShop({ variants: [{ flavor: 'Mint', stock: 1 }] });
    const { client: owner } = await createOwner(shop.id);
    const dup = await owner.from('product_variants').insert({ shop_id: shop.id, product_id: shop.productId, flavor: 'Mint' });
    expect(dup.error?.message).toMatch(/duplicate|unique/i);
    const ok = await owner.from('product_variants').insert({ shop_id: shop.id, product_id: shop.productId, flavor: 'Mint', color: 'Black' }).select('id').single();
    expect(ok.error).toBeNull();
    const neg = await owner.rpc('admin_set_variant_stock', { p_variant_id: ok.data!.id, p_quantity: -1 });
    expect(neg.error?.message).toBe('invalid_quantity');
    const direct = await admin.from('product_variants').update({ stock_quantity: -5 }).eq('id', ok.data!.id);
    expect(direct.error?.message).toMatch(/check constraint/i);
  });
});

function seed(slug: string): string {
  return execFileSync('pnpm', ['-s', 'tenant:seed', '--slug', slug], { encoding: 'utf8', shell: process.platform === 'win32', env: process.env });
}

describe('tenant:seed is idempotent and preserves owner edits', () => {
  it('re-seeding a demo tenant creates no duplicates and keeps owner changes', async () => {
    seed('mint-lab'); // ensure it exists (no-op when already seeded)
    const { data: shop } = await admin.from('shops').select('id, name').eq('slug', 'mint-lab').single();
    const count = async (t: 'categories' | 'products' | 'product_variants' | 'product_images') =>
      (await admin.from(t).select('id', { count: 'exact', head: true }).eq('shop_id', shop!.id)).count;
    const before = { c: await count('categories'), p: await count('products'), v: await count('product_variants'), i: await count('product_images') };

    const { data: product } = await admin.from('products').select('id, name, base_price_minor').eq('shop_id', shop!.id).eq('seed_key', 'prod:clear-mint').single();
    const originalShopName = shop!.name;
    await admin.from('products').update({ name: 'Owner renamed', base_price_minor: 12345 }).eq('id', product!.id);
    await admin.from('shops').update({ name: 'Owner shop name' }).eq('id', shop!.id);
    try {
      const out = seed('mint-lab');
      expect(out).toMatch(/\+0 категорий, \+0 товаров, \+0 вариантов/);
      expect({ c: await count('categories'), p: await count('products'), v: await count('product_variants'), i: await count('product_images') }).toEqual(before);
      const { data: after } = await admin.from('products').select('name, base_price_minor').eq('id', product!.id).single();
      expect(after).toEqual({ name: 'Owner renamed', base_price_minor: 12345 });
      expect((await admin.from('shops').select('name').eq('id', shop!.id).single()).data!.name).toBe('Owner shop name');
    } finally {
      await admin.from('products').update({ name: product!.name, base_price_minor: product!.base_price_minor }).eq('id', product!.id);
      await admin.from('shops').update({ name: originalShopName }).eq('id', shop!.id);
    }
  });
});
