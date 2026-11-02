// Stage-2 security PoC: bucket shop-media (policies, MIME/size validation, crafted paths, lifecycle). LOCAL ONLY.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, anon, createMember, createOwner, createTestShop, env, type Db, type TestShop } from '../helpers';
import { cleanupSecurity, PNG } from './sec-helpers';

const bucket = () => admin.storage.from('shop-media');
const publicUrl = (path: string) => `${env.url}/storage/v1/object/public/shop-media/${path}`;

let A: TestShop;
let B: TestShop;
let P: TestShop; // preview shop
let ownerA: Db;
let managerA: Db;
const bFile = () => `${B.id}/product/${B.productId}/b-owned.png`;

async function exists(path: string): Promise<boolean> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const { data } = await bucket().list(dir, { limit: 100 });
  return (data ?? []).some((f) => f.name === path.slice(path.lastIndexOf('/') + 1));
}

async function bBytes(): Promise<Buffer> {
  const { data, error } = await bucket().download(bFile());
  if (error) throw error;
  return Buffer.from(await data.arrayBuffer());
}

beforeAll(async () => {
  A = await createTestShop();
  B = await createTestShop();
  P = await createTestShop({ mode: 'preview' });
  ownerA = (await createOwner(A.id)).client;
  managerA = (await createMember(A.id, 'manager')).client;
  const up = await bucket().upload(bFile(), PNG, { contentType: 'image/png' });
  if (up.error) throw up.error;
});
afterAll(cleanupSecurity);

