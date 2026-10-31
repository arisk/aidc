import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DM_POLY, QR_POLY, gf256 } from '../../src/core/gf256.ts';
import { rsDecode, rsEncode, rsGenerator } from '../../src/core/reed-solomon.ts';
import { Gs1Error } from '../../src/core/errors.ts';
import vectors from '../vectors/datamatrix.json' with { type: 'json' };

const DM = gf256(DM_POLY);
const QR = gf256(QR_POLY);

const rs = vectors.rs;
type Vector = (typeof rs.vectors)[number];
type Published = Extract<Vector, { ec: number[] }>;
type Sized = Extract<Vector, { blocks: number }>;
const published = rs.vectors.filter((v): v is Published => 'ec' in v);
const sized = rs.vectors.filter((v): v is Sized => 'blocks' in v);

describe('rsGenerator', () => {
  it('matches the ISO 16022 generator for 5 check codewords', () => {
    expect(Array.from(rsGenerator(DM, 5, 1))).toEqual([1, 62, 111, 15, 48, 228]);
  });

  it('matches every generator in the vector file', () => {
    for (const [ec, g] of Object.entries(rs.generators)) {
      expect(Array.from(rsGenerator(DM, Number(ec), 1))).toEqual(g);
    }
  });

  it('is cached and handles zero check codewords', () => {
    expect(rsGenerator(DM, 7, 1)).toBe(rsGenerator(DM, 7, 1));
    expect(Array.from(rsGenerator(DM, 0, 1))).toEqual([1]);
  });

  it('rejects invalid ecLength and firstRoot', () => {
    for (const [ec, root] of [
      [-1, 1],
      [255, 1],
      [1.5, 1],
      [5, -1],
      [5, 0.5],
    ] as const) {
      expect(() => rsGenerator(DM, ec, root)).toThrow(Gs1Error);
    }
  });
});

describe('rsEncode', () => {
  it('reproduces the Guideline Annex A example', () => {
    expect(Array.from(rsEncode(DM, Uint8Array.of(142, 164, 186), 5, 1))).toEqual([
      114, 25, 5, 88, 102,
    ]);
  });

  it('reproduces the ISO 18004 Annex I 1-M example (QR field, first root 0)', () => {
    const data = Uint8Array.of(
      16,
      32,
      12,
      86,
      97,
      128,
      236,
      17,
      236,
      17,
      236,
      17,
      236,
      17,
      236,
      17,
    );
    expect(Array.from(rsEncode(QR, data, 10, 0))).toEqual([
      165, 36, 212, 193, 237, 54, 199, 135, 44, 85,
    ]);
  });

  it('matches the published stream', () => {
    expect(published.length).toBeGreaterThan(0);
    for (const v of published) {
      expect(Array.from(rsEncode(DM, Uint8Array.from(v.data), v.ec.length, 1))).toEqual(v.ec);
    }
  });

  it('matches the bwip-js interleaved streams of every size vector', () => {
    expect(published.length + sized.length).toBe(rs.vectors.length);
    for (const v of sized) {
      const ecPer = v.ecInterleaved.length / v.blocks;
      const slot = (b: number): number => (v.id.startsWith('size:144x144') ? (b + 2) % 10 : b);
      for (let b = 0; b < v.blocks; b++) {
        const data = Uint8Array.from(v.paddedData.filter((_, i) => i % v.blocks === b));
        const expected = Array.from(
          { length: ecPer },
          (_, j) => v.ecInterleaved[j * v.blocks + slot(b)],
        );
        expect(Array.from(rsEncode(DM, data, ecPer, 1)), `${v.id} block ${b}`).toEqual(expected);
      }
    }
  });

  it('returns an empty parity for ecLength 0 and for empty data', () => {
    expect(rsEncode(DM, Uint8Array.of(1, 2, 3), 0, 1).length).toBe(0);
    expect(Array.from(rsEncode(DM, new Uint8Array(0), 5, 1))).toEqual([0, 0, 0, 0, 0]);
  });

  it('gives all-zero parity for all-zero data', () => {
    expect(Array.from(rsEncode(QR, new Uint8Array(20), 7, 0))).toEqual(
      Array.from({ length: 7 }, () => 0),
    );
  });
});

