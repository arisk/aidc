import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Result } from '../../src/core/errors.ts';
import type { FieldSpec } from '../../src/epc/descriptor.ts';
import { type Epc, epc } from '../../src/epc/index.ts';
import { BINARY_SCHEMES } from '../../src/epc/schemes.ts';
import { identity } from '../support/epc.ts';

// Review item 2: whatever epc.tryDecode accepts must re-decode, from each of its own forms,
// to an equal Epc. The bit generator follows each scheme's fields, so most draws decode, and
// every field can also be raw random bits, so values just past a limit are drawn too.

const RUNS = 3000;

const bitsOf = (v: bigint, n: number): string => v.toString(2).padStart(n, '0').slice(-n);
const rawBits = (n: number): fc.Arbitrary<string> =>
  fc.bigInt({ min: 0n, max: (1n << BigInt(n)) - 1n }).map((v) => bitsOf(v, n));
/** A value below 10^digits most of the time, else anything that fits `n` bits. */
const decimalBits = (n: number, digits: number): fc.Arbitrary<string> => {
  const max = (1n << BigInt(n)) - 1n;
  const tenth = 10n ** BigInt(digits) - 1n;
  const near = tenth < max ? tenth : max;
  return fc.oneof(
    { weight: 3, arbitrary: fc.bigInt({ min: 0n, max: near }).map((v) => bitsOf(v, n)) },
    {
      weight: 1,
      arbitrary: fc
        .bigInt({ min: near > 2n ? near - 2n : 0n, max: near + 2n < max ? near + 2n : max })
        .map((v) => bitsOf(v, n)),
    },
    { weight: 1, arbitrary: rawBits(n) },
  );
};

/** The characters of an ASCII string. */
const chars = (s: string): string[] => s.split('');

const CSET82 = `!"%&'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz`;
const SIX = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-/#';
const CAGE = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

/** 7-bit characters padded to `bits`: mostly CSET 82, sometimes any 7-bit value. */
const string7 = (bits: number, maxChars: number): fc.Arbitrary<string> =>
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc
        .array(fc.constantFrom(...chars(CSET82)), { minLength: 0, maxLength: maxChars + 1 })
        .map((cs) =>
          cs
            .map((c) => bitsOf(BigInt(c.charCodeAt(0)), 7))
            .join('')
            .padEnd(bits, '0')
            .slice(0, bits),
        ),
    },
    { weight: 1, arbitrary: rawBits(bits) },
  );

/** 6-bit characters plus the terminator: mostly Table G-1, sometimes any 6-bit value. */
const string6 = (max: number): fc.Arbitrary<string> =>
  fc
    .array(
      fc.oneof(
        { weight: 6, arbitrary: fc.constantFrom(...chars(SIX)).map((c) => c.charCodeAt(0) & 0x3f) },
        { weight: 1, arbitrary: fc.integer({ min: 1, max: 63 }) },
      ),
      { minLength: 0, maxLength: max + 1 },
    )
    .map((vs) => `${vs.map((v) => bitsOf(BigInt(v), 6)).join('')}000000`);

const cage = fc.string({ unit: fc.constantFrom(...chars(CAGE)), minLength: 4, maxLength: 7 });

