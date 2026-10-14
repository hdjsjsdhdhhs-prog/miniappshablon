import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, anon, cleanup, createOwner, createTestShop, env, type Db, type TestShop } from './helpers';

// 1×1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let A: TestShop;
let B: TestShop;
let ownerA: Db;
const bFile = () => `${B.id}/product/x/b-owned.png`;

beforeAll(async () => {
  A = await createTestShop();
  B = await createTestShop();
  ownerA = (await createOwner(A.id)).client;
  const { error } = await admin.storage.from('shop-media').upload(bFile(), PNG, { contentType: 'image/png' });
  if (error) throw error;
});
afterAll(cleanup);

describe('storage policies', () => {
  it('owner uploads into own shop folder and the file is publicly readable', async () => {
    const path = `${A.id}/product/${A.productId}/ok.png`;
    const up = await ownerA.storage.from('shop-media').upload(path, PNG, { contentType: 'image/png' });
    expect(up.error).toBeNull();
    const res = await fetch(`${env.url}/storage/v1/object/public/shop-media/${path}`);
    expect(res.status).toBe(200);
  });

  it("owner A cannot upload into, overwrite or delete tenant B's files", async () => {
    const up = await ownerA.storage.from('shop-media').upload(`${B.id}/product/x/evil.png`, PNG, { contentType: 'image/png' });
    expect(up.error).not.toBeNull();
    const over = await ownerA.storage.from('shop-media').upload(bFile(), PNG, { contentType: 'image/png', upsert: true });
    expect(over.error).not.toBeNull();
    await ownerA.storage.from('shop-media').remove([bFile()]);
    const still = await admin.storage.from('shop-media').list(`${B.id}/product/x`);
    expect(still.data?.map((f) => f.name)).toContain('b-owned.png');
  });

  it('owner A cannot list tenant B folder; anon cannot upload or list', async () => {
    const list = await ownerA.storage.from('shop-media').list(`${B.id}/product/x`);
    expect(list.data ?? []).toEqual([]);
    const db = anon();
    expect((await db.storage.from('shop-media').upload(`${A.id}/product/x/anon.png`, PNG, { contentType: 'image/png' })).error).not.toBeNull();
    expect((await db.storage.from('shop-media').list(A.id)).data ?? []).toEqual([]);
  });

  it('paths outside a shop folder and non-image types are rejected', async () => {
    expect((await ownerA.storage.from('shop-media').upload('no-shop/evil.png', PNG, { contentType: 'image/png' })).error).not.toBeNull();
    expect((await ownerA.storage.from('shop-media').upload(`${A.id}/x/evil.html`, Buffer.from('<script>'), { contentType: 'text/html' })).error).not.toBeNull();
  });

  it('DB rejects image paths that point to another tenant', async () => {
    const { error } = await ownerA.from('product_images').insert({ shop_id: A.id, product_id: A.productId, storage_path: bFile() });
    expect(error?.message).toMatch(/product_image_scoped|check constraint/i);
  });
});