const fields = [
  ['DM field, root 1', DM, 1],
  ['DM field, root 0', DM, 0],
  ['QR field, root 0', QR, 0],
  ['QR field, root 1', QR, 1],
] as const;

const sample: fc.Arbitrary<Sample> = fc.record({
  ec: fc.integer({ min: 1, max: 68 }),
  extra: fc.integer({ min: 1, max: 255 }),
  bytes: fc.uint8Array({ minLength: 255, maxLength: 255 }),
  values: fc.uint8Array({ minLength: 255, maxLength: 255 }),
  order: fc.shuffledSubarray(
    Array.from({ length: 255 }, (_, i) => i),
    {
      minLength: 255,
      maxLength: 255,
    },
  ),
});
interface Sample {
  ec: number;
  extra: number;
  bytes: Uint8Array;
  values: Uint8Array;
  order: number[];
}

function build(
  s: Sample,
  field: typeof DM,
  root: number,
): { block: Uint8Array; positions: number[]; ec: number; n: number } {
  const dataLen = Math.min(s.extra, 255 - s.ec);
  const data = s.bytes.slice(0, dataLen);
  const block = new Uint8Array(dataLen + s.ec);
  block.set(data);
  block.set(rsEncode(field, data, s.ec, root), dataLen);
  return { block, positions: s.order.filter((p) => p < block.length), ec: s.ec, n: block.length };
}

