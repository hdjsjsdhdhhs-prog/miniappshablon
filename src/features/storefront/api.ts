import { shopInformationSchema, shopSettingsSchema } from '@/domain/tenant-config';
import { parseTheme, type ShopTheme } from '@/domain/theme';
import { supabase } from '@/lib/supabase';

/**
 * Storefront data access (anon key + RLS). Owners signed into the admin get preview access to
 * unpublished shops through the same queries (member RLS policies), never through extra code.
 */

export interface Shop {
  id: string;
  slug: string;
  name: string;
  description: string;
  logoPath: string | null;
  coverPath: string | null;
  theme: ShopTheme;
  currency: string;
  mode: 'preview' | 'live';
  isDemo: boolean;
  ageRestriction: number;
  legalNotice: string;
  info: ReturnType<typeof shopInformationSchema.parse>;
  settings: ReturnType<typeof shopSettingsSchema.parse>;
  telegram: { botUsername: string | null; miniAppShortName: string | null };
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  imagePath: string | null;
}

export interface Variant {
  id: string;
  flavor: string | null;
  color: string | null;
  price_override_minor: number | null;
  stock_quantity: number;
  is_active: boolean;
  sort_order: number;
}

export interface ProductImage {
  id: string;
  storage_path: string;
  is_primary: boolean;
  sort_order: number;
  alt_text: string;
}

export interface ProductSummary {
  id: string;
  name: string;
  basePriceMinor: number;
  categoryId: string;
  isFeatured: boolean;
  variants: Variant[];
  images: ProductImage[];
}

export interface ProductDetail extends ProductSummary {
  description: string;
  categoryName: string;
}

export const PAGE_SIZE = 20;

const SHOP_COLUMNS =
  'id, slug, name, description, logo_path, cover_path, theme_config, currency, mode, status, is_demo, age_restriction, legal_notice, info, settings, telegram';

const PRODUCT_COLUMNS =
  'id, name, base_price_minor, category_id, is_featured, description, ' +
  'categories!inner(name, is_active, archived_at), ' +
  'product_variants(id, flavor, color, price_override_minor, stock_quantity, is_active, sort_order), ' +
  'product_images(id, storage_path, is_primary, sort_order, alt_text)';

export class NotFoundError extends Error {}

export async function fetchShopBySlug(slug: string): Promise<Shop> {
  const { data, error } = await supabase.from('shops').select(SHOP_COLUMNS).eq('slug', slug).maybeSingle();
  if (error) throw error;
  if (!data || data.status !== 'active') throw new NotFoundError(slug);
  const info = shopInformationSchema.safeParse(data.info);
  const settings = shopSettingsSchema.safeParse(data.settings);
  const tg = (data.telegram ?? {}) as Partial<Shop['telegram']>;
  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    description: data.description,
    logoPath: data.logo_path,
    coverPath: data.cover_path,
    theme: parseTheme(data.theme_config),
    currency: data.currency,
    mode: data.mode === 'live' ? 'live' : 'preview',
    isDemo: data.is_demo,
    ageRestriction: data.age_restriction,
    legalNotice: data.legal_notice,
    info: info.success ? info.data : shopInformationSchema.parse({}),
    settings: settings.success ? settings.data : shopSettingsSchema.parse({}),
    telegram: { botUsername: tg.botUsername ?? null, miniAppShortName: tg.miniAppShortName ?? null },
  };
}

export async function fetchCategories(shopId: string): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, slug, image_path')
    .eq('shop_id', shopId)
    .eq('is_active', true)
    .is('archived_at', null)
    .order('sort_order')
    .order('name');
  if (error) throw error;
  return data.map((c) => ({ id: c.id, name: c.name, slug: c.slug, imagePath: c.image_path }));
}

interface ProductRow {
  id: string;
  name: string;
  description: string;
  base_price_minor: number;
  category_id: string;
  is_featured: boolean;
  categories: { name: string; is_active: boolean; archived_at: string | null };
  product_variants: Variant[];
  product_images: ProductImage[];
}

function toDetail(row: ProductRow): ProductDetail {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    basePriceMinor: row.base_price_minor,
    categoryId: row.category_id,
    categoryName: row.categories.name,
    isFeatured: row.is_featured,
    variants: row.product_variants.filter((v) => v.is_active).sort((a, b) => a.sort_order - b.sort_order),
    images: [...row.product_images].sort(
      (a, b) => Number(b.is_primary) - Number(a.is_primary) || a.sort_order - b.sort_order,
    ),
  };
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function normalizeSearch(input: string): string {
  return input.trim().replace(/\s+/g, ' ').slice(0, 60);
}

function publicProductsQuery(shopId: string) {
  return supabase
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('shop_id', shopId)
    .eq('is_published', true)
    .is('archived_at', null)
    .eq('categories.is_active', true)
    .is('categories.archived_at', null);
}

export async function fetchProductsPage(
  shopId: string,
  params: { categoryId: string | null; search: string },
  page: number,
): Promise<{ items: ProductDetail[]; nextPage: number | null }> {
  let q = publicProductsQuery(shopId);
  if (params.categoryId) q = q.eq('category_id', params.categoryId);
  const search = normalizeSearch(params.search);
  if (search) q = q.ilike('name', `%${escapeLike(search)}%`);
  const from = page * PAGE_SIZE;
  const { data, error } = await q
    .order('sort_order')
    .order('created_at')
    .order('id')
    .range(from, from + PAGE_SIZE - 1)
    .overrideTypes<ProductRow[], { merge: false }>();
  if (error) throw error;
  return { items: data.map(toDetail), nextPage: data.length === PAGE_SIZE ? page + 1 : null };
}

export async function fetchFeatured(shopId: string): Promise<ProductDetail[]> {
  const { data, error } = await publicProductsQuery(shopId)
    .eq('is_featured', true)
    .order('sort_order')
    .limit(8)
    .overrideTypes<ProductRow[], { merge: false }>();
  if (error) throw error;
  return data.map(toDetail);
}

export async function fetchProduct(shopId: string, productId: string): Promise<ProductDetail> {
  const { data, error } = await publicProductsQuery(shopId)
    .eq('id', productId)
    .maybeSingle()
    .overrideTypes<ProductRow | null, { merge: false }>();
  if (error) throw error;
  if (!data) throw new NotFoundError(productId);
  return toDetail(data);
}
