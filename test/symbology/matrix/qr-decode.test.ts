import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/qr.json' with { type: 'json' };
import { format, parse } from '../../../src/ai/index.ts';
import { Gs1Error } from '../../../src/core/index.ts';
import type { Result } from '../../../src/core/index.ts';
import { matrixFromRows } from '../../../src/symbology/render/index.ts';
import type { ModuleMatrix, Orientation } from '../../../src/symbology/render/index.ts';
import { chooseVersion } from '../../../src/symbology/matrix/qr-encode.ts';
import { buildSymbol } from '../../../src/symbology/matrix/qr-place.ts';
import {
  EC_LEVELS,
  countBits,
  formatBits,
  qrVersion,
  versionBits,
} from '../../../src/symbology/matrix/qr-tables.ts';
import type { QrEcLevel } from '../../../src/symbology/matrix/qr-tables.ts';
import { decodeBits, readQr } from '../../../src/symbology/matrix/qr-decode.ts';
import type { QrRead, QrText } from '../../../src/symbology/matrix/qr-decode.ts';
import {
  damageQrCodewords,
  gs1MessageArb,
  qrRowsToMatrix,
  toBracketed,
} from '../../support/matrix.ts';

const GS = '\u001d';
const FNC1 = -1;

function toLevel(s: string): QrEcLevel {
  const level = EC_LEVELS.find((l) => l === s);
  if (!level) throw new Error(`bad level ${s}`);
  return level;
}

