// pnpm tenant:seed --slug <slug>
// Idempotent import of shop.config.json + assets into Supabase.
//  * the shop row is created once (in preview mode); afterwards its fields belong to the owner;
//  * categories/products/variants are inserted only when their seed_key does not exist yet;
//  * existing rows are never updated, so owner edits survive re-seeding;
//  * images are uploaded to deterministic content-addressed paths; an object that already exists
//    is not uploaded again, and each seed image is attached by its own seed_key, so a seed that was
//    interrupted halfway through a product's photos resumes without duplicates.
import { extname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { seedKeys } from '../../src/domain/tenant-config.ts';
import { planProductImages, planSeed, variantSeedRow } from '../../src/domain/seed-plan.ts';
import { log, parseArgs, requireString, run } from '../lib/cli.ts';
import { serviceClient } from '../lib/supabase-env.ts';
import { loadAsset, validateTenant } from '../lib/tenant-fs.ts';

type Client = ReturnType<typeof serviceClient>;

const BUCKET = 'shop-media';
/** Bounded retry for transient network failures only (e.g. undici "fetch failed"). */
const RETRY_DELAYS_MS = [1_000, 3_000];
const TRANSIENT_RE = /fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

async function withRetry<T>(what: string, attempt: () => Promise<{ value: T } | { error: string }>): Promise<T> {
  for (let i = 0; ; i += 1) {
    let res: { value: T } | { error: string };
    try {
      res = await attempt();
    } catch (err) {
      res = { error: err instanceof Error ? err.message : String(err) };
    }
    if ('value' in res) return res.value;
    const delay = RETRY_DELAYS_MS[i];
    if (delay === undefined || !TRANSIENT_RE.test(res.error)) {
      throw new Error(`${what} не удалась${i > 0 ? ` после ${i + 1} попыток` : ''}: ${res.error}`);
    }
    log.warn(`${what}: ${res.error}; повтор через ${delay / 1000} с`);
    await sleep(delay);
  }
}

async function objectExists(db: Client, path: string): Promise<boolean> {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash);
  const name = path.slice(slash + 1);
  return withRetry<boolean>(`Проверка ${path}`, async () => {
    const { data, error } = await db.storage.from(BUCKET).list(dir, { search: name, limit: 100 });
    return error ? { error: error.message } : { value: (data ?? []).some((o) => o.name === name) };
  });
}

async function uploadAsset(db: Client, slug: string, shopId: string, relPath: string): Promise<string> {
  const asset = loadAsset(slug, relPath);
  // Content-addressed: an existing object at this path already holds exactly these bytes.
  const path = `${shopId}/seed/${asset.sha256.slice(0, 32)}${extname(relPath).toLowerCase()}`;
  if (await objectExists(db, path)) return path;
  await withRetry<void>(`Загрузка ${relPath}`, async () => {
    const { error } = await db.storage
      .from(BUCKET)
      .upload(path, asset.buffer, { contentType: asset.info.mime, upsert: false, cacheControl: '31536000' });
    // "exists": a previous attempt reached the server although its response was lost.
    return error && !/exists|duplicate/i.test(error.message) ? { error: error.message } : { value: undefined };
  });
  return path;
}

function must<T>(res: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null || res.data === undefined) throw new Error(`${what}: пустой ответ`);
  return res.data as NonNullable<T>;
}

