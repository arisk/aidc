import { describe, expect, it } from 'vitest';
import legacyFile from '../vectors/epc-legacy.json' with { type: 'json' };
import uriFile from '../vectors/epc-uri.json' with { type: 'json' };
import { parse } from '../../src/ai/index.ts';
import type { Result } from '../../src/core/errors.ts';
import { type BinarySchemeName, type Epc, type PureSchemeName, epc } from '../../src/epc/index.ts';
import { schemeByName } from '../../src/epc/schemes.ts';
import { identity } from '../support/epc.ts';

interface LegacyVector {
  readonly scheme: string;
  readonly source: string;
  readonly elementString?: string;
  readonly pureIdentityUri: string;
  readonly tagUri?: string;
  readonly hex?: string;
  readonly filter?: number | null;
  readonly companyPrefixLength: number | null;
}
interface UriVector {
  readonly source: string;
  readonly input: string;
  readonly expect: {
    readonly valid?: boolean;
    readonly gcpLength?: number;
    readonly elementString?: string;
    readonly pureIdentityUri?: string;
    readonly tagUri?: string;
    readonly hex?: string;
  };
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON import typed loosely
const legacy = legacyFile.vectors as unknown as LegacyVector[];
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON import typed loosely
const uris = uriFile.vectors as unknown as UriVector[];

/**
 * Plan decision E4: `hex` is padded to 16-bit words, so expected hex is compared exactly.
 * The only exception is a vector printed nibble-padded, listed here by source: TDS 2.3 E.3
 * prints the 146-bit ADI-var example in 37 hex digits. Its expected hex is word padded.
 */
const NIBBLE_PADDED: ReadonlySet<string> = new Set([
  'TDS 2.3 E.3 (146 bits, printed nibble-padded; 16-bit padded = 3B0E0CF5E76C9047759AD00373DC7602E7200000)',
]);
const wordPadded = (hex: string): string => hex.padEnd(Math.ceil(hex.length / 4) * 4, '0');
/** The hex an `Epc` must have for a vector's printed hex. */
const expectedHex = (source: string, hex: string | undefined): string | undefined =>
  hex !== undefined && NIBBLE_PADDED.has(source) ? wordPadded(hex) : hex;
const describeResult = (r: Result<unknown>): unknown =>
  r.ok ? 'ok' : [r.errors[0]?.code, r.errors[0]?.details?.['reason'] ?? null];
/** The binary scheme and filter of a tag URI, as encode options. */
function tagOptions(tagUri: string): { scheme?: BinarySchemeName; filter?: number } {
  const m = /^urn:epc:tag:(?:\[[^\]]*\])*:?([a-z0-9-]+):([^.]*)\./.exec(tagUri);
  const scheme = schemeByName(m?.[1] ?? '');
  if (!scheme) return {};
  return scheme.fields[0]?.spec.kind === 'filter'
    ? { scheme: scheme.name, filter: Number(m?.[2]) }
    : { scheme: scheme.name };
}
const binaryOf = (name: string): BinarySchemeName | undefined => schemeByName(name)?.name;
function pureSchemeOf(name: string): PureSchemeName {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector scheme names are pure scheme names when not binary
  return (schemeByName(name)?.epcScheme ?? name) as PureSchemeName;
}
function decodeFields(e: Epc, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === 'pureIdentityUri') out[k] = identity(e).pureIdentityUri;
    else if (k === 'tagUri') out[k] = identity(e).tagUri;
    else if (k === 'hex') out[k] = e.hex;
  }
  return out;
}

// Legacy vector groups.
const withHex = legacy.filter((v) => v.hex !== undefined);
const withHexAndEs = withHex.filter((v) => v.elementString !== undefined);
const esToTag = legacy.filter(
  (v) =>
    v.elementString !== undefined &&
    typeof v.companyPrefixLength === 'number' &&
    v.tagUri !== undefined,
);
const tagNoHex = legacy.filter((v) => v.tagUri !== undefined && v.hex === undefined);
const esNoTag = legacy.filter((v) => v.elementString !== undefined && v.tagUri === undefined);
const pureOnly = legacy.filter((v) => v.elementString === undefined && v.tagUri === undefined);

describe('epc-legacy.json group sizes', () => {
  it('covers all 88 vectors', () => {
    expect(legacy.length).toBe(88);
    expect([
      withHex.length,
      withHexAndEs.length,
      esToTag.length,
      tagNoHex.length,
      esNoTag.length,
      pureOnly.length,
    ]).toEqual([49, 35, 35, 2, 21, 16]);
    // Every vector is in at least one group: hex, tag without hex, element string only, pure only.
    expect(withHex.length + tagNoHex.length + esNoTag.length + pureOnly.length).toBe(88);
  });
});

