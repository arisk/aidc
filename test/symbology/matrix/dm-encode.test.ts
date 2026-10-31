import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/datamatrix.json' with { type: 'json' };
import { DM_SIZES, dmSize } from '../../../src/symbology/matrix/dm-tables.ts';
import type { DmSize } from '../../../src/symbology/matrix/dm-tables.ts';
import { placeCodewords } from '../../../src/symbology/matrix/dm-place.ts';
import {
  checkSymbols,
  chooseSize,
  DM_FNC1,
  encodeCodewords,
} from '../../../src/symbology/matrix/dm-encode.ts';
import type { DmEncodation, DmSizeOption } from '../../../src/symbology/matrix/dm-encode.ts';
import { xRowsToMatrix } from '../../support/matrix.ts';

const GS = String.fromCharCode(29);

/** Symbols of a string: GS (and `^`, for readability in literals) become FNC1. */
function sym(text: string, options: { gs1?: boolean } = {}): number[] {
  const out = options.gs1 === true ? [DM_FNC1] : [];
  for (const ch of text) out.push(ch === GS || ch === '^' ? DM_FNC1 : ch.charCodeAt(0));
  return out;
}

function sizeOf(rows: number, columns: number): DmSize {
  const s = dmSize(rows, columns);
  if (!s) throw new Error(`no size ${rows}x${columns}`);
  return s;
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

function randomSymbols(rand: () => number, alphabet: readonly number[], length: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < length; i++) out.push(alphabet[Math.floor(rand() * alphabet.length)] ?? 65);
  return out;
}

const CAPACITIES = [...new Set(DM_SIZES.map((s) => s.dataCodewords))].filter((c) => c <= 62);

function fitLength(enc: DmEncodation, capacity: number): number {
  return enc.fit(capacity)?.length ?? Number.POSITIVE_INFINITY;
}

// ---------------------------------------------------------------------------------------------
// Vectors

interface EncodeVector {
  id: string;
  symbols: number[];
  size: DmSizeOption;
  rows: number;
  cols: number;
  matrix: string[];
}

const encodeVectors: EncodeVector[] = vectors.symbols.flatMap((v) => {
  const matrix =
    v.encode === 'bit-exact' || v.encode === 'bit-exact-forced-size'
      ? v.matrix
      : 'isoMatrix' in v && Array.isArray(v.isoMatrix)
        ? v.isoMatrix
        : undefined;
  if (!matrix) return [];
  const gs1 = v.symbology === 'gs1-datamatrix';
  const size: DmSizeOption =
    v.encode === 'bit-exact-forced-size'
      ? { rows: v.rows, columns: v.cols }
      : v.rows === v.cols
        ? 'square'
        : 'rectangular';
  return [
    { id: v.id, symbols: sym(v.rawData ?? '', { gs1 }), size, rows: v.rows, cols: v.cols, matrix },
  ];
});

