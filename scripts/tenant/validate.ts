// pnpm tenant:validate --slug <slug>
// Validates shop.config.json (Zod schema, slug, colors, contrast, references) and source images.
import { log, parseArgs, requireString, run } from '../lib/cli.ts';
import { validateTenant } from '../lib/tenant-fs.ts';

run(async () => {
  const slug = requireString(parseArgs(), 'slug');
  log.step(`Проверка tenant "${slug}"`);
  const report = validateTenant(slug);
  report.warnings.forEach((w) => log.warn(w));
  report.errors.forEach((e) => log.err(e));
  if (report.errors.length > 0) {
    log.err(`Ошибок: ${report.errors.length}`);
    return 1;
  }
  const c = report.config!;
  log.ok(
    `Конфиг корректен: ${c.initialCategories.length} категорий, ${c.initialProducts.length} товаров, ` +
      `${c.initialProducts.reduce((n, p) => n + p.variants.length, 0)} вариантов`,
  );
  return 0;
});
