// Differential test against epc-tds 1.4.1 (plan decision E19, research C.1) for its 15 schemes:
// random valid tag URIs go through both libraries, in both directions (tag URI to hex, and hex
// to tag URI). epc-tds's known bugs are excluded by the named predicates in EXCLUSIONS rather
// than reproduced; at least 90% of the generated cases must survive them.
import epcTdsModule from 'epc-tds';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BinarySchemeName } from '../../src/epc/index.ts';
import { epc } from '../../src/epc/index.ts';
import { identity } from '../support/epc.ts';

// epc-tds sets module.exports to its API object, while its typings describe an ES module with a
// default export; the default import is that object at run time.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
const epcTds = epcTdsModule as unknown as typeof epcTdsModule.default;

const RUNS = Number(process.env['ORACLE_RUNS'] ?? 2000);

/** A generated tag URI with the raw (unescaped) string fields it was built from. */
interface TagCase {
  readonly scheme: BinarySchemeName;
  readonly uri: string;
  /** Raw values of the GS3A3 string fields (serials, extensions, asset references). */
  readonly strings: readonly string[];
  /** The SGCN-96 serial, a Numeric String whose leading zeros are significant. */
  readonly numericSerial?: string;
}

// ---------------------------------------------------------------------------------------------
// Generators. String fields draw mostly from the characters epc-tds handles; a small share
// draws from all of TDS Table A-1 (escaped as TDS 5 requires) so the exclusions below fire.
// ---------------------------------------------------------------------------------------------

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** TDS 5 OtherChar, without ':' and '.' (epc-tds bug 6). */
const SAFE_OTHER = "!'()*+,-;=_";
const CSET82 =
  '!"%&\'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const A1_ESCAPES: Readonly<Record<string, string>> = {
  '"': '%22',
  '%': '%25',
  '&': '%26',
  '/': '%2F',
  '<': '%3C',
  '>': '%3E',
  '?': '%3F',
};
const escape = (raw: string): string =>
  raw
    .split('')
    .map((c) => A1_ESCAPES[c] ?? c)
    .join('');

const charArb = fc.oneof(
  { weight: 200, arbitrary: fc.constantFrom(...ALNUM.split('')) },
  { weight: 20, arbitrary: fc.constantFrom(...SAFE_OTHER.split('')) },
  { weight: 6, arbitrary: fc.constantFrom(...CSET82.split('')) },
);
const rawString = (max: number): fc.Arbitrary<string> =>
  fc.array(charArb, { minLength: 1, maxLength: max }).map((a) => a.join(''));

const digits = (n: number): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...'0123456789'.split('')), { minLength: n, maxLength: n })
    .map((a) => a.join(''));

/** A decimal integer below `bound` without leading zeros (TDS 14.3.1), small values favoured. */
const integer = (bound: bigint): fc.Arbitrary<string> =>
  fc
    .oneof(
      fc.bigInt({ min: 0n, max: bound - 1n < 9999n ? bound - 1n : 9999n }),
      fc.bigInt({ min: 0n, max: bound - 1n }),
    )
    .map((v) => v.toString());
const bits = (n: number): bigint => 1n << BigInt(n);

const filterArb = fc.integer({ min: 0, max: 7 });
/**
 * GS1 Company Prefix length. 12 is drawn less often: with it, four of the schemes get an empty
 * reference, which epc-tds mishandles (EXCLUSIONS 'empty-reference').
 */
const gcpLength = fc.oneof(
  { weight: 12, arbitrary: fc.integer({ min: 6, max: 11 }) },
  { weight: 1, arbitrary: fc.constant(12) },
);

/** GIAI-96 and CPI-96 reference bits N by partition value P = 12 - L (TDS Tables 14-23, 14-34). */
const GIAI96_N = [42, 45, 48, 52, 55, 58, 62] as const;
const CPI96_N = [11, 14, 17, 21, 24, 27, 31] as const;

