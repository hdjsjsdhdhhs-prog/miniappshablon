// pnpm tenant:verify --slug <slug> [--app-url https://shop.example.com] [--strict]
// Checks: config, DB state, public catalog visibility through the anon key, absence of private
// data for anon, owner membership, image availability and Telegram link readiness.
import { hasFlag, log, parseArgs, requireString, run } from '../lib/cli.ts';
import { anonClient, publicObjectUrl, resolveSupabaseEnv, serviceClient } from '../lib/supabase-env.ts';
import { validateTenant } from '../lib/tenant-fs.ts';

run(async () => {
  const args = parseArgs();
  const slug = requireString(args, 'slug');
  const strict = hasFlag(args, 'strict');
  const appUrl = typeof args.flags['app-url'] === 'string' ? String(args.flags['app-url']).replace(/\/$/, '') : null;
  const failures: string[] = [];
  const warnings: string[] = [];
  const pass = (m: string) => log.ok(m);

  log.step(`Verify ${slug} @ ${resolveSupabaseEnv().url}`);

  const report = validateTenant(slug);
  report.errors.forEach((e) => failures.push(`config: ${e}`));
  report.warnings.forEach((w) => warnings.push(`config: ${w}`));
  if (report.errors.length === 0) pass('shop.config.json валиден');

  const db = serviceClient();
  const { data: shop } = await db.from('shops').select('*').eq('slug', slug).maybeSingle();
  if (!shop) {
    failures.push('магазин отсутствует в БД (выполните tenant:seed)');
  } else {
    pass(`магазин в БД: mode=${shop.mode}, status=${shop.status}, demo=${shop.is_demo}`);
    const anon = anonClient();

    const { data: publicShop } = await anon.from('shops').select('id').eq('slug', slug).maybeSingle();
    if (shop.mode === 'live') {
      if (publicShop) pass('публичная витрина читается анонимно');
      else failures.push('live-магазин не читается анонимно (RLS?)');
      const { data: pubProducts, error } = await anon
        .from('products')
        .select('id, product_images(storage_path, is_primary)')
        .eq('shop_id', shop.id)
        .limit(50);
      if (error) failures.push(`публичный каталог: ${error.message}`);
      else if (!pubProducts.length) failures.push('публичный каталог пуст');
      else pass(`публичный каталог: ${pubProducts.length} товаров`);

      const paths = [
        shop.logo_path,
        ...(pubProducts ?? []).flatMap((p) => p.product_images.map((i) => i.storage_path)),
      ].filter((p): p is string => !!p).slice(0, 20);
      let broken = 0;
      for (const p of paths) {
        const res = await fetch(publicObjectUrl(p), { method: 'HEAD' });
        if (!res.ok) broken += 1;
      }
      if (broken) failures.push(`недоступно изображений: ${broken} из ${paths.length}`);
      else pass(`изображения доступны (${paths.length} проверено)`);
    } else {
      if (publicShop) failures.push('preview-магазин виден анонимно!');
      else pass('preview-магазин скрыт от анонимных пользователей');
      warnings.push('магазин в preview: публикация — pnpm tenant:publish --slug ' + slug + ' --yes');
    }

    // anon must never see private data
    for (const table of ['orders', 'order_items', 'shop_memberships', 'inventory_movements'] as const) {
      const { data, error } = await anon.from(table).select('id').limit(1);
      if (!error && data && data.length > 0) failures.push(`anon читает ${table}!`);
    }
    pass('anon не читает orders / order_items / shop_memberships / inventory_movements');

    const { count: owners } = await db.from('shop_memberships').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id);
    if (owners) pass(`владельцев: ${owners}`);
    else failures.push(`нет владельца (pnpm owner:add --slug ${slug} --email ...)`);

    const tg = (shop.telegram ?? {}) as { botUsername?: string | null; miniAppShortName?: string | null };
    if (tg.botUsername && tg.miniAppShortName) {
      pass(`Telegram deep link: https://t.me/${tg.botUsername}/${tg.miniAppShortName}?startapp=${slug}`);
    } else {
      warnings.push('Telegram: botUsername/miniAppShortName не заданы — ссылка t.me не сформирована');
    }

    if (appUrl) {
      for (const path of [`/s/${slug}/`, `/s/${slug}/catalog`, `/admin`]) {
        const res = await fetch(`${appUrl}${path}`);
        if (res.ok) pass(`${appUrl}${path} → ${res.status}`);
        else failures.push(`${appUrl}${path} → ${res.status} (SPA fallback?)`);
      }
    } else {
      warnings.push('--app-url не задан: доступность опубликованного frontend не проверялась');
    }
  }

  warnings.forEach((w) => log.warn(w));
  failures.forEach((f) => log.err(f));
  if (failures.length || (strict && warnings.length)) {
    log.err(`Проверка не пройдена: ${failures.length} ошибок, ${warnings.length} предупреждений`);
    return 1;
  }
  log.ok(`Проверка пройдена (${warnings.length} предупреждений)`);
  return 0;
});
