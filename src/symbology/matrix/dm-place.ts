import { byteAt, DM_POLY, gf256 } from '../../core/gf256.ts';
import { rsEncode } from '../../core/reed-solomon.ts';
import { freezeMatrix, symbolError } from '../render/internal.ts';
import type { ModuleMatrix } from '../render/index.ts';
import { type DmSize, dmBlockData, dmBlockEc, dmEcSlot, dmPad } from './dm-tables.ts';

/** In the mapping map: a fixed module of the 2x2 corner pattern (no codeword bit). */
const FIXED_LIGHT = -1;
const FIXED_DARK = -2;
/** While the map is being built. */
const UNSET = -3;

interface Layout {
  /** Per mapping module (row-major, nrow x ncol): codeword * 8 + bit (bit 0 the MSB), or FIXED_*. */
  readonly map: Int16Array;
  /** Per symbol module (row-major): the mapping module index, or FIXED_LIGHT / FIXED_DARK for finder, clock and alignment modules. */
  readonly symbol: Int16Array;
}

const layouts: Map<DmSize, Layout> = /* @__PURE__ */ (() => new Map<DmSize, Layout>())();

/** ISO/IEC 16022 Annex F placement of codeword bits in the nrow x ncol mapping matrix. */
function buildMap(nrow: number, ncol: number): Int16Array {
  const m = new Int16Array(nrow * ncol).fill(UNSET);
  const put = (row: number, col: number, v: number): void => {
    let r = row;
    let c = col;
    if (r < 0) {
      r += nrow;
      c += 4 - ((nrow + 4) % 8);
    }
    if (c < 0) {
      c += ncol;
      r += 4 - ((ncol + 4) % 8);
    }
    m[r * ncol + c] = v;
  };
  const place = (k: number, cells: readonly number[]): void => {
    for (let bit = 0; bit < 8; bit++)
      put(cells[2 * bit] ?? 0, cells[2 * bit + 1] ?? 0, k * 8 + bit);
  };
  const isUnset = (r: number, c: number): boolean => m[r * ncol + c] === UNSET;
  const utah = (r: number, c: number, k: number): void =>
    place(k, [
      r - 2,
      c - 2,
      r - 2,
      c - 1,
      r - 1,
      c - 2,
      r - 1,
      c - 1,
      r - 1,
      c,
      r,
      c - 2,
      r,
      c - 1,
      r,
      c,
    ]);
  const n1 = nrow - 1;
  const c1 = ncol - 1;

  let r = 4;
  let c = 0;
  let k = 0;
  do {
    if (r === nrow && c === 0)
      place(k++, [n1, 0, n1, 1, n1, 2, 0, c1 - 1, 0, c1, 1, c1, 2, c1, 3, c1]);
    if (r === nrow - 2 && c === 0 && ncol % 4 !== 0)
      place(k++, [n1 - 2, 0, n1 - 1, 0, n1, 0, 0, c1 - 3, 0, c1 - 2, 0, c1 - 1, 0, c1, 1, c1]);
    if (r === nrow - 2 && c === 0 && ncol % 8 === 4)
      place(k++, [n1 - 2, 0, n1 - 1, 0, n1, 0, 0, c1 - 1, 0, c1, 1, c1, 2, c1, 3, c1]);
    if (r === nrow + 4 && c === 2 && ncol % 8 === 0)
      place(k++, [n1, 0, n1, c1, 0, c1 - 2, 0, c1 - 1, 0, c1, 1, c1 - 2, 1, c1 - 1, 1, c1]);
    // Sweep up and to the right.
    do {
      if (r < nrow && c >= 0 && isUnset(r, c)) utah(r, c, k++);
      r -= 2;
      c += 2;
    } while (r >= 0 && c < ncol);
    r += 1;
    c += 3;
    // Sweep down and to the left.
    do {
      if (r >= 0 && c < ncol && isUnset(r, c)) utah(r, c, k++);
      r += 2;
      c -= 2;
    } while (r < nrow && c >= 0);
    r += 3;
    c += 1;
  } while (r < nrow || c < ncol);

  // The fixed 2x2 corner when the mapping area is 4 modules short of a whole codeword.
  if (isUnset(n1, c1)) {
    m[n1 * ncol + c1] = FIXED_DARK;
    m[(n1 - 1) * ncol + c1 - 1] = FIXED_DARK;
    m[n1 * ncol + c1 - 1] = FIXED_LIGHT;
    m[(n1 - 1) * ncol + c1] = FIXED_LIGHT;
  }
  return m;
}

/**
 * Finder, clock tracks and alignment patterns (research 4.2): each data region is framed into a
 * (regionHeight + 2) x (regionWidth + 2) block; bottom row dark, top row dark on even x, left
 * column dark, right column dark on odd y, horizontal rules first.
 */
function buildSymbol(size: DmSize): Int16Array {
  const { rows, columns, regionHeight, regionWidth } = size;
  const ncol = size.regionColumns * regionWidth;
  const bh = regionHeight + 2;
  const bw = regionWidth + 2;
  const out = new Int16Array(rows * columns);
  for (let y = 0; y < rows; y++) {
    const ry = y % bh;
    for (let x = 0; x < columns; x++) {
      const rx = x % bw;
      let v: number;
      if (ry === bh - 1) v = FIXED_DARK;
      else if (ry === 0) v = x % 2 === 0 ? FIXED_DARK : FIXED_LIGHT;
      else if (rx === 0) v = FIXED_DARK;
      else if (rx === bw - 1) v = y % 2 === 1 ? FIXED_DARK : FIXED_LIGHT;
      else {
        const r = Math.floor(y / bh) * regionHeight + ry - 1;
        const c = Math.floor(x / bw) * regionWidth + rx - 1;
        v = r * ncol + c;
      }
      out[y * columns + x] = v;
    }
  }
  return out;
}