type Tail = fc.Arbitrary<{ readonly parts: readonly string[]; readonly strings: string[] }>;
const none: Tail = fc.constant({ parts: [], strings: [] });
const intTail = (b: number): Tail => integer(bits(b)).map((s) => ({ parts: [s], strings: [] }));
const strTail = (max: number): Tail =>
  rawString(max).map((s) => ({ parts: [escape(s)], strings: [s] }));

/** F.C.ref[.tail] tag URIs for the partitioned schemes; `ref` gets the GCP length. */
function partitioned(
  scheme: BinarySchemeName,
  ref: (L: number) => fc.Arbitrary<string>,
  tail: (L: number) => Tail,
): fc.Arbitrary<TagCase> {
  return fc
    .tuple(filterArb, gcpLength)
    .chain(([f, L]) => fc.tuple(fc.constant(f), digits(L), ref(L), tail(L)))
    .map(([f, c, r, t]) => ({
      scheme,
      uri: `urn:epc:tag:${scheme}:${[f, c, r, ...t.parts].join('.')}`,
      strings: t.strings,
    }));
}

const sgcn: fc.Arbitrary<TagCase> = fc
  .tuple(filterArb, gcpLength)
  .chain(([f, L]) =>
    fc.tuple(
      fc.constant(f),
      digits(L),
      digits(12 - L),
      fc.integer({ min: 1, max: 12 }).chain(digits),
    ),
  )
  .map(([f, c, r, s]) => ({
    scheme: 'sgcn-96',
    uri: `urn:epc:tag:sgcn-96:${f}.${c}.${r}.${s}`,
    strings: [],
    numericSerial: s,
  }));

const giai202: fc.Arbitrary<TagCase> = fc
  .tuple(filterArb, gcpLength)
  .chain(([f, L]) => fc.tuple(fc.constant(f), digits(L), rawString(30 - L)))
  .map(([f, c, r]) => ({
    scheme: 'giai-202',
    uri: `urn:epc:tag:giai-202:${f}.${c}.${escape(r)}`,
    strings: [r],
  }));

const gid: fc.Arbitrary<TagCase> = fc
  .tuple(integer(bits(28)), integer(bits(24)), integer(bits(36)))
  .map(([m, c, s]) => ({
    scheme: 'gid-96',
    uri: `urn:epc:tag:gid-96:${m}.${c}.${s}`,
    strings: [],
  }));

const SCHEMES: readonly fc.Arbitrary<TagCase>[] = [
  partitioned(
    'sgtin-96',
    (L) => digits(13 - L),
    () => intTail(38),
  ),
  partitioned(
    'sgtin-198',
    (L) => digits(13 - L),
    () => strTail(20),
  ),
  partitioned(
    'sscc-96',
    (L) => digits(17 - L),
    () => none,
  ),
  partitioned(
    'sgln-96',
    (L) => digits(12 - L),
    () => intTail(41),
  ),
  partitioned(
    'sgln-195',
    (L) => digits(12 - L),
    () => strTail(20),
  ),
  partitioned(
    'grai-96',
    (L) => digits(12 - L),
    () => intTail(38),
  ),
  partitioned(
    'grai-170',
    (L) => digits(12 - L),
    () => strTail(16),
  ),
  partitioned(
    'giai-96',
    (L) => integer(bits(GIAI96_N[12 - L] ?? 0)),
    () => none,
  ),
  giai202,
  partitioned(
    'gsrn-96',
    (L) => digits(17 - L),
    () => none,
  ),
  gid,
  partitioned(
    'cpi-96',
    (L) => {
      // At most K = 15 - L digits and below 2^N (TDS Table 14-25).
      const byBits = bits(CPI96_N[12 - L] ?? 0);
      const byDigits = 10n ** BigInt(15 - L);
      return integer(byBits < byDigits ? byBits : byDigits);
    },
    () => intTail(31),
  ),
  partitioned(
    'gdti-96',
    (L) => digits(12 - L),
    () => intTail(41),
  ),
  partitioned(
    'gdti-174',
    (L) => digits(12 - L),
    () => strTail(17),
  ),
  sgcn,
];