run(async () => {
  const slug = requireString(parseArgs(), 'slug');
  log.step(`Seed tenant "${slug}"`);
  const report = validateTenant(slug);
  report.warnings.forEach((w) => log.warn(w));
  if (!report.config) {
    report.errors.forEach((e) => log.err(e));
    return 1;
  }
  const cfg = report.config;
  const db = serviceClient();

  // ---- shop ---------------------------------------------------------------
  const shopRes = await db.from('shops').select('id, mode').eq('slug', slug).maybeSingle();
  if (shopRes.error) throw new Error(`Чтение магазина: ${shopRes.error.message}`);
  const existingShop = shopRes.data;

  let shopId: string;
  if (!existingShop) {
    const inserted = must(
      await db
        .from('shops')
        .insert({
          slug: cfg.slug,
          name: cfg.name,
          description: cfg.description,
          theme_config: cfg.theme,
          currency: cfg.currency,
          is_demo: cfg.demo,
          mode: 'preview',
          age_restriction: cfg.ageRestriction,
          info: cfg.shopInformation,
          delivery_enabled: cfg.fulfillment.delivery,
          pickup_enabled: cfg.fulfillment.pickup,
          pickup_instructions: cfg.fulfillment.pickupInstructions,
          settings: cfg.settings,
          telegram: cfg.telegram,
        })
        .select('id')
        .single(),
      'Создание магазина',
    );
    shopId = inserted.id;
    const patch: { logo_path?: string; cover_path?: string } = {};
    if (cfg.logo) patch.logo_path = await uploadAsset(db, slug, shopId, cfg.logo);
    if (cfg.cover) patch.cover_path = await uploadAsset(db, slug, shopId, cfg.cover);
    if (Object.keys(patch).length > 0) must(await db.from('shops').update(patch).eq('id', shopId).select('id').single(), 'Логотип');
    log.ok(`Магазин создан в режиме preview (id ${shopId})`);
  } else {
    shopId = existingShop.id;
    log.info(`Магазин уже существует (mode=${existingShop.mode}); его поля не перезаписываются`);
  }

  // ---- existing seed keys --------------------------------------------------
  const [cats, prods, vars] = await Promise.all([
    db.from('categories').select('id, seed_key').eq('shop_id', shopId),
    db.from('products').select('id, seed_key, created_at, updated_at').eq('shop_id', shopId),
    db.from('product_variants').select('seed_key').eq('shop_id', shopId),
  ]);
  const catRows = must(cats, 'Категории');
  const prodRows = must(prods, 'Товары');
  const varRows = must(vars, 'Варианты');

  const plan = planSeed(cfg, {
    shopExists: existingShop !== null,
    categoryKeys: new Set(catRows.map((r) => r.seed_key).filter((k): k is string => !!k)),
    productKeys: new Set(prodRows.map((r) => r.seed_key).filter((k): k is string => !!k)),
    variantKeys: new Set(varRows.map((r) => r.seed_key).filter((k): k is string => !!k)),
  });

  // ---- categories ----------------------------------------------------------
  const categoryIdByKey = new Map<string, string>();
  for (const r of catRows) if (r.seed_key) categoryIdByKey.set(r.seed_key, r.id);
  for (const [index, c] of cfg.initialCategories.entries()) {
    if (!plan.categories.includes(c)) continue;
    const image_path = c.image ? await uploadAsset(db, slug, shopId, c.image) : null;
    const row = must(
      await db
        .from('categories')
        .upsert(
          { shop_id: shopId, name: c.name, slug: c.slug, image_path, sort_order: index, is_active: true, seed_key: seedKeys.category(c.key) },
          { onConflict: 'shop_id,seed_key', ignoreDuplicates: true },
        )
        .select('id, seed_key'),
      `Категория ${c.key}`,
    );
    for (const r of row) if (r.seed_key) categoryIdByKey.set(r.seed_key, r.id);
  }

  // ---- products + images ---------------------------------------------------
  const productIdByKey = new Map<string, string>();
  const untouchedProducts = new Set<string>();
  let attachedImages = 0;
  for (const r of prodRows) {
    if (!r.seed_key) continue;
    productIdByKey.set(r.seed_key, r.id);
    if (r.created_at === r.updated_at) untouchedProducts.add(r.seed_key);
  }

  for (const [index, p] of cfg.initialProducts.entries()) {
    const key = seedKeys.product(p.key);
    if (plan.products.some((x) => x.product === p)) {
      const categoryId = categoryIdByKey.get(seedKeys.category(p.category));
      if (!categoryId) throw new Error(`Нет категории ${p.category} для ${p.key}`);
      const rows = must(
        await db
          .from('products')
          .upsert(
            {
              shop_id: shopId,
              category_id: categoryId,
              name: p.name,
              description: p.description,
              base_price_minor: p.priceMinor,
              is_published: p.published,
              is_featured: p.featured,
              sort_order: index,
              seed_key: key,
            },
            { onConflict: 'shop_id,seed_key', ignoreDuplicates: true },
          )
          .select('id'),
        `Товар ${p.key}`,
      );
      if (rows[0]) {
        productIdByKey.set(key, rows[0].id);
        untouchedProducts.add(key);
      }
    }

    // Images are attached only to products that the owner has not edited yet (new or untouched).
    // Each config image is checked by its own seed_key: a previous seed interrupted after image k
    // is resumed from k + 1, already attached images are never duplicated, and products whose
    // photos the owner manages (own images, gaps) are left alone. See planProductImages.
    const productId = productIdByKey.get(key);
    if (!productId || !untouchedProducts.has(key) || p.images.length === 0) continue;
    const existingImages = must(
      await db.from('product_images').select('seed_key').eq('product_id', productId),
      `Фото ${p.key}`,
    );
    const imagePlan = planProductImages(p.key, p.images.length, existingImages.map((r) => ({ seedKey: r.seed_key })));
    if (imagePlan.status === 'owner_managed') {
      log.info(`${p.key}: фото управляются владельцем, seed их не меняет`);
      continue;
    }
    for (const i of imagePlan.attach) {
      const rel = p.images[i]!;
      const storage_path = await uploadAsset(db, slug, shopId, rel);
      const attached = must(
        await db
          .from('product_images')
          .upsert(
            { shop_id: shopId, product_id: productId, storage_path, sort_order: i, is_primary: i === 0, alt_text: p.name, seed_key: seedKeys.image(p.key, i) },
            { onConflict: 'shop_id,seed_key', ignoreDuplicates: true },
          )
          .select('id'),
        `Фото ${rel}`,
      );
      attachedImages += attached.length;
    }
  }

  // ---- variants ------------------------------------------------------------
  let createdVariants = 0;
  for (const [index, { productKey, variant }] of plan.variants.entries()) {
    const productId = productIdByKey.get(seedKeys.product(productKey));
    if (!productId) throw new Error(`Нет товара ${productKey}`);
    // One price per product: the variant row never gets its own price (see variantSeedRow).
    const row = variantSeedRow({ shopId, productId, productKey }, variant, index);
    const seed_key = row.seed_key;
    const rows = must(
      await db
        .from('product_variants')
        .upsert(row, { onConflict: 'shop_id,seed_key', ignoreDuplicates: true })
        .select('id'),
      `Вариант ${seed_key}`,
    );
    const variantId = rows[0]?.id;
    if (!variantId) continue;
    createdVariants += 1;
    if (variant.stock > 0) {
      must(
        await db
          .from('inventory_movements')
          .upsert(
            { shop_id: shopId, variant_id: variantId, delta: variant.stock, reason: 'seed', operation_key: `seed:${seed_key}` },
            { onConflict: 'shop_id,operation_key', ignoreDuplicates: true },
          )
          .select('id'),
        'Журнал остатков',
      );
    }
  }

  log.ok(
    `Готово: +${plan.categories.length} категорий, +${plan.products.length} товаров, +${createdVariants} вариантов, ` +
      `+${attachedImages} фото; ` +
      `без изменений: ${plan.skipped.categories} кат., ${plan.skipped.products} тов., ${plan.skipped.variants} вар.`,
  );
  if (!existingShop) log.info(`Назначьте владельца: pnpm owner:add --slug ${slug} --email owner@example.com`);
  return 0;
});
