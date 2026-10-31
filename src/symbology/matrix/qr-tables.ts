export type QrEcLevel = 'L' | 'M' | 'Q' | 'H';

export const EC_LEVELS: readonly QrEcLevel[] = /* @__PURE__ */ Object.freeze([
  'L',
  'M',
  'Q',
  'H',
] as const);

export interface QrLevelInfo {
  readonly dataCodewords: number;
  readonly ecPerBlock: number;
  /** Data codewords per block, short blocks first. */
  readonly blockData: readonly number[];
  /** Correctable codeword errors per block (decision Q8, ISO misdecode protection applied). */
  readonly correctable: number;
}

export interface QrVersionInfo {
  readonly version: number;
  /** Modules per side, 17 + 4 * version. */
  readonly size: number;
  /** Alignment pattern centre coordinates, empty for version 1. */
  readonly alignment: readonly number[];
  readonly totalCodewords: number;
  readonly remainderBits: number;
  readonly levels: Readonly<Record<QrEcLevel, QrLevelInfo>>;
}

/** EC codewords per block for versions 1..40 (QR research 1.3). */
const EC_PER_BLOCK: Readonly<Record<QrEcLevel, readonly number[]>> = {
  L: [
    7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30,
    26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  M: [
    10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28,
    28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
  ],
  Q: [
    13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30,
    30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
  H: [
    17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30,
    30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
  ],
};

/** Total number of RS blocks for versions 1..40 (QR research 1.3). */
const BLOCKS: Readonly<Record<QrEcLevel, readonly number[]>> = {
  L: [
    1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15,
    16, 17, 18, 19, 19, 20, 21, 22, 24, 25,
  ],
  M: [
    1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
    26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
  ],
  Q: [
    1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34,
    35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
  ],
  H: [
    1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37,
    40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
  ],
};

/**
 * ISO/IEC 18004 Table 9 misdecode-protection values (recalled, QR research 7.1); every other
 * (version, level) corrects floor(ec / 2).
 */
const PROTECTED: Readonly<Record<string, number>> = {
  '1L': 2,
  '1M': 4,
  '1Q': 6,
  '1H': 8,
  '2L': 4,
  '3L': 7,
};

function alignmentCentres(version: number): readonly number[] {
  if (version === 1) return [];
  const size = 17 + 4 * version;
  const n = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : 2 * Math.ceil((size - 13) / (2 * n - 2));
  const centres = [6];
  for (let i = n - 2; i >= 0; i--) centres.push(size - 7 - i * step);
  return centres;
}

function buildVersion(version: number): QrVersionInfo {
  const n = Math.floor(version / 7) + 2;
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) modules -= (25 * n - 10) * n - 55;
  if (version >= 7) modules -= 36;
  const totalCodewords = Math.floor(modules / 8);
  const info = (level: QrEcLevel): QrLevelInfo => {
    const ecPerBlock = EC_PER_BLOCK[level][version - 1]!;
    const blocks = BLOCKS[level][version - 1]!;
    const dataCodewords = totalCodewords - ecPerBlock * blocks;
    const long = totalCodewords % blocks;
    const shortData = Math.floor(totalCodewords / blocks) - ecPerBlock;
    const blockData = Array.from({ length: blocks }, (_, b) =>
      b < blocks - long ? shortData : shortData + 1,
    );
    return Object.freeze({
      dataCodewords,
      ecPerBlock,
      blockData: Object.freeze(blockData),
      correctable: PROTECTED[`${version}${level}`] ?? Math.floor(ecPerBlock / 2),
    });
  };
  return Object.freeze({
    version,
    size: 17 + 4 * version,
    alignment: Object.freeze(alignmentCentres(version)),
    totalCodewords,
    remainderBits: modules % 8,
    levels: Object.freeze({ L: info('L'), M: info('M'), Q: info('Q'), H: info('H') }),
  });
}

const cache: (QrVersionInfo | undefined)[] = [];

/** The table row of version 1..40, built on first use. */
export function qrVersion(version: number): QrVersionInfo {
  if (!Number.isInteger(version) || version < 1 || version > 40) {
    throw new RangeError(`QR version out of range: ${version}`);
  }
  return (cache[version] ??= buildVersion(version));
}

const COUNT_BITS = /* @__PURE__ */ (() =>
  Object.freeze({
    numeric: [10, 12, 14],
    alphanumeric: [9, 11, 13],
    byte: [8, 16, 16],
    kanji: [8, 10, 12],
  }))();

/** Version group for character count lengths: 0 for versions 1-9, 1 for 10-26, 2 for 27-40. */
export function versionGroup(version: number): 0 | 1 | 2 {
  return version <= 9 ? 0 : version <= 26 ? 1 : 2;
}

/** Width of the character count indicator. */
export function countBits(
  mode: 'numeric' | 'alphanumeric' | 'byte' | 'kanji',
  version: number,
): number {
  return COUNT_BITS[mode][versionGroup(version)]!;
}

/** Remainder of `value` (degree `shift` added) modulo the generator polynomial `poly`. */
function bchRemainder(value: number, shift: number, poly: number): number {
  let v = value << shift;
  const polyDegree = 31 - Math.clz32(poly);
  for (let i = 31 - Math.clz32(v); i >= polyDegree; i--) {
    if ((v >> i) & 1) v ^= poly << (i - polyDegree);
  }
  return v;
}

const EC_BITS: Readonly<Record<QrEcLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };

/** The 15 format information bits for a level and mask 0..7: BCH(15,5), generator 0x537, XOR 0x5412. */
export function formatBits(level: QrEcLevel, mask: number): number {
  const data = (EC_BITS[level] << 3) | mask;
  return (((data << 10) | bchRemainder(data, 10, 0x537)) ^ 0x5412) & 0x7fff;
}

/** The number of set bits of a non-negative integer. Internal. */
export function popcount(x: number): number {
  let n = 0;
  for (let v = x; v; v &= v - 1) n++;
  return n;
}

const FORMAT_CODES = /* @__PURE__ */ (() =>
  EC_LEVELS.flatMap((level) =>
    Array.from({ length: 8 }, (_, mask) => ({ level, mask, bits: formatBits(level, mask) })),
  ))();

/** Nearest format code word over both copies, accepted at Hamming distance 3 or less. */
export function decodeFormat(a: number, b: number): { level: QrEcLevel; mask: number } | undefined {
  let best: { level: QrEcLevel; mask: number } | undefined;
  let bestDistance = 4;
  for (const code of FORMAT_CODES) {
    const d = Math.min(popcount(code.bits ^ a), popcount(code.bits ^ b));
    if (d < bestDistance) {
      bestDistance = d;
      best = { level: code.level, mask: code.mask };
    }
  }
  return best;
}

/** The 18 version information bits for version 7..40: BCH(18,6), generator 0x1F25. */
export function versionBits(version: number): number {
  return (version << 12) | bchRemainder(version, 12, 0x1f25);
}

/** Nearest version code word, accepted at Hamming distance 3 or less. */
export function decodeVersion(bits: number): { version: number; distance: number } | undefined {
  let best: { version: number; distance: number } | undefined;
  for (let version = 7; version <= 40; version++) {
    const distance = popcount(versionBits(version) ^ bits);
    if (distance <= 3 && (!best || distance < best.distance)) best = { version, distance };
  }
  return best;
}
