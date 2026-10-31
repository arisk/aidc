import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/qr.json' with { type: 'json' };
import { QR_POLY, gf256 } from '../../../src/core/gf256.ts';
import { rsEncode } from '../../../src/core/reed-solomon.ts';
import { maskBit, penalty } from '../../../src/symbology/matrix/qr-mask.ts';
import {
  buildSymbol,
  chosenMask,
  codewordModules,
  dataOrder,
  deinterleave,
  functionMap,
  interleave,
  penaltyScores,
  readCodewords,
} from '../../../src/symbology/matrix/qr-place.ts';
import { EC_LEVELS, qrVersion } from '../../../src/symbology/matrix/qr-tables.ts';
import type { QrEcLevel } from '../../../src/symbology/matrix/qr-tables.ts';
import { damageQrCodewords, matrixBits, qrRowsToMatrix } from '../../support/matrix.ts';

const field = gf256(QR_POLY);

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

const symbols = [...vectors.figures, ...vectors.derived, ...vectors.engine].map((v) => ({
  id: v.id,
  version: v.version,
  level: toLevel(v.level),
  mask: v.mask,
  bwipp: 'penaltyMask' in v ? v.penaltyMask.bwipp : v.mask,
  data: hex(v.dataCodewords),
  rows: v.rows,
}));

/** Random (version, level, full-length data codewords) triples. */
const tripleArb = fc
  .record({
    version: fc.integer({ min: 1, max: 40 }),
    level: fc.constantFrom(...EC_LEVELS),
    seed: fc.integer({ min: 0, max: 0x7fffffff }),
  })
  .map(({ version, level, seed }) => {
    let x = seed | 1;
    const n = qrVersion(version).levels[level].dataCodewords;
    const data = Array.from({ length: n }, () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return x & 0xff;
    });
    return { version, level, data };
  });

describe('function patterns and zigzag order', () => {
  it('leaves exactly the raw data modules free for every version', () => {
    for (const row of vectors.tables.versions) {
      const map = functionMap(row.version);
      expect(map.length).toBe(row.size * row.size);
      let free = 0;
      for (const v of map) if (v === 0) free++;
      expect(free, `v${row.version}`).toBe(row.dataModules);
    }
  });

  it('visits every free module once, never in column 6', () => {
    for (let version = 1; version <= 40; version++) {
      const map = functionMap(version);
      const order = dataOrder(version);
      const size = qrVersion(version).size;
      const seen = new Uint8Array(map.length);
      let bad = 0;
      for (const i of order) {
        if (map[i] !== 0 || seen[i] !== 0 || i % size === 6) bad++;
        seen[i] = 1;
      }
      expect(bad, `v${version}`).toBe(0);
      expect(order.length).toBe(map.reduce((n, v) => n + (v === 0 ? 1 : 0), 0));
    }
  }, 30_000);

  it('starts at the bottom right corner going up in pairs', () => {
    const order = dataOrder(1);
    expect(Array.from(order.subarray(0, 4))).toEqual([
      20 * 21 + 20,
      20 * 21 + 19,
      19 * 21 + 20,
      19 * 21 + 19,
    ]);
  });

  it('codewordModules maps each codeword bit to a distinct data module', () => {
    for (let version = 1; version <= 40; version++) {
      const map = functionMap(version);
      const modules = codewordModules(version);
      expect(modules.length).toBe(qrVersion(version).totalCodewords * 8);
      expect(new Set(modules).size).toBe(modules.length);
      for (const i of modules) expect(map[i]).toBe(0);
    }
  });
});

describe('interleaving', () => {
  it('reproduces the ISO "01234567" 1-M codewords', () => {
    const data = hex('10200C566180EC11EC11EC11EC11EC11');
    expect(Array.from(interleave(1, 'M', data))).toEqual([...data, ...hex('A524D4C1ED36C7872C55')]);
  });

  it.each(vectors.derived.map((v) => [v.id, v] as const))('%s interleaves', (_, v) => {
    expect(Array.from(interleave(v.version, toLevel(v.level), hex(v.dataCodewords)))).toEqual(
      hex(v.interleavedCodewords),
    );
  });

  it('deinterleave inverts interleave, each block its data then its EC', () => {
    fc.assert(
      fc.property(tripleArb, ({ version, level, data }) => {
        const info = qrVersion(version).levels[level];
        const blocks = deinterleave(version, level, interleave(version, level, data));
        expect(blocks.map((b) => b.length - info.ecPerBlock)).toEqual(info.blockData);
        let offset = 0;
        for (const b of blocks) {
          const n = b.length - info.ecPerBlock;
          const d = b.subarray(0, n);
          expect(Array.from(d)).toEqual(data.slice(offset, offset + n));
          expect(b.subarray(n)).toEqual(rsEncode(field, d, info.ecPerBlock, 0));
          offset += n;
        }
      }),
      { numRuns: 100 },
    );
  });

  it('rejects data of the wrong length', () => {
    expect(() => interleave(1, 'M', [1, 2, 3])).toThrow(RangeError);
  });
});

