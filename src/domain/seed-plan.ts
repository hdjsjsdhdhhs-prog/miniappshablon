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

type VariantConfig = TenantConfig['initialProducts'][number]['variants'][number];

/**
 * Row inserted by `tenant:seed` for a NEW variant. It never carries its own price: every variant sells at
 * the product price (`products.base_price_minor`; `create_order` charges `coalesce(price_override_minor,
 * base_price_minor)`). A variant added to an already seeded product therefore inherits the price the owner
 * has set, instead of a price from the config.
 */
export function variantSeedRow(
  ids: { shopId: string; productId: string; productKey: string },
  variant: VariantConfig,
  sortOrder: number,
) {
  return {
    shop_id: ids.shopId,
    product_id: ids.productId,
    flavor: variant.flavor,
    color: variant.color,
    sku: variant.sku,
    price_override_minor: null,
    stock_quantity: variant.stock,
    is_active: true,
    sort_order: sortOrder,
    seed_key: seedKeys.variant(ids.productKey, variant.key),
  };
}

export interface ProductImagePlan {
  /** Indexes into the config `images` array that must be uploaded/attached, in order. */
  attach: number[];
  /**
   * `complete`      every config image is attached;
   * `resume`        a prefix is attached (e.g. a previous seed was interrupted), the rest is missing;
   * `owner_managed` the product has images that are not a seed prefix (owner photos or gaps), so
   *                 the seed must not touch it.
   */
  status: 'complete' | 'resume' | 'owner_managed';
}

/**
 * Decides which seed images of ONE product still have to be attached. Images are attached
 * sequentially, so an interrupted seed always leaves a contiguous prefix `img:<key>/0..k-1`;
 * only that state is resumed. Anything else (images without a seed key, gaps, unknown keys) means
 * the owner manages the photos and nothing is added.
 *
 * Limitation: if the owner deleted only the LAST seed photos of a product they never edited, the
 * state is indistinguishable from an interruption and those photos are attached again.
 */
export function planProductImages(
  productKey: string,
  imageCount: number,
  existing: ReadonlyArray<{ seedKey: string | null }>,
): ProductImagePlan {
  const prefix = new Set<number>();
  for (const { seedKey } of existing) {
    const index = seedKey === null ? -1 : parseSeedImageIndex(productKey, seedKey);
    if (index < 0 || index >= imageCount || prefix.has(index)) return { attach: [], status: 'owner_managed' };
    prefix.add(index);
  }
  for (let i = 0; i < prefix.size; i += 1) {
    if (!prefix.has(i)) return { attach: [], status: 'owner_managed' };
  }
  const attach: number[] = [];
  for (let i = prefix.size; i < imageCount; i += 1) attach.push(i);
  return { attach, status: attach.length === 0 ? 'complete' : 'resume' };
}

function parseSeedImageIndex(productKey: string, seedKey: string): number {
  const prefix = seedKeys.image(productKey, 0).slice(0, -1); // "img:<productKey>/"
  if (!seedKey.startsWith(prefix)) return -1;
  const rest = seedKey.slice(prefix.length);
  return /^(0|[1-9]\d*)$/.test(rest) ? Number(rest) : -1;
}
