import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planSeed } from './seed-plan';
import { findForbiddenKeys, seedKeys, tenantConfigSchema, type TenantConfig } from './tenant-config';
import { slugify } from './slugify';

const TENANTS = join(process.cwd(), 'tenants');
const load = (slug: string) => JSON.parse(readFileSync(join(TENANTS, slug, 'shop.config.json'), 'utf8')) as Record<string, unknown>;

describe('tenant config schema', () => {
  it('accepts every committed tenant config', () => {
    const slugs = readdirSync(TENANTS);
    expect(slugs.length).toBeGreaterThanOrEqual(2);
    for (const slug of slugs) {
      const r = tenantConfigSchema.safeParse(load(slug));
      expect(r.success, `${slug}: ${r.error?.message}`).toBe(true);
      expect(findForbiddenKeys(load(slug))).toEqual([]);
    }
  });

  it('demo tenants are visually different and explicitly marked as demo', () => {
    const a = tenantConfigSchema.parse(load('noir-vapor'));
    const b = tenantConfigSchema.parse(load('mint-lab'));
    expect(a.demo && b.demo).toBe(true);
    expect(a.theme.mode).not.toBe(b.theme.mode);
    expect(a.theme.primary).not.toBe(b.theme.primary);
    expect(a.name).not.toBe(b.name);
  });

  it('validates the optional Telegram channel link (old configs without it stay valid)', () => {
    const base = load('mint-lab');
    const info = base.shopInformation as Record<string, unknown>;
    const parsed = tenantConfigSchema.parse(base);
    expect(parsed.shopInformation.telegramChannelUrl).toBe('');
    expect(parsed.shopInformation.telegramChannelLabel).toBe('');
    const withLink = (url: string) => ({ ...base, shopInformation: { ...info, telegramChannelUrl: url } });
    expect(tenantConfigSchema.safeParse(withLink('https://t.me/mint_lab_shop')).success).toBe(true);
    expect(tenantConfigSchema.safeParse(withLink('javascript:alert(1)')).success).toBe(false);
    expect(tenantConfigSchema.safeParse(withLink('https://example.com/mint')).success).toBe(false);
  });

  it('rejects bad slugs, unknown categories, duplicate combos and path traversal', () => {
    const base = load('mint-lab');
    expect(tenantConfigSchema.safeParse({ ...base, slug: 'Bad Slug' }).success).toBe(false);
    expect(tenantConfigSchema.safeParse({ ...base, logo: 'assets/../../secret.png' }).success).toBe(false);
    expect(tenantConfigSchema.safeParse({ ...base, legalNotice: '' }).success).toBe(false);
    const products = base.initialProducts as Array<Record<string, unknown>>;
    expect(
      tenantConfigSchema.safeParse({ ...base, initialProducts: [{ ...products[0], category: 'nope' }] }).success,
    ).toBe(false);
    expect(
      tenantConfigSchema.safeParse({
        ...base,
        initialProducts: [{ ...products[0], variants: [{ key: 'a', flavor: 'X', stock: 1 }, { key: 'b', flavor: 'x', stock: 1 }] }],
      }).success,
    ).toBe(false);
    expect(tenantConfigSchema.safeParse({ ...base, unknownField: 1 }).success).toBe(false);
  });

  it('detects secret-looking keys anywhere in the config', () => {
    expect(findForbiddenKeys({ telegram: { botToken: 'x' }, a: [{ password: 1 }] })).toEqual(['$.telegram.botToken', '$.a[0].password']);
  });
});

describe('seed plan (idempotency)', () => {
  const cfg: TenantConfig = tenantConfigSchema.parse(load('noir-vapor'));

  it('inserts everything for a new shop', () => {
    const plan = planSeed(cfg, { shopExists: false, categoryKeys: new Set(), productKeys: new Set(), variantKeys: new Set() });
    expect(plan.createShop).toBe(true);
    expect(plan.categories).toHaveLength(cfg.initialCategories.length);
    expect(plan.products).toHaveLength(cfg.initialProducts.length);
    expect(plan.variants).toHaveLength(cfg.initialProducts.reduce((n, p) => n + p.variants.length, 0));
  });

  it('inserts nothing on re-seed and only new rows when the config grows', () => {
    const all = {
      shopExists: true,
      categoryKeys: new Set(cfg.initialCategories.map((c) => seedKeys.category(c.key))),
      productKeys: new Set(cfg.initialProducts.map((p) => seedKeys.product(p.key))),
      variantKeys: new Set(cfg.initialProducts.flatMap((p) => p.variants.map((v) => seedKeys.variant(p.key, v.key)))),
    };
    const again = planSeed(cfg, all);
    expect(again.createShop).toBe(false);
    expect([again.categories.length, again.products.length, again.variants.length]).toEqual([0, 0, 0]);

    const first = cfg.initialProducts[0]!;
    const grown: TenantConfig = {
      ...cfg,
      initialProducts: [{ ...first, variants: [...first.variants, { key: 'new-one', flavor: 'Новый', color: null, sku: null, priceMinor: null, stock: 1 }] }, ...cfg.initialProducts.slice(1)],
    };
    const delta = planSeed(grown, all);
    expect(delta.variants.map((v) => v.variant.key)).toEqual(['new-one']);
    expect(delta.products).toHaveLength(0);
  });
});

describe('slugify', () => {
  it('transliterates Cyrillic names into valid category slugs', () => {
    expect(slugify('Pod-системы')).toBe('pod-sistemy');
    expect(slugify('  Жидкости 30 мл ')).toBe('zhidkosti-30-ml');
    expect(slugify('!!!')).toBe('');
  });
});
