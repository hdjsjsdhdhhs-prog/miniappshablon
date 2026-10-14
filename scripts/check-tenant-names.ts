// pnpm check:tenant-names
// Tenant-specific names/slugs must live in tenants/ and the DB, never in src/ (one shared build).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log, run } from './lib/cli.ts';
import { ROOT, TENANTS_DIR } from './lib/tenant-fs.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

run(async () => {
  const needles: string[] = [];
  for (const slug of readdirSync(TENANTS_DIR)) {
    const cfgPath = join(TENANTS_DIR, slug, 'shop.config.json');
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { slug: string; name: string; initialProducts?: Array<{ name: string }> };
      needles.push(cfg.slug, cfg.name, ...(cfg.initialProducts ?? []).map((p) => p.name));
    } catch {
      /* not a tenant dir */
    }
  }
  const files = walk(join(ROOT, 'src')).filter((f) => /\.(ts|tsx|css|html)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const hits: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const n of needles) if (n.length >= 4 && text.includes(n)) hits.push(`${f}: "${n}"`);
  }
  if (hits.length) {
    hits.forEach((h) => log.err(h));
    return 1;
  }
  log.ok(`src/ не содержит названий tenants (${needles.length} строк из tenants/ проверено в ${files.length} файлах)`);
  return 0;
});
