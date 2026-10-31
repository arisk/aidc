import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/datamatrix.json' with { type: 'json' };
import { Gs1Error } from '../../../src/core/index.ts';
import { DM_POLY, gf256 } from '../../../src/core/gf256.ts';
import { rsDecode } from '../../../src/core/reed-solomon.ts';
import { DM_SIZES, dmPad, dmSize } from '../../../src/symbology/matrix/dm-tables.ts';
import type { DmSize } from '../../../src/symbology/matrix/dm-tables.ts';
import {
  codewordModules,
  deinterleave,
  finderMismatches,
  mappingToSymbol,
  placeCodewords,
  readCodewords,
} from '../../../src/symbology/matrix/dm-place.ts';
import type { ModuleMatrix } from '../../../src/symbology/render/index.ts';
import { tryParse } from '../../../src/ai/index.ts';
import { tryParseDigitalLink } from '../../../src/digital-link/index.ts';
import {
  damageCodewords,
  dlUriArb,
  gs1MessageArb,
  rasteriseMatrix,
  toBracketed,
  xRowsToMatrix,
} from '../../support/matrix.ts';

const field = gf256(DM_POLY);

function sizeOf(rows: number, cols: number): DmSize {
  const s = dmSize(rows, cols);
  if (!s) throw new Error(`no size ${rows}x${cols}`);
  return s;
}

function bitsOf(m: ModuleMatrix): Uint8Array {
  return Uint8Array.from(m.rows.join(''), (c) => (c === '1' ? 1 : 0));
}

/** Reads a canonical matrix back: RS-checked blocks, then the data codewords in stream order. */
function readBack(size: DmSize, m: ModuleMatrix): { data: number[]; corrected: number } {
  const blocks = deinterleave(size, readCodewords(size, bitsOf(m)));
  const ec = size.ecCodewords / size.blocks;
  let corrected = 0;
  for (const b of blocks) {
    const n = rsDecode(field, b, ec, 1, ec >> 1);
    if (n === undefined) throw new Error('uncorrectable');
    corrected += n;
  }
  const data: number[] = [];
  for (let i = 0; i < size.dataCodewords; i++)
    data.push(blocks[i % size.blocks]?.[Math.floor(i / size.blocks)] ?? -1);
  return { data, corrected };
}

function ascending(a: readonly number[]): boolean {
  return a.every((v, i) => i === 0 || v > (a[i - 1] ?? 0));
}

describe('DM_SIZES', () => {
  it('matches the 30-row size table of the vector file', () => {
    const ours = DM_SIZES.map((s) => {
      const blocks = deinterleave(s, new Uint8Array(s.dataCodewords + s.ecCodewords));
      return {
        rows: s.rows,
        cols: s.columns,
        dataRegions: [s.regionRows, s.regionColumns],
        regionSize: [s.regionHeight, s.regionWidth],
        mappingMatrix: [s.regionRows * s.regionHeight, s.regionColumns * s.regionWidth],
        dataCodewords: s.dataCodewords,
        ecCodewords: s.ecCodewords,
        blocks: s.blocks,
        ecPerBlock: s.ecCodewords / s.blocks,
        dataPerBlock: blocks.map((b) => b.length - s.ecCodewords / s.blocks),
      };
    });
    expect(ours).toEqual(vectors.sizes);
  });

  it('lists 24 squares ascending, then 6 rectangles ascending by area', () => {
    expect(DM_SIZES.map((s) => s.shape)).toEqual([
      ...Array<string>(24).fill('square'),
      ...Array<string>(6).fill('rectangular'),
    ]);
    const areas = DM_SIZES.map((s) => s.rows * s.columns);
    expect(ascending(areas.slice(0, 24))).toBe(true);
    expect(ascending(areas.slice(24))).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DM_SIZES)).toBe(true);
    expect(Object.isFrozen(DM_SIZES[0])).toBe(true);
  });

  it('dmSize finds the 30 sizes and nothing else', () => {
    for (const s of DM_SIZES) expect(dmSize(s.rows, s.columns)).toBe(s);
    expect(dmSize(11, 11)).toBeUndefined();
    expect(dmSize(18, 8)).toBeUndefined();
    expect(dmSize(20, 44)).toBeUndefined();
    expect(dmSize(Number.NaN, 10)).toBeUndefined();
  });
});

describe('dmPad', () => {
  it('pads an empty message with the 40 vector values', () => {
    expect([...dmPad([], 40)]).toEqual(vectors.padding.firstFortyFromEmptyMessage);
  });

  it('uses the 1-based codeword position for the 253-state pads', () => {
    expect([...dmPad([66, 67], 5)]).toEqual([66, 67, 129, 220, 115]);
  });

  it('leaves full data alone and rejects data over capacity', () => {
    expect([...dmPad([1, 2, 3], 3)]).toEqual([1, 2, 3]);
    expect(() => dmPad([1, 2, 3, 4], 3)).toThrow(Gs1Error);
  });
});