function layoutOf(size: DmSize): Layout {
  const cached = layouts.get(size);
  if (cached) return cached;
  const layout: Layout = {
    map: buildMap(size.regionRows * size.regionHeight, size.regionColumns * size.regionWidth),
    symbol: buildSymbol(size),
  };
  layouts.set(size, layout);
  return layout;
}

/**
 * The placement map of `size` (a copy): per mapping module, row-major over the
 * (regionRows x regionHeight) x (regionColumns x regionWidth) mapping matrix, `codeword * 8 + bit`
 * (codeword in symbol order, bit 0 the most significant), or -1 / -2 for the fixed light / dark
 * modules of the 2x2 corner pattern.
 */
export function codewordModules(size: DmSize): Int16Array {
  return layoutOf(size).map.slice();
}

/** Symbol coordinates (x right, y down, quiet zone excluded) of mapping module `index`. */
export function mappingToSymbol(size: DmSize, index: number): { x: number; y: number } {
  const ncol = size.regionColumns * size.regionWidth;
  const r = Math.floor(index / ncol);
  const c = index % ncol;
  return {
    x: c + 2 * Math.floor(c / size.regionWidth) + 1,
    y: r + 2 * Math.floor(r / size.regionHeight) + 1,
  };
}

/** Data (padded) and EC codewords of every block, interleaved into symbol order. */
function interleave(size: DmSize, data: readonly number[]): Uint8Array {
  const padded = dmPad(data, size.dataCodewords);
  const ec = dmBlockEc(size);
  const field = gf256(DM_POLY);
  const stream = new Uint8Array(size.dataCodewords + size.ecCodewords);
  stream.set(padded);
  for (let b = 0; b < size.blocks; b++) {
    const block = new Uint8Array(dmBlockData(size, b));
    for (let i = 0; i < block.length; i++) block[i] = byteAt(padded, b + i * size.blocks);
    const parity = rsEncode(field, block, ec, 1);
    const slot = dmEcSlot(size, b);
    for (let j = 0; j < ec; j++)
      stream[size.dataCodewords + j * size.blocks + slot] = byteAt(parity, j);
  }
  return stream;
}

/**
 * The whole symbol for `data` (data codewords, at most `size.dataCodewords`): padding, Reed-Solomon,
 * interleaving, placement, finder and alignment patterns. Symbology is left undefined.
 */
export function placeCodewords(size: DmSize, data: readonly number[]): ModuleMatrix {
  const stream = interleave(size, data);
  const { map, symbol } = layoutOf(size);
  const rows: string[] = [];
  for (let y = 0; y < size.rows; y++) {
    let row = '';
    for (let x = 0; x < size.columns; x++) {
      const s = symbol[y * size.columns + x] ?? FIXED_LIGHT;
      const v = s < 0 ? s : (map[s] ?? FIXED_LIGHT);
      const dark =
        v === FIXED_DARK || (v >= 0 && (byteAt(stream, v >> 3) & (0x80 >> (v & 7))) !== 0);
      row += dark ? '1' : '0';
    }
    rows.push(row);
  }
  return freezeMatrix({
    kind: 'matrix',
    symbology: undefined,
    width: size.columns,
    height: size.rows,
    rows,
    quietZone: { left: 1, right: 1, top: 1, bottom: 1 },
    hri: [],
  });
}

/**
 * All codewords (data then EC, interleaved symbol order) of a canonical-orientation symbol given
 * as `size.rows x size.columns` row-major bits (1 dark). Throws INVALID_SYMBOL `size` for any other
 * length.
 */
export function readCodewords(size: DmSize, bits: Uint8Array): Uint8Array {
  if (bits.length !== size.rows * size.columns)
    throw symbolError('size', `Expected ${size.rows * size.columns} modules, got ${bits.length}`);
  const { map, symbol } = layoutOf(size);
  const out = new Uint8Array(size.dataCodewords + size.ecCodewords);
  for (let i = 0; i < symbol.length; i++) {
    const s = symbol[i] ?? FIXED_LIGHT;
    if (s < 0 || byteAt(bits, i) === 0) continue;
    const v = map[s] ?? FIXED_LIGHT;
    if (v >= 0) out[v >> 3] = byteAt(out, v >> 3) | (0x80 >> (v & 7));
  }
  return out;
}

/** Splits the interleaved codewords into blocks, each its data codewords followed by its EC. */
export function deinterleave(size: DmSize, codewords: Uint8Array): readonly Uint8Array[] {
  const ec = dmBlockEc(size);
  const blocks: Uint8Array[] = [];
  for (let b = 0; b < size.blocks; b++) {
    const n = dmBlockData(size, b);
    const block = new Uint8Array(n + ec);
    for (let i = 0; i < n; i++) block[i] = byteAt(codewords, b + i * size.blocks);
    const slot = dmEcSlot(size, b);
    for (let j = 0; j < ec; j++)
      block[n + j] = byteAt(codewords, size.dataCodewords + j * size.blocks + slot);
    blocks.push(block);
  }
  return blocks;
}

/** How many finder, clock and alignment modules of a canonical-orientation symbol are wrong. */
export function finderMismatches(size: DmSize, bits: Uint8Array): number {
  const { symbol } = layoutOf(size);
  let n = 0;
  for (let i = 0; i < symbol.length; i++) {
    const s = symbol[i] ?? 0;
    if (s >= 0) continue;
    if ((byteAt(bits, i) !== 0) !== (s === FIXED_DARK)) n++;
  }
  return n;
}
