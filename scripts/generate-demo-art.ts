// pnpm tsx scripts/generate-demo-art.ts --slug <slug>
// Generates deterministic, clearly synthetic artwork for DEMO tenants (no real product photos).
// Every asset path referenced by shop.config.json that does not exist yet is rendered from the
// tenant palette. Existing files are never overwritten (use --force to regenerate).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tenantConfigSchema } from '../src/domain/tenant-config.ts';
import { hasFlag, log, parseArgs, requireString, run } from './lib/cli.ts';
import { Canvas, hexToRgb, mix, type RGB } from './lib/png.ts';
import { configPath, tenantDir } from './lib/tenant-fs.ts';

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

type Shape = 'bottle' | 'pod' | 'cartridge' | 'box';

function shapeFor(categoryKey: string): Shape {
  if (/liquid|juice|salt/.test(categoryKey)) return 'bottle';
  if (/pod|device|kit/.test(categoryKey)) return 'pod';
  if (/cart|coil|consum/.test(categoryKey)) return 'cartridge';
  return 'box';
}

function background(c: Canvas, top: RGB, bottom: RGB): void {
  c.fill((x, y) => {
    const t = y / c.height;
    const glow = Math.max(0, 1 - Math.hypot(x - c.width * 0.5, y - c.height * 0.42) / (c.width * 0.6));
    return mix(mix(top, bottom, t), [255, 255, 255], glow * 0.06);
  });
}

function product(size: number, shape: Shape, tint: RGB, bgTop: RGB, bgBottom: RGB, variant: number): Canvas {
  const c = new Canvas(size, size);
  background(c, bgTop, bgBottom);
  const cx = size / 2;
  const cy = size / 2 + size * 0.02;
  // soft shadow
  c.roundRect(cx, size * 0.86, size * 0.42, size * 0.05, size * 0.025, () => [0, 0, 0], 0.25);
  const body = (x: number, _y: number) => {
    const t = (x - (cx - size * 0.2)) / (size * 0.4);
    return mix(mix(tint, [255, 255, 255], 0.25), mix(tint, [0, 0, 0], 0.35), Math.min(1, Math.max(0, t)));
  };
  const dark = mix(tint, [0, 0, 0], 0.6);
  if (shape === 'bottle') {
    c.roundRect(cx, cy + size * 0.08, size * 0.34, size * 0.5, size * 0.05, body);
    c.roundRect(cx, cy - size * 0.21, size * 0.14, size * 0.1, size * 0.02, () => dark);
    c.roundRect(cx, cy - size * 0.29, size * 0.06, size * 0.08, size * 0.02, () => dark);
    c.roundRect(cx, cy + size * 0.1, size * 0.26, size * 0.18, size * 0.02, () => [250, 250, 250], 0.9);
    c.roundRect(cx, cy + size * 0.07, size * 0.16, size * 0.025, size * 0.01, () => dark, 0.9);
    c.roundRect(cx, cy + size * 0.12, size * 0.1, size * 0.015, size * 0.007, () => tint, 0.9);
  } else if (shape === 'pod') {
    c.roundRect(cx, cy, size * 0.24, size * 0.6, size * 0.11, body);
    c.roundRect(cx, cy - size * 0.33, size * 0.12, size * 0.08, size * 0.03, () => dark);
    c.circle(cx, cy + size * 0.12, size * 0.025, [255, 255, 255], 0.85);
    c.roundRect(cx, cy - size * 0.12, size * 0.04, size * 0.16, size * 0.02, () => [255, 255, 255], 0.25);
  } else if (shape === 'cartridge') {
    for (let i = 0; i < 3; i += 1) {
      const dx = (i - 1) * size * 0.17;
      c.roundRect(cx + dx, cy, size * 0.13, size * 0.4, size * 0.04, body);
      c.roundRect(cx + dx, cy - size * 0.24, size * 0.06, size * 0.08, size * 0.02, () => dark);
      c.roundRect(cx + dx, cy + size * 0.05, size * 0.07, size * 0.15, size * 0.02, () => [255, 255, 255], 0.35);
    }
  } else {
    c.roundRect(cx, cy, size * 0.46, size * 0.36, size * 0.04, body);
    c.roundRect(cx, cy - size * 0.18, size * 0.46, size * 0.04, size * 0.02, () => dark);
    c.ring(cx, cy + size * 0.02, size * 0.08, size * 0.02, [255, 255, 255], 0.8);
  }
  // variant accent dots
  for (let i = 0; i <= variant % 3; i += 1) c.circle(size * 0.12 + i * size * 0.05, size * 0.12, size * 0.014, tint, 0.9);
  return c;
}

function logo(size: number, primary: RGB, fg: RGB, bg: RGB, seed: number): Canvas {
  const c = new Canvas(size, size);
  c.fill(() => bg);
  c.roundRect(size / 2, size / 2, size * 0.92, size * 0.92, size * 0.24, (x, y) => mix(primary, mix(primary, [0, 0, 0], 0.35), (x + y) / (2 * size)));
  c.ring(size / 2, size / 2, size * 0.28, size * 0.06, fg, 0.95);
  const n = 3 + (seed % 3);
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    c.circle(size / 2 + Math.cos(a) * size * 0.14, size / 2 + Math.sin(a) * size * 0.14, size * 0.04, fg, 0.95);
  }
  return c;
}

function cover(w: number, h: number, a: RGB, b: RGB, accent: RGB): Canvas {
  const c = new Canvas(w, h);
  c.fill((x, y) => mix(a, b, (x / w) * 0.7 + (y / h) * 0.3));
  for (let i = 0; i < 6; i += 1) {
    c.circle(w * (0.15 + i * 0.15), h * (0.3 + 0.4 * ((i * 37) % 10) / 10), h * (0.12 + (i % 3) * 0.06), accent, 0.12);
  }
  return c;
}

run(async () => {
  const args = parseArgs();
  const slug = requireString(args, 'slug');
  const force = hasFlag(args, 'force');
  const cfg = tenantConfigSchema.parse(JSON.parse(readFileSync(configPath(slug), 'utf8')));
  if (!cfg.demo) log.warn('Tenant не помечен demo=true — синтетические изображения предназначены только для демо');
  const t = cfg.theme;
  const [bg, card, primary, muted] = [t.background, t.card, t.primary, t.muted].map(hexToRgb) as RGB[];
  const out = (rel: string, canvas: Canvas) => {
    const abs = join(tenantDir(slug), rel);
    if (existsSync(abs) && !force) return;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, canvas.png());
    log.ok(`${rel}`);
  };

  if (cfg.logo) out(cfg.logo, logo(256, primary!, t.mode === 'dark' ? [20, 20, 20] : [255, 255, 255], bg!, hash(slug)));
  if (cfg.cover) out(cfg.cover, cover(1200, 520, card!, bg!, primary!));
  for (const cat of cfg.initialCategories) {
    if (cat.image) out(cat.image, product(320, shapeFor(cat.key), primary!, card!, muted!, 0));
  }
  for (const p of cfg.initialProducts) {
    const h = hash(p.key);
    p.images.forEach((rel, i) => {
      const tint = mix(hsl(h % 360, 0.55, 0.55), primary!, 0.35);
      out(rel, product(640, shapeFor(p.category), tint, card!, t.mode === 'dark' ? bg! : muted!, i + h));
    });
  }
  return 0;
});
