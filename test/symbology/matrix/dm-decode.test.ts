import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/datamatrix.json' with { type: 'json' };
import { Gs1Error } from '../../../src/core/index.ts';
import { tryFromScan } from '../../../src/scan/index.ts';
import { matrixFromRows } from '../../../src/symbology/render/index.ts';
import type { ModuleMatrix, Orientation } from '../../../src/symbology/render/index.ts';
import {
  DM_SIZES,
  dmBlockData,
  dmBlockEc,
  dmEcSlot,
  dmSize,
} from '../../../src/symbology/matrix/dm-tables.ts';
import type { DmSize } from '../../../src/symbology/matrix/dm-tables.ts';
import { placeCodewords } from '../../../src/symbology/matrix/dm-place.ts';
import { chooseSize, DM_FNC1, encodeCodewords } from '../../../src/symbology/matrix/dm-encode.ts';
import type { DmSizeOption } from '../../../src/symbology/matrix/dm-encode.ts';
import {
  decodeCodewords,
  gs1FromData,
  readDataMatrix,
  specialError,
} from '../../../src/symbology/matrix/dm-decode.ts';
import type { DmMode, DmText } from '../../../src/symbology/matrix/dm-decode.ts';
import {
  damageCodewords,
  gs1MessageArb,
  toBracketed,
  xRowsToMatrix,
} from '../../support/matrix.ts';
import { parse, format } from '../../../src/ai/index.ts';

const GS = String.fromCharCode(29);

function sizeOf(rows: number, columns: number): DmSize {
  const s = dmSize(rows, columns);
  if (!s) throw new Error(`no size ${rows}x${columns}`);
  return s;
}

/** Symbols of a string: GS becomes FNC1. */
function sym(text: string, gs1 = false): number[] {
  const out = gs1 ? [DM_FNC1] : [];
  for (const ch of text) out.push(ch === GS ? DM_FNC1 : ch.charCodeAt(0));
  return out;
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

/** Encodes text at the smallest size of `size` and places it. */
function symbolOf(
  text: string,
  gs1: boolean,
  size: DmSizeOption = 'square',
): { m: ModuleMatrix; size: DmSize; codewords: readonly number[] } {
  const r = chooseSize(encodeCodewords(sym(text, gs1), 'auto'), size);
  if (!r.ok) throw new Error('does not fit');
  return { m: placeCodewords(r.value.size, r.value.codewords), ...r.value };
}

function mustRead(m: unknown): ReturnType<typeof readDataMatrix> & { ok: true } {
  const r = readDataMatrix(m);
  if (!r.ok) throw new Error(`read failed: ${r.errors[0]?.message ?? ''}`);
  return r;
}

function mustText(codewords: readonly number[]): DmText {
  const r = decodeCodewords(codewords);
  if (!r.ok) throw new Error(`decode failed: ${r.errors[0]?.message ?? ''}`);
  return r.value;
}

/** aimId + data of a matrix. */
function scanOf(m: ModuleMatrix): string {
  const t = mustText(mustRead(m).value.codewords);
  return t.aimId + t.data;
}

function firstError(r: { ok: boolean; errors?: readonly Gs1Error[] }): Gs1Error {
  const e = r.ok ? undefined : r.errors?.[0];
  if (!e) throw new Error('expected an error');
  return e;
}

/**
 * The input a caller would see when the canonical symbol is mirrored left-right (if `mirrored`)
 * and then rotated clockwise by `rotation`.
 */
function turn(m: ModuleMatrix, o: Orientation): ModuleMatrix {
  const R = m.height;
  const C = m.width;
  const swap = o.rotation === 90 || o.rotation === 270;
  const h = swap ? C : R;
  const w = swap ? R : C;
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => '0'));
  for (let r = 0; r < R; r++)
    for (let c0 = 0; c0 < C; c0++) {
      const c = o.mirrored ? C - 1 - c0 : c0;
      let y = r;
      let x = c;
      if (o.rotation === 90) [y, x] = [c, R - 1 - r];
      else if (o.rotation === 180) [y, x] = [R - 1 - r, C - 1 - c];
      else if (o.rotation === 270) [y, x] = [C - 1 - c, r];
      const row = grid[y];
      if (row) row[x] = m.rows[r]?.[c0] ?? '0';
    }
  return matrixFromRows(grid.map((r) => r.join('')));
}

function invert(m: ModuleMatrix): ModuleMatrix {
  return matrixFromRows(
    m.rows.map((r) =>
      r
        .split('')
        .map((c) => (c === '1' ? '0' : '1'))
        .join(''),
    ),
  );
}

function border(m: ModuleMatrix, n: number, dark = false): ModuleMatrix {
  const q = dark ? '1' : '0';
  const edge = q.repeat(m.width + 2 * n);
  const rows = [
    ...Array.from({ length: n }, () => edge),
    ...m.rows.map((r) => q.repeat(n) + r + q.repeat(n)),
    ...Array.from({ length: n }, () => edge),
  ];
  return matrixFromRows(rows);
}