describe('vectors', () => {
  it('has 16 encode vectors (13 bit-exact, 1 forced size, 2 engine isoMatrix)', () => {
    expect(encodeVectors).toHaveLength(16);
  });

  for (const v of encodeVectors) {
    it(`reproduces ${v.id}`, () => {
      const r = chooseSize(encodeCodewords(v.symbols, 'auto'), v.size);
      if (!r.ok) throw r.errors[0] ?? new Error('failed');
      expect([r.value.size.rows, r.value.size.columns]).toEqual([v.rows, v.cols]);
      expect(placeCodewords(r.value.size, r.value.codewords).rows).toEqual(
        xRowsToMatrix(v.matrix).rows,
      );
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Codewords

describe('encodeCodewords', () => {
  it('encodes 123456 in ASCII as 142 164 186 (Guideline Annex A)', () => {
    const enc = encodeCodewords(sym('123456'), 'auto');
    expect(enc.minimum).toBe(3);
    expect(enc.fit(3)).toEqual([142, 164, 186]);
  });

  it('encodes the GS1 Table 5-34 example as FNC1 then digit pairs', () => {
    const enc = encodeCodewords(sym('0110012345678902', { gs1: true }), 'auto');
    expect(enc.fit(10)).toEqual([232, 131, 140, 131, 153, 175, 197, 219, 132]);
  });

  it('keeps the leading FNC1 first even when C40 would absorb it', () => {
    const s = sym('ABCDEFGHIJKLMNOPQRSTUVWX', { gs1: true });
    const enc = encodeCodewords(s, 'auto');
    expect(enc.fit(30)?.[0]).toBe(232);
    expect(enc.fit(30)?.[1]).toBe(230);
  });

  it('encodes the empty input as no codewords', () => {
    const enc = encodeCodewords([], 'auto');
    expect(enc.minimum).toBe(0);
    expect(enc.fit(3)).toEqual([]);
    expect(encodeCodewords([DM_FNC1], 'auto').fit(3)).toEqual([232]);
  });

  it('uses C40 for uppercase runs, Text for lowercase, X12 and EDIFACT where shorter', () => {
    expect(encodeCodewords(sym('ABCDEFGHIJK'), 'auto').fit(12)?.[0]).toBe(230);
    expect(encodeCodewords(sym('abcdefghijkl'), 'auto').fit(12)?.[0]).toBe(239);
    expect(encodeCodewords(sym('A*B>C*D>E*F>'), 'auto').fit(12)?.[0]).toBe(238);
    expect(encodeCodewords(sym('A.B.C.D.E.F.G.H.'), 'auto').fit(18)?.[0]).toBe(240);
  });

  it('packs C40 and Text values, shifts included, into triplets (research 3.1)', () => {
    for (const [text, latch, isText] of [
      ['abcdefghijkl{mnop`qr~stu|vwxyz', 239, true],
      ['ABCDEFGHIJKL!MNOP`QR~STU' + String.fromCharCode(1) + 'VWXYZ^', 230, false],
    ] as const) {
      const s = sym(text);
      const cws = encodeCodewords(s, 'auto').fit(1558) ?? [];
      expect(cws[0]).toBe(latch);
      const values: number[] = [];
      for (let i = 1; i + 1 < cws.length && cws[i] !== 254; i += 2) {
        const v = 256 * (cws[i] ?? 0) + (cws[i + 1] ?? 0) - 1;
        values.push(Math.floor(v / 1600), Math.floor((v % 1600) / 40), v % 40);
      }
      expect(values).toEqual(s.flatMap((c) => ctValues(c, isText)).slice(0, values.length));
      expect(values.length).toBeGreaterThan(30);
    }
  });

  it('fit returns undefined when nothing fits and never exceeds the capacity', () => {
    const enc = encodeCodewords(sym('ABCDEFGHIJKLMNOP'), 'auto');
    expect(enc.fit(enc.minimum - 1)).toBeUndefined();
    expect(enc.fit(enc.minimum)).toHaveLength(enc.minimum);
    for (const c of CAPACITIES) expect(enc.fit(c)?.length ?? 0).toBeLessThanOrEqual(c);
  });

  it("encodation 'ascii' never latches", () => {
    const rand = rng(7);
    const alphabet = sym('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz*>/ .^');
    for (let k = 0; k < 300; k++) {
      const s = randomSymbols(rand, alphabet, 1 + Math.floor(rand() * 40));
      const cws = encodeCodewords(s, 'ascii').fit(1558) ?? [];
      expect(cws.length).toBeGreaterThan(0);
      expect(cws.every((c) => (c >= 1 && c <= 128) || (c >= 130 && c <= 229) || c === 232)).toBe(
        true,
      );
    }
  });

  it('values above 127 have no encodation: checkSymbols gives NOT_REPRESENTABLE', () => {
    const enc = encodeCodewords([65, 200], 'auto');
    expect(enc.fit(1558)).toBeUndefined();
    expect(enc.minimum).toBe(Number.POSITIVE_INFINITY);
    const r = checkSymbols([65, 200]);
    expect(r.ok).toBe(false);
    expect(r.ok ? undefined : r.errors[0]?.code).toBe('NOT_REPRESENTABLE');
    expect(r.ok ? undefined : r.errors[0]?.details?.['value']).toBe(200);
    expect(checkSymbols([65, 1.5]).ok).toBe(false);
    expect(checkSymbols([65, -2]).ok).toBe(false);
    expect(checkSymbols([DM_FNC1, 0, 127]).ok).toBe(true);
  });

  it('chooseSize gives NOT_REPRESENTABLE for an encodation that cannot carry its data', () => {
    const r = chooseSize(encodeCodewords([65, 128], 'auto'), 'square');
    expect(r.ok ? undefined : r.errors[0]?.code).toBe('NOT_REPRESENTABLE');
  });
});

// ---------------------------------------------------------------------------------------------
// End rules

describe('end-of-data rules', () => {
  it('a deterministic search finds every pinned ending kind', () => {
    const found = new Set<string>();
    const rand = rng(20261012);
    const upper = sym('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 */>.');
    for (let k = 0; k < 3000 && found.size < 3; k++) {
      const s = randomSymbols(rand, upper, 3 + Math.floor(rand() * 20));
      const enc = encodeCodewords(s, 'auto');
      for (const c of CAPACITIES) {
        const e = enc.ending(c);
        if (e?.kind === 'ascii-last' && e.mode === 'c40') found.add('c40-ascii-last');
        if (e?.kind === 'edifact-ascii-tail' && e.tail === 2) found.add('edifact-2');
        if (e?.kind === 'exact') found.add('exact');
      }
    }
    expect(found).toEqual(new Set(['c40-ascii-last', 'edifact-2', 'exact']));
  });

  // Inputs found by the search above (seed 20261012), pinned with their capacities.
  const pinned: {
    name: string;
    text: string;
    capacity: number;
    kind: string;
    mode: string;
    tail: number;
    last: number[];
  }[] = [
    {
      name: 'C40 + 1 codeword left (last character in ASCII, no unlatch)',
      text: 'P5HKCFLQRZ4*.88EWMQ64',
      capacity: 16,
      kind: 'ascii-last',
      mode: 'c40',
      tail: 1,
      last: [229, 47, 194],
    },
    {
      name: 'EDIFACT then 2 ASCII codewords',
      text: '/SE>2LG1.TZ*Z03',
      capacity: 12,
      kind: 'edifact-ascii-tail',
      mode: 'edifact',
      tail: 2,
      last: [241, 185, 70, 170, 91, 133],
    },
    {
      name: 'exact fit without unlatch',
      text: '72H61DOKHVDF3DD4',
      capacity: 12,
      kind: 'exact',
      mode: 'c40',
      tail: 0,
      last: [230, 153, 108, 109, 64, 108, 241],
    },
  ];

  for (const p of pinned) {
    it(`pins ${p.name}`, () => {
      const enc = encodeCodewords(sym(p.text), 'auto');
      const e = enc.ending(p.capacity);
      expect(e).toEqual({ kind: p.kind, mode: p.mode, tail: p.tail, total: p.capacity });
      const cws = enc.fit(p.capacity) ?? [];
      expect(cws).toHaveLength(p.capacity);
      expect(cws.slice(-p.last.length)).toEqual(p.last);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Minimality

const X12 = new Set(sym('\r*> 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
const SHIFT2 = '!"#$%&\'()*+,-./:;<=>?@[\\]^_';

/** C40 or Text values of one symbol (independent of the source under test). */
function ctValues(c: number, text: boolean): number[] {
  if (c === DM_FNC1) return [1, 27];
  if (c === 32) return [3];
  if (c >= 48 && c <= 57) return [c - 44];
  const basicLo = text ? 97 : 65;
  if (c >= basicLo && c < basicLo + 26) return [c - basicLo + 14];
  if (c < 32) return [0, c];
  const k = SHIFT2.indexOf(String.fromCharCode(c));
  if (k >= 0) return [1, k];
  if (!text) return [2, c - 96];
  if (c === 96) return [2, 0];
  if (c >= 65 && c <= 90) return [2, c - 64];
  return [2, c - 123 + 27];
}

const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 48 && c <= 57;

/** Fewest ASCII codewords for s[i..]: greedy digit pairs are optimal for plain ASCII. */
function asciiLength(s: readonly number[], i: number): number {
  let n = 0;
  for (let q = i; q < s.length; n++) q += isDigit(s[q]) && isDigit(s[q + 1]) ? 2 : 1;
  return n;
}

/**
 * Brute force over every mode sequence (characters one at a time, partial triplets carried as
 * state, every latch and unlatch), with the H9 end rules. The fewest codewords that fit
 * `capacity`, or Infinity.
 */
function bruteForce(input: readonly number[], capacity: number): number {
  let s = input;
  let base = 0;
  if (s[0] === DM_FNC1) {
    s = s.slice(1);
    base = 1;
  }
  const cap = capacity - base;
  const n = s.length;
  let best = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const unlatchEdf = [1, 2, 3, 3];
  const visit = (i: number, mode: string, buf: number, k: number, cost: number): void => {
    if (cost > cap) return;
    const key = `${i},${mode},${buf},${k},${cost}`;
    if (seen.has(key)) return;
    seen.add(key);
    const c = s[i];
    const done = (total: number): void => {
      if (total <= cap && total < best) best = total;
    };
    if (mode === 'A') {
      if (i === n) done(cost);
      else {
        visit(i + 1, 'A', 0, 0, cost + 1);
        if (isDigit(c) && isDigit(s[i + 1])) visit(i + 2, 'A', 0, 0, cost + 1);
      }
      for (const m of ['C', 'T', 'X', 'E']) visit(i, m, 0, 0, cost + 1);
      return;
    }
    if (mode === 'E') {
      if (i === n) done(k === 0 && cap - cost <= 2 ? cost : cost + (unlatchEdf[k] ?? 3));
      visit(i, 'A', 0, 0, cost + (unlatchEdf[k] ?? 3));
      if (k === 0 && cap - cost <= 2 && i < n) done(cost + asciiLength(s, i));
      if (c !== undefined && c >= 32 && c <= 94)
        visit(i + 1, 'E', 0, (k + 1) % 4, cost + (k === 3 ? 3 : 0));
      return;
    }
    // C, T, X: buf is the number of pending values (0..2) of the current triplet.
    if (buf === 0) {
      if (i === n) done(cost === cap ? cost : cost + 1);
      visit(i, 'A', 0, 0, cost + 1);
      const oneCodeword = i === n - 1 || (i === n - 2 && isDigit(c) && isDigit(s[i + 1]));
      if (oneCodeword && cost + 1 === cap) done(cap);
    }
    if (c === undefined) return;
    let values: number;
    if (mode === 'X') {
      if (!X12.has(c)) return;
      values = 1;
    } else values = ctValues(c, mode === 'T').length;
    const total = buf + values;
    visit(i + 1, mode, total % 3, 0, cost + 2 * Math.floor(total / 3));
  };
  visit(0, 'A', 0, 0, 0);
  return best === Number.POSITIVE_INFINITY ? best : best + base;
}

describe('minimality', () => {
  const strings: number[][] = (() => {
    const rand = rng(424242);
    const alphabet = [
      ...sym('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz*> /'),
      DM_FNC1,
    ];
    return Array.from({ length: 2000 }, () =>
      randomSymbols(rand, alphabet, 1 + Math.floor(rand() * 30)),
    );
  })();
  const short = strings.filter((s) => s.length <= 8);

  it('is never beaten by ASCII alone (2,000 strings of length 1 to 30)', () => {
    for (const s of strings) {
      const enc = encodeCodewords(s, 'auto');
      const ascii = encodeCodewords(s, 'ascii');
      expect(enc.minimum).toBeLessThanOrEqual(ascii.minimum);
      expect(enc.fit(enc.minimum)).toHaveLength(enc.minimum);
      for (const c of CAPACITIES)
        expect(fitLength(enc, c)).toBeLessThanOrEqual(fitLength(ascii, c));
    }
  });

  it('is never beaten by brute force over all mode sequences (the strings up to length 8)', () => {
    expect(short.length).toBeGreaterThan(300);
    let equal = 0;
    let total = 0;
    for (const s of short) {
      const enc = encodeCodewords(s, 'auto');
      for (let c = 1; c <= 14; c++) {
        const dp = fitLength(enc, c);
        const brute = bruteForce(s, c);
        expect(dp).toBeLessThanOrEqual(brute);
        total++;
        equal += dp === brute ? 1 : 0;
      }
    }
    expect(equal).toBe(total);
  }, 20_000);

  it('matches brute force on hand-picked tricky inputs', () => {
    for (const t of ['A1', 'AB12', '1A', 'ABCDEF1', 'abc^de', 'A*B>C', '12345', '>>>A', 'ABC.']) {
      const s = sym(t);
      const enc = encodeCodewords(s, 'auto');
      for (let c = 1; c <= 12; c++) expect(fitLength(enc, c)).toBe(bruteForce(s, c));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Size selection

function digits(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 48 + (i % 10));
}

function errorOf(r: ReturnType<typeof chooseSize>): {
  code: string | undefined;
  details: Readonly<Record<string, unknown>> | undefined;
} {
  if (r.ok) return { code: undefined, details: undefined };
  return { code: r.errors[0]?.code, details: r.errors[0]?.details };
}

describe('chooseSize', () => {
  const fifteen = encodeCodewords(digits(30), 'auto');

  it('picks the smallest square by default', () => {
    const r = chooseSize(fifteen, 'square');
    expect(r.ok && [r.value.size.rows, r.value.size.columns]).toEqual([18, 18]);
    expect(r.ok && r.value.codewords).toHaveLength(15);
  });

  it("picks the smallest rectangle for 'rectangular'", () => {
    const r = chooseSize(fifteen, 'rectangular');
    expect(r.ok && [r.value.size.rows, r.value.size.columns]).toEqual([12, 26]);
  });

  it("'auto' picks the smallest area: 15 codewords gives 12x26 (312) over 18x18 (324)", () => {
    const r = chooseSize(fifteen, 'auto');
    expect(r.ok && [r.value.size.rows, r.value.size.columns]).toEqual([12, 26]);
  });

  it("'auto' prefers the square on equal areas (12x12 over 8x18)", () => {
    const r = chooseSize(encodeCodewords(digits(10), 'auto'), 'auto');
    expect(r.ok && [r.value.size.rows, r.value.size.columns]).toEqual([12, 12]);
  });

  it('tests capacities in ascending order within each shape', () => {
    for (let n = 0; n <= 120; n++) {
      const enc = encodeCodewords(digits(2 * n), 'auto');
      const r = chooseSize(enc, 'square');
      const want = DM_SIZES.find((s) => s.shape === 'square' && s.dataCodewords >= n);
      expect(r.ok && r.value.size).toBe(want);
    }
  });

  it('uses an explicit size', () => {
    const r = chooseSize(fifteen, { rows: 24, columns: 24 });
    expect(r.ok && r.value.size).toBe(sizeOf(24, 24));
    const rect = chooseSize(fifteen, { rows: 16, columns: 48 });
    expect(rect.ok && rect.value.size).toBe(sizeOf(16, 48));
  });

  it('explicit 10x10 with more than 3 codewords is DATA_TOO_LONG limit 3', () => {
    expect(
      errorOf(chooseSize(encodeCodewords(digits(8), 'auto'), { rows: 10, columns: 10 })),
    ).toEqual({
      code: 'DATA_TOO_LONG',
      details: { limit: 3, actual: 4, unit: 'codewords', size: { rows: 10, columns: 10 } },
    });
  });

  it('rejects DMRE and unknown explicit sizes with INVALID_VALUE size', () => {
    for (const size of [
      { rows: 20, columns: 44 },
      { rows: 11, columns: 11 },
      { rows: 18, columns: 8 },
      { rows: 10.5, columns: 10 },
      { rows: Number.NaN, columns: 10 },
      { rows: -10, columns: -10 },
    ])
      expect(errorOf(chooseSize(fifteen, size))).toEqual({
        code: 'INVALID_VALUE',
        details: { option: 'size' },
      });
  });

  it('rejects malformed size options with INVALID_VALUE size', () => {
    const throwing = {
      get rows(): number {
        throw new Error('boom');
      },
      columns: 10,
    };
    for (const size of ['big', 10, null, undefined, [], { rows: '10', columns: '10' }, throwing])
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- hostile input on purpose
      expect(errorOf(chooseSize(fifteen, size as DmSizeOption))).toEqual({
        code: 'INVALID_VALUE',
        details: { option: 'size' },
      });
  });

  it("more than 49 codewords with 'rectangular' is DATA_TOO_LONG limit 49", () => {
    expect(errorOf(chooseSize(encodeCodewords(digits(100), 'auto'), 'rectangular'))).toEqual({
      code: 'DATA_TOO_LONG',
      details: { limit: 49, actual: 50, unit: 'codewords' },
    });
  });

  it('the largest square (1558 codewords) is the global limit', () => {
    expect(chooseSize(encodeCodewords(digits(3116), 'auto'), 'square').ok).toBe(true);
    for (const size of ['square', 'auto'] as const)
      expect(errorOf(chooseSize(encodeCodewords(digits(3118), 'auto'), size))).toEqual({
        code: 'DATA_TOO_LONG',
        details: { limit: 1558, actual: 1559, unit: 'codewords' },
      });
  });
});

// ---------------------------------------------------------------------------------------------
// Time

describe('bounded time', () => {
  it('encodes 1,557 digits plus FNC1 in under 50 ms', () => {
    const s = [DM_FNC1, ...digits(1557)];
    encodeCodewords(s, 'auto');
    const t0 = performance.now();
    const r = chooseSize(encodeCodewords(s, 'auto'), 'square');
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(50);
  });

  it('encodes 2,000 mixed characters in under 200 ms', () => {
    const rand = rng(99);
    const alphabet = sym('00112233445566778899ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef/.-');
    const s = [DM_FNC1, ...randomSymbols(rand, alphabet, 2000)];
    const t0 = performance.now();
    const r = chooseSize(encodeCodewords(s, 'auto'), 'square');
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(200);
  });
});
