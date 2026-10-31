import { describe, expect, it } from 'vitest';
import file from '../vectors/epc-legacy.json' with { type: 'json' };
import { Gs1Error } from '../../src/core/errors.ts';
import {
  bitsToBytes,
  bitsToHex,
  bytesToBits,
  decodeBinary,
  encodeBinary,
  hexToBits,
  isDecodedPlus,
} from '../../src/epc/binary.ts';
import {
  BINARY_SCHEMES,
  isPlusHeader,
  schemeByHeader,
  schemeByName,
} from '../../src/epc/schemes.ts';

interface LegacyVector {
  readonly scheme: string;
  readonly source: string;
  readonly tagUri?: string;
  readonly hex?: string;
  readonly filter?: number;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON import typed loosely
const vectors = (file.vectors as unknown as LegacyVector[]).filter(
  (v) => v.hex !== undefined && v.tagUri !== undefined,
);

/** Splits a tag URI body into filter and components (control fields not used in these vectors). */
function tagParts(tagUri: string): {
  name: string;
  filter: number | undefined;
  components: string[];
} {
  const rest = tagUri.slice('urn:epc:tag:'.length);
  const colon = rest.indexOf(':');
  const name = rest.slice(0, colon);
  const body = rest.slice(colon + 1);
  const scheme = schemeByName(name);
  const n = (scheme?.fields ?? []).reduce(
    (k, f) =>
      k +
      (f.spec.kind === 'partition'
        ? 2
        : f.spec.kind === 'filter' || f.spec.kind === 'zeros'
          ? 0
          : 1),
    0,
  );
  const hasFilter = scheme?.fields[0]?.spec.kind === 'filter';
  const parts: string[] = [];
  let s = body;
  for (let i = 0; i < n + (hasFilter ? 1 : 0) - 1; i++) {
    const dot = s.indexOf('.');
    parts.push(s.slice(0, dot));
    s = s.slice(dot + 1);
  }
  parts.push(s);
  return hasFilter
    ? { name, filter: Number(parts[0]), components: parts.slice(1) }
    : { name, filter: undefined, components: parts };
}

/** Bits of a vector's hex, compared modulo trailing zero padding (E4). */
function sameBits(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  return a.padEnd(len, '0') === b.padEnd(len, '0');
}

describe('descriptors', () => {
  it('has the 22 legacy schemes with unique names and headers', () => {
    expect(BINARY_SCHEMES.length).toBe(22);
    expect(new Set(BINARY_SCHEMES.map((s) => s.name)).size).toBe(22);
    expect(new Set(BINARY_SCHEMES.map((s) => s.header)).size).toBe(22);
    expect(schemeByHeader(0x30)?.name).toBe('sgtin-96');
    expect(schemeByName('adi-var')?.header).toBe(0x3b);
  });

  it('fixed-length schemes add up to their bit length', () => {
    for (const s of BINARY_SCHEMES.filter((x) => x.bits !== undefined)) {
      const bits =
        8 +
        s.fields.reduce((t, f) => {
          const sp = f.spec;
          if (sp.kind === 'partition')
            return t + 3 + (sp.table[0]?.[0] ?? 0) + (sp.table[0]?.[2] ?? 0);
          if (sp.kind === 'cage6') return t + 36;
          if (sp.kind === 'ascii8') return t + 8 * sp.chars;
          if (sp.kind === 'string6Var') return t;
          return t + sp.bits;
        }, 0);
      expect([s.name, bits]).toEqual([s.name, s.bits]);
    }
  });

  it('recognises the + and ++ header range (M3b)', () => {
    expect([0xe5, 0xe6, 0xf7, 0xfd, 0xfe].map(isPlusHeader)).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('TDS Appendix E and derived vectors at bit level', () => {
  it('has vectors for every scheme', () => {
    expect(new Set(vectors.map((v) => v.scheme)).size).toBeGreaterThanOrEqual(21);
  });
  for (const v of vectors) {
    it(`${v.source}: ${v.tagUri}`, () => {
      const t = tagParts(v.tagUri ?? '');
      const scheme = schemeByName(t.name);
      const theirs = hexToBits(v.hex ?? '');
      const ours = scheme ? encodeBinary(scheme, t.filter, t.components) : 'no scheme';
      const decoded = typeof theirs === 'string' ? decodeBinary(theirs) : theirs;
      expect({
        encodes: typeof ours === 'string' && typeof theirs === 'string' && sameBits(ours, theirs),
        decodes:
          decoded instanceof Gs1Error || typeof decoded === 'number'
            ? decoded
            : isDecodedPlus(decoded)
              ? decoded.scheme.name
              : [decoded.scheme.name, decoded.filter, decoded.components],
      }).toEqual({ encodes: true, decodes: [t.name, t.filter, t.components] });
    });
  }
});

describe('hex and bytes (E4)', () => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- valid hex literal
  const bits = hexToBits('3074257BF7194E4000001A85') as string;
  it('pads to 16-bit words, uppercase', () => {
    expect(bitsToHex(bits)).toBe('3074257BF7194E4000001A85');
    expect(bitsToHex('1')).toBe('8000');
    expect(bytesToBits(bitsToBytes(bits))).toBe(bits);
    expect(bitsToBytes('1')).toEqual(new Uint8Array([0x80, 0x00]));
  });
  it('accepts either case and reports the first bad character', () => {
    expect(hexToBits('3074257bf7194e4000001a85')).toBe(bits);
    expect(hexToBits('30G4')).toBe(2);
  });
});

function reason(bits: string): unknown {
  const d = decodeBinary(bits);
  return d instanceof Gs1Error
    ? [d.code, d.details?.['reason'] ?? null, d.details?.['bit'] ?? null]
    : 'ok';
}

describe('decode errors (Review Focus 2)', () => {
  it('accepts zero padding of any length and rejects set padding bits', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- valid hex literal
    const b = hexToBits('3074257BF7194E4000001A85') as string;
    expect(reason(`${b}0000`)).toBe('ok');
    expect(reason(`${b}0001`)).toEqual(['INVALID_EPC', 'binary', 99]);
  });
  it('rejects truncated input, unknown and +/++ headers', () => {
    expect(reason('00110000' + '0'.repeat(50))).toEqual(['INVALID_EPC', 'binary', 58]);
    expect(reason('0000000100000000')).toEqual(['EPC_UNKNOWN_HEADER', null, 0]);
    // A "+" header goes to the plus engine: the SGTIN+ body is missing.
    expect(reason('1111011100000000')).toEqual(['INVALID_EPC', 'binary', 16]);
  });
  it('encode rejects a bad filter', () => {
    const s = schemeByName('sgtin-96');
    const e = s && encodeBinary(s, 8, ['9521141', '012345', '1']);
    expect(e instanceof Gs1Error ? [e.code, e.details?.['reason']] : e).toEqual([
      'INVALID_EPC',
      'filter',
    ]);
  });
});