describe('content validation is declared-type only', () => {
  it('[VULN] HTML/script bytes declared as image/png are accepted and served publicly', async () => {
    const path = `${A.id}/product/${A.productId}/${randomUUID()}.png`;
    const html = Buffer.from('<html><script>alert(document.domain)</script></html>');
    const up = await ownerA.storage.from('shop-media').upload(path, html, { contentType: 'image/png' });
    expect(up.error).toBeNull();
    const res = await fetch(publicUrl(path));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toContain('<script>');
  });

  it('[VULN] extension is not checked: "*.html" object with declared image/png is stored', async () => {
    const path = `${A.id}/product/${A.productId}/${randomUUID()}.html`;
    const up = await ownerA.storage.from('shop-media').upload(path, Buffer.from('<b>x</b>'), { contentType: 'image/png' });
    expect(up.error).toBeNull();
    const res = await fetch(publicUrl(path));
    expect(res.status).toBe(200);
    // Served with the declared type, not text/html: browsers will not render it as a page.
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('declared non-image types (text/html, image/svg+xml, application/octet-stream) are refused', async () => {
    for (const contentType of ['text/html', 'image/svg+xml', 'application/octet-stream']) {
      const up = await ownerA.storage.from('shop-media').upload(`${A.id}/x/${randomUUID()}`, Buffer.from('<svg/>'), { contentType });
      expect(up.error, contentType).not.toBeNull();
    }
  });

  it('server-side size limit (5 MiB) is enforced', async () => {
    const up = await ownerA.storage.from('shop-media').upload(`${A.id}/x/${randomUUID()}.png`, Buffer.alloc(5 * 1024 * 1024 + 1), { contentType: 'image/png' });
    expect(up.error).not.toBeNull();
  });
});

describe("crafted paths against shop B's prefix", () => {
  const variants = () => [
    `${A.id}/../${B.id}/product/${B.productId}/b-owned.png`,
    `${A.id}/%2e%2e/${B.id}/product/${B.productId}/b-owned.png`,
    `${A.id}/..%2f${B.id}/product/${B.productId}/b-owned.png`,
    `${B.id.toUpperCase()}/product/${B.productId}/b-owned.png`,
    `/${B.id}/product/${B.productId}/b-owned.png`,
    `./${B.id}/product/${B.productId}/b-owned.png`,
  ];

  it("upload / upsert / remove through crafted paths never changes B's object", async () => {
    const original = await bBytes();
    const results: Record<string, unknown> = {};
    for (const path of variants()) {
      const up = await ownerA.storage.from('shop-media').upload(path, Buffer.from('EVIL'), { contentType: 'image/png', upsert: true });
      const rm = await ownerA.storage.from('shop-media').remove([path]);
      results[path.replace(A.id, '<A>').replace(B.id, '<B>').replace(B.id.toUpperCase(), '<B-UPPER>')] = {
        upload: up.error ? `refused: ${up.error.message}` : `stored as ${up.data?.path?.replace(A.id, '<A>').replace(B.id, '<B>')}`,
        removed: rm.data?.length ?? 0,
      };
    }
    console.log('[crafted paths]', JSON.stringify(results, null, 1));
    expect(await exists(bFile())).toBe(true);
    expect((await bBytes()).equals(original)).toBe(true);
  });

  it("direct overwrite / delete of B's object is refused (negative control)", async () => {
    const over = await ownerA.storage.from('shop-media').upload(bFile(), Buffer.from('EVIL'), { contentType: 'image/png', upsert: true });
    expect(over.error).not.toBeNull();
    await ownerA.storage.from('shop-media').remove([bFile()]);
    expect(await exists(bFile())).toBe(true);
  });
});

describe('media lifecycle', () => {
  it('[INFO] a member can delete an object that is still referenced (no server-side reference check)', async () => {
    const path = `${A.id}/product/${A.productId}/${randomUUID()}.png`;
    expect((await ownerA.storage.from('shop-media').upload(path, PNG, { contentType: 'image/png' })).error).toBeNull();
    expect((await ownerA.from('product_images').insert({ shop_id: A.id, product_id: A.productId, storage_path: path })).error).toBeNull();
    const rm = await managerA.storage.from('shop-media').remove([path]);
    expect(rm.data).toHaveLength(1);
    expect((await fetch(publicUrl(path))).status).not.toBe(200);
    expect((await admin.from('product_images').select('id').eq('storage_path', path)).data).toHaveLength(1);
  });

  it('[INFO] files of a deleted product / category stay public until the client removes them', async () => {
    const { data: prod } = await admin.from('products').insert({ shop_id: A.id, category_id: A.categoryId, name: 'tmp', base_price_minor: 1 }).select('id').single();
    await admin.from('product_variants').insert({ shop_id: A.id, product_id: prod!.id, flavor: 'x' });
    const path = `${A.id}/product/${prod!.id}/${randomUUID()}.png`;
    await ownerA.storage.from('shop-media').upload(path, PNG, { contentType: 'image/png' });
    await ownerA.from('product_images').insert({ shop_id: A.id, product_id: prod!.id, storage_path: path });
    const del = await ownerA.rpc('admin_delete_product', { p_product_id: prod!.id });
    expect(del.error).toBeNull();
    expect((del.data as { unused_media: string[] }).unused_media).toEqual([path]);
    expect((await fetch(publicUrl(path))).status).toBe(200);
  });

  it('[INFO] files of a deleted shop are not removed by the database (orphaned, still public)', async () => {
    const S = await createTestShop();
    const path = `${S.id}/logo/${S.id}/${randomUUID()}.png`;
    await bucket().upload(path, PNG, { contentType: 'image/png' });
    await admin.from('shops').delete().eq('id', S.id);
    expect((await admin.from('shops').select('id').eq('id', S.id)).data).toEqual([]);
    expect((await fetch(publicUrl(path))).status).toBe(200);
    await bucket().remove([path]);
  });

  it('[INFO] media of a PREVIEW shop is readable by anyone with the URL, but not listable', async () => {
    const path = `${P.id}/product/${P.productId}/${randomUUID()}.png`;
    await bucket().upload(path, PNG, { contentType: 'image/png' });
    expect((await fetch(publicUrl(path))).status).toBe(200);
    expect((await anon().storage.from('shop-media').list(`${P.id}/product/${P.productId}`)).data ?? []).toEqual([]);
    expect((await anon().from('shops').select('id').eq('id', P.id)).data).toEqual([]);
  });
});