describe('buildSymbol', () => {
  it.each(symbols.map((s) => [s.id, s] as const))('%s: forced mask gives the rows', (_, s) => {
    const m = buildSymbol(s.version, s.level, s.data, s.mask);
    expect(m).toEqual(qrRowsToMatrix(s.rows));
    expect(m.symbology).toBeUndefined();
    expect(chosenMask(m)).toBe(s.mask);
  });

  it.each(symbols.map((s) => [s.id, s] as const))('%s: auto picks the BWIPP mask', (_, s) => {
    const m = buildSymbol(s.version, s.level, s.data, 'auto');
    expect(chosenMask(m)).toBe(s.bwipp);
    expect(m).toEqual(buildSymbol(s.version, s.level, s.data, s.bwipp));
  });

  it('rejects out-of-range masks, wrong module counts and unreadable format information', () => {
    const data = Array.from({ length: 16 }, () => 0);
    expect(() => buildSymbol(1, 'M', data, 8)).toThrow(RangeError);
    expect(() => buildSymbol(1, 'M', data, 1.5)).toThrow(RangeError);
    expect(() => maskBit(-1, 0, 0)).toThrow(RangeError);
    expect(() => readCodewords(1, new Uint8Array(21 * 21), 8)).toThrow(RangeError);
    expect(() => readCodewords(1, new Uint8Array(20), 0)).toThrow(
      expect.objectContaining({ code: 'INVALID_SYMBOL' }),
    );
    expect(() =>
      chosenMask(qrRowsToMatrix(Array.from({ length: 21 }, () => ' '.repeat(21)))),
    ).toThrow(RangeError);
  });

  it('draws the version information for v >= 7', () => {
    const m = buildSymbol(
      7,
      'L',
      Array.from({ length: 156 }, () => 0),
      0,
    );
    const s = 45;
    for (let i = 0; i < 18; i++) {
      const bit = (0x07c94 >> i) & 1 ? '1' : '0';
      expect(m.rows[Math.floor(i / 3)]?.[s - 11 + (i % 3)]).toBe(bit);
      expect(m.rows[s - 11 + (i % 3)]?.[Math.floor(i / 3)]).toBe(bit);
    }
  });

  it('readCodewords inverts placement for random symbols', () => {
    fc.assert(
      fc.property(tripleArb, fc.integer({ min: 0, max: 8 }), ({ version, level, data }, m) => {
        const symbol = buildSymbol(version, level, data, m === 8 ? 'auto' : m);
        const mask = chosenMask(symbol);
        expect(mask).toBe(m === 8 ? mask : m);
        expect(readCodewords(version, matrixBits(symbol), mask)).toEqual(
          interleave(version, level, data),
        );
      }),
      { numRuns: 200 },
    );
  }, 30_000);

  it('damageQrCodewords flips exactly the planned codeword bits', () => {
    fc.assert(
      fc.property(
        tripleArb,
        fc.array(fc.record({ codeword: fc.nat(), xor: fc.integer({ min: 1, max: 255 }) }), {
          maxLength: 6,
        }),
        ({ version, level, data }, raw) => {
          const total = qrVersion(version).totalCodewords;
          const plan = raw.map((p) => ({ codeword: p.codeword % total, xor: p.xor }));
          const symbol = buildSymbol(version, level, data, 'auto');
          const mask = chosenMask(symbol);
          const expected = interleave(version, level, data);
          for (const p of plan) expected[p.codeword] = (expected[p.codeword] ?? 0) ^ p.xor;
          const damaged = damageQrCodewords(symbol, version, plan);
          expect(readCodewords(version, matrixBits(damaged), mask)).toEqual(expected);
          expect(chosenMask(damaged)).toBe(mask);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe('masks and penalty', () => {
  it('evaluates the eight mask conditions (QR research 3.1)', () => {
    const conditions = [
      (x: number, y: number) => (x + y) % 2 === 0,
      (_: number, y: number) => y % 2 === 0,
      (x: number) => x % 3 === 0,
      (x: number, y: number) => (x + y) % 3 === 0,
      (x: number, y: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
      (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    for (let mask = 0; mask < 8; mask++)
      for (let y = 0; y < 30; y++)
        for (let x = 0; x < 30; x++) expect(maskBit(mask, x, y)).toBe(conditions[mask]?.(x, y));
  });

  it('scores an all-light matrix as N1 + N2 + N4', () => {
    // N1: 42 lines of 21 give 19 each; N2: 20 x 20 blocks of 3; N4: 0% dark gives 100.
    expect(penalty(new Uint8Array(21 * 21), 21)).toBe(42 * 19 + 400 * 3 + 100);
  });

  it('equals a direct transcription of QR research 3.2 on random matrices', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }).chain((v) => {
          const size = 17 + 4 * v;
          return fc.tuple(
            fc.constant(size),
            fc.uint8Array({ minLength: size * size, maxLength: size * size, max: 1 }),
            fc.integer({ min: 1, max: 9 }),
          );
        }),
        ([size, raw, runScale]) => {
          // Stretch runs horizontally so that long runs and scaled patterns occur.
          const bits = raw.map((_, i) => raw[Math.floor(i / runScale)] ?? 0);
          expect(penalty(bits, size)).toBe(referencePenalty(bits, size));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('reference N3 counts 1:1:3:1:1 and 2:2:6:2:2 runs with a light margin of 4 or the edge', () => {
    expect(n3Of('1011101')).toBe(40);
    expect(n3Of('00001011101')).toBe(40);
    expect(n3Of('01011101000')).toBe(40); // first dark run: the quiet zone is the margin
    expect(n3Of('1101011101011')).toBe(0);
    expect(n3Of('11010000101110101')).toBe(40);
    expect(n3Of('11010001011101011')).toBe(0);
    expect(n3Of('1011001111110011010')).toBe(0);
    expect(n3Of('1100111111001100000')).toBe(40);
    expect(n3Of('11001111110011')).toBe(40);
    expect(n3Of('10111010111010000')).toBe(80);
  });

  it.each(vectors.penaltyExamples.map((p) => [p.id, p] as const))(
    '%s: BWIPP scores and argmin',
    (id, p) => {
      const v = vectors.derived.find((d) => d.id === id);
      if (!v) throw new Error(`no vector ${id}`);
      const scores = penaltyScores(p.version, toLevel(p.level), hex(v.dataCodewords));
      expect(scores).toEqual(p.bwippScores);
      expect(scores.indexOf(Math.min(...scores))).toBe(p.bwippMask);
    },
  );
});

/** `n3Line` of a '0'/'1' string. */
function n3Of(pattern: string): number {
  return n3Line(Array.from(pattern, (c) => (c === '1' ? 1 : 0)));
}

/** N3 of one line, transcribed from QR research 3.2. */
function n3Line(line: readonly number[]): number {
  const r: number[] = [0];
  let colour = 0;
  for (const b of line) {
    if (b !== colour) {
      r.push(0);
      colour = b;
    }
    r[r.length - 1] = (r[r.length - 1] ?? 0) + 1;
  }
  const len = r.length;
  const at = (i: number) => r[i] ?? 0;
  let n = 0;
  for (let i = 3; i <= len - 3; i += 2) {
    const k = at(i) / 3;
    if (at(i) % 3 !== 0) continue;
    if (at(i - 2) !== k || at(i - 1) !== k || at(i + 1) !== k || at(i + 2) !== k) continue;
    if (i === 3 || i + 4 >= len || at(i - 3) >= 4 || at(i + 3) >= 4) n += 40;
  }
  return n;
}

/** N1 + N2 + N3 + N4 of QR research 3.2, written for clarity rather than speed. */
function referencePenalty(bits: Uint8Array, size: number): number {
  const get = (x: number, y: number) => bits[y * size + x] ?? 0;
  const lines: number[][] = [];
  for (let y = 0; y < size; y++) lines.push(Array.from({ length: size }, (_, x) => get(x, y)));
  for (let x = 0; x < size; x++) lines.push(Array.from({ length: size }, (_, y) => get(x, y)));
  let score = 0;
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    score += n3Line(line);
  }
  for (let y = 0; y + 1 < size; y++)
    for (let x = 0; x + 1 < size; x++) {
      const c = get(x, y);
      if (get(x + 1, y) === c && get(x, y + 1) === c && get(x + 1, y + 1) === c) score += 3;
    }
  const total = size * size;
  const dark = bits.reduce((n, b) => n + b, 0);
  return score + 10 * Math.floor(Math.abs(20 * dark - 10 * total) / total);
}
