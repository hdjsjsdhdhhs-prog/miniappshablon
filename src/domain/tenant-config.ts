import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from './money';
import { normalizeTelegramChannelUrl } from './telegram-link';
import { themeSchema } from './theme';

/**
 * Schema of tenants/<slug>/shop.config.json — the INPUT of the tenant pipeline.
 * After the first seed, Supabase is the runtime source of truth; re-seeding never overwrites
 * values the owner changed in the admin panel.
 */

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const assetPath = z
  .string()
  .regex(/^assets\/[A-Za-z0-9._/-]+\.(png|jpe?g|webp)$/i, 'Путь вида assets/<file>.png|jpg|webp')
  .refine((p) => !p.includes('..'), 'Путь не должен выходить за пределы папки tenant');

/** Keys that must never appear in a public config (secrets belong to server environments). */
export const FORBIDDEN_CONFIG_KEYS = [
  'serviceRole',
  'service_role',
  'serviceRoleKey',
  'botToken',
  'bot_token',
  'password',
  'secret',
  'apiKey',
  'anonKey',
  'supabaseKey',
];

export const variantConfigSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  flavor: z.string().trim().min(1).max(60).nullable().default(null),
  color: z.string().trim().min(1).max(60).nullable().default(null),
  sku: z.string().trim().min(1).max(64).nullable().default(null),
  // A product has ONE price (product `priceMinor`) for every flavor/color. A variant must not have the field at
  // all — any value, null included, is rejected — so a per-variant price can never come back through a config.
  priceMinor: z.never({ error: 'Цена задаётся одна на товар (priceMinor товара), у вариантов поля priceMinor быть не должно' }).optional(),
  stock: z.number().int().min(0).max(1_000_000),
});

export const productConfigSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  category: z.string().regex(KEY_RE),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  priceMinor: z.number().int().min(0),
  published: z.boolean().default(true),
  featured: z.boolean().default(false),
  images: z.array(assetPath).max(10).default([]),
  variants: z.array(variantConfigSchema).min(1).max(100),
});

export const categoryConfigSchema = z.strictObject({
  key: z.string().regex(KEY_RE),
  name: z.string().trim().min(1).max(60),
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/),
  image: assetPath.nullable().default(null),
});

export const shopInformationSchema = z.strictObject({
  address: z.string().max(300).default(''),
  hours: z.string().max(200).default(''),
  delivery: z.string().max(1000).default(''),
  payment: z.string().max(1000).default(''),
  phone: z.string().max(32).default(''),
  telegram: z.string().max(64).default(''),
  // Header button "Наш канал в Телеграме". Stored as typed; validated/normalized by
  // normalizeTelegramChannelUrl (admin on save, storefront before rendering). Empty URL = no button.
  telegramChannelUrl: z.string().max(200).default(''),
  telegramChannelLabel: z.string().max(60).default(''),
});

export const shopSettingsSchema = z.strictObject({
  showFeatured: z.boolean().default(true),
  showInfo: z.boolean().default(true),
  showCategories: z.boolean().default(true),
});

/** How a buyer receives the order. At least one method must stay enabled for checkout to work. */
export const fulfillmentConfigSchema = z.strictObject({
  delivery: z.boolean().default(true),
  pickup: z.boolean().default(true),
  pickupInstructions: z.string().max(1000).default(''),
});

