import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parse } from '../../src/ai/index.ts';
import { Gs1Error, type Result } from '../../src/core/errors.ts';
import { type Epc, type PlusSchemeName, epc } from '../../src/epc/index.ts';
import { PLUS_SCHEMES } from '../../src/epc/plus.ts';

// Review Focus 4: valid plus EPCs of every scheme, built from random element strings, decode
// back to their content. Then random bits after a plus header, and mutations (bit flips,
// truncation, appended bits) of those valid EPCs, never throw from hex, bytes or a sibling
// scheme option (F13); every error is a Gs1Error; whatever decodes re-decodes to an equal value
// from its hex and raw URI.

const RUNS = 2000;
const MAX_BITS = 496;

const bitsOf = (v: bigint, n: number): string => v.toString(2).padStart(n, '0').slice(-n);
const toHex = (bits: string): string => {
  const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, '0');
  let out = '';
  for (let i = 0; i < padded.length; i += 4)
    out += Number.parseInt(padded.slice(i, i + 4), 2).toString(16);
  return out;
};

const plusBits: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...PLUS_SCHEMES.map((s) => s.header)),
    fc.integer({ min: 0, max: MAX_BITS - 8 }),
  )
  .chain(([header, n]) =>
    (n === 0
      ? fc.constant('')
      : fc.bigInt({ min: 0n, max: (1n << BigInt(n)) - 1n }).map((v) => bitsOf(v, n))
    ).map((rest) => bitsOf(BigInt(header), 8) + rest),
  );

/** The fields of a decoded value that must survive re-decoding. */
const view = (e: Epc): unknown =>
  e.kind === 'plus'
    ? [e.binaryScheme, e.filter, e.hostname, e.hex, e.elementString.toString()]
    : [e.kind];

