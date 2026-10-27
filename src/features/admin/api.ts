import type { ShopTheme } from '@/domain/theme';
import type { OrderStatus } from '@/domain/order-status';
import { IMAGE_SETTINGS } from '@/config/images';
import { supabase, type Tables } from '@/lib/supabase';

const IMAGE_BUCKET = IMAGE_SETTINGS.bucket;

/**
 * Admin data access. All writes go through RLS (membership checked in Postgres) or
 * SECURITY DEFINER RPCs that re-check membership (stock, order status). Nothing here relies on
 * the frontend to enforce permissions.
 */

export type AdminShop = Tables<'shops'>;
export type AdminCategory = Tables<'categories'>;
export type AdminProduct = Tables<'products'> & {
  product_variants: Tables<'product_variants'>[];
  product_images: Tables<'product_images'>[];
};
export type AdminOrder = Tables<'orders'> & { order_items: Tables<'order_items'>[] };

/** For `.single()` / list / rpc results: throws on error or empty response. */
function check<T>(res: { data: T; error: { message: string } | null }): NonNullable<T> {
  if (res.error) throw new Error(res.error.message);
  if (res.data === null || res.data === undefined) throw new Error('Пустой ответ сервера');
  return res.data as NonNullable<T>;
}

/** For `.maybeSingle()` results where "not found" is a valid outcome. */
function checkMaybe<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

/**
 * "Мои магазины": shops the signed-in user is a member of (owner / manager), for platform admins too.
 * Platform admins see every shop in the separate platform section (platformApi.list), so a shop handed
 * over to a client leaves its previous owner's list but stays in the platform list.
 */
export async function fetchMyShops(): Promise<Array<{ role: string; shop: AdminShop }>> {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return [];
  const rows = check(
    await supabase.from('shop_memberships').select('role, shops(*)').eq('user_id', auth.user.id),
  ) as unknown as Array<{ role: string; shops: AdminShop | null }>;
  return rows
    .filter((r) => r.shops)
    .map((r) => ({ role: r.role, shop: r.shops! }))
    .sort((a, b) => a.shop.name.localeCompare(b.shop.name, 'ru'));
}

/** Resolves a shop by slug AND verifies membership on the server (is_shop_member RPC). */
export async function fetchAdminShop(slug: string): Promise<AdminShop | null> {
  const shop = checkMaybe(await supabase.from('shops').select('*').eq('slug', slug).maybeSingle());
  if (!shop) return null;
  const member = check(await supabase.rpc('is_shop_member', { p_shop_id: shop.id }));
  return member ? shop : null;
}

export async function updateShopSettings(
  shopId: string,
  patch: Partial<
    Pick<AdminShop, 'name' | 'description' | 'logo_path' | 'cover_path' | 'delivery_enabled' | 'pickup_enabled' | 'pickup_instructions'>
  > & {
    theme_config?: ShopTheme;
    info?: Record<string, string>;
    settings?: Record<string, boolean>;
  },
): Promise<AdminShop> {
  return check(await supabase.from('shops').update(patch).eq('id', shopId).select('*').single());
}

// ---- categories --------------------------------------------------------------

export async function fetchAdminCategories(shopId: string): Promise<AdminCategory[]> {
  return check(await supabase.from('categories').select('*').eq('shop_id', shopId).order('sort_order').order('name'));
}

export async function createCategory(shopId: string, input: { name: string; slug: string; sort_order: number }) {
  return check(await supabase.from('categories').insert({ shop_id: shopId, ...input }).select('*').single());
}

export async function updateCategory(
  id: string,
  patch: Partial<Pick<AdminCategory, 'name' | 'slug' | 'sort_order' | 'is_active' | 'archived_at' | 'image_path'>>,
) {
  return check(await supabase.from('categories').update(patch).eq('id', id).select('*').single());
}

// ---- products ------------------------------------------------------------------

export async function fetchAdminProducts(shopId: string): Promise<AdminProduct[]> {
  return check(
    await supabase
      .from('products')
      .select('*, product_variants(*), product_images(*)')
      .eq('shop_id', shopId)
      .order('sort_order')
      .order('created_at'),
  ) as AdminProduct[];
}

export async function fetchAdminProduct(shopId: string, productId: string): Promise<AdminProduct | null> {
  return checkMaybe(
    await supabase
      .from('products')
      .select('*, product_variants(*), product_images(*)')
      .eq('shop_id', shopId)
      .eq('id', productId)
      .maybeSingle(),
  ) as AdminProduct | null;
}

