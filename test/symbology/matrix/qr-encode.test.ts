import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/qr.json' with { type: 'json' };
import {
  type QrMode,
  type QrSegment,
  characterCount,
  chooseVersion,
  encodeSegments,
  segment,
} from '../../../src/symbology/matrix/qr-encode.ts';
import { buildSymbol } from '../../../src/symbology/matrix/qr-place.ts';
import { EC_LEVELS, countBits, qrVersion } from '../../../src/symbology/matrix/qr-tables.ts';
import type { QrEcLevel } from '../../../src/symbology/matrix/qr-tables.ts';
import { qrRowsToMatrix } from '../../support/matrix.ts';

const FNC1 = -1;
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const GROUP_VERSION = [1, 10, 27] as const;

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

/** Units of a vector input: U+001D is FNC1 in GS1 data. */
function unitsOf(input: string, gs1: boolean): number[] {
  return Array.from(input, (c) => (gs1 && c === '\u001d' ? FNC1 : c.charCodeAt(0)));
}

const MODE_LETTER: Readonly<Record<QrMode, string>> = {
  numeric: 'N',
  alphanumeric: 'A',
  byte: 'B',
};

/** Segments in the vector notation, FNC1 indicator excluded. */
function described(
  segments: readonly QrSegment[],
  gs1: boolean,
): { mode: string; count: number }[] {
  return segments.map((s) => ({ mode: MODE_LETTER[s.mode], count: characterCount(s, gs1) }));
}

/** Exact bits of a segment list, computed independently of the encoder. */
function exactBits(segments: readonly QrSegment[], gs1: boolean, group: 0 | 1 | 2): number {
  let bits = gs1 ? 4 : 0;
  for (const s of segments) {
    const c = characterCount(s, gs1);
    bits += 4 + countBits(s.mode, GROUP_VERSION[group]);
    if (s.mode === 'numeric') bits += 10 * Math.floor(c / 3) + [0, 4, 7][c % 3]!;
    else if (s.mode === 'alphanumeric') bits += 11 * Math.floor(c / 2) + 6 * (c % 2);
    else bits += 8 * c;
  }
  return bits;
}

const isDigit = (u: number): boolean => u >= 0x30 && u <= 0x39;
const isAlnum = (u: number, gs1: boolean): boolean =>
  (u === FNC1 && gs1) || (u >= 0 && ALNUM.includes(String.fromCharCode(u)));

/** The minimum exact bits over every mode assignment (brute force). */
function bruteForce(units: readonly number[], gs1: boolean, group: 0 | 1 | 2): number {
  let best = Number.POSITIVE_INFINITY;
  const modes: QrMode[] = [];
  const walk = (i: number): void => {
    if (i === units.length) {
      const segs: { mode: QrMode; units: number[] }[] = [];
      for (let k = 0; k < units.length; k++) {
        const last = segs.at(-1);
        if (last && last.mode === modes[k]) last.units.push(units[k]!);
        else segs.push({ mode: modes[k]!, units: [units[k]!] });
      }
      best = Math.min(best, exactBits(segs, gs1, group));
      return;
    }
    const u = units[i]!;
    const allowed: QrMode[] = ['byte'];
    if (isDigit(u)) allowed.push('numeric');
    if (isAlnum(u, gs1)) allowed.push('alphanumeric');
    for (const m of allowed) {
      modes[i] = m;
      walk(i + 1);
    }
  };
  walk(0);
  return best;
}

/**
 * The minimum exact bits over every partition into single-mode segments, by a shortest path over
 * positions that prices each candidate segment with `exactBits` (quadratic, independent of the
 * encoder's sixths-of-a-bit costs). Equal to the minimum over mode assignments, since merging two
 * neighbouring segments of one mode never costs more.
 */
function partitionMinimum(units: readonly number[], gs1: boolean, group: 0 | 1 | 2): number {
  const best = [gs1 ? 4 : 0];
  for (let j = 1; j <= units.length; j++) {
    let b = Number.POSITIVE_INFINITY;
    for (let i = j - 1; i >= 0; i--) {
      const part = units.slice(i, j);
      const allowed: QrMode[] = ['byte'];
      if (part.every(isDigit)) allowed.push('numeric');
      if (part.every((u) => isAlnum(u, gs1))) allowed.push('alphanumeric');
      for (const mode of allowed) {
        b = Math.min(b, best[i]! + exactBits([{ mode, units: part }], gs1, group) - (gs1 ? 4 : 0));
      }
    }
    best.push(b);
  }
  return best[units.length]!;
}