export const tenantConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    slug: z.string().regex(SLUG_RE, 'slug: 3–40 символов a-z, 0-9, дефис'),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(500).default(''),
    logo: assetPath.nullable(),
    cover: assetPath.nullable().default(null),
    theme: themeSchema,
    currency: z.enum(SUPPORTED_CURRENCIES),
    demo: z.boolean().default(false),
    ageRestriction: z.number().int().min(0).max(21),
    shopInformation: shopInformationSchema,
    fulfillment: fulfillmentConfigSchema.default({ delivery: true, pickup: true, pickupInstructions: '' }),
    settings: shopSettingsSchema.default({ showFeatured: true, showInfo: true, showCategories: true }),
    telegram: z
      .strictObject({
        botUsername: z.string().regex(/^[A-Za-z0-9_]{5,32}$/).nullable().default(null),
        miniAppShortName: z.string().regex(/^[A-Za-z0-9_]{3,30}$/).nullable().default(null),
      })
      .default({ botUsername: null, miniAppShortName: null }),
    initialCategories: z.array(categoryConfigSchema).min(1).max(50),
    initialProducts: z.array(productConfigSchema).max(500).default([]),
  })
  .superRefine((cfg, ctx) => {
    if (!cfg.fulfillment.delivery && !cfg.fulfillment.pickup) {
      ctx.addIssue({ code: 'custom', message: 'Включите хотя бы один способ получения: доставку или самовывоз', path: ['fulfillment'] });
    }
    const channel = cfg.shopInformation.telegramChannelUrl;
    if (channel.trim() && !normalizeTelegramChannelUrl(channel)) {
      ctx.addIssue({ code: 'custom', message: 'Ссылка на канал: https://t.me/<канал> или https://t.me/+<приглашение>', path: ['shopInformation', 'telegramChannelUrl'] });
    }
    const catKeys = new Set<string>();
    cfg.initialCategories.forEach((c, i) => {
      if (catKeys.has(c.key)) ctx.addIssue({ code: 'custom', message: `Повтор key категории ${c.key}`, path: ['initialCategories', i, 'key'] });
      catKeys.add(c.key);
    });
    const slugs = new Set<string>();
    cfg.initialCategories.forEach((c, i) => {
      if (slugs.has(c.slug)) ctx.addIssue({ code: 'custom', message: `Повтор slug категории ${c.slug}`, path: ['initialCategories', i, 'slug'] });
      slugs.add(c.slug);
    });
    const productKeys = new Set<string>();
    const variantKeys = new Set<string>();
    cfg.initialProducts.forEach((p, i) => {
      if (productKeys.has(p.key)) ctx.addIssue({ code: 'custom', message: `Повтор key товара ${p.key}`, path: ['initialProducts', i, 'key'] });
      productKeys.add(p.key);
      if (!catKeys.has(p.category)) {
        ctx.addIssue({ code: 'custom', message: `Неизвестная категория ${p.category}`, path: ['initialProducts', i, 'category'] });
      }
      const combos = new Set<string>();
      p.variants.forEach((v, j) => {
        const vk = `${p.key}/${v.key}`;
        if (variantKeys.has(vk)) ctx.addIssue({ code: 'custom', message: `Повтор key варианта ${vk}`, path: ['initialProducts', i, 'variants', j, 'key'] });
        variantKeys.add(vk);
        const combo = `${v.flavor ?? ''}|${v.color ?? ''}`.toLowerCase();
        if (combos.has(combo)) ctx.addIssue({ code: 'custom', message: `Повтор сочетания вкус/цвет в ${p.key}`, path: ['initialProducts', i, 'variants', j] });
        combos.add(combo);
      });
    });
  });

export type TenantConfig = z.infer<typeof tenantConfigSchema>;
export type TenantConfigInput = z.input<typeof tenantConfigSchema>;

/** Recursively looks for keys that look like secrets. Returns JSON paths of offenders. */
export function findForbiddenKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => findForbiddenKeys(v, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const here = `${path}.${k}`;
      const bad = FORBIDDEN_CONFIG_KEYS.some((f) => k.toLowerCase() === f.toLowerCase());
      return [...(bad ? [here] : []), ...findForbiddenKeys(v, here)];
    });
  }
  return [];
}

/** Seed keys used for idempotent import (namespaced by entity). */
export const seedKeys = {
  category: (key: string) => `cat:${key}`,
  product: (key: string) => `prod:${key}`,
  variant: (productKey: string, variantKey: string) => `var:${productKey}/${variantKey}`,
  image: (productKey: string, index: number) => `img:${productKey}/${index}`,
};
