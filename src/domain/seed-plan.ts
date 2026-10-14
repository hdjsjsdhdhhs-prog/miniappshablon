import { seedKeys, type TenantConfig } from './tenant-config';

/**
 * Pure planning step of `tenant:seed`. Given the config and the seed keys that already exist in
 * the database, returns only the rows that must be INSERTED. Existing rows are never updated, so
 * owner edits made in the admin panel survive any number of re-seeds.
 */
export interface ExistingSeedState {
  shopExists: boolean;
  categoryKeys: ReadonlySet<string>;
  productKeys: ReadonlySet<string>;
  variantKeys: ReadonlySet<string>;
}

export interface SeedPlan {
  createShop: boolean;
  categories: TenantConfig['initialCategories'];
  products: Array<{ product: TenantConfig['initialProducts'][number]; isNew: boolean }>;
  variants: Array<{ productKey: string; variant: TenantConfig['initialProducts'][number]['variants'][number] }>;
  skipped: { categories: number; products: number; variants: number };
}

export function planSeed(config: TenantConfig, existing: ExistingSeedState): SeedPlan {
  const categories = config.initialCategories.filter((c) => !existing.categoryKeys.has(seedKeys.category(c.key)));
  const products: SeedPlan['products'] = [];
  const variants: SeedPlan['variants'] = [];
  let skippedProducts = 0;
  let skippedVariants = 0;

  for (const p of config.initialProducts) {
    const isNew = !existing.productKeys.has(seedKeys.product(p.key));
    if (isNew) products.push({ product: p, isNew });
    else skippedProducts += 1;
    for (const v of p.variants) {
      if (existing.variantKeys.has(seedKeys.variant(p.key, v.key))) skippedVariants += 1;
      else variants.push({ productKey: p.key, variant: v });
    }
  }

  return {
    createShop: !existing.shopExists,
    categories,
    products,
    variants,
    skipped: {
      categories: config.initialCategories.length - categories.length,
      products: skippedProducts,
      variants: skippedVariants,
    },
  };
}
