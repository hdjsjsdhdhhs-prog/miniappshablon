import { describe, expect, it, vi } from 'vitest';
import { isInsideShopPrefix, removeShopMedia } from './shop-media-cleanup';

const SHOP = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const FAST = { listLimit: 1000, batch: 2, attempts: 3, rounds: 10, backoffMs: 1 };

/** In-memory bucket: list returns names under the prefix (as the SQL does), remove deletes the given names. */
function bucket(names: string[], failures = 0) {
  const objects = new Set(names);
  let failuresLeft = failures;
  const remove = vi.fn(async (paths: string[]) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return { data: null, error: { message: 'storage unavailable' } };
    }
    const gone = paths.filter((p) => objects.delete(p));
    return { data: gone.map((name) => ({ name })), error: null };
  });
  const list = vi.fn(async (limit: number) => ({ data: [...objects].filter((n) => n.startsWith(`${SHOP}/`)).sort().slice(0, limit), error: null }));
  return { objects, list, remove };
}

describe('isInsideShopPrefix', () => {
  it('accepts only names strictly inside "<shop_id>/"', () => {
    expect(isInsideShopPrefix(`${SHOP}/products/p/a.webp`, SHOP)).toBe(true);
    expect(isInsideShopPrefix(`${SHOP}/`, SHOP)).toBe(false);
    expect(isInsideShopPrefix(`${SHOP}x/a.webp`, SHOP)).toBe(false);
    expect(isInsideShopPrefix(`${OTHER}/a.webp`, SHOP)).toBe(false);
    expect(isInsideShopPrefix(`${SHOP}/../${OTHER}/a.webp`, SHOP)).toBe(false);
    expect(isInsideShopPrefix(`${SHOP}//a.webp`, SHOP)).toBe(false);
    expect(isInsideShopPrefix(`a/${SHOP}/b`, SHOP)).toBe(false);
    expect(isInsideShopPrefix(42, SHOP)).toBe(false);
    expect(isInsideShopPrefix(`${SHOP}/a`, 'not-a-uuid')).toBe(false);
  });
});

describe('removeShopMedia', () => {
  it('removes every object of the shop in batches and never touches other shops', async () => {
    const b = bucket([`${SHOP}/logo/a.webp`, `${SHOP}/products/1/a.webp`, `${SHOP}/products/1/b.webp`, `${OTHER}/logo/a.webp`]);
    const res = await removeShopMedia(b.list, b.remove, SHOP, FAST);
    expect(res).toEqual({ removed: 3, error: null });
    expect([...b.objects]).toEqual([`${OTHER}/logo/a.webp`]);
    for (const [paths] of b.remove.mock.calls) for (const p of paths) expect(p.startsWith(`${SHOP}/`)).toBe(true);
  });

  it('retries a failing batch and then succeeds', async () => {
    const b = bucket([`${SHOP}/a.webp`], 2);
    expect(await removeShopMedia(b.list, b.remove, SHOP, FAST)).toEqual({ removed: 1, error: null });
    expect(b.remove).toHaveBeenCalledTimes(3);
  });

  it('gives up after the retries and reports the error (resumable, nothing thrown)', async () => {
    const b = bucket([`${SHOP}/a.webp`], 99);
    const res = await removeShopMedia(b.list, b.remove, SHOP, FAST);
    expect(res.error).toMatch(/^remove_failed: storage unavailable/);
    expect(b.objects.size).toBe(1);
    // A later resume with Storage back to normal completes it.
    const again = await removeShopMedia(b.list, async (p) => ({ data: p.map((name) => (b.objects.delete(name), { name })), error: null }), SHOP, FAST);
    expect(again).toEqual({ removed: 1, error: null });
  });

  it('stops without removing anything when the listing contains a name outside the prefix', async () => {
    const remove = vi.fn();
    const res = await removeShopMedia(async () => ({ data: [`${SHOP}/a`, `${OTHER}/b`], error: null }), remove, SHOP, FAST);
    expect(res.error).toBe('unexpected_object_name');
    expect(remove).not.toHaveBeenCalled();
  });

  it('reports a listing error and a Storage that silently removes nothing', async () => {
    expect((await removeShopMedia(async () => ({ data: null, error: { message: 'x', code: 'mfa_required' } }), vi.fn(), SHOP, FAST)).error).toBe(
      'list_failed: mfa_required',
    );
    const stuck = await removeShopMedia(async () => ({ data: [`${SHOP}/a`], error: null }), async () => ({ data: [], error: null }), SHOP, FAST);
    expect(stuck.error).toBe('remove_failed: objects were not removed');
  });

  it('is idempotent: nothing left → no remove call, no error', async () => {
    const b = bucket([]);
    expect(await removeShopMedia(b.list, b.remove, SHOP, FAST)).toEqual({ removed: 0, error: null });
    expect(b.remove).not.toHaveBeenCalled();
  });
});