function asymmetries(r: Result<Epc>): unknown[] {
  if (!r.ok) return r.errors.filter((e) => !(e instanceof Gs1Error));
  const e = r.value;
  const out: unknown[] = [];
  for (const form of [e.hex ?? '', e.rawUri ?? '']) {
    const back = epc.tryDecode(form);
    const same =
      back.ok &&
      back.value.kind === 'plus' &&
      e.kind === 'plus' &&
      back.value.elementString.equals(e.elementString) &&
      JSON.stringify(view(back.value)) === JSON.stringify(view(e));
    if (!same) out.push({ form, want: view(e), got: back.ok ? view(back.value) : back.errors });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Valid plus EPCs per scheme.

const DIGITS = '0123456789'.split('');
/** CSET 82 without '(', which a bracketed element string would need escaped. */
const CSET82 =
  `!"%&')*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz`.split('');
const CSET39 = '#-/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const HOST = 'abcdefghijklmnopqrstuvwxyz0123456789-.'.split('');

const str = (cs: string[], min: number, max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...cs), { minLength: min, maxLength: max }).map((a) => a.join(''));

/** GS1 mod 10 check digit appended to `body`. */
const withCheck = (body: string): string => {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return body + String((10 - (sum % 10)) % 10);
};
/** A key of `n` digits (check digit included) with GCP 9521141. */
const key = (n: number): fc.Arbitrary<string> =>
  str(DIGITS, n - 8, n - 8).map((d) => withCheck(`9521141${d}`));
const lead = (first: string, n: number): fc.Arbitrary<string> =>
  str(DIGITS, n - 9, n - 9).map((d) => withCheck(`${first}9521141${d}`));
const date = fc
  .tuple(
    fc.integer({ min: 0, max: 99 }),
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
  )
  .map(([y, m, d]) => [y, m, d].map((x) => String(x).padStart(2, '0')).join(''));
const serial = str(CSET82, 1, 12);

const families: Record<string, fc.Arbitrary<string>> = {
  sgtin: fc.tuple(lead('0', 14), serial).map(([g, s]) => `(01)${g}(21)${s}`),
  dsgtin: fc
    .tuple(lead('0', 14), serial, fc.constantFrom('11', '13', '15', '16', '17', '7006'), date)
    .map(([g, s, ai, d]) => `(01)${g}(21)${s}(${ai})${d}`),
  sscc: lead('0', 18).map((s) => `(00)${s}`),
  sgln: fc
    .tuple(key(13), fc.option(str(CSET82, 2, 12)))
    .map(([g, x]) => `(414)${g}${x === null ? '' : `(254)${x}`}`),
  grai: fc.tuple(key(13), str(CSET82, 0, 10)).map(([g, s]) => `(8003)0${g}${s}`),
  giai: str(CSET82, 1, 15).map((s) => `(8004)9521141${s}`),
  gsrn: key(18).map((s) => `(8018)${s}`),
  gsrnp: key(18).map((s) => `(8017)${s}`),
  gdti: fc.tuple(key(13), str(CSET82, 0, 10)).map(([g, s]) => `(253)${g}${s}`),
  sgcn: fc.tuple(key(13), str(DIGITS, 0, 12)).map(([g, s]) => `(255)${g}${s}`),
  itip: fc
    .tuple(lead('0', 14), fc.integer({ min: 1, max: 99 }), serial)
    .map(([g, n, s]) => `(8006)${g}01${String(n).padStart(2, '0')}(21)${s}`),
  cpi: fc
    .tuple(str(CSET39, 1, 12), fc.integer({ min: 1, max: 999_999 }))
    .map(([c, n]) => `(8010)9521141${c}(8011)${n}`),
};

const extra = fc.option(str(CSET82, 1, 10).map((s) => `(90)${s}`));
const base = (name: PlusSchemeName): string => name.replaceAll('+', '');

const validPlus: fc.Arbitrary<{
  scheme: PlusSchemeName;
  es: string;
  filter: number;
  hostname: string | undefined;
}> = fc.constantFrom(...PLUS_SCHEMES.map((s) => s.name)).chain((scheme) =>
  fc
    .tuple(
      families[base(scheme)] ?? fc.constant(''),
      extra,
      fc.integer({ min: 0, max: 7 }),
      str(HOST, 1, 20),
    )
    .map(([es, x, filter, host]) => ({
      scheme,
      es: es + (x ?? ''),
      filter,
      hostname: scheme.endsWith('++') ? `id${host}` : undefined,
    })),
);

describe('valid plus EPCs of every scheme', () => {
  it('encode, decode back to their content and reach all 24 schemes', { timeout: 60_000 }, () => {
    const reached = new Set<string>();
    const problems: unknown[] = [];
    for (const v of fc.sample(validPlus, { numRuns: RUNS, seed: 11 })) {
      const r = epc.tryFromElementString(v.es, {
        scheme: v.scheme,
        filter: v.filter,
        ...(v.hostname === undefined ? {} : { hostname: v.hostname }),
      });
      if (!r.ok) {
        const e = r.errors[0];
        // Only an over-long EPC may fail (F11).
        if (e?.code !== 'EPC_FIELD_OVERFLOW' || e.details?.['field'] !== 'epc')
          problems.push({ v, error: e?.message });
        continue;
      }
      const e = r.value;
      const back = epc.tryDecode(e.hex ?? '');
      const fromRaw = epc.tryDecode(e.rawUri ?? '');
      const ok =
        e.kind === 'plus' &&
        e.elementString.equivalent(parse(v.es)) &&
        back.ok &&
        fromRaw.ok &&
        JSON.stringify(view(back.value)) === JSON.stringify(view(e)) &&
        JSON.stringify(view(fromRaw.value)) === JSON.stringify(view(e)) &&
        back.value.kind === 'plus' &&
        back.value.filter === v.filter &&
        back.value.hostname === v.hostname;
      if (ok) reached.add(v.scheme);
      else problems.push({ v, hex: e.hex, back: back.ok ? view(back.value) : back.errors });
    }
    expect(problems).toEqual([]);
    expect(reached.size).toBe(PLUS_SCHEMES.length);
  });
});

// ---------------------------------------------------------------------------------------------
// Random and mutated bits.

/** Unpadded bits of valid plus EPCs: the seeds of the mutations. */
const seeds: readonly string[] = fc.sample(validPlus, { numRuns: 300, seed: 5 }).flatMap((v) => {
  const r = epc.tryFromElementString(v.es, {
    scheme: v.scheme,
    filter: v.filter,
    ...(v.hostname === undefined ? {} : { hostname: v.hostname }),
  });
  if (!r.ok || r.value.kind !== 'plus') return [];
  const hex = r.value.hex;
  let bits = '';
  for (const h of hex) bits += Number.parseInt(h, 16).toString(2).padStart(4, '0');
  return [bits.slice(0, r.value.bitLength)];
});

const flip = (bits: string, at: number): string =>
  bits.slice(0, at) + (bits[at] === '1' ? '0' : '1') + bits.slice(at + 1);

/** A valid EPC with a few bits flipped, cut short, or with bits appended. */
const mutated: fc.Arbitrary<string> = fc.constantFrom(...seeds).chain((bits) =>
  fc.oneof(
    fc
      .array(fc.integer({ min: 8, max: bits.length - 1 }), { minLength: 0, maxLength: 3 })
      .map((ats) => ats.reduce(flip, bits)),
    fc.integer({ min: 8, max: bits.length }).map((n) => bits.slice(0, n)),
    fc
      .array(fc.constantFrom('0', '1'), {
        minLength: 1,
        maxLength: Math.max(1, MAX_BITS - bits.length),
      })
      .map((tail) => bits + tail.join('')),
  ),
);

const toBytes = (bits: string): Uint8Array => {
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return out;
};

/** The non-Gs1Error errors of a result (there must be none). */
const strays = (r: Result<Epc>): unknown[] =>
  r.ok ? [] : r.errors.filter((e) => !(e instanceof Gs1Error));

/** A "+"/"++" scheme of the same family as the header of `bits`, picked by `pick`. */
const siblingOf = (bits: string, pick: number): PlusSchemeName | undefined => {
  const header = Number.parseInt(bits.slice(0, 8), 2);
  const own = PLUS_SCHEMES.find((s) => s.header === header);
  const family = PLUS_SCHEMES.filter((s) => s.family === own?.family);
  return family[pick % Math.max(family.length, 1)]?.name;
};

describe('random and mutated bits after a plus header', () => {
  it('has seeds from every scheme', () => {
    const headers = new Set(seeds.map((b) => b.slice(0, 8)));
    expect(headers.size).toBe(PLUS_SCHEMES.length);
  });

  it(
    'never throw from hex, bytes or a sibling scheme, fail with Gs1Error, and re-decode equal',
    { timeout: 60_000 },
    () => {
      let decoded = 0;
      fc.assert(
        fc.property(fc.oneof(plusBits, mutated, mutated), fc.nat(), (bits, pick) => {
          const fromHex = epc.tryDecode(toHex(bits));
          if (fromHex.ok) decoded++;
          expect(asymmetries(fromHex)).toEqual([]);
          // Bytes add zero fill, which can complete a field: compare with the same bits as hex.
          const whole = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
          const wholeHex = epc.tryDecode(toHex(whole));
          const fromBytes = epc.tryDecode(toBytes(whole));
          expect([
            strays(fromBytes),
            fromBytes.ok ? view(fromBytes.value) : fromBytes.errors[0]?.code,
          ]).toEqual([[], wholeHex.ok ? view(wholeHex.value) : wholeHex.errors[0]?.code]);
          const scheme = siblingOf(bits, pick);
          const sibling = epc.tryDecode(toHex(bits), {
            ...(scheme === undefined ? {} : { scheme }),
            ...(scheme?.endsWith('++') === true ? { hostname: 'id.example.com' } : {}),
          });
          expect(strays(sibling)).toEqual([]);
          const same =
            !sibling.ok ||
            !fromHex.ok ||
            (sibling.value.kind === 'plus' &&
              fromHex.value.kind === 'plus' &&
              sibling.value.binaryScheme === scheme &&
              sibling.value.elementString.equivalent(fromHex.value.elementString));
          expect(same).toBe(true);
        }),
        { numRuns: RUNS },
      );
      // The round-trip checks must run: mutations of valid EPCs often still decode.
      expect(decoded).toBeGreaterThan(RUNS / 10);
    },
  );
});