// ---------------------------------------------------------------------------------------------
// Known epc-tds bugs (research C.1, numbered as there), excluded rather than reproduced.
// ---------------------------------------------------------------------------------------------

const EXCLUSIONS: Readonly<Record<string, (c: TagCase) => boolean>> = {
  /** Bug 1: no percent-escaping; it writes the escape triplet's characters into the binary. */
  'bug-1-no-escaping': (c) => c.strings.some((s) => s.split('').some((ch) => ch in A1_ESCAPES)),
  /**
   * Bug 3: leading zeros are dropped. Our integer generator never makes them, but an SGCN-96
   * serial is a Numeric String (TDS 14.3.6) whose leading zeros are significant.
   */
  'bug-3-leading-zeros': (c) =>
    c.numericSerial !== undefined && c.numericSerial.length > 1 && c.numericSerial.startsWith('0'),
  /**
   * Bug 3 again, found by this test: valueOf(...).toTagURI() drops the leading zeros of the
   * GSRN-96 service reference (urn:epc:tag:gsrn-96:0.952114.01234567890 comes back as
   * ...952114.1234567890). Its hex is right.
   */
  'bug-3-gsrn-reference-leading-zeros': (c) =>
    c.scheme === 'gsrn-96' && (c.uri.split('.')[2] ?? '').startsWith('0'),
  /** Bug 6: fromTagURI splits on ':' and '.', so neither may appear inside a field. */
  'bug-6-colon-split': (c) => c.strings.some((s) => s.includes(':') || s.includes('.')),
  // No control fields are generated (bug 6 again: `[att=x01]:` breaks fromTagURI).
  /**
   * Found by this test (not in research C.1): an empty reference component, which a 12-digit
   * GS1 Company Prefix gives SGLN, GRAI, GDTI and SGCN (TDS 6.3.3, 6.3.4, 6.3.8, 6.3.10, for
   * example urn:epc:tag:sgln-96:3.952656789012..0), is rejected by fromTagURI ("not a known EPC
   * tag URI scheme") and printed as "0" by valueOf(...).toTagURI().
   */
  'empty-reference': (c) => c.uri.includes('..'),
};

const excludedBy = (c: TagCase): string | undefined =>
  Object.keys(EXCLUSIONS).find((k) => EXCLUSIONS[k]?.(c) === true);

/** Both hex strings zero-padded to the longer length: epc-tds pads to bytes, we to 16-bit words. */
function padded(a: string, b: string): [string, string] {
  const n = Math.max(a.length, b.length);
  return [a.padEnd(n, '0').toUpperCase(), b.padEnd(n, '0').toUpperCase()];
}

describe('epc agrees with epc-tds 1.4.1', () => {
  it('on tag URI to hex and hex to tag URI for its 15 schemes', () => {
    let ran = 0;
    let total = 0;
    const seen = new Set<string>();
    fc.assert(
      fc.property(fc.oneof(...SCHEMES), (c) => {
        total++;
        if (excludedBy(c) !== undefined) return;
        ran++;
        seen.add(c.scheme);
        const ours = epc.decode(c.uri);
        expect(identity(ours).tagUri).toBe(c.uri);
        const [a, b] = padded(ours.hex ?? '', epcTds.fromTagURI(c.uri).toHexString());
        expect(a).toBe(b);
        expect(epcTds.valueOf(ours.hex ?? '').toTagURI()).toBe(identity(ours).tagUri);
      }),
      { numRuns: RUNS },
    );
    // Not vacuous: nearly every case ran, across all 15 schemes.
    expect(total).toBe(RUNS);
    expect(ran).toBeGreaterThanOrEqual(total * 0.9);
    expect(seen.size).toBe(RUNS >= 200 ? 15 : seen.size); // small ORACLE_RUNS may miss a scheme
  });
});
