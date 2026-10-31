import { dataTooLong } from '../render/internal.ts';

/** One ECC 200 symbol size (GenSpecs Tables 5-32 and 5-33). Rows and columns exclude the quiet zone. */
export interface DmSize {
  readonly rows: number;
  readonly columns: number;
  /** Data regions vertically and horizontally. */
  readonly regionRows: number;
  readonly regionColumns: number;
  /** Size of one data region without its finder and clock modules. */
  readonly regionHeight: number;
  readonly regionWidth: number;
  readonly dataCodewords: number;
  readonly ecCodewords: number;
  readonly blocks: number;
  readonly shape: 'square' | 'rectangular';
}

/** rows, columns, region rows, region columns, EC codewords, blocks. */
const TABLE: readonly (readonly [number, number, number, number, number, number])[] = [
  [10, 10, 1, 1, 5, 1],
  [12, 12, 1, 1, 7, 1],
  [14, 14, 1, 1, 10, 1],
  [16, 16, 1, 1, 12, 1],
  [18, 18, 1, 1, 14, 1],
  [20, 20, 1, 1, 18, 1],
  [22, 22, 1, 1, 20, 1],
  [24, 24, 1, 1, 24, 1],
  [26, 26, 1, 1, 28, 1],
  [32, 32, 2, 2, 36, 1],
  [36, 36, 2, 2, 42, 1],
  [40, 40, 2, 2, 48, 1],
  [44, 44, 2, 2, 56, 1],
  [48, 48, 2, 2, 68, 1],
  [52, 52, 2, 2, 84, 2],
  [64, 64, 4, 4, 112, 2],
  [72, 72, 4, 4, 144, 4],
  [80, 80, 4, 4, 192, 4],
  [88, 88, 4, 4, 224, 4],
  [96, 96, 4, 4, 272, 4],
  [104, 104, 4, 4, 336, 6],
  [120, 120, 6, 6, 408, 6],
  [132, 132, 6, 6, 496, 8],
  [144, 144, 6, 6, 620, 10],
  [8, 18, 1, 1, 7, 1],
  [8, 32, 1, 2, 11, 1],
  [12, 26, 1, 1, 14, 1],
  [12, 36, 1, 2, 18, 1],
  [16, 36, 1, 2, 24, 1],
  [16, 48, 1, 2, 28, 1],
];

/**
 * The 30 ECC 200 sizes: 24 squares ascending, then 6 rectangles ascending by area. Derived fields
 * per DataMatrix research 2: mapping = (rows - 2 region rows) x (columns - 2 region columns), total
 * codewords = floor(mapping area / 8), data = total - EC.
 */
export const DM_SIZES: readonly DmSize[] = /* @__PURE__ */ (() =>
  Object.freeze(
    TABLE.map(([rows, columns, regionRows, regionColumns, ecCodewords, blocks]) => {
      const nrow = rows - 2 * regionRows;
      const ncol = columns - 2 * regionColumns;
      const size: DmSize = {
        rows,
        columns,
        regionRows,
        regionColumns,
        regionHeight: nrow / regionRows,
        regionWidth: ncol / regionColumns,
        dataCodewords: Math.floor((nrow * ncol) / 8) - ecCodewords,
        ecCodewords,
        blocks,
        shape: rows === columns ? 'square' : 'rectangular',
      };
      return Object.freeze(size);
    }),
  ))();

/** The ECC 200 size with these dimensions, or undefined (DMRE sizes included). */
export function dmSize(rows: number, columns: number): DmSize | undefined {
  return DM_SIZES.find((s) => s.rows === rows && s.columns === columns);
}

/** Data codewords of block `b`: data codeword i belongs to block i mod blocks. */
export function dmBlockData(size: DmSize, b: number): number {
  const base = Math.floor(size.dataCodewords / size.blocks);
  return base + (b < size.dataCodewords % size.blocks ? 1 : 0);
}

/** EC codewords per block (equal for every block of every size). */
export function dmBlockEc(size: DmSize): number {
  return size.ecCodewords / size.blocks;
}

/**
 * Position of block `b` within each round of interleaved EC codewords: `b`, except 144x144 where
 * the two short blocks come first, `(b + 2) mod 10` (DataMatrix research 2, key fact 4).
 */
export function dmEcSlot(size: DmSize, b: number): number {
  return size.rows === 144 ? (b + 2) % size.blocks : b;
}

/**
 * `data` padded to `capacity` codewords (research 3.4): first pad 129, then at 1-based position p
 * the 253-state value 129 + ((149 p) mod 253) + 1, minus 254 above 254. Throws DATA_TOO_LONG when
 * `data` exceeds `capacity`.
 */
export function dmPad(data: readonly number[], capacity: number): Uint8Array {
  if (data.length > capacity) throw dataTooLong(capacity, data.length);
  const out = new Uint8Array(capacity);
  out.set(data);
  for (let i = data.length; i < capacity; i++) {
    if (i === data.length) {
      out[i] = 129;
      continue;
    }
    const v = 129 + ((149 * (i + 1)) % 253) + 1;
    out[i] = v > 254 ? v - 254 : v;
  }
  return out;
}
