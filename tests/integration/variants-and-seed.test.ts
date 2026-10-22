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

  it('resumes images after an interrupted seed: the missing photo is uploaded and attached once', async () => {
    seed('mint-lab');
    const { data: shop } = await admin.from('shops').select('id').eq('slug', 'mint-lab').single();
    const { data: product } = await admin
      .from('products')
      .select('id, created_at, updated_at')
      .eq('shop_id', shop!.id)
      .eq('seed_key', 'prod:lab-one')
      .single();
    // The seed only attaches images to products the owner has never edited.
    expect(product!.created_at).toBe(product!.updated_at);
    const images = async () =>
      (await admin.from('product_images').select('id, seed_key, storage_path, is_primary, sort_order').eq('product_id', product!.id).order('sort_order'))
        .data!;
    const original = await images();
    expect(original.map((i) => i.seed_key)).toEqual(['img:lab-one/0', 'img:lab-one/1']);
    const [first, second] = original as [(typeof original)[0], (typeof original)[0]];
    const { count: sharing } = await admin
      .from('product_images')
      .select('id', { count: 'exact', head: true })
      .eq('storage_path', second.storage_path);
    expect(sharing).toBe(1); // the object below belongs to this image only

    // Simulate the hosted failure: image 0 attached, image 1 neither attached nor uploaded.
    expect((await admin.from('product_images').delete().eq('id', second.id)).error).toBeNull();
    expect((await admin.storage.from('shop-media').remove([second.storage_path])).error).toBeNull();
    const objectExists = async () => {
      const slash = second.storage_path.lastIndexOf('/');
      const { data } = await admin.storage
        .from('shop-media')
        .list(second.storage_path.slice(0, slash), { search: second.storage_path.slice(slash + 1) });
      return (data ?? []).some((o) => o.name === second.storage_path.slice(slash + 1));
    };
    expect(await objectExists()).toBe(false);

    const out = seed('mint-lab');
    expect(out).toMatch(/\+0 товаров, \+0 вариантов, \+1 фото/);
    const resumed = await images();
    expect(resumed.map((i) => [i.seed_key, i.storage_path, i.is_primary, i.sort_order])).toEqual([
      ['img:lab-one/0', first.storage_path, true, 0],
      ['img:lab-one/1', second.storage_path, false, 1],
    ]);
    expect(resumed[0]!.id).toBe(first.id); // the existing image was not re-created
    expect(await objectExists()).toBe(true);

    // A further re-seed is a no-op: no duplicate rows, nothing new attached.
    expect(seed('mint-lab')).toMatch(/\+0 товаров, \+0 вариантов, \+0 фото/);
    expect((await images()).map((i) => i.id)).toEqual(resumed.map((i) => i.id));
  });
});