function hex(s: string): number[] {
  return Array.from({ length: s.length / 2 }, (_, i) =>
    Number.parseInt(s.slice(2 * i, 2 * i + 2), 16),
  );
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mustRead(m: unknown): QrRead {
  const r = readQr(m);
  if (!r.ok) throw new Error(`read failed: ${r.errors[0]?.message ?? ''}`);
  return r.value;
}

function mustText(codewords: readonly number[], version: number): QrText {
  const r = decodeBits(codewords, version);
  if (!r.ok) throw new Error(`decode failed: ${r.errors[0]?.message ?? ''}`);
  return r.value;
}

function firstError<T>(r: Result<T>): Gs1Error {
  if (r.ok) throw new Error('expected a failure');
  const e = r.errors[0];
  if (!e) throw new Error('no error');
  return e;
}

/** aimId + data of a matrix. */
function scanOf(m: unknown): string {
  const read = mustRead(m);
  const t = mustText(read.codewords, read.version);
  return t.aimId + t.data;
}

/** Units of a string: GS is FNC1 in GS1 mode. */
function unitsOf(text: string, gs1: boolean): number[] {
  return Array.from(text, (c) => (gs1 && c === GS ? FNC1 : c.charCodeAt(0)));
}

/** The symbol of `text` at `version` (or the smallest) and `level`, mask 'auto'. */
function symbolOf(
  text: string,
  gs1: boolean,
  level: QrEcLevel = 'M',
  version: number | 'auto' = 'auto',
): { m: ModuleMatrix; version: number; codewords: readonly number[] } | undefined {
  const r = chooseVersion(unitsOf(text, gs1), gs1, level, version);
  if (!r.ok) return undefined;
  return {
    m: buildSymbol(r.value.version, level, r.value.codewords, 'auto'),
    version: r.value.version,
    codewords: r.value.codewords,
  };
}

function mustSymbol(
  text: string,
  gs1: boolean,
  level: QrEcLevel = 'M',
  version: number | 'auto' = 'auto',
): { m: ModuleMatrix; version: number; codewords: readonly number[] } {
  const s = symbolOf(text, gs1, level, version);
  if (!s) throw new Error('does not fit');
  return s;
}

/** The input of a canonical square matrix turned by `o`: mirrored left to right, then rotated clockwise. */
function transform(m: ModuleMatrix, o: Orientation): ModuleMatrix {
  const s = m.width;
  const grid = Array.from({ length: s }, () => Array.from({ length: s }, () => '0'));
  for (let r = 0; r < s; r++) {
    for (let c0 = 0; c0 < s; c0++) {
      const c = o.mirrored ? s - 1 - c0 : c0;
      const [y, x] =
        o.rotation === 0
          ? [r, c]
          : o.rotation === 90
            ? [c, s - 1 - r]
            : o.rotation === 180
              ? [s - 1 - r, s - 1 - c]
              : [s - 1 - c, r];
      const row = grid[y];
      if (row) row[x] = m.rows[r]?.[c0] ?? '0';
    }
  }
  return matrixFromRows(grid.map((row) => row.join('')));
}

function invert(m: ModuleMatrix): ModuleMatrix {
  return matrixFromRows(m.rows.map((r) => Array.from(r, (c) => (c === '1' ? '0' : '1')).join('')));
}

/** `k` modules of `fill` on every side. */
function bordered(m: ModuleMatrix, k: number, fill = '0'): ModuleMatrix {
  const w = m.width + 2 * k;
  const edge = fill.repeat(w);
  const rows = [
    ...Array.from({ length: k }, () => edge),
    ...m.rows.map((r) => fill.repeat(k) + r + fill.repeat(k)),
    ...Array.from({ length: k }, () => edge),
  ];
  return matrixFromRows(rows);
}

/** A copy with the canonical modules (x, y) flipped. */
function flipped(m: ModuleMatrix, cells: readonly (readonly [number, number])[]): ModuleMatrix {
  const grid = m.rows.map((r) => r.split(''));
  for (const [x, y] of cells) {
    const row = grid[y];
    if (row) row[x] = row[x] === '1' ? '0' : '1';
  }
  return matrixFromRows(grid.map((r) => r.join('')));
}

/** A copy with the canonical modules (x, y) set to the bits of `value` (bit i at cells[i]). */
function written(
  m: ModuleMatrix,
  cells: readonly (readonly [number, number])[],
  value: number,
): ModuleMatrix {
  const grid = m.rows.map((r) => r.split(''));
  cells.forEach(([x, y], i) => {
    const row = grid[y];
    if (row) row[x] = (value >> i) & 1 ? '1' : '0';
  });
  return matrixFromRows(grid.map((r) => r.join('')));
}

/** Format information modules (x, y) of bit i, copy 1 and copy 2 (QR research 1.2). */
function formatCells(s: number): [[number, number][], [number, number][]] {
  const a: [number, number][] = [];
  const b: [number, number][] = [];
  for (let i = 0; i < 15; i++) {
    a.push(i <= 5 ? [8, i] : i === 6 ? [8, 7] : i === 7 ? [8, 8] : i === 8 ? [7, 8] : [14 - i, 8]);
    b.push(i <= 7 ? [s - 1 - i, 8] : [8, s - 15 + i]);
  }
  return [a, b];
}

/** Version information modules (x, y) of bit i, top right copy and bottom left copy. */
function versionCells(s: number): [[number, number][], [number, number][]] {
  const a: [number, number][] = [];
  const b: [number, number][] = [];
  for (let i = 0; i < 18; i++) {
    a.push([s - 11 + (i % 3), Math.floor(i / 3)]);
    b.push([Math.floor(i / 3), s - 11 + (i % 3)]);
  }
  return [a, b];
}

/** A big-endian bit writer for hand-built streams. */
class Bits {
  readonly bits: number[] = [];
  put(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    return this;
  }
  /** Terminator (up to 4 zeros), zero bits to the codeword boundary, 0xEC/0x11 pads. */
  codewords(version: number, level: QrEcLevel): number[] {
    const capacity = qrVersion(version).levels[level].dataCodewords;
    const bits = this.bits.slice();
    if (bits.length > capacity * 8) throw new Error('stream too long');
    for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const out: number[] = [];
    for (let i = 0; i < bits.length; i += 8)
      out.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
    for (let k = 0; out.length < capacity; k++) out.push(k % 2 === 0 ? 0xec : 0x11);
    return out;
  }
}

/** A hand-built stream through buildSymbol and the whole decoder. */
function viaSymbol(b: Bits, version = 2, level: QrEcLevel = 'L'): Result<QrText> {
  const read = mustRead(buildSymbol(version, level, b.codewords(version, level), 'auto'));
  return decodeBits(read.codewords, read.version);
}

function mustViaSymbol(b: Bits, version = 2, level: QrEcLevel = 'L'): QrText {
  const r = viaSymbol(b, version, level);
  if (!r.ok) throw new Error(`decode failed: ${r.errors[0]?.message ?? ''}`);
  return r.value;
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function alnum(b: Bits, text: string, version = 2): Bits {
  b.put(0b0010, 4).put(text.length, countBits('alphanumeric', version));
  let i = 0;
  for (; i + 2 <= text.length; i += 2)
    b.put(ALNUM.indexOf(text[i] ?? '') * 45 + ALNUM.indexOf(text[i + 1] ?? ''), 11);
  if (i < text.length) b.put(ALNUM.indexOf(text[i] ?? ''), 6);
  return b;
}

function bytes(b: Bits, text: string, version = 2): Bits {
  b.put(0b0100, 4).put(text.length, countBits('byte', version));
  for (const c of text) b.put(c.charCodeAt(0), 8);
  return b;
}

function numeric(b: Bits, digits: string, version = 2): Bits {
  b.put(0b0001, 4).put(digits.length, countBits('numeric', version));
  let i = 0;
  for (; i + 3 <= digits.length; i += 3) b.put(Number(digits.slice(i, i + 3)), 10);
  const rest = digits.length - i;
  if (rest > 0) b.put(Number(digits.slice(i)), rest === 2 ? 7 : 4);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Vectors

interface Vector {
  readonly id: string;
  readonly scan: string;
  readonly version: number;
  readonly level: string;
  readonly mask: number;
  readonly dataCodewords: string;
  readonly rows: readonly string[];
}

const ROW_VECTORS: readonly Vector[] = [...vectors.engine, ...vectors.figures, ...vectors.derived];

describe('vectors', () => {
  it.each(ROW_VECTORS.map((v) => [v.id, v] as const))('%s decodes to its scan', (_, v) => {
    const read = mustRead(qrRowsToMatrix(v.rows));
    expect(read).toMatchObject({
      version: v.version,
      level: v.level,
      mask: v.mask,
      errorsCorrected: 0,
      orientation: { rotation: 0, mirrored: false },
      inverted: false,
    });
    expect(read.codewords).toEqual(hex(v.dataCodewords));
    const info = qrVersion(v.version).levels[toLevel(v.level)];
    expect(read.blocks).toBe(info.blockData.length);
    expect(read.ecCodewords).toBe(info.blockData.length * info.ecPerBlock);
    const t = mustText(read.codewords, read.version);
    expect(t.aimId + t.data).toBe(v.scan);
    expect(t.special).toBeUndefined();
  });

  it('the engine GS1 vector decodes despite its misaligned padding (key fact 6)', () => {
    const v = vectors.engine[1];
    if (!v) throw new Error('no vector');
    expect(v.dataCodewords.endsWith('0EC11EC11EC11EC11C')).toBe(true);
    expect(scanOf(qrRowsToMatrix(v.rows))).toBe(v.scan);
  });

  it('Figure 9-7 (no FNC1) decodes as ]Q1 text', () => {
    const v = vectors.figures.find((f) => f.id === 'verif-fig-9-7');
    if (!v) throw new Error('no vector');
    const read = mustRead(qrRowsToMatrix(v.rows));
    const t = mustText(read.codewords, read.version);
    expect(t.aimId).toBe(']Q1');
    expect(t.data).toBe('01095070000000361508121299www.gs1.mobi/products.asp');
    expect(t.segments).toEqual([
      { mode: 'numeric', count: 26 },
      { mode: 'byte', count: 25 },
    ]);
  });

  it('reports segments and dataBits', () => {
    const v = vectors.derived.find((d) => d.id === 'gs1-mixed-modes');
    if (!v) throw new Error('no vector');
    const read = mustRead(qrRowsToMatrix(v.rows));
    const t = mustText(read.codewords, read.version);
    expect(t.segments).toEqual([
      { mode: 'numeric', count: 23 },
      { mode: 'alphanumeric', count: 15 },
      { mode: 'numeric', count: 8 },
    ]);
    // 0101, N23 (4 + 10 + 77), A15 (4 + 9 + 83), N8 (4 + 10 + 27).
    expect(t.dataBits).toBe(4 + 91 + 96 + 41);
  });

  it('the four Figure 5-52 images decode, two of them mirrored', () => {
    const v = vectors.figures.find((f) => f.id === 'genspecs-fig-5-52');
    if (!v) throw new Error('no vector');
    const canonical = qrRowsToMatrix(v.rows);
    const images: Orientation[] = [
      { rotation: 0, mirrored: false },
      { rotation: 180, mirrored: false },
      { rotation: 0, mirrored: true },
      { rotation: 180, mirrored: true },
    ];
    for (const o of images) {
      const read = mustRead(transform(canonical, o));
      expect(read.orientation).toEqual(o);
      const t = mustText(read.codewords, read.version);
      expect(t.aimId + t.data).toBe(v.scan);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 4: orientation, inversion, borders

describe('Review Focus 4: orientation, inversion and borders', () => {
  const ROTATIONS: readonly Orientation['rotation'][] = [0, 90, 180, 270];
  const ORIENTATIONS: Orientation[] = ROTATIONS.flatMap((rotation) =>
    [false, true].map((mirrored) => ({ rotation, mirrored })),
  );
  const CASES = ['engine-gs1-ai-element-string', 'large-v10-h', 'genspecs-5.7.4.3-gtin'];

  it.each(CASES)('%s decodes under all 8 transforms, inverted and with borders', (id) => {
    const v = ROW_VECTORS.find((x) => x.id === id);
    if (!v) throw new Error('no vector');
    const canonical = qrRowsToMatrix(v.rows);
    for (const o of ORIENTATIONS) {
      const m = transform(canonical, o);
      const read = mustRead(m);
      expect(read.orientation).toEqual(o);
      expect(read.inverted).toBe(false);
      expect(scanOf(m)).toBe(v.scan);
      const inv = mustRead(invert(m));
      expect(inv.orientation).toEqual(o);
      expect(inv.inverted).toBe(true);
      expect(scanOf(invert(m))).toBe(v.scan);
    }
    for (let k = 0; k <= 8; k++) {
      expect(scanOf(bordered(canonical, k))).toBe(v.scan);
      const inv = bordered(invert(canonical), k, '1');
      expect(mustRead(inv).inverted).toBe(true);
      expect(scanOf(inv)).toBe(v.scan);
    }
  });

  it('a transposed version 7+ symbol reports the mirror', () => {
    const { m } = mustSymbol('01095060001343521012345A', true, 'H', 8);
    const read = mustRead(transform(m, { rotation: 270, mirrored: true }));
    expect(read.orientation).toEqual({ rotation: 270, mirrored: true });
    expect(read.version).toBe(8);
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 3: damage

/** The interleaved index of codeword i of block b (data then EC), as qr-place interleaves. */
function symbolIndex(version: number, level: QrEcLevel, b: number, i: number): number {
  const { blockData, dataCodewords } = qrVersion(version).levels[level];
  const blocks = blockData.length;
  const n = blockData[b] ?? 0;
  if (i >= n) return dataCodewords + (i - n) * blocks + b;
  let p = 0;
  for (let k = 0; k < i; k++) for (const d of blockData) if (k < d) p++;
  for (let bb = 0; bb < b; bb++) if (i < (blockData[bb] ?? 0)) p++;
  return p;
}

function pickDistinct(rand: () => number, n: number, k: number): number[] {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [all[i], all[j]] = [all[j] ?? 0, all[i] ?? 0];
  }
  return all.slice(0, k);
}

function damagePlan(
  rand: () => number,
  version: number,
  level: QrEcLevel,
  perBlock: (b: number) => number,
): { plan: { codeword: number; xor: number }[]; total: number } {
  const { blockData, ecPerBlock } = qrVersion(version).levels[level];
  const plan: { codeword: number; xor: number }[] = [];
  let total = 0;
  blockData.forEach((n, b) => {
    const k = perBlock(b);
    total += k;
    for (const i of pickDistinct(rand, n + ecPerBlock, k))
      plan.push({
        codeword: symbolIndex(version, level, b, i),
        xor: 1 + Math.floor(rand() * 255),
      });
  });
  return { plan, total };
}

describe('Review Focus 3: codeword damage', () => {
  const FORCED: readonly (readonly [number | 'auto', QrEcLevel | undefined])[] = [
    ['auto', undefined],
    [5, 'Q'],
    [10, 'H'],
    [20, 'M'],
    [40, 'L'],
    [1, 'L'],
    [1, 'M'],
    [2, 'L'],
  ];

  it('symbolIndex matches the interleaving', () => {
    // 5-Q: 2 blocks of 15 and 2 of 16 data codewords.
    expect(symbolIndex(5, 'Q', 0, 0)).toBe(0);
    expect(symbolIndex(5, 'Q', 3, 0)).toBe(3);
    expect(symbolIndex(5, 'Q', 1, 1)).toBe(5);
    expect(symbolIndex(5, 'Q', 2, 15)).toBe(60);
    expect(symbolIndex(5, 'Q', 3, 15)).toBe(61);
    expect(symbolIndex(5, 'Q', 0, 15)).toBe(62);
  });

  it('corrects up to the limit per block and detects one more (300 messages)', () => {
    const rand = rng(300);
    const miscorrectedToOriginal: string[] = [];
    const errorsGot: unknown[] = [];
    const errorsWant: unknown[] = [];
    const seen = new Set<string>();
    let beyondFailed = 0;
    let runs = 0;
    fc.assert(
      fc.property(gs1MessageArb, (msg) => {
        const raw = format(parse(toBracketed(msg), { validateAssociations: false }), 'raw');
        const [forcedVersion, forcedLevel] = FORCED[Math.floor(rand() * FORCED.length)] ?? [
          'auto',
          undefined,
        ];
        const level = forcedLevel ?? EC_LEVELS[Math.floor(rand() * 4)] ?? 'M';
        const s = symbolOf(raw, true, level, forcedVersion) ?? symbolOf(raw, true, level, 'auto');
        if (!s) return;
        runs++;
        const { m, version } = s;
        seen.add(`${version}-${level}`);
        const { correctable, blockData, ecPerBlock } = qrVersion(version).levels[level];
        const { plan, total } = damagePlan(rand, version, level, () =>
          Math.floor(rand() * (correctable + 1)),
        );
        const read = mustRead(damageQrCodewords(m, version, plan));
        expect(read.errorsCorrected).toBe(total);
        expect(read.codewords).toEqual(s.codewords);
        const t = mustText(read.codewords, read.version);
        expect(t.aimId + t.data).toBe(`]Q3${raw}`);

        const bad = Math.floor(rand() * blockData.length);
        const beyond = damagePlan(rand, version, level, (b) =>
          b === bad ? correctable + 1 : Math.floor(rand() * (correctable + 1)),
        );
        const r2 = readQr(damageQrCodewords(m, version, beyond.plan));
        if (r2.ok) {
          if (r2.value.codewords.every((c, i) => c === s.codewords[i]))
            miscorrectedToOriginal.push(`${version}-${level}`);
        } else {
          beyondFailed++;
          errorsGot.push([r2.errors[0]?.code, r2.errors[0]?.details]);
          errorsWant.push([
            'RS_UNCORRECTABLE',
            {
              block: bad,
              blocks: blockData.length,
              ecCodewords: ecPerBlock,
              capacity: correctable,
            },
          ]);
        }
      }),
      { numRuns: 300, seed: 7 },
    );
    expect(runs).toBeGreaterThan(250);
    expect(beyondFailed).toBeGreaterThan(runs - 10);
    expect(miscorrectedToOriginal).toEqual([]);
    expect(errorsGot).toEqual(errorsWant);
    for (const key of ['5-Q', '10-H', '20-M', '40-L', '1-L', '1-M', '2-L'])
      expect(seen.has(key)).toBe(true);
  }, 300_000);

  it('a mirrored symbol beyond RS reports RS_UNCORRECTABLE, not format', () => {
    const s = mustSymbol('0110012345678902', true, 'M', 2);
    const rand = rng(22);
    const { plan } = damagePlan(rand, 2, 'M', () => 9);
    const damaged = damageQrCodewords(s.m, 2, plan);
    for (const o of [
      { rotation: 0, mirrored: true },
      { rotation: 90, mirrored: true },
    ] as const) {
      const e = firstError(readQr(transform(damaged, o)));
      expect(e.code).toBe('RS_UNCORRECTABLE');
    }
  });

  it.each([
    [1, 'L', 2],
    [1, 'M', 4],
    [2, 'L', 4],
  ] as const)('%i-%s corrects %i errors and rejects one more', (version, level, limit) => {
    const { m } = mustSymbol('0110012345678902', true, level, version);
    const rand = rng(version * 10 + limit);
    for (let trial = 0; trial < 20; trial++) {
      const ok = damagePlan(rand, version, level, () => limit);
      expect(mustRead(damageQrCodewords(m, version, ok.plan)).errorsCorrected).toBe(limit);
      const over = damagePlan(rand, version, level, () => limit + 1);
      const e = firstError(readQr(damageQrCodewords(m, version, over.plan)));
      expect(e.code).toBe('RS_UNCORRECTABLE');
      expect(e.details).toMatchObject({ block: 0, blocks: 1, capacity: limit });
    }
  });
});

describe('Review Focus 3: format and version information', () => {
  const v = vectors.derived.find((d) => d.id === 'gs1-mixed-modes');
  if (!v) throw new Error('no vector');
  const canonical = qrRowsToMatrix(v.rows);
  const [f1, f2] = formatCells(canonical.width);

  it('3 bit errors in each format copy still decode', () => {
    const rand = rng(3);
    for (let trial = 0; trial < 50; trial++) {
      const cells = [
        ...pickDistinct(rand, 15, 3).map((i): [number, number] => f1[i] ?? [0, 0]),
        ...pickDistinct(rand, 15, 3).map((i): [number, number] => f2[i] ?? [0, 0]),
      ];
      expect(scanOf(flipped(canonical, cells))).toBe(v.scan);
    }
  });

  it('either format copy fully inverted still decodes', () => {
    expect(scanOf(flipped(canonical, f1))).toBe(v.scan);
    expect(scanOf(flipped(canonical, f2))).toBe(v.scan);
  });

  it('both copies inverted read as the complementary format code, never the data', () => {
    // The all-ones word is in the BCH(15,5) code, so a fully inverted copy is another valid
    // format word (H mask 1 here): the decoder takes it and RS then fails.
    const r = readQr(flipped(canonical, [...f1, ...f2]));
    expect(r.ok).toBe(false);
  });

  it('both copies destroyed give format', () => {
    // 4 bit errors in each copy, towards no other code word.
    const e = firstError(readQr(flipped(canonical, [...f1.slice(0, 4), ...f2.slice(0, 4)])));
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details).toMatchObject({ reason: 'format', x: 8, y: 0 });
  });

  it('a transposed symbol with both format copies destroyed reports the location in the input', () => {
    const damaged = flipped(canonical, [...f1.slice(0, 4), ...f2.slice(0, 4)]);
    const e = firstError(
      readQr(bordered(transform(damaged, { rotation: 90, mirrored: false }), 2)),
    );
    // Canonical (8, 0) after a 90-degree turn is at x = s - 1, y = 8, plus the border.
    expect(e.details).toMatchObject({ reason: 'format', x: canonical.width - 1 + 2, y: 8 + 2 });
  });

  it.each([7, 20, 40])('version %i with 3 errors per version copy decodes', (version) => {
    const s = mustSymbol('0110012345678902', true, 'L', version);
    const [a, b] = versionCells(s.m.width);
    const rand = rng(version);
    for (let trial = 0; trial < 10; trial++) {
      const cells = [
        ...pickDistinct(rand, 18, 3).map((i): [number, number] => a[i] ?? [0, 0]),
        ...pickDistinct(rand, 18, 3).map((i): [number, number] => b[i] ?? [0, 0]),
      ];
      const read = mustRead(flipped(s.m, cells));
      expect(read.version).toBe(version);
      expect(mustText(read.codewords, read.version).data).toBe('0110012345678902');
    }
  });

  it.each([7, 20])(
    'version %i with a copy rewritten to the next version gives version',
    (version) => {
      const s = mustSymbol('0110012345678902', true, 'L', version);
      const [a, b] = versionCells(s.m.width);
      for (const [cells, x, y] of [
        [a, s.m.width - 11, 0],
        [b, 0, s.m.width - 11],
      ] as const) {
        const e = firstError(readQr(written(s.m, cells, versionBits(version + 1))));
        expect(e.code).toBe('INVALID_SYMBOL');
        expect(e.details).toMatchObject({ reason: 'version', x, y });
      }
    },
  );

  it('unreadable version information is ignored', () => {
    const s = mustSymbol('0110012345678902', true, 'L', 7);
    const [a, b] = versionCells(s.m.width);
    const m = written(written(s.m, a, versionBits(7) ^ 0b1111), b, versionBits(7) ^ 0b11110000);
    expect(mustRead(m).version).toBe(7);
  });

  it('more than a quarter of the timing modules wrong gives timing', () => {
    // Version 2: 9 timing modules per line, 18 in all; 4 wrong pass, 5 fail.
    const s = mustSymbol('0110012345678902', true, 'L', 2);
    const size = s.m.width;
    const timing: [number, number][] = [];
    for (let i = 8; i <= size - 9; i++) timing.push([i, 6], [6, i]);
    expect(timing).toHaveLength(18);
    expect(mustRead(flipped(s.m, timing.slice(0, 4))).version).toBe(2);
    const e = firstError(readQr(flipped(s.m, timing.slice(0, 5))));
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details).toMatchObject({ reason: 'timing', x: 8, y: 6 });
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 2: hostile input

function safe(r: Result<unknown>): boolean {
  return r.ok ? true : r.errors.every((e) => e instanceof Gs1Error);
}

function failsSafely(v: unknown): boolean {
  let r: Result<QrRead>;
  try {
    r = readQr(v);
  } catch {
    return false;
  }
  return !r.ok && r.errors.every((e) => e instanceof Gs1Error);
}

function darkMatrix(w: number, h: number): ModuleMatrix {
  return matrixFromRows(Array.from({ length: h }, () => '1'.repeat(w)));
}

describe('Review Focus 2: hostile input', () => {
  it('never throws on random values (2,000 runs)', () => {
    fc.assert(
      fc.property(fc.anything({ withObjectString: true, withNullPrototype: true }), (v) => {
        expect(failsSafely(v)).toBe(true);
        expect(failsSafely({ kind: 'matrix', rows: v })).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });

  it('never throws on random 0/1 grids (300 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 45 }),
        fc.array(fc.array(fc.boolean(), { minLength: 45, maxLength: 45 }), {
          minLength: 1,
          maxLength: 45,
        }),
        (w, grid) => {
          const rows = grid.map((r) =>
            r
              .slice(0, w)
              .map((b) => (b ? '1' : '0'))
              .join(''),
          );
          expect(safe(readQr({ kind: 'matrix', rows }))).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('rejects ragged rows, wrong characters, 0 and 2,000 rows, getters and proxies', () => {
    const throwing = {
      kind: 'matrix',
      get rows(): never {
        throw new Error('boom');
      },
    };
    const rowThrows = {
      kind: 'matrix',
      rows: new Proxy(['1010'], {
        get(t, p): unknown {
          if (p === '0') throw new Error('boom');
          return Reflect.get(t, p);
        },
      }),
    };
    const proxy = new Proxy(
      {},
      {
        get(): never {
          throw new Error('boom');
        },
        getPrototypeOf(): never {
          throw new Error('boom');
        },
      },
    );
    for (const input of [
      undefined,
      null,
      42,
      'matrix',
      { kind: 'matrix', rows: ['101', '10'] },
      { kind: 'matrix', rows: ['10x', '101'] },
      { kind: 'matrix', rows: [] },
      { kind: 'matrix', rows: Array.from({ length: 2000 }, () => '1') },
      { kind: 'matrix', rows: [[1, 0, 1]] },
      { kind: 'pattern', rows: ['1'] },
      throwing,
      rowThrows,
      proxy,
    ])
      expect(failsSafely(input)).toBe(true);
  });

  it('a non-square symbol and a square of side 22 are size', () => {
    for (const [w, h] of [
      [25, 21],
      [22, 22],
    ] as const) {
      const e = firstError(readQr(darkMatrix(w, h)));
      expect(e.code).toBe('INVALID_SYMBOL');
      expect(e.details).toMatchObject({ reason: 'size', rows: h, columns: w });
    }
    const light = firstError(readQr(matrixFromRows(['000', '000'])));
    expect(light.details).toMatchObject({ reason: 'size', rows: 2, columns: 3 });
  });

  it('a symbol without three finders is finder', () => {
    const v = vectors.derived.find((d) => d.id === 'iso-annex-01234567');
    if (!v) throw new Error('no vector');
    const m = qrRowsToMatrix(v.rows);
    // Wipe the top left finder (33 wrong) and darken the bottom right corner (16 wrong): the
    // failing finder is the better of the two, reported at its top left module.
    const tl: [number, number][] = [];
    const br: [number, number][] = [];
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        tl.push([x, y]);
        br.push([14 + x, 14 + y]);
      }
    const damaged = written(written(m, tl.slice(0, 25), 0), tl.slice(25), 0);
    const dark = written(written(damaged, br.slice(0, 25), 0x1ffffff), br.slice(25), 0xffffff);
    const e = firstError(readQr(bordered(dark, 3)));
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details).toMatchObject({ reason: 'finder', x: 17, y: 17 });
  });

  it('reads 177 x 177 random bits in under 1 s', () => {
    const rand = rng(177);
    const rows = Array.from({ length: 177 }, () => {
      let s = '';
      for (let x = 0; x < 177; x++) s += rand() < 0.5 ? '1' : '0';
      return s;
    });
    const m = matrixFromRows(rows);
    const t0 = performance.now();
    const r = readQr(m);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(false);
  });

  it('reads 177 x 177 random bits with real finders and timing in under 1 s', () => {
    const rand = rng(1770);
    const base = buildSymbol(
      40,
      'L',
      Array.from({ length: 2956 }, () => 0),
      0,
    );
    const fn = base.rows.map((r) => r.split(''));
    // Keep the finders and timing, randomise the rest (format and data).
    for (let y = 0; y < 177; y++)
      for (let x = 0; x < 177; x++) {
        const keep =
          (x < 8 && y < 8) || (x > 168 && y < 8) || (x < 8 && y > 168) || x === 6 || y === 6;
        const row = fn[y];
        if (row && !keep) row[x] = rand() < 0.5 ? '1' : '0';
      }
    const m = matrixFromRows(fn.map((r) => r.join('')));
    const t0 = performance.now();
    const r = readQr(m);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(false);
  });

  it('never throws on random codeword streams (2,000 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 80 }),
        (version, cws) => {
          expect(safe(decodeBits(cws, version))).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('rejects codewords that are not bytes and versions out of range', () => {
    for (const bad of [[-1], [256], [1.5], [Number.NaN]]) {
      const e = firstError(decodeBits(bad, 1));
      expect(e.details).toMatchObject({ reason: 'codeword', codeword: 0 });
    }
    // oxlint-disable-next-line no-unsafe-type-assertion -- hostile input on purpose
    const notArray = firstError(decodeBits(42 as unknown as number[], 1));
    expect(notArray.code).toBe('INVALID_SYMBOL');
    for (const version of [0, 41, 1.5, Number.NaN]) {
      const e = firstError(decodeBits([0], version));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.details).toMatchObject({ option: 'version' });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Modes

describe('modes', () => {
  it('ECI 26 (8, 16 and 24-bit designators)', () => {
    const t = mustViaSymbol(bytes(new Bits().put(0b0111, 4).put(26, 8), 'AB'));
    expect(t).toMatchObject({ aimId: ']Q1', data: 'AB', special: { reason: 'eci', eci: 26 } });
    const t16 = mustViaSymbol(bytes(new Bits().put(0b0111, 4).put(0b10, 2).put(1000, 14), 'A'));
    expect(t16.special).toEqual({ reason: 'eci', eci: 1000 });
    const t24 = mustViaSymbol(bytes(new Bits().put(0b0111, 4).put(0b110, 3).put(999_999, 21), 'A'));
    expect(t24.special).toEqual({ reason: 'eci', eci: 999_999 });
    // B1 takes 20 bits; the designator 0xFF (prefix 111) starts at bit 24, in codeword 3.
    const bad = firstError(viaSymbol(bytes(new Bits(), 'A').put(0b0111, 4).put(0xff, 8)));
    expect(bad.details).toMatchObject({ reason: 'codeword', codeword: 3 });
    const big = firstError(viaSymbol(new Bits().put(0b0111, 4).put(0b110, 3).put(1_000_000, 21)));
    expect(big.details).toMatchObject({ reason: 'codeword', codeword: 0 });
  });

  it('the first special feature wins', () => {
    const t = mustViaSymbol(
      bytes(new Bits().put(0b0111, 4).put(3, 8).put(0b0111, 4).put(26, 8), 'A'),
    );
    expect(t.special).toEqual({ reason: 'eci', eci: 3 });
  });

  it('structured append (position, total, parity)', () => {
    const t = mustViaSymbol(
      bytes(new Bits().put(0b0011, 4).put(2, 4).put(3, 4).put(0x5a, 8), 'AB'),
    );
    expect(t).toMatchObject({
      aimId: ']Q1',
      data: 'AB',
      special: { reason: 'structured-append', position: 2, total: 4, parity: 0x5a },
    });
  });

  it('FNC1 in second position with application indicator 37', () => {
    const t = mustViaSymbol(alnum(new Bits().put(0b1001, 4).put(37, 8), 'AB%C'));
    expect(t).toMatchObject({
      aimId: ']Q5',
      data: `37AB${GS}C`,
      special: { reason: 'fnc1-second', applicationIndicator: 37 },
    });
    const letter = mustViaSymbol(bytes(new Bits().put(0b1001, 4).put(165, 8), 'x'));
    expect(letter.data).toBe('Ax');
  });

  it('FNC1 indicators after data are codeword errors', () => {
    for (const indicator of [0b0101, 0b1001, 0b0011]) {
      // B4 takes 44 bits: the indicator starts in codeword 5.
      const e = firstError(viaSymbol(bytes(new Bits(), 'ABCD').put(indicator, 4).put(0, 16)));
      expect(e.details).toMatchObject({ reason: 'codeword', codeword: 5 });
    }
  });

  it('Kanji', () => {
    // Shift JIS 0x935F: 0x935F - 0x8140 = 0x121F, 0x12 * 0xC0 + 0x1F = 0xD9F.
    // Shift JIS 0xE4AA: 0xE4AA - 0xC140 = 0x236A, 0x23 * 0xC0 + 0x6A = 0x1AAA.
    const t = mustViaSymbol(
      new Bits().put(0b1000, 4).put(2, countBits('kanji', 2)).put(0xd9f, 13).put(0x1aaa, 13),
    );
    expect(t).toMatchObject({
      aimId: ']Q1',
      data: '\u0093_äª',
      segments: [{ mode: 'kanji', count: 2 }],
      special: { reason: 'kanji' },
    });
  });

  it('a truncated terminator: data filling the capacity exactly, or 3 bits left', () => {
    const exact = numeric(new Bits(), '1234567890123456789012345678901234', 1);
    expect(exact.bits).toHaveLength(128);
    const t = mustViaSymbol(exact, 1, 'M');
    expect(t.data).toBe('1234567890123456789012345678901234');
    expect(t.dataBits).toBe(128);
    const short = numeric(numeric(new Bits(), '123', 1), '12345678901234567890123456', 1);
    expect(short.bits).toHaveLength(125);
    expect(mustViaSymbol(short, 1, 'M').data).toBe('12312345678901234567890123456');
  });

  it('bits after the terminator are not checked', () => {
    const cw = numeric(new Bits(), '12', 1).codewords(1, 'M');
    cw[5] = 0x7b;
    cw[15] = 0xff;
    expect(mustText(cw, 1).data).toBe('12');
  });

  it('out-of-range numeric and alphanumeric values are codeword errors', () => {
    const cases: [Bits, number][] = [
      [new Bits().put(0b0001, 4).put(3, 10).put(1000, 10), 1],
      [new Bits().put(0b0001, 4).put(2, 10).put(100, 7), 1],
      [new Bits().put(0b0001, 4).put(1, 10).put(10, 4), 1],
      [new Bits().put(0b0010, 4).put(2, 9).put(2025, 11), 1],
      [new Bits().put(0b0010, 4).put(1, 9).put(45, 6), 1],
    ];
    for (const [b, codeword] of cases) {
      const e = firstError(viaSymbol(b));
      expect(e.code).toBe('INVALID_SYMBOL');
      expect(e.details).toMatchObject({ reason: 'codeword', codeword });
    }
  });

  it('a count longer than the remaining bits is a codeword error', () => {
    // N8 takes 41 bits; the byte count field starts at bit 45, in codeword 5.
    const b = numeric(new Bits(), '12345678').put(0b0100, 4).put(200, 8);
    const e = firstError(viaSymbol(b, 1, 'M'));
    expect(e.details).toMatchObject({ reason: 'codeword', codeword: 5 });
    for (const mode of [0b0001, 0b0010, 0b1000]) {
      const n = firstError(viaSymbol(new Bits().put(mode, 4).put(255, 8), 1, 'M'));
      expect(n.details).toMatchObject({ reason: 'codeword', codeword: 0 });
    }
  });

  it('a truncated count field or header is a codeword error', () => {
    // 1-M holds 128 bits: B14 takes 4 + 8 + 112 = 124, then a byte indicator and no count.
    const cw = bytes(new Bits(), 'ABCDEFGHIJKLMN', 1).put(0b0100, 4).codewords(1, 'M');
    const e = firstError(decodeBits(cw, 1));
    expect(e.details).toMatchObject({ reason: 'codeword', codeword: 15 });
    for (const header of [0b0111, 0b0011, 0b1001]) {
      const h = bytes(new Bits(), 'ABCDEFGHIJKLMN', 1).put(header, 4).codewords(1, 'M');
      expect(firstError(decodeBits(h, 1)).details).toMatchObject({ reason: 'codeword' });
    }
  });

  it('an unknown mode indicator 0110 is a codeword error', () => {
    const b = numeric(new Bits(), '12345678').put(0b0110, 4);
    const e = firstError(viaSymbol(b, 1, 'M'));
    expect(e.details).toMatchObject({ reason: 'codeword', codeword: 5 });
  });

  it('the % rule applies under FNC1 only', () => {
    const gs1 = mustViaSymbol(alnum(new Bits().put(0b0101, 4), 'A%%B%C'));
    expect(gs1).toMatchObject({ aimId: ']Q3', data: `A%B${GS}C` });
    const plain = mustViaSymbol(alnum(new Bits(), 'A%%B%C'));
    expect(plain).toMatchObject({ aimId: ']Q1', data: 'A%%B%C' });
    expect(plain.segments).toEqual([{ mode: 'alphanumeric', count: 6 }]);
    const bytesGs = mustViaSymbol(bytes(new Bits().put(0b0101, 4), `A%${GS}B`));
    expect(bytesGs.data).toBe(`A%${GS}B`);
  });

  it('count fields follow the version group', () => {
    for (const version of [9, 10, 26, 27]) {
      const b = alnum(numeric(bytes(new Bits(), 'ab', version), '123', version), 'XY', version);
      const t = mustText(b.codewords(version, 'L'), version);
      expect(t.data).toBe('ab123XY');
    }
  });

  it('formatBits of the format test vector', () => {
    expect(formatBits('H', 1)).toBe(0x13be);
  });
});
