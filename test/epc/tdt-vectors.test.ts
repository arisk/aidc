// Checks our EPC encoder against vectors frozen from GS1's TDT 2.3 draft translator by
// scripts/gen-epc-tdt-vectors.ts (plan decision E19). TDS 2.3 wins over TDT where they
// disagree; each known case is in KNOWN_TDT_DIFFERENCES with the TDS section that shows TDT
// is wrong, and ours must still differ from TDT there (so a stale entry fails).
import { describe, expect, it } from 'vitest';
import vectorsFile from '../vectors/epc-tdt.json' with { type: 'json' };
import type { BinarySchemeName } from '../../src/epc/index.ts';
import { epc } from '../../src/epc/index.ts';
import type { Gs1Error } from '../../src/core/errors.ts';
import { identity } from '../support/epc.ts';

interface TdtVector {
  readonly scheme: BinarySchemeName;
  readonly pureIdentityUri: string;
  /** Absent for GID-96, which has no filter. */
  readonly filter?: number;
  /** Decode direction (TDT cannot encode the scheme): our encoding of pureIdentityUri. */
  readonly inputHex?: string;
  readonly expect: {
    readonly hex?: string;
    readonly tagUri?: string;
    readonly pureIdentityUri?: string;
    readonly aiJson?: Readonly<Record<string, string>>;
  };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON file of known shape
const VECTORS = vectorsFile.vectors as readonly TdtVector[];

type Field = 'hex' | 'tagUri' | 'pureIdentityUri' | 'aiJson';

/** One comparison: what we produce and what TDT produced, for one field of one vector. */
interface Case {
  readonly name: string;
  readonly vector: TdtVector;
  readonly field: Field;
  readonly ours: unknown;
  readonly theirs: unknown;
}

interface Difference {
  readonly fields: readonly Field[];
  /** The TDS 2.3 text that shows TDT is wrong (or, for cpi-serial-zero, stricter than TDT). */
  readonly tds: string;
  readonly why: string;
  readonly applies: (v: TdtVector) => boolean;
  /** What TDS gives, derived from TDT's output; ours must equal it. */
  readonly expected: (c: Case) => unknown;
}

/** URI components of the vector's pure identity. */
const parts = (v: TdtVector): string[] => (v.pureIdentityUri.split(':')[4] ?? '').split('.');
const last = (v: TdtVector): string => parts(v).at(-1) ?? '';
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const obj = (x: unknown): Record<string, unknown> =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- aiJson cases hold objects
  typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {};

/** `hex` with `len` bits from bit `from` replaced by `value` (same length, upper case). */
function withBits(hex: string, from: number, len: number, value: bigint): string {
  const bits = hex
    .split('')
    .map((h) => Number.parseInt(h, 16).toString(2).padStart(4, '0'))
    .join('');
  const next = bits.slice(0, from) + value.toString(2).padStart(len, '0') + bits.slice(from + len);
  let out = '';
  for (let i = 0; i < next.length; i += 4)
    out += Number.parseInt(next.slice(i, i + 4), 2)
      .toString(16)
      .toUpperCase();
  return out;
}

/** GIAI-96 asset reference bits N by partition value, L = 12 - P (TDS Table 14-23). */
const GIAI96_REF_BITS = [42, 45, 48, 52, 55, 58, 62] as const;

const KNOWN_TDT_DIFFERENCES: ReadonlyMap<string, Difference> = new Map<string, Difference>([
  [
    'gdti-113-numeric-string',
    {
      fields: ['hex'],
      tds: 'TDS 14.6.8.2 (Table 14-31: serial coding method Numeric String), 14.3.6',
      why: 'TDT writes the GDTI-113 serial as a plain integer; TDS prepends "1" so leading zeros survive (plan decision E3).',
      applies: (v) => v.scheme === 'gdti-113',
      // Header 8, filter 3, partition 3, GCP plus document type 41: the serial is the last 58 bits.
      expected: (c) => withBits(str(c.theirs), 55, 58, BigInt(`1${last(c.vector)}`)),
    },
  ],
  [
    'giai-96-double-precision',
    {
      fields: ['hex'],
      tds: 'TDS 14.3.4 ("Unpadded Partition Table": the reference is encoded as an exact integer of N bits)',
      why: 'TDT converts the asset reference to a JavaScript number, so values that are not exact doubles (above 2^53) are rounded.',
      applies: (v) => v.scheme === 'giai-96' && BigInt(Number(last(v))) !== BigInt(last(v)),
      // The asset reference is the last N bits, N from TDS Table 14-23 by GCP length.
      expected: (c) => {
        const n = GIAI96_REF_BITS[12 - (parts(c.vector)[0] ?? '').length] ?? 0;
        return withBits(str(c.theirs), 96 - n, n, BigInt(last(c.vector)));
      },
    },
  ],
  [
    'sgln-extension-zero',
    {
      fields: ['aiJson'],
      tds: 'TDS 7.5 (EPC URI to element string, step 4: an extension of "0" omits the extension)',
      why: 'TDT emits (254)0; TDS reserves extension 0 for a GLN without extension (plan decision E11).',
      applies: (v) => v.scheme.startsWith('sgln-') && last(v) === '0',
      expected: (c) => {
        const { '254': _, ...rest } = obj(c.theirs);
        return rest;
      },
    },
  ],
  [
    'cpi-serial-zero',
    {
      fields: ['aiJson'],
      tds: 'TDS 7.11 (AIs 8010 and 8011 as defined in GS1 General Specifications 3.9.11; the GS1 syntax dictionary gives (8011) N..12,nozeroprefix)',
      why: 'Upstream conflict: GenSpecs v26 3.9.11 allows an (8011) serial of exactly 0, but the GS1 Barcode Syntax Dictionary gives (8011) nozeroprefix with no exception. The library follows the Syntax Dictionary for AI validation (as the GS1 Syntax Engine does), so for serial 0, where TDT emits (8011)0 (or, for CPI-var, an empty (8011)), ours fails with INVALID_VALUE on (8011).',
      applies: (v) => v.scheme.startsWith('cpi-') && last(v) === '0',
      expected: () => ['INVALID_VALUE (8011)'],
    },
  ],
  [
    'cpi-96-partition-6',
    {
      fields: ['hex', 'tagUri', 'aiJson'],
      tds: 'TDS 14.6.9.1 (Table 14-25: C.P then S) and 7.11',
      why: 'The TDT CPI-96 PURE_IDENTITY option 6 (6-digit GCP) numbers both comppartref and cpiserial as seq 3, so the serial overwrites the part reference.',
      applies: (v) => v.scheme === 'cpi-96' && (parts(v)[0] ?? '').length === 6,
      expected: (c) => {
        const [gcp = '', ref = '', serial = ''] = parts(c.vector);
        if (c.field === 'hex') return withBits(str(c.theirs), 34, 31, BigInt(ref));
        if (c.field === 'tagUri')
          return `urn:epc:tag:cpi-96:${c.vector.filter ?? ''}.${gcp}.${ref}.${serial}`;
        return { ...obj(c.theirs), '8010': gcp + ref };
      },
    },
  ],
  [
    'cpi-var-empty-serial',
    {
      fields: ['aiJson'],
      tds: 'TDS 7.11 ((8011) is s1s2...sK, the third URI component)',
      why: 'TDT decodes CPI-var binary to an element string with an empty (8011).',
      applies: (v) => v.scheme === 'cpi-var',
      expected: (c) => ({ ...obj(c.theirs), '8011': last(c.vector) }),
    },
  ],
  [
    'usdod-96-space-padding',
    {
      fields: ['tagUri', 'pureIdentityUri'],
      tds: 'TDS 6.3.17 (grammar: CAGECode = 5(CAGECodeOrDODAACChar), no space)',
      why: 'TDT keeps the space that pads a 5-character CAGE code to 6 bytes in the binary (plan decision E12), giving URIs such as urn:epc:id:usdod: 2S194.1.',
      applies: (v) => v.scheme === 'usdod-96' && (parts(v)[0] ?? '').length === 5,
      expected: (c) => str(c.theirs).replace(': ', ':').replace('. ', '.'),
    },
  ],
]);

/** Both hex strings zero-padded to the longer length (plan decision E4: tools pad differently). */
function padded(a: string, b: string): [string, string] {
  const n = Math.max(a.length, b.length);
  return [a.padEnd(n, '0'), b.padEnd(n, '0')];
}

const codes = (errors: readonly Gs1Error[]): string[] =>
  errors.map((e) => `${e.code}${e.ai === undefined ? '' : ` (${e.ai})`}`);

function casesOf(v: TdtVector): Case[] {
  const e = v.expect;
  const name = `${v.scheme} ${v.pureIdentityUri} filter ${v.filter ?? '-'}`;
  const filter = v.filter === undefined ? {} : { filter: v.filter };
  const r =
    v.inputHex === undefined
      ? epc.tryDecode(v.pureIdentityUri, { scheme: v.scheme, ...filter })
      : epc.tryDecode(v.inputHex);
  const out: Case[] = [];
  const add = (field: Field, mine: unknown, theirs: unknown): void => {
    out.push({ name: `${name}: ${field}`, vector: v, field, ours: mine, theirs });
  };
  if (!r.ok) {
    // Ours rejects what TDT accepted: one failing case that names our errors.
    add('hex', codes(r.errors), e);
    return out;
  }
  const ours = r.value;
  if (e.hex !== undefined) {
    const [a, b] = padded(ours.hex ?? '', e.hex);
    add('hex', a, b);
  }
  if (e.tagUri !== undefined) add('tagUri', identity(ours).tagUri, e.tagUri);
  if (e.pureIdentityUri !== undefined)
    add('pureIdentityUri', identity(ours).pureIdentityUri, e.pureIdentityUri);
  if (e.aiJson !== undefined) {
    const es = epc.tryToElementString(ours);
    add('aiJson', es.ok ? es.value.toObject() : codes(es.errors), e.aiJson);
  }
  return out;
}

const CASES = VECTORS.flatMap(casesOf);
const known = (c: Case): string | undefined => {
  for (const [id, d] of KNOWN_TDT_DIFFERENCES)
    if (d.fields.includes(c.field) && d.applies(c.vector)) return id;
  return undefined;
};
const AGREE = CASES.filter((c) => known(c) === undefined);
const DIFFER = CASES.flatMap((c) => {
  const id = known(c);
  const d = id === undefined ? undefined : KNOWN_TDT_DIFFERENCES.get(id);
  return id === undefined || d === undefined ? [] : [{ id, d, c }];
});

describe('GS1 TDT 2.3 frozen vectors', () => {
  it('cover every legacy scheme in both directions', () => {
    expect(VECTORS.length).toBe(550);
    expect(new Set(VECTORS.map((v) => v.scheme)).size).toBe(22);
    expect(VECTORS.filter((v) => v.inputHex !== undefined).length).toBe(50);
    expect(CASES.length).toBeGreaterThanOrEqual(1500);
    // Most comparisons agree outright; the known differences stay a small minority.
    expect(AGREE.length).toBeGreaterThanOrEqual(CASES.length * 0.9);
  });

  it.each(AGREE.map((c) => [c.name, c] as const))('%s agrees with TDT', (_name, c) => {
    expect(c.ours).toEqual(c.theirs);
  });

  it.each(DIFFER.map((x) => [`${x.c.name} (${x.id})`, x] as const))(
    '%s differs from TDT and matches TDS',
    (_name, { d, c }) => {
      expect(c.ours).not.toEqual(c.theirs);
      expect(c.ours).toEqual(d.expected(c));
    },
  );

  it('lists each known difference once, and each still applies', () => {
    expect(KNOWN_TDT_DIFFERENCES.size).toBe(7);
    const used = new Set(DIFFER.map((x) => x.id));
    expect([...KNOWN_TDT_DIFFERENCES.keys()].filter((id) => !used.has(id))).toEqual([]);
  });
});