const ROTATIONS: readonly Orientation['rotation'][] = [0, 90, 180, 270];
const ORIENTATIONS: readonly Orientation[] = ROTATIONS.flatMap((rotation) =>
  [false, true].map((mirrored) => ({ rotation, mirrored })),
);

/** aimId + data of a symbol's codewords. */
function scanText(s: { codewords: readonly number[] }): string {
  const t = mustText(s.codewords);
  return t.aimId + t.data;
}

/** Whether `readDataMatrix` fails with only Gs1Errors (and does not throw). */
function failsSafely(input: unknown): boolean {
  const r = readDataMatrix(input);
  return !r.ok && r.errors.every((e) => e instanceof Gs1Error);
}

/** Ok, or failed with only Gs1Errors. */
function safe(r: { ok: boolean; errors?: readonly unknown[] }): boolean {
  return r.ok || (r.errors ?? []).every((e) => e instanceof Gs1Error);
}

/** An L finder with clock tracks at rows x columns (no data). */
function frame(rows: number, columns: number): ModuleMatrix {
  return matrixFromRows(
    Array.from({ length: rows }, (_r, y) =>
      Array.from({ length: columns }, (_c, x) => {
        if (y === rows - 1 || x === 0) return '1';
        if (y === 0) return x % 2 === 0 ? '1' : '0';
        if (x === columns - 1) return y % 2 === 1 ? '1' : '0';
        return '0';
      }).join(''),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Vectors

interface SymbolVector {
  id: string;
  aimId?: string;
  rawData?: string;
  errorsCorrected?: number;
  expectError?: string;
  dataCodewords?: number[];
  matrix: string[];
}

const SYMBOLS = vectors.symbols as unknown as SymbolVector[]; // oxlint-disable-line no-unsafe-type-assertion -- JSON vector file

describe('symbol vectors', () => {
  it('has 71 symbol vectors', () => {
    expect(SYMBOLS).toHaveLength(71);
  });

  const decoding = SYMBOLS.filter((v) => v.expectError === undefined);
  const failing = SYMBOLS.filter((v) => v.expectError !== undefined);

  for (const v of decoding) {
    it(`decodes ${v.id}`, () => {
      // Engine vectors are stored without their quiet zone: put it back.
      const m = v.id.startsWith('engine:')
        ? border(xRowsToMatrix(v.matrix), 1)
        : xRowsToMatrix(v.matrix);
      const read = mustRead(m).value;
      expect(read.errorsCorrected).toBe(v.errorsCorrected ?? 0);
      const t = mustText(read.codewords);
      expect(t.aimId + t.data).toBe(`${v.aimId ?? ''}${v.rawData ?? ''}`);
    });
  }

  for (const v of decoding.filter((d) => d.dataCodewords !== undefined)) {
    it(`reads the data codewords of ${v.id}`, () => {
      const cws = v.dataCodewords ?? [];
      const m = v.id.startsWith('engine:')
        ? border(xRowsToMatrix(v.matrix), 1)
        : xRowsToMatrix(v.matrix);
      const read = mustRead(m).value;
      expect(read.codewords.slice(0, cws.length)).toEqual(cws);
      expect(mustText(read.codewords).length).toBe(cws.length);
    });
  }

  for (const v of failing) {
    it(`rejects ${v.id} with ${v.expectError ?? ''}`, () => {
      const r = readDataMatrix(xRowsToMatrix(v.matrix));
      expect(firstError(r).code).toBe(v.expectError);
    });
  }

  it('reports the orientation of the derived orientation vectors', () => {
    const base = SYMBOLS.find((v) => v.id === 'figure:guideline-p19:20x20');
    const rot = SYMBOLS.find((v) => v.id === 'orientation:rot90');
    const tr = SYMBOLS.find((v) => v.id === 'orientation:transposed');
    if (!base || !rot || !tr) throw new Error('missing vectors');
    const canonical = xRowsToMatrix(base.matrix);
    for (const v of [rot, tr]) {
      const read = mustRead(xRowsToMatrix(v.matrix)).value;
      expect(turn(canonical, read.orientation).rows).toEqual(xRowsToMatrix(v.matrix).rows);
    }
    expect(mustRead(xRowsToMatrix(rot.matrix)).value.orientation.mirrored).toBe(false);
    expect(mustRead(xRowsToMatrix(tr.matrix)).value.orientation.mirrored).toBe(true);
  });

  const modes: Record<string, { special?: DmText['special']; encodation: DmMode[] }> = {
    'mode:c40': { encodation: ['c40'] },
    'mode:text': { encodation: ['text'] },
    'mode:x12': { encodation: ['x12', 'ascii'] },
    'mode:edifact': { encodation: ['edifact'] },
    'mode:base256': { encodation: ['base256'] },
    'mode:upper-shift': { encodation: ['ascii'] },
    'mode:eci26-base256': { special: 'eci', encodation: ['ascii', 'base256'] },
    'mode:eci26-upper-shift': { special: 'eci', encodation: ['ascii'] },
    'mode:macro05': { special: 'macro', encodation: ['ascii'] },
    'mode:macro06': { special: 'macro', encodation: ['ascii'] },
    'mode:reader-programming': { special: 'reader-programming', encodation: ['ascii'] },
    'mode:fnc1-second-position': { encodation: ['ascii'] },
    'mode:structured-append-gs1': { special: 'structured-append', encodation: ['ascii'] },
    'mode:gs1-c40-with-fnc1': { encodation: ['ascii', 'c40', 'ascii'] },
    'mode:dl-text': { encodation: ['text', 'ascii'] },
  };

  it('pins all 15 mode vectors', () => {
    expect(new Set(SYMBOLS.filter((v) => v.id.startsWith('mode:')).map((v) => v.id))).toEqual(
      new Set(Object.keys(modes)),
    );
  });

  for (const [id, want] of Object.entries(modes)) {
    it(`reports special and encodation of ${id}`, () => {
      const v = SYMBOLS.find((s) => s.id === id);
      if (!v) throw new Error(id);
      const t = mustText(mustRead(xRowsToMatrix(v.matrix)).value.codewords);
      expect(t.special).toBe(want.special);
      expect(t.encodation).toEqual(want.encodation);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Specials as UNSUPPORTED

describe('specialError', () => {
  const cases: [string, string, Record<string, unknown>][] = [
    ['mode:macro05', 'macro', {}],
    ['mode:eci26-base256', 'eci', { eci: 26 }],
    ['mode:reader-programming', 'reader-programming', {}],
    ['mode:fnc1-second-position', 'fnc1-second', {}],
    ['mode:structured-append-gs1', 'structured-append', { index: 2, count: 3, fileId: [1, 2] }],
  ];
  for (const [id, reason, extra] of cases) {
    it(`gives UNSUPPORTED ${reason} for ${id}`, () => {
      const v = SYMBOLS.find((s) => s.id === id);
      if (!v) throw new Error(id);
      const t = mustText(mustRead(xRowsToMatrix(v.matrix)).value.codewords);
      const e = specialError(t);
      expect(e?.code).toBe('UNSUPPORTED');
      expect(e?.details).toEqual({ reason, aimId: v.aimId, rawData: v.rawData, ...extra });
    });
  }

  it('is undefined for plain ]d1 and ]d2 data', () => {
    expect(specialError(mustText([66, 67]))).toBeUndefined();
    expect(specialError(mustText([232, 131]))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Round trips through the Task 4 encoder

describe('round trip with the encoder', () => {
  const pinned: { text: string; capacity: number }[] = [
    { text: 'P5HKCFLQRZ4*.88EWMQ64', capacity: 16 },
    { text: '/SE>2LG1.TZ*Z03', capacity: 12 },
    { text: '72H61DOKHVDF3DD4', capacity: 12 },
  ];
  for (const p of pinned) {
    it(`decodes the pinned end-rule input ${p.text} at capacity ${p.capacity}`, () => {
      const cws = encodeCodewords(sym(p.text), 'auto').fit(p.capacity) ?? [];
      expect(cws).toHaveLength(p.capacity);
      const size = DM_SIZES.find((s) => s.dataCodewords === p.capacity);
      if (!size) throw new Error('no size');
      expect(scanOf(placeCodewords(size, cws))).toBe(`]d1${p.text}`);
    });
  }

  it('decodes random strings encoded at every fitting capacity (1,500 strings)', () => {
    const rand = rng(51012);
    const alphabets = [
      [...Array.from({ length: 128 }, (_, i) => i), DM_FNC1],
      sym('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 */>.\r'),
      sym('abcdefghijklmnopqrstuvwxyz0123456789 .-'),
      sym('!"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^'),
      sym('0123456789'),
    ];
    let checked = 0;
    const mismatches: unknown[] = [];
    for (let k = 0; k < 1500; k++) {
      const alphabet = alphabets[k % alphabets.length] ?? [];
      const n = Math.floor(rand() * 40);
      const gs1 = rand() < 0.5;
      const s: number[] = gs1 ? [DM_FNC1] : [];
      for (let i = 0; i < n; i++) {
        let c = alphabet[Math.floor(rand() * alphabet.length)] ?? 65;
        // FNC1 in the first positions would make an AIM application indicator (]d3).
        if (c === DM_FNC1 && i < 3) c = 65;
        s.push(c);
      }
      const want =
        (gs1 ? ']d2' : ']d1') +
        String.fromCharCode(...s.slice(gs1 ? 1 : 0).map((c) => (c === DM_FNC1 ? 29 : c)));
      for (const mode of ['auto', 'ascii'] as const) {
        const enc = encodeCodewords(s, mode);
        let sizes = 0;
        for (const size of DM_SIZES) {
          if (size.dataCodewords < enc.minimum || sizes >= 3) continue;
          const cws = enc.fit(size.dataCodewords);
          if (!cws) continue;
          sizes++;
          const read = mustRead(placeCodewords(size, cws)).value;
          const t = mustText(read.codewords);
          if (t.aimId + t.data !== want || t.length !== cws.length) {
            mismatches.push({ got: t.aimId + t.data, want, length: t.length, cws: cws.length });
          }
          checked++;
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(3000);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Review Focus 3: damage at and beyond capacity

/** Symbol-order index of codeword `i` (data then EC) of block `b`. */
function symbolIndex(size: DmSize, b: number, i: number): number {
  const n = dmBlockData(size, b);
  if (i < n) return b + i * size.blocks;
  return size.dataCodewords + (i - n) * size.blocks + dmEcSlot(size, b);
}

function pickDistinct(rand: () => number, n: number, k: number): number[] {
  const all = Array.from({ length: n }, (_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (n - i));
    [all[i], all[j]] = [all[j] ?? 0, all[i] ?? 0];
  }
  return all.slice(0, k);
}

describe('Review Focus 3: codeword damage', () => {
  const FORCED = [sizeOf(52, 52), sizeOf(64, 64), sizeOf(120, 120), sizeOf(144, 144)];
  it('corrects up to floor(ec/2) errors per block and detects one more (300 messages)', () => {
    const rand = rng(300);
    let beyondFailed = 0;
    const miscorrectedToOriginal: number[] = [];
    const errorsGot: unknown[] = [];
    const errorsWant: unknown[] = [];
    fc.assert(
      fc.property(gs1MessageArb, (msg) => {
        const raw = format(parse(toBracketed(msg), { validateAssociations: false }), 'raw');
        const enc = encodeCodewords(sym(raw, true), 'auto');
        const pick = Math.floor(rand() * 6);
        const forced = FORCED[pick];
        const r = chooseSize(
          enc,
          forced ? { rows: forced.rows, columns: forced.columns } : pick === 4 ? 'square' : 'auto',
        );
        if (!r.ok) return;
        const { size, codewords } = r.value;
        const m = placeCodewords(size, codewords);
        const ec = dmBlockEc(size);
        const cap = ec >> 1;
        const plan: { codeword: number; xor: number }[] = [];
        let total = 0;
        for (let b = 0; b < size.blocks; b++) {
          const k = Math.floor(rand() * (cap + 1));
          total += k;
          for (const i of pickDistinct(rand, dmBlockData(size, b) + ec, k))
            plan.push({ codeword: symbolIndex(size, b, i), xor: 1 + Math.floor(rand() * 255) });
        }
        const read = mustRead(damageCodewords(m, size, plan)).value;
        expect(read.errorsCorrected).toBe(total);
        expect(read.codewords.slice(0, codewords.length)).toEqual(codewords);
        expect(`${mustText(read.codewords).aimId}${mustText(read.codewords).data}`).toBe(
          `]d2${raw}`,
        );

        // One block with cap + 1 errors, the others at most cap.
        const bad = Math.floor(rand() * size.blocks);
        const beyond: { codeword: number; xor: number }[] = [];
        for (let b = 0; b < size.blocks; b++) {
          const k = b === bad ? cap + 1 : Math.floor(rand() * (cap + 1));
          for (const i of pickDistinct(rand, dmBlockData(size, b) + ec, k))
            beyond.push({ codeword: symbolIndex(size, b, i), xor: 1 + Math.floor(rand() * 255) });
        }
        const r2 = readDataMatrix(damageCodewords(m, size, beyond));
        if (r2.ok) {
          // A miscorrection: never the original data.
          const got = r2.value.codewords.slice(0, codewords.length);
          if (got.every((c, i) => c === codewords[i])) miscorrectedToOriginal.push(bad);
        } else {
          beyondFailed++;
          errorsGot.push([r2.errors[0]?.code, r2.errors[0]?.details]);
          errorsWant.push([
            'RS_UNCORRECTABLE',
            { block: bad, blocks: size.blocks, ecCodewords: ec, capacity: cap },
          ]);
        }
      }),
      { numRuns: 300, seed: 5 },
    );
    expect(beyondFailed).toBeGreaterThan(290);
    expect(miscorrectedToOriginal).toEqual([]);
    expect(errorsGot).toEqual(errorsWant);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------
// Review Focus 4: orientation, inversion, borders

describe('Review Focus 4: orientation, inversion and borders', () => {
  const square = symbolOf(`010950110102091710ABC123${GS}21XYZ`, true);
  const rect = symbolOf('0109501101020917', true, 'rectangular');
  const big = symbolOf('0109501101020917', true, { rows: 32, columns: 32 });
  for (const o of ORIENTATIONS) {
    for (const inverted of [false, true]) {
      it(`square: rotation ${o.rotation}, mirrored ${o.mirrored}, inverted ${inverted}`, () => {
        for (let b = 0; b <= 5; b++) {
          const turned = turn(square.m, o);
          const m = inverted ? border(invert(turned), b, true) : border(turned, b);
          const read = mustRead(m).value;
          expect(read.orientation).toEqual(o);
          expect(read.inverted).toBe(inverted);
          expect(read.size).toBe(square.size);
          expect(read.errorsCorrected).toBe(0);
          expect(scanOf(m)).toBe(scanText(square));
        }
        const m = inverted ? border(invert(turn(big.m, o)), 2, true) : border(turn(big.m, o), 2);
        expect(mustRead(m).value.orientation).toEqual(o);
        expect(mustRead(m).value.inverted).toBe(inverted);
        expect(scanOf(m)).toBe(scanText(big));
      });
    }
  }

  // Turned by 90 degrees, a rectangle's transposed dimensions are a valid size.
  for (const o of ORIENTATIONS) {
    it(`rectangle: rotation ${o.rotation}, mirrored ${o.mirrored}`, () => {
      for (let b = 0; b <= 5; b++) {
        for (const inverted of [false, true]) {
          const turned = turn(rect.m, o);
          const m = inverted ? border(invert(turned), b, true) : border(turned, b);
          const read = mustRead(m).value;
          expect(read.orientation).toEqual(o);
          expect(read.inverted).toBe(inverted);
          expect(read.size).toBe(rect.size);
          expect(scanOf(m)).toBe(scanText(rect));
        }
      }
    });
  }

  it('a rectangle has 4 candidate transforms per input shape', () => {
    expect(rect.size.shape).toBe('rectangular');
    expect(mustRead(rect.m).value.size).toBe(rect.size);
    expect(mustRead(turn(rect.m, { rotation: 90, mirrored: true })).value.size).toBe(rect.size);
  });

  it('decodes when a few finder modules are damaged', () => {
    const rows = square.m.rows.map((r) => r.split(''));
    const bottom = rows[rows.length - 1];
    if (bottom) {
      bottom[3] = '0';
      bottom[5] = '0';
    }
    const m = matrixFromRows(rows.map((r) => r.join('')));
    expect(scanOf(m)).toBe(scanText(square));
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 2: hostile input

describe('Review Focus 2: hostile input', () => {
  it('never throws on random values (1,500 runs)', () => {
    fc.assert(
      fc.property(fc.anything({ withObjectString: true, withNullPrototype: true }), (v) => {
        expect(failsSafely(v)).toBe(true);
        expect(failsSafely({ kind: 'matrix', rows: v })).toBe(true);
      }),
      { numRuns: 1500 },
    );
  });

  it('never throws on random 0/1 grids (300 runs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.array(fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }), {
          minLength: 1,
          maxLength: 40,
        }),
        (w, grid) => {
          const rows = grid.map((r) =>
            r
              .slice(0, w)
              .map((b) => (b ? '1' : '0'))
              .join(''),
          );
          expect(safe(readDataMatrix({ kind: 'matrix', rows }))).toBe(true);
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

  it('never throws on random codeword streams (2,000 runs)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: 0, max: 255 }), fc.constantFrom(230, 231, 239, 240)), {
          maxLength: 80,
        }),
        (cws) => {
          expect(safe(decodeCodewords(cws))).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('rejects codewords that are not bytes', () => {
    for (const bad of [[-1], [256], [1.5], [Number.NaN]]) {
      const e = firstError(decodeCodewords(bad));
      expect(e.details).toMatchObject({ reason: 'codeword', codeword: 0 });
    }
  });

  it('reads 1024 x 1024 random bits in under 1 s', () => {
    const rand = rng(1024);
    const rows = Array.from({ length: 1024 }, () => {
      let s = '';
      for (let x = 0; x < 1024; x++) s += rand() < 0.5 ? '1' : '0';
      return s;
    });
    const m = matrixFromRows(rows);
    const t0 = performance.now();
    const r = readDataMatrix(m);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(false);
  });

  it('reads 144 x 144 random bits in bounded time', () => {
    const rand = rng(144);
    const rows = Array.from({ length: 144 }, () => {
      let s = '';
      for (let x = 0; x < 144; x++) s += rand() < 0.5 ? '1' : '0';
      return s;
    });
    // Keep a finder so the size is found.
    const grid = rows.map((r) => r.split(''));
    for (let y = 0; y < 144; y++) {
      const row = grid[y];
      if (row) row[0] = '1';
    }
    grid[143] = Array.from({ length: 144 }, () => '1');
    const t0 = performance.now();
    const r = readDataMatrix(matrixFromRows(grid.map((row) => row.join(''))));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Geometric errors

describe('geometric errors', () => {
  it('an unknown size is INVALID_SYMBOL size', () => {
    // All dark: the inverted reading is all light and has no size either.
    const m = matrixFromRows(Array.from({ length: 11 }, () => '1'.repeat(11)));
    const e = firstError(readDataMatrix(m));
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details).toMatchObject({ reason: 'size', rows: 11, columns: 11 });
    expect(e.position).toBeUndefined();
  });

  it('an all-light matrix is INVALID_SYMBOL size', () => {
    const e = firstError(readDataMatrix(matrixFromRows(['000', '000'])));
    expect(e.details?.['reason']).toBe('size');
  });

  it('a DMRE size (20x44 built by hand) is UNSUPPORTED dmre, also turned', () => {
    for (const m of [frame(20, 44), turn(frame(20, 44), { rotation: 90, mirrored: false })]) {
      const e = firstError(readDataMatrix(border(m, 2)));
      expect(e.code).toBe('UNSUPPORTED');
      expect(e.details).toMatchObject({ reason: 'dmre' });
    }
  });

  it('a destroyed finder is INVALID_SYMBOL finder with x/y in the caller coordinates', () => {
    // 22x22 (one region) with a 4-module border: 30x30 is no size, so the inverted reading
    // (where the border turns dark) has no candidate.
    const { m } = symbolOf('0109501101020917', true, { rows: 22, columns: 22 });
    const n = m.height;
    // Replace every finder and clock module by a pattern that matches no orientation.
    const rows = m.rows.map((r, y) =>
      r
        .split('')
        .map((c, x) =>
          y === 0 || x === 0 || y === n - 1 || x === n - 1
            ? (x + 2 * y) % 3 === 0
              ? '1'
              : '0'
            : c,
        )
        .join(''),
    );
    const bordered = border(matrixFromRows(rows), 4);
    const e = firstError(readDataMatrix(bordered));
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details?.['reason']).toBe('finder');
    const x = e.details?.['x'];
    const y = e.details?.['y'];
    expect(typeof x === 'number' && x >= 4 && x < 4 + n).toBe(true);
    expect(typeof y === 'number' && y >= 4 && y < 4 + n).toBe(true);
    expect(e.position).toBeUndefined();
  });

  it('locates a finder error at the first wrong fixed module (left column)', () => {
    const { m } = symbolOf('0109501101020917', true, { rows: 22, columns: 22 });
    const n = m.height;
    // The top row stays intact; the other fixed modules match no orientation.
    const rows = m.rows.map((r, y) =>
      r
        .split('')
        .map((c, x) =>
          y > 0 && (x === 0 || y === n - 1 || x === n - 1)
            ? (x + 2 * y) % 3 === 0
              ? '1'
              : '0'
            : c,
        )
        .join(''),
    );
    const e = firstError(readDataMatrix(border(matrixFromRows(rows), 4)));
    expect(e.details).toEqual({ reason: 'finder', x: 4, y: 5 });
  });

  it('passes readMatrix errors through (pattern)', () => {
    const e = firstError(readDataMatrix({ kind: 'matrix', rows: ['12'] }));
    expect(e.details?.['reason']).toBe('pattern');
  });
});

// ---------------------------------------------------------------------------------------------
// Codeword streams

function c40(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 3) {
    const v = 1600 * (values[i] ?? 0) + 40 * (values[i + 1] ?? 0) + (values[i + 2] ?? 0) + 1;
    out.push(v >> 8, v & 255);
  }
  return out;
}

function edifact(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 4) {
    const v =
      ((values[i] ?? 0) << 18) |
      ((values[i + 1] ?? 0) << 12) |
      ((values[i + 2] ?? 0) << 6) |
      (values[i + 3] ?? 0);
    out.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
  }
  return out;
}

/** Base 256 randomisation of `value` at 1-based stream position `p`. */
function r255(value: number, p: number): number {
  return (value + ((149 * p) % 255) + 1) % 256;
}

const CODEWORD = ['INVALID_SYMBOL', 'codeword'];

/** Code and reason of the first error decoding `cws`. */
function cwFailure(cws: readonly number[]): unknown[] {
  const e = firstError(decodeCodewords(cws));
  return [e.code, e.details?.['reason']];
}

function cwDetails(cws: readonly number[]): unknown {
  return firstError(decodeCodewords(cws)).details;
}

function textOf(cws: readonly number[]): string {
  const t = mustText(cws);
  return t.aimId + t.data;
}

describe('decodeCodewords', () => {
  it('decodes ASCII characters, digit pairs, FNC1 and stops at the first pad', () => {
    expect(textOf([66, 67, 130, 229, 129, 66, 0])).toBe(']d1AB0099');
    expect(textOf([232, 131, 232, 142])).toBe(`]d201${GS}12`);
    expect(textOf([])).toBe(']d1');
    expect(mustText([66, 129, 5]).length).toBe(1);
  });

  it('rejects 0, 242 to 253 and 254 in ASCII mode with details.codeword', () => {
    for (const c of [0, 242, 245, 253, 254]) {
      expect(cwDetails([66, c])).toEqual({ reason: 'codeword', codeword: 1, value: c });
    }
    expect(cwDetails([255])).toMatchObject({ codeword: 0 });
  });

  it('places FNC1 first after structured append and second after one character', () => {
    expect(textOf([233, 0x2e, 1, 2, 232, 131])).toBe(']d201');
    expect(textOf([233, 0x2e, 1, 2, 66, 232, 67])).toBe(']d3AB');
    expect(textOf([130, 232, 67])).toBe(']d300B');
    expect(textOf([66, 67, 232, 68])).toBe(`]d1AB${GS}C`);
    expect(textOf([34, 232, 68])).toBe(`]d1!${GS}C`);
    expect(mustText([233, 0x2e, 1, 2, 66]).structuredAppend).toEqual({
      index: 2,
      count: 3,
      fileId: [1, 2],
    });
  });

  it('rejects an invalid structured append header', () => {
    for (const cws of [
      [233, 0x20, 1, 2],
      [233, 0x3e, 1, 2],
      [233, 0x2e, 0, 2],
      [233, 0x2e, 1, 255],
    ])
      expect(cwFailure(cws)).toEqual(CODEWORD);
  });

  it('accepts structured append, reader programming and macros only first', () => {
    expect(cwFailure([66, 233, 1, 1, 1])).toEqual(CODEWORD);
    expect(cwFailure([66, 234])).toEqual(CODEWORD);
    expect(cwFailure([66, 236])).toEqual(CODEWORD);
    expect(cwFailure([233, 1, 1])).toEqual(CODEWORD);
    expect(textOf([237, 66])).toBe(']d1[)>\u001e06\u001dA\u001e\u0004');
    expect(mustText([234, 66]).special).toBe('reader-programming');
  });

  it('decodes 1, 2 and 3 codeword ECI designators', () => {
    expect(mustText([241, 27, 66]).eci).toBe(26);
    expect(mustText([241, 128 + 1, 5, 66]).eci).toBe(254 + 5 - 1 + 127);
    expect(mustText([241, 192 + 1, 2, 3, 66]).eci).toBe(64516 + 254 + 3 - 1 + 16383);
    expect(textOf([241, 27, 66])).toBe(']d1A');
    expect(cwFailure([241])).toEqual(CODEWORD);
    expect(cwFailure([241, 130])).toEqual(CODEWORD);
    expect(cwFailure([241, 200, 1])).toEqual(CODEWORD);
    expect(cwFailure([241, 0])).toEqual(CODEWORD);
  });

  it('decodes upper shift in ASCII and rejects it before a non-character', () => {
    expect(textOf([235, 106])).toBe(']d1é');
    expect(cwFailure([235])).toEqual(CODEWORD);
    expect(cwFailure([235, 130])).toEqual(CODEWORD);
  });

  it('decodes C40 basic and shift sets, upper shift and FNC1, across triplets', () => {
    // A B space 0 9 Z | shift1 0x07 | shift2 '!' | shift2 FNC1 | shift3 96+5 | shift2 upshift 'A'
    const vals = [14, 15, 3, 4, 13, 39, 0, 7, 1, 0, 1, 27, 2, 5, 1, 30, 14];
    expect(textOf([230, ...c40(vals.concat([0])), 254, 66])).toBe(`]d1AB 09Z\u0007!${GS}eÁA`);
    expect(mustText([230, ...c40(vals.concat([0])), 254, 66]).encodation).toEqual(['c40', 'ascii']);
  });

  it('decodes Text shift 3 and its lowercase basic set', () => {
    // a z | shift3 0 (`) | shift3 1 (A) | shift3 27 ({) | shift3 31 (DEL)
    const vals = [14, 39, 2, 0, 2, 1, 2, 27, 2, 31];
    expect(textOf([239, ...c40(vals.concat([14, 15]))])).toBe(']d1az`A{\u007fab');
  });

  it('rejects invalid C40, Text and X12 values', () => {
    expect(cwFailure([230, ...c40([1, 28, 3])])).toEqual(CODEWORD); // shift 2 value 28
    expect(cwFailure([230, ...c40([0, 32, 3])])).toEqual(CODEWORD); // shift 1 value 32
    expect(cwFailure([230, ...c40([2, 32, 3])])).toEqual(CODEWORD); // shift 3 value 32
    expect(cwFailure([239, ...c40([2, 35, 3])])).toEqual(CODEWORD);
    expect(cwFailure([238, ...c40([3, 3, 3]).map((v, i) => (i === 0 ? 253 : v))])).toEqual(
      CODEWORD,
    ); // value 40
    expect(cwFailure([230, 253, 255])).toEqual(CODEWORD);
    expect(cwFailure([230, ...c40([1, 30, 1]), ...c40([27, 3, 3])])).toEqual(CODEWORD); // upper shift before FNC1
  });

  it('decodes X12 values', () => {
    expect(textOf([238, ...c40([0, 1, 2, 3, 4, 39])])).toBe(']d1\r*> 0Z');
  });

  it('applies the triplet tail rules: lone final codeword as ASCII, 254 last', () => {
    expect(textOf([230, ...c40([14, 15, 16]), 67])).toBe(']d1ABCB');
    expect(textOf([230, ...c40([14, 15, 16]), 254])).toBe(']d1ABC');
    expect(textOf([230, ...c40([14, 15, 16]), 254, 129, 77])).toBe(']d1ABC');
    // A dangling shift (padding of the last triplet) is ignored.
    expect(textOf([230, ...c40([14, 15, 0]), 254])).toBe(']d1AB');
  });

  it('decodes EDIFACT with unlatch at every position and the ASCII tail', () => {
    const A = 1; // 'A' & 63
    expect(textOf([240, ...edifact([A, A, A, A]), 66, 67])).toBe(']d1AAAAAB');
    expect(textOf([240, ...edifact([31, 0, 0, 0]).slice(0, 1), 66, 129, 1, 1])).toBe(']d1A');
    expect(textOf([240, ...edifact([A, 31, 0, 0]).slice(0, 2), 66, 129, 1])).toBe(']d1AA');
    expect(textOf([240, ...edifact([A, A, 31, 0]), 66, 129])).toBe(']d1AAA');
    expect(textOf([240, ...edifact([A, A, A, 31]), 66, 129])).toBe(']d1AAAA');
    expect(textOf([240, ...edifact([32, 33, 0x3e, 0])])).toBe(']d1 !>@');
    expect(mustText([240, ...edifact([A, A, A, A]), 66]).encodation).toEqual(['edifact', 'ascii']);
  });

  it('decodes Base 256 with short, long and to-the-end lengths', () => {
    const bytes = [0xe9, 0x00, 0xff];
    const short = [231, r255(3, 2), ...bytes.map((b, i) => r255(b, 3 + i)), 66];
    expect(textOf(short)).toBe(']d1é\u0000ÿA');
    const long = Array.from({ length: 300 }, (_, i) => i & 255);
    const d1 = Math.floor(300 / 250) + 249;
    const d2 = 300 % 250;
    const cws = [231, r255(d1, 2), r255(d2, 3), ...long.map((b, i) => r255(b, 4 + i))];
    expect(mustText(cws).data).toBe(String.fromCharCode(...long));
    const toEnd = [231, r255(0, 2), ...bytes.map((b, i) => r255(b, 3 + i))];
    expect(mustText(toEnd).data).toBe('é\u0000ÿ');
    expect(mustText(toEnd).encodation).toEqual(['base256']);
    expect(cwFailure([231, r255(5, 2), r255(1, 3)])).toEqual(CODEWORD);
    expect(cwFailure([231])).toEqual(CODEWORD);
    expect(cwFailure([231, r255(251, 2)])).toEqual(CODEWORD);
  });

  it('rejects upper shift before FNC1 in ASCII', () => {
    expect(cwFailure([235, 232])).toEqual(CODEWORD);
  });
});

// ---------------------------------------------------------------------------------------------
// gs1FromData

/** ok, or the errors as [code, details, position - shift, length]. */
function summary(r: { ok: boolean; errors?: readonly Gs1Error[] }, shift: number): unknown {
  return r.ok
    ? 'ok'
    : (r.errors ?? []).map((e) => [
        e.code,
        e.details,
        e.position === undefined ? undefined : e.position - shift,
        e.length,
      ]);
}

describe('gs1FromData', () => {
  it('parses ]d2 data without the association rules', () => {
    const r = gs1FromData(`10ABC${GS}21XYZ`);
    expect(r.ok && r.value.get('10')).toBe('ABC');
  });

  it('agrees with fromScan on the pre-checks and positions', () => {
    for (const data of [
      '',
      '^0112345678901231',
      '01123456789012^31',
      `${GS}0112345678901231`,
      '(01)12345678901231',
      'A1',
      '0112345678901234',
      `10ABC${GS}${GS}21X`,
      '0112345678901231',
    ]) {
      const ours = gs1FromData(data);
      const theirs = tryFromScan(`]d2${data}`, { validateAssociations: false });
      expect(summary(ours, 0)).toEqual(summary(theirs, 3));
    }
  });

  it('empty data is EMPTY_INPUT at 0 and a leading GS is INVALID_SCAN payload', () => {
    expect(firstError(gs1FromData('')).code).toBe('EMPTY_INPUT');
    const e = firstError(gs1FromData(`${GS}01`));
    expect([e.code, e.details, e.position]).toEqual(['INVALID_SCAN', { reason: 'payload' }, 0]);
  });

  it('never throws (500 random strings)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(safe(gs1FromData(s))).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
