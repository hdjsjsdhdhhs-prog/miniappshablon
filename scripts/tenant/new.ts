// pnpm tenant:new --slug <slug> [--name "Shop name"] [--force]
// Creates tenants/<slug>/ with a template shop.config.json and an assets/ folder.
// Never overwrites an existing tenant unless --force is given.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DARK_PREMIUM_THEME } from '../../src/domain/theme.ts';
import type { TenantConfigInput } from '../../src/domain/tenant-config.ts';
import { fail, hasFlag, log, parseArgs, requireString, run } from '../lib/cli.ts';
import { configPath, tenantDir } from '../lib/tenant-fs.ts';

run(async () => {
  const args = parseArgs();
  const slug = requireString(args, 'slug');
  const dir = tenantDir(slug);
  const name = typeof args.flags.name === 'string' ? args.flags.name : 'Новый магазин';

  if (existsSync(configPath(slug)) && !hasFlag(args, 'force')) {
    fail(`tenants/${slug}/shop.config.json уже существует. Используйте --force для перезаписи шаблона.`);
  }

  mkdirSync(join(dir, 'assets'), { recursive: true });

  const template: TenantConfigInput = {
    slug,
    name,
    description: 'Короткое описание магазина',
    logo: null,
    cover: null,
    theme: DARK_PREMIUM_THEME,
    currency: 'RUB',
    demo: false,
    ageRestriction: 18,
    legalNotice:
      'Продажа никотинсодержащей продукции лицам младше 18 лет запрещена. Заказ подтверждается магазином; оплата и получение согласуются отдельно.',
    shopInformation: { address: '', hours: '', delivery: '', payment: '', phone: '', telegram: '' },
    settings: { showFeatured: true, showInfo: true, showCategories: true },
    telegram: { botUsername: null, miniAppShortName: null },
    initialCategories: [{ key: 'main', name: 'Каталог', slug: 'main', image: null }],
    initialProducts: [],
  };

  writeFileSync(configPath(slug), `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  writeFileSync(join(dir, 'assets', '.gitkeep'), '');
  log.ok(`Создан tenants/${slug}/shop.config.json`);
  log.info('Дальше: положите logo в assets/, заполните конфиг и выполните');
  log.info(`pnpm tenant:validate --slug ${slug}`);
});