/** Bits of codewords, most significant first. */
function bitsOf(codewords: readonly number[]): number[] {
  return codewords.flatMap((c) => Array.from({ length: 8 }, (_, i) => (c >> (7 - i)) & 1));
}

function read(bits: readonly number[], at: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) v = (v << 1) | bits[at + i]!;
  return v;
}

/** The characters of the alphanumeric segment that starts the stream (after 0101 when gs1). */
function alnumChars(codewords: readonly number[], gs1: boolean): string {
  const bits = bitsOf(codewords);
  let p = 0;
  if (gs1) {
    if (read(bits, p, 4) !== 0b0101) throw new Error('no FNC1 indicator');
    p += 4;
  }
  if (read(bits, p, 4) !== 0b0010) throw new Error('not an alphanumeric segment');
  p += 4;
  const count = read(bits, p, 9);
  p += 9;
  let out = '';
  for (let i = 0; i + 1 < count; i += 2) {
    const v = read(bits, p, 11);
    p += 11;
    out += ALNUM[Math.floor(v / 45)]! + ALNUM[v % 45]!;
  }
  if (count % 2) out += ALNUM[read(bits, p, 6)]!;
  return out;
}

// Web Crypto, so the test also runs in the browser projects.
const sha256 = async (rows: readonly string[]): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rows.join('\n')));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const encodeVectors = [...vectors.derived, ...vectors.figures].filter(
  (v) => v.use.startsWith('encode') || v.use.startsWith('decode, and encode'),
);

describe('vectors', () => {
  it('covers every vector whose use says encode', () => {
    expect(encodeVectors.map((v) => v.id)).toEqual([
      ...vectors.derived.map((v) => v.id),
      'genspecs-fig-2-3',
      'genspecs-fig-5-10',
      'genspecs-fig-5-52',
      'genspecs-fig-6-6',
      'verif-fig-9-7',
    ]);
  });

  for (const v of encodeVectors) {
    it(`encodes ${v.id} bit-exact`, () => {
      const gs1 = v.syntax === 'element-string';
      const level = toLevel(v.level);
      const r = chooseVersion(unitsOf(v.input, gs1), gs1, level, 'auto');
      if (!r.ok) throw new Error(r.errors[0]?.message);
      expect(r.value.version).toBe(v.version);
      expect(described(r.value.segments, gs1)).toEqual(v.segments.filter((s) => s.mode !== 'FNC1'));
      expect(r.value.codewords).toEqual(hex(v.dataCodewords));
      expect(buildSymbol(v.version, level, r.value.codewords, 'auto')).toEqual(
        qrRowsToMatrix(v.rows),
      );
    });
  }

  for (const v of [...vectors.engine, ...vectors.figures].filter((x) => 'derivedOptimal' in x)) {
    it(`gives the derived optimal symbol of ${v.id}`, () => {
      if (!('derivedOptimal' in v)) throw new Error('filtered');
      const gs1 = v.syntax === 'element-string';
      const level = toLevel(v.level);
      const r = chooseVersion(unitsOf(v.input, gs1), gs1, level, 'auto');
      if (!r.ok) throw new Error(r.errors[0]?.message);
      const d = v.derivedOptimal;
      expect(r.value.version).toBe(d.version);
      expect(described(r.value.segments, gs1)).toEqual(d.segments);
      expect(buildSymbol(d.version, level, r.value.codewords, 'auto')).toEqual(
        qrRowsToMatrix(d.rows),
      );
    });
  }

  it('reproduces the engine Digital Link vector byte-only', () => {
    const v = vectors.engine.find((x) => x.id === 'engine-digital-link')!;
    const cw = encodeSegments([{ mode: 'byte', units: unitsOf(v.input, false) }], false, 3, 'M');
    expect(cw).toEqual(hex(v.dataCodewords));
    expect(buildSymbol(3, 'M', cw ?? [], 3)).toEqual(qrRowsToMatrix(v.rows));
    expect(buildSymbol(3, 'M', cw ?? [], 'auto')).toEqual(qrRowsToMatrix(v.rows));
  });

  for (const id of ['engine-gs1-ai-element-string', 'genspecs-fig-5-7']) {
    it(`encodes ${id} in strictly fewer bits than its byte-only symbol`, () => {
      const v = [...vectors.engine, ...vectors.figures].find((x) => x.id === id)!;
      const units = unitsOf(v.input, true);
      const byteOnly = 4 + 4 + 8 + 8 * units.length;
      const r = chooseVersion(units, true, toLevel(v.level), 'auto');
      if (!r.ok) throw new Error(r.errors[0]?.message);
      expect(r.value.bits).toBeLessThan(byteOnly);
      expect(r.value.version).toBeLessThan(v.version);
    });
  }

  it('reproduces the 160 structure hashes of HELLO1', async () => {
    const units = unitsOf('HELLO1', false);
    expect(vectors.structure).toHaveLength(160);
    await Promise.all(
      vectors.structure.map(async (s) => {
        const level = toLevel(s.level);
        const r = chooseVersion(units, false, level, s.version);
        if (!r.ok) throw new Error(r.errors[0]?.message);
        expect(r.value.version).toBe(s.version);
        expect(r.value.codewords).toHaveLength(qrVersion(s.version).levels[level].dataCodewords);
        const m = buildSymbol(s.version, level, r.value.codewords, 'auto');
        expect(await sha256(m.rows), `${s.version}-${s.level}`).toBe(s.sha256);
      }),
    );
  }, 30_000);
});

