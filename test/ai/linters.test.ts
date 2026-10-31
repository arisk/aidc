import { describe, expect, it } from 'vitest';
import vectorsFile from '../vectors/linters.json' with { type: 'json' };
import { LINTERS, isLinterName } from '../../src/ai/linters/index.ts';

interface Case {
  readonly data: string;
  readonly expected: { code: string; pos: number; len: number } | null;
}

// The gcppos vectors come from C unit tests built with a mock custom GCP lookup
// (the same input expects both INVALID_GCP_PREFIX and GCP_DATASOURCE_OFFLINE), so
// they cannot apply to the lookup-free port. The hand-written cases below cover them.
const LOOKUP_DEPENDENT = new Set(['gcppos1', 'gcppos2']);

// The couponcode vectors that exercise the GCP lookup expect INVALID_GCP_PREFIX or
// GCP_DATASOURCE_OFFLINE for inputs the C only rejects with a mock custom lookup. The port
// has no lookup and gcppos1 cannot fail on the digit-only data couponcode passes it, so only
// those error vectors are dropped. The ok:true vectors for the same inputs are kept: they are
// the lookup-free C results and show the gcppos1 omission is safe.
const LOOKUP_CODES = new Set(['INVALID_GCP_PREFIX', 'GCP_DATASOURCE_OFFLINE']);
const isLookupVector = (v: { linter: string; code?: string | undefined }): boolean =>
  v.linter === 'couponcode' && v.code !== undefined && LOOKUP_CODES.has(v.code);

it('drops exactly the 8 lookup-dependent couponcode vectors', () => {
  expect(vectorsFile.vectors.filter(isLookupVector)).toHaveLength(8);
});

const byLinter = new Map<string, Case[]>();
for (const v of vectorsFile.vectors) {
  if (LOOKUP_DEPENDENT.has(v.linter)) continue;
  if (isLookupVector(v)) continue;
  const list = byLinter.get(v.linter) ?? [];
  const expected = v.ok ? null : { code: v.code ?? '', pos: v.pos ?? -1, len: v.len ?? -1 };
  list.push({ data: v.data, expected });
  byLinter.set(v.linter, list);
}

describe('csumalpha edge cases', () => {
  it('rejects non-ASCII characters in the payload as invalid cset82', () => {
    expect(LINTERS.csumalpha('\u00e9AB')).toEqual({
      code: 'INVALID_CSET82_CHARACTER',
      pos: 0,
      len: 1,
    });
  });
  it('rejects characters outside cset82 and accepts the 22 pair', () => {
    expect(LINTERS.csumalpha('~AB')).toEqual({ code: 'INVALID_CSET82_CHARACTER', pos: 0, len: 1 });
    expect(LINTERS.csumalpha('22')).toBeNull();
  });
});

describe('GS1 reference linter vectors', () => {
  for (const [name, cases] of byLinter) {
    const suite = isLinterName(name) ? describe : describe.skip;
    suite(name, () => {
      it(`passes all ${cases.length} reference cases`, () => {
        const lint = isLinterName(name) ? LINTERS[name] : () => null;
        const mismatches = cases
          .map((c) => ({ data: c.data, expected: c.expected, actual: lint(c.data) }))
          .filter((r) => JSON.stringify(r.expected) !== JSON.stringify(r.actual));
        expect(mismatches).toEqual([]);
      });
    });
  }
});

describe('linters never throw on hostile input', () => {
  const hostile = [
    '',
    '\u0000',
    'é',
    '\u{1F600}',
    'A'.repeat(200),
    '(',
    '\\',
    '=',
    '0'.repeat(200),
  ];
  it.each(Object.keys(LINTERS))('%s', (name) => {
    const lint = isLinterName(name) ? LINTERS[name] : () => null;
    for (const s of hostile) expect(() => lint(s)).not.toThrow();
  });
});

describe('gcppos (dynamic C cases ported by hand)', () => {
  it('gcppos1 needs 4 leading digits', () => {
    expect(LINTERS.gcppos1('1234')).toBeNull();
    expect(LINTERS.gcppos1('123')).toEqual({ code: 'TOO_SHORT_FOR_GCP', pos: 0, len: 3 });
    expect(LINTERS.gcppos1('12A4')).toEqual({ code: 'INVALID_GCP_PREFIX', pos: 2, len: 1 });
  });
  it('gcppos2 skips the first character', () => {
    expect(LINTERS.gcppos2('X1234')).toBeNull();
    expect(LINTERS.gcppos2('X')).toEqual({ code: 'TOO_SHORT_FOR_GCP', pos: 0, len: 1 });
    expect(LINTERS.gcppos2('912A4')).toEqual({ code: 'INVALID_GCP_PREFIX', pos: 3, len: 1 });
  });
});

const pad = (n: number): string => String(((n % 100) + 100) % 100).padStart(2, '0');

describe('two-digit year century window (GenSpecs 7.12)', () => {
  const yy = new Date().getUTCFullYear() % 100;

  it('treats +50 years as this century and -50 years as this century or the last', () => {
    expect(LINTERS.yymmd0(`${pad(yy + 50)}0101`)).toBeNull();
    expect(LINTERS.yymmd0(`${pad(yy - 49)}0101`)).toBeNull();
  });

  it('checks 29 February against the resolved century', () => {
    expect(LINTERS.yymmdd('000229')).toBeNull();
    expect(LINTERS.yymmdd('010229')).toEqual({ code: 'ILLEGAL_DAY', pos: 4, len: 2 });
  });

  it('yymmd0 permits day 00 and yymmdd does not', () => {
    expect(LINTERS.yymmd0('250100')).toBeNull();
    expect(LINTERS.yymmdd('250100')).toEqual({ code: 'ILLEGAL_DAY', pos: 4, len: 2 });
  });
});

describe('geocoordinates at and above 2^32 (GenSpecs 7.13)', () => {
  // The Syntax Engine's WASM build accumulates these in a 32-bit unsigned long, so it wraps
  // 5000000000 to 705032704 and accepts it; the oracle test lists this as a known difference.
  it('rejects them instead of wrapping', () => {
    expect(LINTERS.longitude('5000000000')).toEqual({ code: 'INVALID_LONGITUDE', pos: 0, len: 10 });
    expect(LINTERS.latitude('4294967296')).toEqual({ code: 'INVALID_LATITUDE', pos: 0, len: 10 });
    expect(LINTERS.longitude('3600000000')).toBeNull();
    expect(LINTERS.latitude('1800000000')).toBeNull();
  });
});