describe('hex padding exceptions (E4)', () => {
  it('only the listed vectors are nibble padded', () => {
    const nibble = [
      ...legacy.map((v) => [v.source, v.hex]),
      ...uris.map((v) => [v.source, v.expect.hex]),
    ]
      .filter(([, hex]) => hex !== undefined && hex.length % 4 !== 0)
      .map(([source]) => source);
    expect(nibble).toEqual([...NIBBLE_PADDED]);
  });
});

describe('epc-legacy.json: decode hex', () => {
  for (const v of withHex) {
    it(`${v.source}: ${v.hex}`, () => {
      const e = epc.decode(v.hex ?? '');
      expect([identity(e).tagUri, identity(e).pureIdentityUri]).toEqual([
        v.tagUri,
        v.pureIdentityUri,
      ]);
    });
  }
});

describe('epc-legacy.json: hex to element string', () => {
  for (const v of withHexAndEs) {
    it(`${v.source}: ${v.hex} -> ${v.elementString}`, () => {
      const es = epc.toElementString(epc.decode(v.hex ?? ''));
      expect(es.equals(parse(v.elementString ?? ''))).toBe(true);
    });
  }
});

describe('epc-legacy.json: encode pure identity to hex', () => {
  for (const v of withHex) {
    it(`${v.source}: ${v.pureIdentityUri} as ${v.scheme}`, () => {
      const scheme = binaryOf(v.scheme);
      const e = epc.decode(v.pureIdentityUri, {
        ...(scheme === undefined ? {} : { scheme }),
        ...(typeof v.filter === 'number' ? { filter: v.filter } : {}),
      });
      expect(e.hex).toBe(expectedHex(v.source, v.hex));
    });
  }
});

describe('epc-legacy.json: element string to tag URI', () => {
  for (const v of esToTag) {
    it(`${v.source}: ${v.elementString} as ${v.scheme}`, () => {
      const scheme = binaryOf(v.scheme);
      const e = epc.fromElementString(v.elementString ?? '', {
        ...(scheme === undefined ? {} : { scheme }),
        ...(typeof v.filter === 'number' ? { filter: v.filter } : {}),
        companyPrefixLength: v.companyPrefixLength ?? 0,
      });
      expect(identity(e).tagUri).toBe(v.tagUri);
    });
  }
});

describe('epc-legacy.json: tag URIs without hex', () => {
  for (const v of tagNoHex) {
    it(`${v.source}: ${v.tagUri}`, () => {
      const scheme = binaryOf(v.scheme);
      const fromPure = epc.decode(v.pureIdentityUri, {
        ...(scheme === undefined ? {} : { scheme }),
        ...(typeof v.filter === 'number' ? { filter: v.filter } : {}),
      });
      expect([
        identity(epc.decode(v.tagUri ?? '')).pureIdentityUri,
        identity(fromPure).tagUri,
      ]).toEqual([v.pureIdentityUri, v.tagUri]);
    });
  }
});

describe('epc-legacy.json: element strings to pure identities and back', () => {
  for (const v of esNoTag) {
    it(`${v.source}: ${v.elementString} <-> ${v.pureIdentityUri}`, () => {
      const e = epc.fromElementString(v.elementString ?? '', {
        epcScheme: pureSchemeOf(v.scheme),
        companyPrefixLength: v.companyPrefixLength ?? 0,
      });
      const back = epc.toElementString(epc.decode(v.pureIdentityUri));
      expect([identity(e).pureIdentityUri, back.equals(parse(v.elementString ?? ''))]).toEqual([
        v.pureIdentityUri,
        true,
      ]);
    });
  }
});

describe('epc-legacy.json: pure identity URIs', () => {
  for (const v of pureOnly) {
    it(`${v.source}: ${v.pureIdentityUri}`, () => {
      expect(identity(epc.decode(v.pureIdentityUri)).pureIdentityUri).toBe(v.pureIdentityUri);
    });
  }
});

// URI vector groups.
// Pattern URIs (urn:epc:idpat:, urn:epc:pat:) are out of scope for M3a (plan decision E6).
const isPattern = (v: UriVector): boolean =>
  v.input.startsWith('urn:epc:idpat:') || v.input.startsWith('urn:epc:pat:');
/** A raw URI with an AFI body (`N.xAFI.xHEX`, toggle 1): not an EPC (plan decision E14). */
const isRawAfi = (v: UriVector): boolean =>
  /^urn:epc:raw:(?:\[[^\]]*\])*:?\d+\.x[0-9A-Fa-f]*\.x/.test(v.input);