export interface ProductInput {
  name: string;
  description: string;
  category_id: string;
  base_price_minor: number;
  is_published: boolean;
  sort_order: number;
}

export async function createProduct(shopId: string, input: ProductInput) {
  const product = check(await supabase.from('products').insert({ shop_id: shopId, ...input }).select('*').single());
  // Every product needs at least one sellable row; start with the default (no flavor/color) variant.
  // It has no own price: the product price applies to it, as to every later variant.
  check(
    await supabase
      .from('product_variants')
      .insert({ shop_id: shopId, product_id: product.id, price_override_minor: null })
      .select('id')
      .single(),
  );
  return product;
}

export async function updateProduct(id: string, patch: Partial<ProductInput> & { archived_at?: string | null }) {
  return check(await supabase.from('products').update(patch).eq('id', id).select('*').single());
}

/**
 * One price per product. The price lives in products.base_price_minor; checkout (create_order) charges
 * coalesce(price_override_minor, base_price_minor). Clearing every variant's own price therefore makes all
 * variants of the product sell at exactly the product price. Returns the ids of the variants that changed.
 */
export async function syncVariantPricesToProduct(productId: string): Promise<string[]> {
  const rows = check(
    await supabase
      .from('product_variants')
      .update({ price_override_minor: null })
      .eq('product_id', productId)
      .not('price_override_minor', 'is', null)
      .select('id'),
  );
  return rows.map((r) => r.id);
}

/** Saves the product card; its price becomes the price of every variant. */
export async function saveProductWithPrice(id: string, input: ProductInput) {
  const product = await updateProduct(id, input);
  await syncVariantPricesToProduct(id);
  return product;
}

// ---- variants --------------------------------------------------------------------

/** A variant has no price of its own: it always sells at the product price (base_price_minor). */
export interface VariantInput {
  flavor: string | null;
  color: string | null;
  sku: string | null;
  is_active: boolean;
}

/** Writable variant fields; the price is deliberately not one of them. */
function variantRow(input: Partial<VariantInput>) {
  const { flavor, color, sku, is_active } = input;
  return Object.fromEntries(Object.entries({ flavor, color, sku, is_active }).filter(([, v]) => v !== undefined)) as Partial<VariantInput>;
}

export async function createVariant(shopId: string, productId: string, input: VariantInput, stock: number) {
  const v = check(
    await supabase
      .from('product_variants')
      .insert({ shop_id: shopId, product_id: productId, ...variantRow(input), price_override_minor: null })
      .select('*')
      .single(),
  );
  if (stock > 0) await setVariantStock(v.id, stock);
  return v;
}

export async function updateVariant(id: string, patch: Partial<VariantInput>) {
  return check(await supabase.from('product_variants').update(variantRow(patch)).eq('id', id).select('*').single());
}

/** Stock changes are journaled server-side (inventory_movements) by the RPC. */
export async function setVariantStock(variantId: string, quantity: number) {
  return check(await supabase.rpc('admin_set_variant_stock', { p_variant_id: variantId, p_quantity: quantity }));
}

// ---- physical deletion ---------------------------------------------------------------

/**
 * A refused delete. `code` is the server's reason (product_has_orders, variant_has_orders, last_variant,
 * category_has_products, target_not_found, *_not_found); `details` carries counts such as { orders: 2 }.
 */
export class CatalogDeleteError extends Error {
  readonly code: string;
  readonly details: Record<string, number>;
  constructor(code: string, details: Record<string, number>) {
    super(code);
    this.name = 'CatalogDeleteError';
    this.code = code;
    this.details = details;
  }
}

interface DeleteResult {
  id: string;
  deleted: true;
  /** Storage paths of the deleted rows that no row of the shop references any more (computed by the server). */
  unused_media: string[];
}