describe('the % character and FNC1 (Review Focus 5)', () => {
  it('doubles a literal % in an alphanumeric segment: (10)%A', () => {
    const units = unitsOf('10%A', true);
    const r = segment(units, true, 0);
    expect(r.segments).toEqual([{ mode: 'alphanumeric', units }]);
    expect(r.bits).toBe(4 + 4 + 9 + 11 * 2 + 6);
    expect(alnumChars(encodeSegments(r.segments, true, 1, 'M') ?? [], true)).toBe('10%%A');
  });

  it('encodes FNC1 then a literal % as %%%', () => {
    const units = [0x41, FNC1, 0x25];
    const cw = encodeSegments([{ mode: 'alphanumeric', units }], true, 1, 'M');
    expect(alnumChars(cw ?? [], true)).toBe('A%%%');
  });

  it('never doubles % outside GS1 mode', () => {
    const units = unitsOf('HTTPS://X.Y/A%2F', false);
    const r = segment(units, false, 0);
    expect(r.segments).toEqual([{ mode: 'alphanumeric', units }]);
    expect(alnumChars(encodeSegments(r.segments, false, 1, 'M') ?? [], false)).toBe(
      'HTTPS://X.Y/A%2F',
    );
  });

  it('(99)%%% is six alphanumeric characters for the %, but bytes are cheaper', () => {
    const units = unitsOf('99%%%', true);
    const cw = encodeSegments([{ mode: 'alphanumeric', units }], true, 1, 'M');
    expect(alnumChars(cw ?? [], true)).toBe('99%%%%%%');
    const r = segment(units, true, 0);
    expect(described(r.segments, true)).toEqual([{ mode: 'B', count: 5 }]);
    expect(r.bits).toBe(4 + 4 + 8 + 40);
    expect(r.bits).toBe(bruteForce(units, true, 0));
  });

  it('(01)09506000134352(10)abc%(99)%%% at Q is FNC1,N18,B10 = 170 bits, 2-Q', () => {
    const units = unitsOf('010950600013435210abc%\u001d99%%%', true);
    const r = chooseVersion(units, true, 'Q', 'auto');
    if (!r.ok) throw new Error(r.errors[0]?.message);
    expect(described(r.value.segments, true)).toEqual([
      { mode: 'N', count: 18 },
      { mode: 'B', count: 10 },
    ]);
    expect(r.value.bits).toBe(170);
    expect(r.value.version).toBe(2);
    expect(partitionMinimum(units, true, 0)).toBe(170);
  });

  it('(10)abc%(99)%%% alone at Q is one byte segment of 12 (112 bits)', () => {
    const units = unitsOf('10abc%\u001d99%%%', true);
    const r = chooseVersion(units, true, 'Q', 'auto');
    if (!r.ok) throw new Error(r.errors[0]?.message);
    expect(described(r.value.segments, true)).toEqual([{ mode: 'B', count: 12 }]);
    expect(r.value.bits).toBe(112);
    expect(bruteForce(units, true, 0)).toBe(112);
    expect(partitionMinimum(units, true, 0)).toBe(112);
  });

  it('writes FNC1 as 0x1D in a byte segment', () => {
    const cw = encodeSegments([{ mode: 'byte', units: [0x61, FNC1] }], true, 1, 'M') ?? [];
    const bits = bitsOf(cw);
    expect(read(bits, 0, 4)).toBe(0b0101);
    expect(read(bits, 4, 4)).toBe(0b0100);
    expect(read(bits, 8, 8)).toBe(2);
    expect(read(bits, 16, 8)).toBe(0x61);
    expect(read(bits, 24, 8)).toBe(0x1d);
  });
});

