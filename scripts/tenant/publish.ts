// pnpm tenant:publish --slug <slug> --yes          -> preview → live (after checks)
// pnpm tenant:publish --slug <slug> --unpublish --yes -> live → preview
import { fail, hasFlag, log, parseArgs, requireString, run } from '../lib/cli.ts';
import { serviceClient } from '../lib/supabase-env.ts';
import { validateTenant } from '../lib/tenant-fs.ts';

run(async () => {
  const args = parseArgs();
  const slug = requireString(args, 'slug');
  const unpublish = hasFlag(args, 'unpublish');
  if (!hasFlag(args, 'yes')) {
    fail(`Публикация — явное действие. Повторите с флагом --yes: pnpm tenant:publish --slug ${slug}${unpublish ? ' --unpublish' : ''} --yes`);
  }
  const db = serviceClient();
  const { data: shop, error } = await db
    .from('shops')
    .select('id, mode, status, name, legal_notice, age_restriction, logo_path, is_demo')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!shop) fail(`Магазин ${slug} не найден. Сначала pnpm tenant:seed --slug ${slug}`);

  if (unpublish) {
    const { error: e } = await db.from('shops').update({ mode: 'preview' }).eq('id', shop.id);
    if (e) throw new Error(e.message);
    log.ok(`${slug}: переведён в preview`);
    return 0;
  }

  log.step(`Предпубликационная проверка ${slug}`);
  const problems: string[] = [];
  const report = validateTenant(slug);
  report.errors.forEach((e) => problems.push(`конфиг: ${e}`));

  if (shop.status !== 'active') problems.push(`status=${shop.status}`);
  if (!shop.legal_notice.trim()) problems.push('нет юридического уведомления (legal_notice)');
  if (shop.age_restriction < 18) problems.push('для вейп-продукции ageRestriction должен быть ≥ 18');
  if (!shop.logo_path) log.warn('нет логотипа');

  const [{ count: cats }, { count: owners }, { data: products, error: pe }] = await Promise.all([
    db.from('categories').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).eq('is_active', true).is('archived_at', null),
    db.from('shop_memberships').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id),
    db
      .from('products')
      .select('id, product_variants(stock_quantity, is_active)')
      .eq('shop_id', shop.id)
      .eq('is_published', true)
      .is('archived_at', null),
  ]);
  if (pe) throw new Error(pe.message);
  if (!cats) problems.push('нет активных категорий');
  if (!owners) problems.push(`нет владельца: pnpm owner:add --slug ${slug} --email ...`);
  const sellable = (products ?? []).filter((p) => p.product_variants.some((v) => v.is_active && v.stock_quantity > 0));
  if (sellable.length === 0) problems.push('нет опубликованных товаров в наличии');

  if (problems.length > 0) {
    problems.forEach((p) => log.err(p));
    log.err('Публикация отменена');
    return 1;
  }

  const { error: ue } = await db
    .from('shops')
    .update({ mode: 'live', published_at: new Date().toISOString() })
    .eq('id', shop.id);
  if (ue) throw new Error(ue.message);
  log.ok(`${slug}: опубликован (mode=live)${shop.is_demo ? ' — DEMO, заказы помечаются тестовыми' : ''}`);
  log.info(`Проверьте: pnpm tenant:verify --slug ${slug}`);
  return 0;
});