/**
 * A raw URI (toggle 0) whose header no EPC scheme assigns (TDS 2.3 Figure 12-1 and 12.2.2
 * use 0x01 and 0x12). A valid raw URI, but not an EPC that epc.decode can return.
 */
const isRawUnknownHeader = (v: UriVector): boolean =>
  v.input.startsWith('urn:epc:raw:') && !isRawAfi(v) && /:96\.x(01|12)/.test(v.input);
const isEs = (v: UriVector): boolean => v.input.startsWith('(');
const patterns = uris.filter(isPattern);
const rawAfi = uris.filter(isRawAfi);
const rawUnknownHeader = uris.filter(isRawUnknownHeader);
const validity = uris.filter(
  (v) => v.expect.valid !== undefined && !isPattern(v) && !isRawAfi(v) && !isRawUnknownHeader(v),
);
const esExpect = uris.filter((v) => !isEs(v) && v.expect.elementString !== undefined);
const FIELD_KEYS = ['pureIdentityUri', 'tagUri', 'hex'] as const;
const hasFields = (v: UriVector): boolean => FIELD_KEYS.some((k) => v.expect[k] !== undefined);
const esInput = uris.filter((v) => isEs(v) && hasFields(v));
const uriInput = uris.filter((v) => !isEs(v) && hasFields(v));

describe('epc-uri.json group sizes', () => {
  it('covers all 72 vectors', () => {
    expect(uris.length).toBe(72);
    expect([
      patterns.length,
      rawAfi.length,
      rawUnknownHeader.length,
      validity.length,
      esExpect.length,
      esInput.length,
      uriInput.length,
    ]).toEqual([3, 2, 2, 12, 37, 11, 26]);
    const covered = new Set([
      ...patterns,
      ...rawAfi,
      ...rawUnknownHeader,
      ...validity,
      ...esExpect,
      ...esInput,
      ...uriInput,
    ]);
    expect(covered.size).toBe(72);
  });
});

describe('epc-uri.json: validity', () => {
  for (const v of validity) {
    it(`${v.source}: ${v.input}`, () => {
      expect(epc.tryDecode(v.input).ok).toBe(v.expect.valid);
    });
  }
});

describe('epc-uri.json: raw AFI URIs are valid but not EPCs (E14)', () => {
  for (const v of rawAfi) {
    it(`${v.source}: ${v.input}`, () => {
      expect([v.expect.valid, describeResult(epc.tryDecode(v.input))]).toEqual([
        true,
        ['UNSUPPORTED', 'raw-afi'],
      ]);
    });
  }
});

describe('epc-uri.json: raw URIs with an unassigned EPC header', () => {
  for (const v of rawUnknownHeader) {
    it(`${v.source}: ${v.input}`, () => {
      expect([v.expect.valid, describeResult(epc.tryDecode(v.input))]).toEqual([
        true,
        ['EPC_UNKNOWN_HEADER', null],
      ]);
    });
  }
});

describe('epc-uri.json: element strings of URIs and hex', () => {
  for (const v of esExpect) {
    it(`${v.source}: ${v.input}`, () => {
      const es = epc.toElementString(epc.decode(v.input));
      expect(es.equals(parse(v.expect.elementString ?? ''))).toBe(true);
    });
  }
});

describe('epc-uri.json: element string input', () => {
  for (const v of esInput) {
    it(`${v.source}: ${v.input}`, () => {
      const e = epc.fromElementString(v.input, {
        companyPrefixLength: v.expect.gcpLength ?? 0,
        ...tagOptions(v.expect.tagUri ?? ''),
      });
      const keys = FIELD_KEYS.filter((k) => v.expect[k] !== undefined);
      expect(decodeFields(e, keys)).toEqual(
        Object.fromEntries(
          keys.map((k) => [k, k === 'hex' ? expectedHex(v.source, v.expect[k]) : v.expect[k]]),
        ),
      );
    });
  }
});

describe('epc-uri.json: URI and hex input', () => {
  for (const v of uriInput) {
    it(`${v.source}: ${v.input}`, () => {
      const e = epc.decode(v.input, tagOptions(v.expect.tagUri ?? ''));
      const keys = FIELD_KEYS.filter((k) => v.expect[k] !== undefined);
      expect(decodeFields(e, keys)).toEqual(
        Object.fromEntries(
          keys.map((k) => [k, k === 'hex' ? expectedHex(v.source, v.expect[k]) : v.expect[k]]),
        ),
      );
    });
  }
});