const unitArb = fc.oneof(
  fc.integer({ min: 0x30, max: 0x39 }),
  fc.integer({ min: 0x41, max: 0x5a }),
  fc.integer({ min: 0x61, max: 0x7a }),
  fc.constantFrom(0x25, 0x2f, 0x3a, 0x3f, 0x3d, FNC1),
);

describe('minimality', () => {
  it('equals the brute-force minimum and never beats the exact bits of its segments', () => {
    fc.assert(
      fc.property(
        fc.array(unitArb, { minLength: 1, maxLength: 40 }),
        fc.boolean(),
        fc.constantFrom<0 | 1 | 2>(0, 1, 2),
        (raw, gs1, group) => {
          const units = gs1 ? raw : raw.map((u) => (u === FNC1 ? 0x1d : u));
          const r = segment(units, gs1, group);
          expect(r.bits).toBe(exactBits(r.segments, gs1, group));
          expect(r.segments.flatMap((s) => s.units)).toEqual(units);
          const fits = (s: QrSegment): boolean =>
            s.units.length > 0 &&
            (s.mode !== 'numeric' || s.units.every(isDigit)) &&
            (s.mode !== 'alphanumeric' || s.units.every((u) => isAlnum(u, gs1)));
          expect(r.segments.every(fits)).toBe(true);
          const byteOnly = exactBits([{ mode: 'byte', units }], gs1, group);
          expect(r.bits).toBeLessThanOrEqual(byteOnly);
          expect(r.bits).toBe(partitionMinimum(units, gs1, group));
          const brute = units.length <= 10 ? bruteForce(units, gs1, group) : r.bits;
          expect(r.bits).toBe(brute);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('merges neighbours into maximal segments', () => {
    fc.assert(
      fc.property(fc.array(unitArb, { minLength: 1, maxLength: 60 }), (units) => {
        const { segments } = segment(units, true, 1);
        for (let i = 1; i < segments.length; i++) {
          expect(segments[i]!.mode).not.toBe(segments[i - 1]!.mode);
        }
      }),
    );
  });

  it('breaks ties toward the previous mode in order N, A, B', () => {
    // A25 costs the same; the tie at the A after the digits goes to the numeric predecessor.
    const units = unitsOf('48//C04/C0C0048044880084C', true);
    const r = segment(units, true, 0);
    expect(described(r.segments, true)).toEqual([
      { mode: 'A', count: 11 },
      { mode: 'N', count: 13 },
      { mode: 'A', count: 1 },
    ]);
    expect(r.bits).toBe(exactBits([{ mode: 'alphanumeric', units }], true, 0));
  });

  it('gives no segments for no units', () => {
    expect(segment([], true, 0)).toEqual({ segments: [], bits: 4 });
    expect(segment([], false, 2)).toEqual({ segments: [], bits: 0 });
  });
});

describe('bit stream', () => {
  it('pads with a terminator, zero bits and EC 11 alternately', () => {
    // 01234567 at 1-M, the ISO Annex I example.
    const cw = encodeSegments(
      [{ mode: 'numeric', units: unitsOf('01234567', false) }],
      false,
      1,
      'M',
    );
    expect(cw).toEqual(hex('10200C566180EC11EC11EC11EC11EC11'));
  });

  it('shortens the terminator at capacity', () => {
    // 1-L holds 152 bits; 41 digits take 4 + 10 + 137 = 151.
    const units = unitsOf('1'.repeat(41), false);
    const cw = encodeSegments([{ mode: 'numeric', units }], false, 1, 'L');
    expect(cw).toHaveLength(19);
    expect((cw?.[18] ?? 1) & 1).toBe(0);
    expect(encodeSegments([{ mode: 'numeric', units: [...units, 0x31] }], false, 1, 'L')).toBe(
      undefined,
    );
  });

  it('returns undefined when the stream does not fit', () => {
    const units = unitsOf('a'.repeat(15), false);
    expect(encodeSegments([{ mode: 'byte', units }], false, 1, 'M')).toBe(undefined);
    expect(encodeSegments([{ mode: 'byte', units: units.slice(1) }], false, 1, 'M')).toHaveLength(
      16,
    );
  });
});

describe('version selection and errors (Review Focus 1)', () => {
  it('gives DATA_TOO_LONG in bits for an explicit version that is too small', () => {
    const r = chooseVersion(
      unitsOf('0110012345678902\u001d10ABCDEFGHIJKLMNOPQRSTUV', true),
      true,
      'M',
      1,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('DATA_TOO_LONG');
    expect(r.errors[0]?.details).toMatchObject({ limit: 128, unit: 'bits', version: 1 });
    expect(r.errors[0]?.details?.actual).toBeGreaterThan(128);
  });

  it('fits 7,089 digits at L in version 40 and rejects 7,090', () => {
    const fits = chooseVersion(unitsOf('7'.repeat(7089), false), false, 'L', 'auto');
    expect(fits.ok && fits.value.version).toBe(40);
    const r = chooseVersion(unitsOf('7'.repeat(7090), false), false, 'L', 'auto');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('DATA_TOO_LONG');
    expect(r.errors[0]?.details).toEqual({ limit: 2956 * 8, actual: 23652, unit: 'bits' });
  });

  it('rejects a unit above 0x7E with NOT_REPRESENTABLE and its position', () => {
    const r = chooseVersion([0x41, 0x42, 0x80], false, 'M', 'auto');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('NOT_REPRESENTABLE');
    expect(r.errors[0]?.details).toMatchObject({ position: 2, value: 0x80 });
  });

  it('rejects FNC1 outside GS1 mode', () => {
    const r = chooseVersion([0x41, FNC1], false, 'M', 'auto');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('NOT_REPRESENTABLE');
    expect(r.errors[0]?.details).toMatchObject({ position: 1 });
  });

  for (const version of [0, 41, 1.5, Number.NaN, '7', -1]) {
    it(`rejects version ${String(version)} with INVALID_VALUE`, () => {
      // oxlint-disable-next-line no-unsafe-type-assertion -- deliberately invalid input
      const r = chooseVersion([0x41], false, 'M', version as number);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors[0]?.code).toBe('INVALID_VALUE');
      expect(r.errors[0]?.details).toMatchObject({ option: 'version' });
    });
  }

  it('takes the smallest version across groups', () => {
    // 1-H holds 72 bits: 17 digits are 4 + 10 + 57 = 71.
    const r = chooseVersion(unitsOf('1'.repeat(17), false), false, 'H', 'auto');
    expect(r.ok && r.value.version).toBe(1);
    const big = chooseVersion(unitsOf('a'.repeat(300), false), false, 'L', 'auto');
    expect(big.ok && big.value.version).toBe(11);
  });

  it('encodes 2,953 bytes at 40-L in under 50 ms', () => {
    const units = unitsOf('a'.repeat(2953), false);
    chooseVersion(units, false, 'L', 'auto');
    const t = performance.now();
    const r = chooseVersion(units, false, 'L', 'auto');
    const elapsed = performance.now() - t;
    expect(r.ok && r.value.version).toBe(40);
    expect(elapsed).toBeLessThan(50);
  });
});