const placementVectors = vectors.symbols.filter((v) => v.encode === 'codewords-to-matrix');
const bitExactVectors = vectors.symbols.flatMap((v) => {
  if (v.encode === 'bit-exact' || v.encode === 'bit-exact-forced-size')
    return [
      { id: v.id, rows: v.rows, cols: v.cols, data: v.dataCodewords ?? [], matrix: v.matrix },
    ];
  if ('isoMatrix' in v && Array.isArray(v.isoMatrix))
    return [
      { id: v.id, rows: v.rows, cols: v.cols, data: v.dataCodewords ?? [], matrix: v.isoMatrix },
    ];
  return [];
});

describe('placeCodewords and readCodewords', () => {
  it('has the expected vector counts', () => {
    expect(placementVectors).toHaveLength(30);
    expect(bitExactVectors).toHaveLength(16);
  });

  for (const v of placementVectors) {
    it(`${v.id}: places the data codewords bit for bit and reads them back`, () => {
      const size = sizeOf(v.rows, v.cols);
      const data = v.dataCodewords ?? [];
      const m = placeCodewords(size, data);
      expect(m.rows).toEqual(xRowsToMatrix(v.matrix).rows);
      expect([m.width, m.height]).toEqual([v.cols, v.rows]);
      const back = readBack(size, m);
      expect(back.corrected).toBe(0);
      expect(back.data).toEqual([...dmPad(data, size.dataCodewords)]);
    });
  }

  for (const v of bitExactVectors) {
    it(`${v.id}: reproduces the ISO matrix`, () => {
      const m = placeCodewords(sizeOf(v.rows, v.cols), v.data);
      expect(m.rows).toEqual(xRowsToMatrix(v.matrix).rows);
    });
  }

  it('returns a frozen matrix with a 1-module quiet zone and no symbology', () => {
    const m = placeCodewords(sizeOf(10, 10), [142, 164, 186]);
    expect(m.kind).toBe('matrix');
    expect(m.symbology).toBeUndefined();
    expect(m.quietZone).toEqual({ left: 1, right: 1, top: 1, bottom: 1 });
    expect(m.hri).toEqual([]);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.rows)).toBe(true);
  });

  it('readCodewords returns the interleaved stream', () => {
    const size = sizeOf(10, 10);
    const cw = readCodewords(size, bitsOf(placeCodewords(size, [142, 164, 186])));
    // Guideline 2.5.1 Annex A: data 142 164 186, EC 114 25 5 88 102.
    expect([...cw]).toEqual([142, 164, 186, 114, 25, 5, 88, 102]);
  });

  it('readCodewords rejects a bit array of the wrong length', () => {
    expect(() => readCodewords(sizeOf(10, 10), new Uint8Array(99))).toThrow(Gs1Error);
  });

  it('deinterleave puts 144x144 EC slots at (b + 2) mod 10', () => {
    const size = sizeOf(144, 144);
    const stream = new Uint8Array(size.dataCodewords + size.ecCodewords);
    // Mark the first EC round: slot s holds block (s + 8) mod 10.
    for (let s = 0; s < 10; s++) stream[size.dataCodewords + s] = 100 + s;
    const blocks = deinterleave(size, stream);
    for (let b = 0; b < 10; b++) {
      const dataLen = b < 8 ? 156 : 155;
      expect(blocks[b]?.[dataLen]).toBe(100 + ((b + 2) % 10));
    }
  });
});

describe('finderMismatches', () => {
  // The orientation vectors are deliberately turned; every other matrix is canonical.
  const all = [
    ...vectors.symbols
      .filter((v) => !v.id.startsWith('orientation:'))
      .map((v) => ({ id: v.id, rows: v.rows, cols: v.cols, matrix: v.matrix })),
    ...bitExactVectors,
  ];
  it('is 0 for every canonical vector matrix', () => {
    expect(all).toHaveLength(69 + 16);
    for (const v of all) {
      const bits = bitsOf(xRowsToMatrix(v.matrix));
      expect([v.id, finderMismatches(sizeOf(v.rows, v.cols), bits)]).toEqual([v.id, 0]);
    }
  });

  it('counts flipped finder and clock modules', () => {
    for (const size of DM_SIZES) {
      const bits = bitsOf(placeCodewords(size, []));
      const w = size.columns;
      // Bottom-left corner (L), top-right corner (clock), and the left column middle.
      const flips = [(size.rows - 1) * w, w - 1, Math.floor(size.rows / 2) * w];
      flips.forEach((i, n) => {
        bits[i] = (bits[i] ?? 0) ^ 1;
        expect(finderMismatches(size, bits)).toBe(n + 1);
      });
    }
  });

  it('ignores mapping modules', () => {
    const size = sizeOf(12, 12);
    const bits = bitsOf(placeCodewords(size, [1, 2, 3]));
    bits[1 * 12 + 1] = (bits[1 * 12 + 1] ?? 0) ^ 1;
    expect(finderMismatches(size, bits)).toBe(0);
  });
});

