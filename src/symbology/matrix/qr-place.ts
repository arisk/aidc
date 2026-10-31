import { QR_POLY, byteAt, gf256 } from '../../core/gf256.ts';
import { rsEncode } from '../../core/reed-solomon.ts';
import { freezeMatrix, symbolError } from '../render/internal.ts';
import type { ModuleMatrix } from '../render/index.ts';
import { chooseMask, maskPatterns, maskScores } from './qr-mask.ts';
import { type QrEcLevel, decodeFormat, formatBits, qrVersion, versionBits } from './qr-tables.ts';

interface Layout {
  readonly size: number;
  /** Per module (row-major): 1 for function modules (format, version and dark module included). */
  readonly fn: Uint8Array;
  /** Function patterns as drawn: dark module dark, version information real, format modules light. */
  readonly drawn: Uint8Array;
  /** The scoring matrix of decision Q6: format modules dark, dark module and version modules light. */
  readonly scoring: Uint8Array;
  /** Data modules (y * size + x) in zigzag order (QR research 4.2). */
  readonly order: Int32Array;
  /** Per entry of `order`: bit m set where mask m flips that module. */
  readonly patterns: Uint8Array;
  /** Module indices of format bit i (bit 0 the least significant) in copy 1 and copy 2. */
  readonly format1: Int32Array;
  readonly format2: Int32Array;
}

const layouts: (Layout | undefined)[] = [];

