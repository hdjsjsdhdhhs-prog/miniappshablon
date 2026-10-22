import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planProductImages, planSeed, variantSeedRow } from './seed-plan';
import { seedKeys, tenantConfigSchema, type TenantConfig } from './tenant-config';

const TENANTS = join(process.cwd(), 'tenants');
const config = (slug: string): TenantConfig =>
  tenantConfigSchema.parse(JSON.parse(readFileSync(join(TENANTS, slug, 'shop.config.json'), 'utf8')));
const ids = { shopId: 's', productId: 'p' };

describe('variant rows of tenant:seed carry no own price', () => {
  it('every variant of every committed tenant sells at its product price', () => {
    for (const slug of readdirSync(TENANTS)) {
      const cfg = config(slug);
      const plan = planSeed(cfg, { shopExists: false, categoryKeys: new Set(), productKeys: new Set(), variantKeys: new Set() });
      expect(plan.variants.length).toBeGreaterThan(0);
      for (const [i, { productKey, variant }] of plan.variants.entries()) {
        const row = variantSeedRow({ ...ids, productKey }, variant, i);
        expect(row.price_override_minor, `${slug}/${productKey}/${variant.key}`).toBeNull();
        expect(row.seed_key).toBe(seedKeys.variant(productKey, variant.key));
        expect(row.stock_quantity).toBe(variant.stock);
      }
    }
  });

  it('a re-seed of a grown config adds the new variant without a price (it inherits the owner price)', () => {
    const cfg = config('noir-vapor');
    const all = {
      shopExists: true,
      categoryKeys: new Set(cfg.initialCategories.map((c) => seedKeys.category(c.key))),
      productKeys: new Set(cfg.initialProducts.map((p) => seedKeys.product(p.key))),
      variantKeys: new Set(cfg.initialProducts.flatMap((p) => p.variants.map((v) => seedKeys.variant(p.key, v.key)))),
    };
    const salt = cfg.initialProducts.find((p) => p.key === 'noir-salt-30')!;
    const grown: TenantConfig = {
      ...cfg,
      initialProducts: cfg.initialProducts.map((p) =>
        p === salt ? { ...p, variants: [...p.variants, { key: 'peach', flavor: 'Персик', color: null, sku: null, stock: 3 }] } : p,
      ),
    };
    const delta = planSeed(grown, all);
    expect(delta.products).toEqual([]); // the product (and the owner's price) is not touched
    expect(delta.variants.map((v) => v.variant.key)).toEqual(['peach']);
    expect(variantSeedRow({ ...ids, productKey: 'noir-salt-30' }, delta.variants[0]!.variant, 0).price_override_minor).toBeNull();
  });
});

const keys = (...k: Array<string | null>) => k.map((seedKey) => ({ seedKey }));

describe('planProductImages', () => {
  it('attaches every image of a product that has none yet', () => {
    expect(planProductImages('noir-salt-30', 2, [])).toEqual({ attach: [0, 1], status: 'resume' });
  });

  it('resumes after an interrupted seed: first image attached, second missing', () => {
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/0'))).toEqual({ attach: [1], status: 'resume' });
  });

  it('adds nothing once all images are attached (repeated re-seed creates no duplicates)', () => {
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/1', 'img:noir-salt-30/0'))).toEqual({
      attach: [],
      status: 'complete',
    });
  });

  it('leaves owner-managed photos alone: own images, gaps, foreign or out-of-range keys', () => {
    const managed = { attach: [], status: 'owner_managed' };
    expect(planProductImages('noir-salt-30', 2, keys(null))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/0', null))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 3, keys('img:noir-salt-30/1'))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:velvet-ice/0'))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/2'))).toEqual(managed);
    expect(planProductImages('noir-salt-30', 2, keys('img:noir-salt-30/01'))).toEqual(managed);
    // Key of a product whose key extends this one must not be mistaken for its own.
    expect(planProductImages('noir', 1, keys('img:noir-salt-30/0'))).toEqual(managed);
  });

  it('a product without config images needs nothing', () => {
    expect(planProductImages('lanyard', 0, [])).toEqual({ attach: [], status: 'complete' });
  });
});
