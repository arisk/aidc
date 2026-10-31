import * as fc from 'fast-check';
import { checkDigit } from '../../src/core/index.ts';
import type { LinearPattern } from '../../src/symbology/render/index.ts';
import { isCanonicalUpce, upceExpand } from '../../src/symbology/linear/upce.ts';

/** One string per row, one character per module (`X` dark, space light), `width` characters. */
export function patternToBitmap(p: LinearPattern): string[] {
  return p.rows.map((row) => {
    const cells: string[] = Array.from({ length: Math.ceil(p.width) }, () => ' ');
    let x = row.x;
    row.widths.forEach((w, i) => {
      if (i % 2 === 0) for (let k = 0; k < w; k++) cells[Math.round(x + k)] = 'X';
      x += w;
    });
    return cells.join('');
  });
}

const digit = fc.integer({ min: 0, max: 9 }).map(String);

/** A valid GTIN of `n` digits (n - 1 random digits plus the check digit). */
export function gtinArb(n: 8 | 12 | 13 | 14): fc.Arbitrary<string> {
  return fc
    .array(digit, { minLength: n - 1, maxLength: n - 1 })
    .map((ds) => ds.join(''))
    .map((body) => body + checkDigit(body));
}

/** A GTIN-12 that zero-suppresses to a canonical UPC-E body. */
export const upceGtinArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999_999 })
  .map((n) => n.toString().padStart(6, '0'))
  .filter(isCanonicalUpce)
  .map((body) => upceExpand(body));

/** A 2 or 5 digit add-on. */
export const addOnArb: fc.Arbitrary<string> = fc
  .constantFrom(2, 5)
  .chain((n) => fc.array(digit, { minLength: n, maxLength: n }).map((ds) => ds.join('')));

/** An RGBA image (the shape zxing-wasm's `readBarcodes` accepts as `ImageData`). */
export interface Raster {
  readonly data: Uint8ClampedArray<ArrayBuffer>;
  readonly width: number;
  readonly height: number;
  readonly colorSpace: 'srgb';
}

/**
 * Paints a pattern's rows and bearer into an RGBA image, `px` pixels per module, white background.
 * The layout is the SVG renderer's: light modules around the content box, then the bearer (top and
 * bottom bars, plus the sides for a frame), then the same light margin outside it. `qz` is the light
 * margin in modules on every side, or `'pattern'` for the pattern's own minimum quiet zones (left and
 * right; top and bottom at least 1 module).
 */
export function rasterise(p: LinearPattern, px = 3, qz: number | 'pattern' = 10): Raster {
  const q =
    qz === 'pattern'
      ? {
          left: p.quietZone.left,
          right: p.quietZone.right,
          top: Math.max(1, p.quietZone.top),
          bottom: Math.max(1, p.quietZone.bottom),
        }
      : { left: qz, right: qz, top: qz, bottom: qz };
  const bw = p.bearer?.width ?? 0;
  const side = p.bearer?.sides === 'frame' ? bw : 0;
  const ox = 2 * q.left + side;
  const oy = 2 * q.top + bw;
  const width = Math.round((ox + p.width + 2 * q.right + side) * px);
  const height = Math.round((oy + p.height + 2 * q.bottom + bw) * px);
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const dark = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = Math.round(y0 * px); y < Math.round(y1 * px); y++)
      for (let x = Math.round(x0 * px); x < Math.round(x1 * px); x++) {
        const i = (y * width + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
      }
  };
  for (const row of p.rows) {
    let x = ox + row.x;
    row.widths.forEach((w, i) => {
      if (i % 2 === 0 && w > 0) dark(x, oy + row.y, x + w, oy + row.y + row.height);
      x += w;
    });
  }
  if (bw > 0) {
    const l = q.left;
    const t = q.top;
    const r = ox + p.width + q.right + side;
    const b = oy + p.height + q.bottom + bw;
    dark(l, t, r, t + bw);
    dark(l, b - bw, r, b);
    if (side > 0) {
      dark(l, t, l + bw, b);
      dark(r - bw, t, r, b);
    }
  }
  return { data, width, height, colorSpace: 'srgb' };
}

/** Loads the zxing-wasm reader from the installed package (never the CDN). Node only. */
export async function initZxingNode(): Promise<void> {
  const { readFileSync } = await import('node:fs');
  const { createRequire } = await import('node:module');
  const { prepareZXingModule } = await import('zxing-wasm/reader');
  const wasm = readFileSync(
    createRequire(import.meta.url).resolve('zxing-wasm/reader/zxing_reader.wasm'),
  );
  await prepareZXingModule({
    overrides: {
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    },
    fireImmediately: true,
  });
}