describe('codewordModules', () => {
  for (const size of DM_SIZES) {
    it(`${size.rows}x${size.columns}: covers every mapping module exactly once`, () => {
      const map = codewordModules(size);
      const nrow = size.regionRows * size.regionHeight;
      const ncol = size.regionColumns * size.regionWidth;
      expect(map).toHaveLength(nrow * ncol);
      const total = (size.dataCodewords + size.ecCodewords) * 8;
      const seen = new Uint8Array(total);
      let fixedLight = 0;
      let fixedDark = 0;
      for (const v of map) {
        if (v === -1) fixedLight++;
        else if (v === -2) fixedDark++;
        else seen[v] = (seen[v] ?? 0) + 1;
      }
      expect(seen.every((n) => n === 1)).toBe(true);
      const corner = [12, 16, 20, 24].includes(size.rows) && size.shape === 'square' ? 2 : 0;
      expect([fixedLight, fixedDark]).toEqual([corner, corner]);
    });
  }

  it('returns a copy the caller may change', () => {
    const size = sizeOf(10, 10);
    const a = codewordModules(size);
    a[0] = 99;
    expect(codewordModules(size)[0]).not.toBe(99);
  });

  it('starts the 10x10 first row with the ISO figure (2.1 2.2 3.6 3.7 3.8 4.3 4.4 4.5)', () => {
    const map = codewordModules(sizeOf(10, 10));
    expect(Array.from(map.slice(0, 8))).toEqual([8, 9, 21, 22, 23, 26, 27, 28]);
  });

  it('mappingToSymbol skips the finder and alignment patterns', () => {
    const size = sizeOf(32, 32);
    expect(mappingToSymbol(size, 0)).toEqual({ x: 1, y: 1 });
    expect(mappingToSymbol(size, 14)).toEqual({ x: 17, y: 1 });
    expect(mappingToSymbol(size, 14 * 28 + 13)).toEqual({ x: 14, y: 17 });
  });
});

describe('test support', () => {
  it('damageCodewords XORs exactly the chosen codewords', () => {
    const size = sizeOf(20, 20);
    const m = placeCodewords(size, [232, 131, 133]);
    const clean = readCodewords(size, bitsOf(m));
    const plan = [
      { codeword: 0, xor: 0xff },
      { codeword: 7, xor: 0x01 },
      { codeword: 39, xor: 0x80 },
    ];
    const damaged = readCodewords(size, bitsOf(damageCodewords(m, size, plan)));
    const expected = Uint8Array.from(clean);
    for (const p of plan) expected[p.codeword] = (expected[p.codeword] ?? 0) ^ p.xor;
    expect(damaged).toEqual(expected);
    expect(readBack(size, damageCodewords(m, size, plan)).corrected).toBe(3);
  });

  it('xRowsToMatrix trims a quiet zone', () => {
    expect(xRowsToMatrix(['    ', ' XX ', ' X  ', '    '], { trimQuietZone: 1 }).rows).toEqual([
      '11',
      '10',
    ]);
  });

  it('rasteriseMatrix paints dark modules black on white', () => {
    const r = rasteriseMatrix(xRowsToMatrix(['X ']), 2, 1);
    expect([r.width, r.height]).toEqual([8, 6]);
    const px = (x: number, y: number): number => r.data[(y * r.width + x) * 4] ?? -1;
    expect([px(0, 0), px(2, 2), px(3, 3), px(4, 2)]).toEqual([255, 0, 0, 255]);
  });

  it('the message and URI arbitraries produce parseable input', () => {
    for (const m of fc.sample(gs1MessageArb, 10))
      expect(tryParse(toBracketed(m), { validateAssociations: false }).ok).toBe(true);
    for (const uri of fc.sample(dlUriArb, 10)) expect(tryParseDigitalLink(uri).ok).toBe(true);
  });
});

describe('placement round trip', () => {
  it('reads back any data codewords at any size', () => {
    const arb = fc
      .constantFrom(...DM_SIZES)
      .chain((size) =>
        fc.tuple(
          fc.constant(size),
          fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: size.dataCodewords }),
        ),
      );
    fc.assert(
      fc.property(arb, ([size, data]) => {
        const back = readBack(size, placeCodewords(size, data));
        expect(back.corrected).toBe(0);
        expect(back.data.slice(0, data.length)).toEqual(data);
      }),
      { numRuns: 60 },
    );
  });
});