function flip(block: Uint8Array, index: number, mask: number): void {
  block[index] = (block[index] ?? 0) ^ mask;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function corrupt(
  block: Uint8Array,
  positions: number[],
  values: Uint8Array,
  count: number,
): Uint8Array {
  const out = block.slice();
  for (let i = 0; i < count; i++) {
    flip(out, positions[i] ?? 0, ((values[i] ?? 0) % 255) + 1);
  }
  return out;
}

const cfg = { seed: 20261012, numRuns: 500 };

describe.each(fields)('rsDecode properties (%s)', (_name, field, root) => {
  it('leaves an untouched block alone', () => {
    fc.assert(
      fc.property(sample, (s) => {
        const { block, ec } = build(s, field, root);
        const copy = block.slice();
        expect(rsDecode(field, copy, ec, root, Math.floor(ec / 2))).toBe(0);
        expect(copy).toEqual(block);
      }),
      cfg,
    );
  });

  it('corrects up to floor(ec/2) errors', () => {
    fc.assert(
      fc.property(sample, fc.nat(100), (s, k) => {
        const { block, positions, ec } = build(s, field, root);
        const t = Math.min(k % (Math.floor(ec / 2) + 1), positions.length);
        const bad = corrupt(block, positions, s.values, t);
        expect(rsDecode(field, bad, ec, root, Math.floor(ec / 2))).toBe(t);
        expect(bad).toEqual(block);
      }),
      cfg,
    );
  });

  it('corrects exactly the capacity', () => {
    fc.assert(
      fc.property(sample, (s) => {
        const { block, positions, ec } = build(s, field, root);
        const t = Math.floor(ec / 2);
        const bad = corrupt(block, positions, s.values, t);
        expect(rsDecode(field, bad, ec, root, t)).toBe(t);
        expect(bad).toEqual(block);
      }),
      cfg,
    );
  });

  it('never restores the original with floor(ec/2)+1 errors', () => {
    fc.assert(
      fc.property(sample, (s) => {
        const { block, positions, ec } = build(s, field, root);
        const bad = corrupt(block, positions, s.values, Math.floor(ec / 2) + 1);
        const work = bad.slice();
        const r = rsDecode(field, work, ec, root, Math.floor(ec / 2));
        expect(r === undefined ? work : bad).toEqual(bad);
        expect(r !== undefined && sameBytes(work, block)).toBe(false);
      }),
      cfg,
    );
  });

  it('honours maxErrors below the capacity', () => {
    fc.assert(
      fc.property(sample, (s) => {
        const { block, positions, ec } = build(s, field, root);
        fc.pre(ec >= 2);
        const t = Math.floor(ec / 2);
        const bad = corrupt(block, positions, s.values, t);
        const work = bad.slice();
        expect(rsDecode(field, work, ec, root, t - 1)).toBeUndefined();
        expect(work).toEqual(bad);
      }),
      cfg,
    );
  });
});

describe('rsDecode edge cases', () => {
  it('handles ecLength 0', () => {
    expect(rsDecode(DM, Uint8Array.of(1, 2, 3), 0, 1, 0)).toBe(0);
    expect(rsDecode(DM, new Uint8Array(0), 0, 1, 0)).toBe(0);
  });

  it('handles an all-zero block', () => {
    const block = new Uint8Array(30);
    expect(rsDecode(DM, block, 10, 1, 5)).toBe(0);
    block[3] = 9;
    expect(rsDecode(DM, block, 10, 1, 5)).toBe(1);
    expect(block).toEqual(new Uint8Array(30));
  });

  it('corrects errors in the parity part only', () => {
    const data = Uint8Array.of(142, 164, 186);
    const block = new Uint8Array(8);
    block.set(data);
    block.set(rsEncode(DM, data, 5, 1), 3);
    const good = block.slice();
    flip(block, 3, 0x55);
    flip(block, 7, 0x01);
    expect(rsDecode(DM, block, 5, 1, 2)).toBe(2);
    expect(block).toEqual(good);
  });

  it('corrects the first and last codeword of a full-length block', () => {
    const data = Uint8Array.from({ length: 235 }, (_, i) => (i * 37) & 0xff);
    const block = new Uint8Array(255);
    block.set(data);
    block.set(rsEncode(QR, data, 20, 0), 235);
    const good = block.slice();
    flip(block, 0, 0xff);
    flip(block, 254, 0x80);
    expect(rsDecode(QR, block, 20, 0, 10)).toBe(2);
    expect(block).toEqual(good);
  });

  it('returns undefined for invalid parameters without throwing', () => {
    const block = new Uint8Array(10);
    expect(rsDecode(DM, block, 11, 1, 5)).toBeUndefined();
    expect(rsDecode(DM, block, -1, 1, 5)).toBeUndefined();
    expect(rsDecode(DM, block, 2.5, 1, 5)).toBeUndefined();
    expect(rsDecode(DM, block, 2, -1, 5)).toBeUndefined();
    expect(rsDecode(DM, new Uint8Array(256), 10, 1, 5)).toBeUndefined();
    expect(rsDecode(DM, new Uint8Array(255), 255, 1, 5)).toBeUndefined();
    expect(rsDecode(DM, block, 4, 1, -1)).toBeUndefined();
    expect(rsDecode(DM, block, 4, 1, Number.NaN)).toBeUndefined();
  });

  it('never throws on arbitrary input', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 300 }),
        fc.integer({ min: -2, max: 300 }),
        fc.integer({ min: -1, max: 3 }),
        (block, ec, root) => {
          const r = rsDecode(DM, block, ec, root, 100);
          expect(r === undefined || Number.isInteger(r)).toBe(true);
        },
      ),
      cfg,
    );
  });

  it('accepts maxErrors above the capacity by clamping to it', () => {
    const data = Uint8Array.of(1, 2, 3, 4);
    const block = new Uint8Array(8);
    block.set(data);
    block.set(rsEncode(DM, data, 4, 1), 4);
    flip(block, 0, 1);
    flip(block, 1, 1);
    flip(block, 2, 1);
    expect(rsDecode(DM, block, 4, 1, 99)).toBeUndefined();
  });
});
