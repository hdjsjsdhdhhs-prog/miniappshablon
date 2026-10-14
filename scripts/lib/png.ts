import { deflateSync } from 'node:zlib';

/** Minimal RGBA → PNG encoder (used only to generate demo artwork). */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export class Canvas {
  readonly data: Uint8Array;
  constructor(readonly width: number, readonly height: number) {
    this.data = new Uint8Array(width * height * 4);
  }

  fill(fn: (x: number, y: number) => RGB): void {
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) this.set(x, y, fn(x, y), 1);
    }
  }

  set(x: number, y: number, c: RGB, alpha: number): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const i = (y * this.width + x) * 4;
    const a = Math.min(1, alpha);
    this.data[i] = this.data[i]! * (1 - a) + c[0] * a;
    this.data[i + 1] = this.data[i + 1]! * (1 - a) + c[1] * a;
    this.data[i + 2] = this.data[i + 2]! * (1 - a) + c[2] * a;
    this.data[i + 3] = 255;
  }

  /** Signed-distance rounded rectangle with anti-aliased edge and vertical shading. */
  roundRect(cx: number, cy: number, w: number, h: number, r: number, color: (x: number, y: number) => RGB, alpha = 1): void {
    const x0 = Math.floor(cx - w / 2 - 2);
    const x1 = Math.ceil(cx + w / 2 + 2);
    const y0 = Math.floor(cy - h / 2 - 2);
    const y1 = Math.ceil(cy + h / 2 + 2);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const qx = Math.abs(x - cx) - (w / 2 - r);
        const qy = Math.abs(y - cy) - (h / 2 - r);
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
        const cover = Math.min(1, Math.max(0, 0.5 - d));
        if (cover > 0) this.set(x, y, color(x, y), cover * alpha);
      }
    }
  }

  circle(cx: number, cy: number, radius: number, color: RGB, alpha = 1): void {
    this.roundRect(cx, cy, radius * 2, radius * 2, radius, () => color, alpha);
  }

  ring(cx: number, cy: number, radius: number, thickness: number, color: RGB, alpha = 1): void {
    for (let y = Math.floor(cy - radius - 2); y <= cy + radius + 2; y += 1) {
      for (let x = Math.floor(cx - radius - 2); x <= cx + radius + 2; x += 1) {
        const d = Math.abs(Math.hypot(x - cx, y - cy) - (radius - thickness / 2)) - thickness / 2;
        const cover = Math.min(1, Math.max(0, 0.5 - d));
        if (cover > 0) this.set(x, y, color, cover * alpha);
      }
    }
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}