function buildLayout(version: number): Layout {
  const info = qrVersion(version);
  const s = info.size;
  const fn = new Uint8Array(s * s);
  const drawn = new Uint8Array(s * s);
  const set = (x: number, y: number, dark: boolean): void => {
    fn[y * s + x] = 1;
    drawn[y * s + x] = dark ? 1 : 0;
  };

  // Finder patterns with their separators: the three 8x8 corner squares.
  for (const [fx, fy] of [
    [0, 0],
    [s - 7, 0],
    [0, s - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = fx + dx;
        const y = fy + dy;
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  // Timing patterns.
  for (let i = 8; i <= s - 9; i++) {
    set(i, 6, i % 2 === 0);
    set(6, i, i % 2 === 0);
  }
  // Alignment patterns, except the three that would overlap a finder.
  const centres = info.alignment;
  const first = centres[0];
  const last = centres[centres.length - 1];
  for (const cy of centres) {
    for (const cx of centres) {
      if ((cx === first && cy === first) || (cx === first && cy === last)) continue;
      if (cx === last && cy === first) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // Format information areas (QR research 1.2), drawn per symbol.
  const format1 = new Int32Array(15);
  const format2 = new Int32Array(15);
  for (let i = 0; i < 15; i++) {
    const [x1, y1] =
      i <= 5 ? [8, i] : i === 6 ? [8, 7] : i === 7 ? [8, 8] : i === 8 ? [7, 8] : [14 - i, 8];
    const [x2, y2] = i <= 7 ? [s - 1 - i, 8] : [8, s - 15 + i];
    format1[i] = y1 * s + x1;
    format2[i] = y2 * s + x2;
    set(x1, y1, false);
    set(x2, y2, false);
  }
  // The dark module.
  const darkModule = (s - 8) * s + 8;
  set(8, s - 8, true);
  // Version information (v >= 7).
  const versionModules: number[] = [];
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const a = s - 11 + (i % 3);
      const b = Math.floor(i / 3);
      const dark = ((bits >> i) & 1) === 1;
      set(a, b, dark);
      set(b, a, dark);
      versionModules.push(b * s + a, a * s + b);
    }
  }

  const scoring = drawn.slice();
  for (let i = 0; i < 15; i++) {
    scoring[format1[i] ?? 0] = 1;
    scoring[format2[i] ?? 0] = 1;
  }
  scoring[darkModule] = 0;
  for (const i of versionModules) scoring[i] = 0;

  // Zigzag order: column pairs from the right, alternately upwards and downwards, skipping column 6.
  const count = info.totalCodewords * 8 + info.remainderBits;
  const order = new Int32Array(count);
  const patterns = new Uint8Array(count);
  let k = 0;
  for (let right = s - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < s; vert++) {
      const y = upward ? s - 1 - vert : vert;
      for (let x = right; x >= right - 1; x--) {
        const i = y * s + x;
        if (fn[i]) continue;
        order[k] = i;
        patterns[k] = maskPatterns(x, y);
        k++;
      }
    }
  }
  if (k !== count) throw new Error(`QR v${version}: ${k} data modules, expected ${count}`);
  return { size: s, fn, drawn, scoring, order, patterns, format1, format2 };
}

function layoutOf(version: number): Layout {
  return (layouts[version] ??= buildLayout(qrVersion(version).version));
}

/** Per module (row-major, size x size): 1 for function modules. A copy of the cached map. */
export function functionMap(version: number): Uint8Array {
  return layoutOf(version).fn.slice();
}

/** The data modules (index y * size + x) in zigzag placement order. A copy of the cached order. */
export function dataOrder(version: number): Int32Array {
  return layoutOf(version).order.slice();
}

/** The data module of every interleaved codeword bit, at `codeword * 8 + bit` (bit 0 the MSB). */
export function codewordModules(version: number): Int32Array {
  return layoutOf(version).order.slice(0, qrVersion(version).totalCodewords * 8);
}

/**
 * RS per block, then interleaved (QR research 4.1): the data codewords column by column over the
 * blocks (short blocks first), then the EC codewords likewise. `data` must hold exactly the
 * version's data codewords for `level` (RangeError otherwise).
 */
export function interleave(version: number, level: QrEcLevel, data: readonly number[]): Uint8Array {
  const info = qrVersion(version);
  const { dataCodewords, ecPerBlock, blockData } = info.levels[level];
  if (data.length !== dataCodewords)
    throw new RangeError(
      `QR ${version}-${level} needs ${dataCodewords} data codewords, got ${data.length}`,
    );
  const field = gf256(QR_POLY);
  const bytes = Uint8Array.from(data);
  const blocks = blockData.length;
  const longest = blockData[blocks - 1] ?? 0;
  const out = new Uint8Array(info.totalCodewords);
  let p = 0;
  for (let i = 0; i < longest; i++) {
    let offset = 0;
    for (const n of blockData) {
      if (i < n) out[p++] = byteAt(bytes, offset + i);
      offset += n;
    }
  }
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const n = blockData[b] ?? 0;
    const ec = rsEncode(field, bytes.subarray(offset, offset + n), ecPerBlock, 0);
    for (let j = 0; j < ecPerBlock; j++) out[dataCodewords + j * blocks + b] = byteAt(ec, j);
    offset += n;
  }
  return out;
}

/** Splits interleaved codewords into blocks, each its data codewords followed by its EC. */
export function deinterleave(
  version: number,
  level: QrEcLevel,
  codewords: Uint8Array,
): readonly Uint8Array[] {
  const { dataCodewords, ecPerBlock, blockData } = qrVersion(version).levels[level];
  const blocks = blockData.map((n) => new Uint8Array(n + ecPerBlock));
  const longest = blockData[blockData.length - 1] ?? 0;
  let p = 0;
  for (let i = 0; i < longest; i++) {
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      if (block && i < (blockData[b] ?? 0)) block[i] = byteAt(codewords, p++);
    }
  }
  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b];
    const n = blockData[b] ?? 0;
    if (!block) continue;
    for (let j = 0; j < ecPerBlock; j++)
      block[n + j] = byteAt(codewords, dataCodewords + j * blocks.length + b);
  }
  return blocks;
}

function checkMask(mask: number): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7)
    throw new RangeError(`QR mask out of range: ${mask}`);
  return mask;
}

