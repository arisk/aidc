import * as fc from 'fast-check';
import { parse, tryParse } from '../../src/ai/index.ts';
import { tryToDigitalLink } from '../../src/digital-link/index.ts';
import { matrixFromRows } from '../../src/symbology/render/index.ts';
import type { ModuleMatrix } from '../../src/symbology/render/index.ts';
import type { DmSize } from '../../src/symbology/matrix/dm-tables.ts';
import { codewordModules, mappingToSymbol } from '../../src/symbology/matrix/dm-place.ts';
import { codewordModules as qrCodewordModules } from '../../src/symbology/matrix/qr-place.ts';
import { type Message, messageArb } from './arbitraries.ts';
import type { Raster } from './symbology.ts';

/**
 * A matrix from vector-file rows (`'X'` dark, `' '` light). `trimQuietZone` drops that many
 * modules from every side first (for matrices stored with their quiet zone).
 */
export function xRowsToMatrix(
  rows: readonly string[],
  options: { trimQuietZone?: number } = {},
): ModuleMatrix {
  const q = options.trimQuietZone ?? 0;
  const kept = rows.slice(q, rows.length - q).map((r) => r.slice(q, r.length - q));
  return matrixFromRows(kept.map((r) => r.replaceAll('X', '1').replaceAll(' ', '0')));
}

/**
 * A QR matrix from vector-file rows (`'X'` dark, `' '` light, no quiet zone), with the 4-module
 * quiet zone `buildSymbol` reports, so the two compare with `toEqual`.
 */
export function qrRowsToMatrix(rows: readonly string[]): ModuleMatrix {
  return { ...xRowsToMatrix(rows), quietZone: { left: 4, right: 4, top: 4, bottom: 4 } };
}

/** The modules of a matrix, row-major, 1 dark. */
export function matrixBits(m: ModuleMatrix): Uint8Array {
  return Uint8Array.from(m.rows.join(''), (c) => (c === '1' ? 1 : 0));
}

/**
 * Paints a matrix into an RGBA image, `px` pixels per module, white background, with `qz` light
 * modules on every side.
 */
export function rasteriseMatrix(m: ModuleMatrix, px = 4, qz = 2): Raster {
  const width = (m.width + 2 * qz) * px;
  const height = (m.height + 2 * qz) * px;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  m.rows.forEach((row, my) => {
    for (let mx = 0; mx < row.length; mx++) {
      if (row[mx] !== '1') continue;
      for (let y = (my + qz) * px; y < (my + qz + 1) * px; y++)
        for (let x = (mx + qz) * px; x < (mx + qz + 1) * px; x++) {
          const i = (y * width + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
        }
    }
  });
  return { data, width, height, colorSpace: 'srgb' };
}

/**
 * A copy of a canonical-orientation symbol of `size` with codeword `codeword` (symbol order,
 * interleaved) XORed with `xor`, for every entry of `plan`.
 */
export function damageCodewords(
  m: ModuleMatrix,
  size: DmSize,
  plan: readonly { codeword: number; xor: number }[],
): ModuleMatrix {
  const xors = new Map<number, number>();
  for (const p of plan) xors.set(p.codeword, (xors.get(p.codeword) ?? 0) ^ p.xor);
  const grid = m.rows.map((r) => r.split(''));
  const map = codewordModules(size);
  for (let i = 0; i < map.length; i++) {
    const v = map[i] ?? -1;
    if (v < 0) continue;
    const mask = 0x80 >> (v & 7);
    if (((xors.get(v >> 3) ?? 0) & mask) === 0) continue;
    const { x, y } = mappingToSymbol(size, i);
    const row = grid[y];
    if (row) row[x] = row[x] === '1' ? '0' : '1';
  }
  return matrixFromRows(grid.map((r) => r.join('')));
}

/**
 * A copy of a canonical-orientation QR symbol of `version` with interleaved codeword `codeword`
 * XORed with `xor`, for every entry of `plan` (the mask does not matter: a flipped module flips
 * the bit read back).
 */
export function damageQrCodewords(
  m: ModuleMatrix,
  version: number,
  plan: readonly { codeword: number; xor: number }[],
): ModuleMatrix {
  const xors = new Map<number, number>();
  for (const p of plan) xors.set(p.codeword, (xors.get(p.codeword) ?? 0) ^ p.xor);
  const grid = m.rows.map((r) => r.split(''));
  const modules = qrCodewordModules(version);
  for (const [codeword, xor] of xors) {
    for (let bit = 0; bit < 8; bit++) {
      if ((xor & (0x80 >> bit)) === 0) continue;
      const i = modules[codeword * 8 + bit];
      if (i === undefined) throw new RangeError(`codeword ${codeword} out of range`);
      const row = grid[Math.floor(i / m.width)];
      const x = i % m.width;
      if (row) row[x] = row[x] === '1' ? '0' : '1';
    }
  }
  return { ...matrixFromRows(grid.map((r) => r.join(''))), quietZone: m.quietZone };
}

/** `(AI)value` form of a message, with `(` in values escaped. */
export const toBracketed = (m: Message): string =>
  m.map(([a, v]) => `(${a})${v.replaceAll('(', '\\(')}`).join('');

/** Messages that parse without the association rules (what GS1 DataMatrix accepts). */
export const gs1MessageArb: fc.Arbitrary<Message> = messageArb.filter(
  (m) => tryParse(toBracketed(m), { validateAssociations: false }).ok,
);

/**
 * GS1 Digital Link URIs built from the association-valid messages of `messages` (as `uriArb` in
 * the DL oracle).
 */
export const dlUriArbOf = (messages: fc.Arbitrary<Message>): fc.Arbitrary<string> =>
  messages
    .filter((m) => tryParse(toBracketed(m)).ok)
    .map((m) => tryToDigitalLink(parse(toBracketed(m)), { domain: 'https://example.com' }))
    .filter((r) => r.ok)
    .map((r) => (r.ok ? r.value : ''));

/** GS1 Digital Link URIs built from association-valid messages. */
export const dlUriArb: fc.Arbitrary<string> = dlUriArbOf(messageArb);

/** The matrix part of bwip-js `raw` output: `pixs` row-major, 1 dark. */
export interface BwipMatrixRaw {
  readonly pixs: readonly number[];
  readonly pixx: number;
  readonly pixy: number;
}

/** A bwip-js `raw` result as a ModuleMatrix (oracle tests import bwip-js themselves). */
export function bwipRawToMatrix(r: BwipMatrixRaw): ModuleMatrix {
  const rows: string[] = [];
  for (let y = 0; y < r.pixy; y++) rows.push(r.pixs.slice(y * r.pixx, (y + 1) * r.pixx).join(''));
  return matrixFromRows(rows);
}

/** A one-channel module grid (zxing-wasm `symbol`: 0 dark, 255 light) as a ModuleMatrix. */
export function symbolToMatrix(s: {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}): ModuleMatrix {
  const rows: string[] = [];
  for (let y = 0; y < s.height; y++) {
    let row = '';
    for (let x = 0; x < s.width; x++) row += (s.data[y * s.width + x] ?? 255) < 128 ? '1' : '0';
    rows.push(row);
  }
  return matrixFromRows(rows);
}