function field(spec: FieldSpec): fc.Arbitrary<string> {
  switch (spec.kind) {
    case 'filter':
      return rawBits(spec.bits);
    case 'zeros':
      return fc.oneof(
        { weight: 5, arbitrary: fc.constant('0'.repeat(spec.bits)) },
        rawBits(spec.bits),
      );
    case 'integer':
      return spec.maxDigits === undefined
        ? rawBits(spec.bits)
        : decimalBits(spec.bits, spec.maxDigits);
    case 'fixedWidthInteger':
      return decimalBits(spec.bits, spec.digits);
    case 'numericString':
      return fc.oneof(
        {
          weight: 3,
          arbitrary: fc
            .string({
              unit: fc.constantFrom(...chars('0123456789')),
              minLength: 1,
              maxLength: spec.maxDigits + 1,
            })
            .map((d) => bitsOf(BigInt(`1${d}`), spec.bits)),
        },
        rawBits(spec.bits),
      );
    case 'string7':
      return string7(spec.bits, spec.maxChars);
    case 'cage6':
      return fc.oneof(
        {
          weight: 4,
          arbitrary: cage.map(
            (s) =>
              (s.length === 5 ? '100000' : '') +
              chars(s)
                .map((c) => bitsOf(BigInt(c.charCodeAt(0) & 0x3f), 6))
                .join('')
                .padEnd(36, '0')
                .slice(0, 36 - (s.length === 5 ? 6 : 0)),
          ),
        },
        rawBits(36),
      );
    case 'string6Var':
      return string6(spec.max);
    case 'ascii8':
      return fc.oneof(
        {
          weight: 4,
          arbitrary: cage.map((s) =>
            chars(s.padStart(spec.chars, ' ').slice(-spec.chars))
              .map((c) => bitsOf(BigInt(c.charCodeAt(0)), 8))
              .join(''),
          ),
        },
        rawBits(spec.chars * 8),
      );
    case 'partition':
      return fc.integer({ min: 0, max: 7 }).chain((p) => {
        const row = spec.table[p];
        const head = bitsOf(BigInt(p), 3);
        if (!row) return rawBits(60).map((b) => head + b);
        const [m, l, n, k] = row;
        const other =
          spec.other === 'string7'
            ? string7(n, k)
            : spec.other === 'cpref6'
              ? string6(k)
              : decimalBits(n, k);
        return fc.tuple(decimalBits(m, l), other).map(([c, d]) => head + c + d);
      });
  }
  return spec satisfies never;
}

const legacyBits: fc.Arbitrary<string> = fc.constantFrom(...BINARY_SCHEMES).chain((s) =>
  fc
    .tuple(fc.tuple(...s.fields.map((f) => field(f.spec))), fc.integer({ min: 0, max: 24 }))
    .map(([parts, pad]) => {
      const body = bitsOf(BigInt(s.header), 8) + parts.join('');
      const fixed = s.bits === undefined ? body : body.padEnd(s.bits, '0').slice(0, s.bits);
      return fixed + '0'.repeat(pad);
    }),
);

const toHex = (bits: string): string => {
  const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0');
  let out = '';
  for (let i = 0; i < padded.length; i += 4)
    out += Number.parseInt(padded.slice(i, i + 4), 2).toString(16);
  return out;
};

const view = (e: Epc): unknown => ({
  scheme: e.scheme,
  binaryScheme: e.binaryScheme,
  filter: e.filter,
  components: identity(e).components,
  fields: identity(e).fields,
  pureIdentityUri: identity(e).pureIdentityUri,
  tagUri: identity(e).tagUri,
  hex: e.hex,
  bitLength: e.bitLength,
});

/** The forms of a decoded Epc that do not re-decode to an equal value. */
function asymmetries(r: Result<Epc>): unknown[] {
  if (!r.ok) return [];
  const e = r.value;
  const want = view(e);
  const out: unknown[] = [];
  for (const form of [
    identity(e).tagUri ?? '',
    e.rawUri ?? '',
    e.hex ?? '',
    e.bytes ?? new Uint8Array(),
  ]) {
    const back = epc.tryDecode(form);
    const got = back.ok ? view(back.value) : back.errors[0]?.message;
    if (JSON.stringify(got) !== JSON.stringify(want)) out.push({ form, want, got });
  }
  return out;
}

describe('decode and re-decode agree (random bits per legacy header)', () => {
  it('every accepted input re-decodes from its tag URI, raw URI, hex and bytes', () => {
    fc.assert(
      fc.property(legacyBits, (bits) => {
        expect(asymmetries(epc.tryDecode(toHex(bits)))).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it('the generator reaches every scheme with decodable inputs', () => {
    const decoded = new Set<string>();
    for (const bits of fc.sample(legacyBits, { numRuns: 4000, seed: 7 })) {
      const r = epc.tryDecode(toHex(bits));
      if (r.ok && r.value.binaryScheme) decoded.add(r.value.binaryScheme);
    }
    expect(decoded.size).toBe(BINARY_SCHEMES.length);
  });
});