function parseDetails(raw: string | null | undefined): Record<string, number> {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Membership, dependency checks and the delete itself all run in one server transaction (SECURITY DEFINER RPC). */
function deleteRpc<T>(res: { data: unknown; error: { message: string; details?: string | null } | null }): T {
  if (res.error) throw new CatalogDeleteError(res.error.message, parseDetails(res.error.details));
  if (!res.data) throw new Error('Пустой ответ сервера');
  return res.data as T;
}

/**
 * Removes Storage objects the server reported as unused after a delete. The database is already consistent at this
 * point, so a Storage failure only leaves an orphaned file behind; it is reported, not thrown.
 */
async function removeUnusedMedia(paths: string[]): Promise<{ removed: number; failed: boolean }> {
  if (paths.length === 0) return { removed: 0, failed: false };
  const { data, error } = await supabase.storage.from(IMAGE_BUCKET).remove(paths);
  return { removed: data?.length ?? 0, failed: !!error };
}

export async function deleteProduct(productId: string) {
  const r = deleteRpc<DeleteResult & { variants: number; images: number }>(
    await supabase.rpc('admin_delete_product', { p_product_id: productId }),
  );
  return { ...r, media: await removeUnusedMedia(r.unused_media) };
}

export async function deleteVariant(variantId: string) {
  return deleteRpc<{ id: string; product_id: string; deleted: true }>(
    await supabase.rpc('admin_delete_variant', { p_variant_id: variantId }),
  );
}

/** With products in the category, `moveProductsTo` (another category of the same shop) is required by the server. */
export async function deleteCategory(categoryId: string, moveProductsTo?: string) {
  const r = deleteRpc<DeleteResult & { moved_products: number; moved_to: string | null }>(
    await supabase.rpc('admin_delete_category', {
      p_category_id: categoryId,
      ...(moveProductsTo ? { p_move_products_to: moveProductsTo } : {}),
    }),
  );
  return { ...r, media: await removeUnusedMedia(r.unused_media) };
}

// ---- images ------------------------------------------------------------------------

export async function addProductImage(shopId: string, productId: string, storagePath: string, sortOrder: number, isPrimary: boolean, alt: string) {
  return check(
    await supabase
      .from('product_images')
      .insert({ shop_id: shopId, product_id: productId, storage_path: storagePath, sort_order: sortOrder, is_primary: isPrimary, alt_text: alt })
      .select('*')
      .single(),
  );
}

export async function updateProductImage(id: string, patch: Partial<Pick<Tables<'product_images'>, 'storage_path' | 'sort_order' | 'is_primary' | 'alt_text'>>) {
  return check(await supabase.from('product_images').update(patch).eq('id', id).select('*').single());
}

export async function deleteProductImage(id: string) {
  check(await supabase.from('product_images').delete().eq('id', id).select('id'));
}

/** Makes one image primary. The partial unique index requires clearing the old one first. */
export async function setPrimaryImage(productId: string, imageId: string) {
  check(await supabase.from('product_images').update({ is_primary: false }).eq('product_id', productId).eq('is_primary', true).select('id'));
  await updateProductImage(imageId, { is_primary: true });
}

// ---- orders --------------------------------------------------------------------------

export async function fetchAdminOrders(shopId: string, status: OrderStatus | 'active' | 'all'): Promise<AdminOrder[]> {
  let q = supabase.from('orders').select('*, order_items(*)').eq('shop_id', shopId).order('created_at', { ascending: false }).limit(100);
  if (status === 'active') q = q.in('status', ['new', 'confirmed', 'ready']);
  else if (status !== 'all') q = q.eq('status', status);
  return check(await q) as AdminOrder[];
}

export async function setOrderStatus(orderId: string, status: OrderStatus) {
  return check(await supabase.rpc('admin_set_order_status', { p_order_id: orderId, p_status: status }));
}

export async function fetchDashboardStats(shopId: string) {
  const count = async (build: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count: c, error } = await build(base());
    if (error) throw new Error(error.message);
    return c ?? 0;
  };
  const base = () => supabase.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', shopId);
  const [newOrders, active, completed] = await Promise.all([
    count((q) => q.eq('status', 'new')),
    count((q) => q.in('status', ['new', 'confirmed', 'ready'])),
    count((q) => q.eq('status', 'completed')),
  ]);
  const outOfStock = check(
    await supabase
      .from('product_variants')
      .select('id, flavor, color, products!inner(id, name, archived_at)')
      .eq('shop_id', shopId)
      .eq('is_active', true)
      .eq('stock_quantity', 0)
      .is('products.archived_at', null)
      .limit(20),
  ) as unknown as Array<{ id: string; flavor: string | null; color: string | null; products: { id: string; name: string } }>;
  const recent = await fetchAdminOrders(shopId, 'all');
  return { newOrders, active, completed, outOfStock, recent: recent.slice(0, 5) };
}
