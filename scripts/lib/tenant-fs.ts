import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_SETTINGS } from '../../src/config/images.ts';
import {
  SLUG_RE,
  findForbiddenKeys,
  tenantConfigSchema,
  type TenantConfig,
} from '../../src/domain/tenant-config.ts';
import { themeContrastIssues } from '../../src/domain/theme.ts';
import { fail } from './cli.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TENANTS_DIR = join(ROOT, 'tenants');

export function assertSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) fail(`Некорректный slug "${slug}": 3–40 символов a-z, 0-9, дефис, без дефиса по краям`);
}

export function tenantDir(slug: string): string {
  assertSlug(slug);
  return join(TENANTS_DIR, slug);
}

export function configPath(slug: string): string {
  return join(tenantDir(slug), 'shop.config.json');
}

export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  width: number;
  height: number;
  bytes: number;
}

/** Reads dimensions from PNG/JPEG/WebP headers without extra dependencies. */
export function readImageInfo(buf: Buffer): ImageInfo | null {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length - 9) {
      if (buf[o] !== 0xff) return null;
      const marker = buf[o + 1]!;
      const len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { mime: 'image/jpeg', height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7), bytes: buf.length };
      }
      o += 2 + len;
    }
    return null;
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return { mime: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), bytes: buf.length };
    }
    if (chunk === 'VP8 ') {
      return { mime: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, bytes: buf.length };
    }
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { mime: 'image/webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, bytes: buf.length };
    }
  }
  return null;
}

export interface LoadedAsset {
  relPath: string;
  absPath: string;
  buffer: Buffer;
  info: ImageInfo;
  sha256: string;
}

export function loadAsset(slug: string, relPath: string): LoadedAsset {
  const absPath = join(tenantDir(slug), relPath);
  const buffer = readFileSync(absPath);
  const info = readImageInfo(buffer);
  if (!info) fail(`${relPath}: не PNG/JPEG/WebP`);
  return { relPath, absPath, buffer, info, sha256: createHash('sha256').update(buffer).digest('hex') };
}

export interface ValidationReport {
  config: TenantConfig | null;
  errors: string[];
  warnings: string[];
}

/** Full validation used by tenant:validate and as a precondition of seed/publish/verify. */
export function validateTenant(slug: string): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const path = configPath(slug);
  if (!existsSync(path)) return { config: null, errors: [`Нет файла ${path}`], warnings };

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { config: null, errors: [`shop.config.json: невалидный JSON (${(e as Error).message})`], warnings };
  }

  for (const p of findForbiddenKeys(raw)) errors.push(`${p}: секреты запрещены в публичном конфиге`);

  const parsed = tenantConfigSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push(`${issue.path.join('.') || '$'}: ${issue.message}`);
    return { config: null, errors, warnings };
  }
  const config = parsed.data;
  if (config.slug !== slug) errors.push(`slug в конфиге (${config.slug}) не совпадает с папкой (${slug})`);

  for (const issue of themeContrastIssues(config.theme)) {
    warnings.push(
      `theme: низкий контраст ${issue.pair[0]}/${issue.pair[1]} = ${issue.ratio.toFixed(2)} (нужно ≥ ${issue.required})`,
    );
  }

  const assets = new Set<string>();
  if (config.logo) assets.add(config.logo);
  else warnings.push('logo не задан: витрина покажет монограмму');
  if (config.cover) assets.add(config.cover);
  config.initialCategories.forEach((c) => c.image && assets.add(c.image));
  config.initialProducts.forEach((p) => p.images.forEach((i) => assets.add(i)));

  for (const rel of assets) {
    const abs = join(tenantDir(slug), rel);
    if (!existsSync(abs)) {
      errors.push(`${rel}: файл не найден`);
      continue;
    }
    const size = statSync(abs).size;
    if (size > IMAGE_SETTINGS.maxUploadBytes) {
      errors.push(`${rel}: ${(size / 1024 / 1024).toFixed(1)} МБ > лимита ${IMAGE_SETTINGS.maxUploadBytes / 1024 / 1024} МБ`);
      continue;
    }
    const info = readImageInfo(readFileSync(abs));
    if (!info) {
      errors.push(`${rel}: не PNG/JPEG/WebP`);
      continue;
    }
    if (Math.min(info.width, info.height) < IMAGE_SETTINGS.minDimension) {
      errors.push(`${rel}: ${info.width}×${info.height} меньше ${IMAGE_SETTINGS.minDimension}px`);
    }
  }

  if (config.initialProducts.length === 0) warnings.push('initialProducts пуст: товары нужно будет добавить в админке');
  for (const p of config.initialProducts) {
    if (p.images.length === 0) warnings.push(`${p.key}: нет фото (будет плейсхолдер)`);
  }
  if (!config.telegram.botUsername || !config.telegram.miniAppShortName) {
    warnings.push('telegram.botUsername / miniAppShortName не заданы: deep link t.me/... не будет сформирован');
  }

  return { config: errors.length === 0 ? config : null, errors, warnings };
}

export function mimeForPath(p: string): string {
  if (/\.png$/i.test(p)) return 'image/png';
  if (/\.webp$/i.test(p)) return 'image/webp';
  return 'image/jpeg';
}