/** One bit per data module in placement order: the codeword bits MSB first, then remainder 0s. */
function streamBits(layout: Layout, stream: Uint8Array): Uint8Array {
  const bits = new Uint8Array(layout.order.length);
  const n = stream.length * 8;
  for (let k = 0; k < n; k++) bits[k] = (byteAt(stream, k >> 3) >> (7 - (k & 7))) & 1;
  return bits;
}

/** The eight BWIPP-compatible mask penalties (decision Q6) for the data codewords of `level`. */
export function penaltyScores(
  version: number,
  level: QrEcLevel,
  codewords: readonly number[] | Uint8Array,
): readonly number[] {
  const layout = layoutOf(version);
  const bits = streamBits(layout, interleave(version, level, Array.from(codewords)));
  return maskScores(layout.scoring, layout.size, layout.order, layout.patterns, bits);
}

/**
 * The whole symbol for exactly the data codewords of `version`-`level`: RS, interleaving, zigzag
 * placement (remainder bits 0), mask (ISO 0..7, or `'auto'` for the lowest Q6 penalty), function
 * patterns, format and version information. Quiet zone 4, symbology undefined.
 */
export function buildSymbol(
  version: number,
  level: QrEcLevel,
  data: readonly number[],
  mask: number | 'auto',
): ModuleMatrix {
  const layout = layoutOf(version);
  const { size, order, patterns } = layout;
  const dataBits = streamBits(layout, interleave(version, level, data));
  const m =
    mask === 'auto'
      ? chooseMask(maskScores(layout.scoring, size, order, patterns, dataBits))
      : checkMask(mask);
  const bits = layout.drawn.slice();
  const format = formatBits(level, m);
  for (let i = 0; i < 15; i++) {
    const b = (format >> i) & 1;
    bits[layout.format1[i] ?? 0] = b;
    bits[layout.format2[i] ?? 0] = b;
  }
  for (let k = 0; k < order.length; k++) bits[order[k]!] = dataBits[k]! ^ ((patterns[k]! >> m) & 1);

  const rows: string[] = [];
  const codes = new Uint16Array(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) codes[x] = 48 + byteAt(bits, y * size + x);
    rows.push(String.fromCharCode(...codes));
  }
  return freezeMatrix({
    kind: 'matrix',
    symbology: undefined,
    width: size,
    height: size,
    rows,
    quietZone: { left: 4, right: 4, top: 4, bottom: 4 },
    hri: [],
  });
}

/** The mask in the format information of a canonical-orientation `buildSymbol`-sized matrix. */
export function chosenMask(m: ModuleMatrix): number {
  const version = (m.width - 17) / 4;
  const layout = layoutOf(version);
  const read = (positions: Int32Array): number => {
    let v = 0;
    for (let i = 0; i < 15; i++) {
      const p = positions[i] ?? 0;
      if (m.rows[Math.floor(p / layout.size)]?.[p % layout.size] === '1') v |= 1 << i;
    }
    return v;
  };
  const format = decodeFormat(read(layout.format1), read(layout.format2));
  if (!format) throw new RangeError('QR format information unreadable');
  return format.mask;
}

/**
 * All `totalCodewords` codewords (interleaved order, data then EC) of a canonical-orientation
 * symbol given as size x size row-major modules (nonzero dark), unmasked with `mask`; remainder
 * bits are ignored. Throws INVALID_SYMBOL `size` for any other length.
 */
export function readCodewords(version: number, bits: Uint8Array, mask: number): Uint8Array {
  const layout = layoutOf(version);
  const { size, order, patterns } = layout;
  if (bits.length !== size * size)
    throw symbolError('size', `Expected ${size * size} modules, got ${bits.length}`);
  const m = checkMask(mask);
  const out = new Uint8Array(qrVersion(version).totalCodewords);
  for (let c = 0, k = 0; c < out.length; c++) {
    let v = 0;
    for (let bit = 0; bit < 8; bit++, k++)
      v = (v << 1) | ((bits[order[k]!]! !== 0 ? 1 : 0) ^ ((patterns[k]! >> m) & 1));
    out[c] = v;
  }
  return out;
}
