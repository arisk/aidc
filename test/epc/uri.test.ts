import { describe, expect, it } from 'vitest';
import file from '../vectors/epc-uri.json' with { type: 'json' };
import { Gs1Error } from '../../src/core/errors.ts';
import { encodeBinary } from '../../src/epc/binary.ts';
import { schemeByName } from '../../src/epc/schemes.ts';
import {
  controlPrefix,
  formatPure,
  formatRaw,
  formatTag,
  parsePure,
  parseRaw,
  parseTag,
  pureComponentCount,
} from '../../src/epc/uri.ts';

interface UriVector {
  readonly source: string;
  readonly input: string;
  readonly expect: { readonly valid?: boolean; readonly pureIdentityUri?: string };
}
// Pattern URIs (urn:epc:idpat:, urn:epc:pat:) are out of scope for M3a (plan decision E6).
const isPattern = (uri: string): boolean =>
  uri.startsWith('urn:epc:idpat:') || uri.startsWith('urn:epc:pat:');
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON import typed loosely
const validity = (file.vectors as unknown as UriVector[]).filter(
  (v) => v.expect.valid !== undefined && v.input.startsWith('urn:epc:') && !isPattern(v.input),
);

function parseAny(uri: string): unknown {
  if (uri.startsWith('urn:epc:tag:')) {
    // As epc.decode does (Task 6): the filter range and the fit of each component (TDS 12.3.2,
    // Table 12-2) are checked by encoding, not by the URI grammar.
    const t = parseTag(uri);
    return t instanceof Gs1Error ? t : encodeBinary(t.scheme, t.filter, t.components);
  }
  if (uri.startsWith('urn:epc:raw:')) return parseRaw(uri);
  return parsePure(uri);
}
const failure = (r: unknown): unknown =>
  r instanceof Gs1Error ? [r.code, r.details?.['reason'], r.position] : 'ok';

describe('TDS 2.3 URI validity vectors', () => {
  for (const v of validity) {
    it(`${v.source}: ${v.input}`, () => {
      const r = parseAny(v.input);
      // Raw AFI URIs (toggle 1) parse here; it is epc.decode that rejects them (E14).
      expect(!(r instanceof Gs1Error)).toBe(v.expect.valid);
    });
  }
});

describe('pure identity URIs', () => {
  it('parses and formats every scheme, splitting only on the first n-1 dots', () => {
    const uris = [
      'urn:epc:id:sgtin:9521141.012345.a.b:c',
      'urn:epc:id:sscc:9521141.0012345678',
      'urn:epc:id:sgln:952656789012..0',
      'urn:epc:id:grai:9521141.12345.5678',
      'urn:epc:id:giai:9521141.32a%2Fb',
      'urn:epc:id:gsrn:9521141.0012345678',
      'urn:epc:id:gsrnp:9521141.0012345678',
      'urn:epc:id:gdti:9521141.12345.5678',
      'urn:epc:id:cpi:9521141.123ABC.123456789',
      'urn:epc:id:sgcn:9521141.12345.04711',
      'urn:epc:id:ginc:9521141.xyz47%2F11',
      'urn:epc:id:gsin:9521141.123456789',
      'urn:epc:id:itip:9521141.012345.04.04.1',
      "urn:epc:id:upui:9521141.089456.51qIgY)%3C%26Jp3*j7'SDB",
      'urn:epc:id:pgln:9521141.89012',
      'urn:epc:id:gid:952056.2718.1414',
      'urn:epc:id:usdod:CAGEY.5678',
      'urn:epc:id:adi:W81X9C..%23A1',
      'urn:epc:id:bic:CSQU3054383',
      'urn:epc:id:imovn:9176187',
      'urn:epc:class:lgtin:4012345.012345.998877',
    ];
    for (const uri of uris) {
      const p = parsePure(uri);
      expect(p instanceof Gs1Error ? [uri, p.message] : formatPure(p)).toBe(uri);
    }
    expect(parsePure('urn:epc:id:sgtin:9521141.012345.a.b:c')).toMatchObject({
      components: ['9521141', '012345', 'a.b:c'],
    });
  });

  it('re-emits escapes canonically (Review Focus 3)', () => {
    const p = parsePure('urn:epc:id:sgtin:9521141.012345.32a%2fb');
    expect(p instanceof Gs1Error ? p : formatPure(p)).toBe(
      'urn:epc:id:sgtin:9521141.012345.32a%2Fb',
    );
  });

  it('reports positions in the URI', () => {
    expect(failure(parsePure('urn:epc:id:sgtin:9521141.012345.32a/b'))).toEqual([
      'INVALID_EPC',
      'escape',
      35,
    ]);
    expect(failure(parsePure('urn:epc:id:sgtin:9521141.012345.a%00'))).toEqual([
      'INVALID_EPC',
      'escape',
      33,
    ]);
    expect(failure(parsePure('urn:epc:id:sgtin:9521141.12345.4711'))).toEqual([
      'INVALID_EPC',
      'component',
      17,
    ]);
    expect(failure(parsePure('urn:epc:id:nope:1.2'))).toEqual(['INVALID_EPC', 'scheme', 11]);
    expect(failure(parsePure('urn:epc:id:sscc:9521141'))).toEqual(['INVALID_EPC', 'syntax', 23]);
    expect(failure(parsePure('urn:epc:class:sgtin:1.2.3'))).toEqual(['INVALID_EPC', 'scheme', 14]);
    expect(failure(parsePure('urn:epc:id:gid:01.2.3'))).toEqual(['INVALID_EPC', 'component', 15]);
  });
});

describe('tag URIs and control fields (Review Focus 5)', () => {
  it('round trips control fields and serials with dots and colons', () => {
    const uri = 'urn:epc:tag:[att=x01][umi=1]:sgtin-198:3.9521141.012345.a.b:c';
    const t = parseTag(uri);
    expect(t instanceof Gs1Error ? t : [t.scheme.name, t.filter, t.components, t.control]).toEqual([
      'sgtin-198',
      3,
      ['9521141', '012345', 'a.b:c'],
      { att: 1, umi: true },
    ]);
    expect(t instanceof Gs1Error ? t : formatTag(t.scheme, t.filter, t.components, t.control)).toBe(
      uri,
    );
  });
  it('rejects controls out of order and unknown encodings', () => {
    expect(failure(parseTag('urn:epc:tag:[umi=1][att=x01]:sgtin-96:3.9521141.012345.1'))).toEqual([
      'INVALID_EPC',
      'control',
      19,
    ]);
    expect(failure(parseTag('urn:epc:tag:sgtin-97:3.9521141.012345.1'))).toEqual([
      'INVALID_EPC',
      'scheme',
      12,
    ]);
    expect(failure(parseTag('urn:epc:tag:sgtin-96:x.9521141.012345.1'))).toEqual([
      'INVALID_EPC',
      'filter',
      21,
    ]);
  });
  it('gid has no filter', () => {
    const t = parseTag('urn:epc:tag:gid-96:952056.2718.1414');
    expect(t instanceof Gs1Error ? t : [t.filter, t.components]).toEqual([
      undefined,
      ['952056', '2718', '1414'],
    ]);
  });
});

describe('raw URIs (E14)', () => {
  it('hex and decimal bodies give the bits; format emits hex', () => {
    const r = parseRaw('urn:epc:raw:96.x3074257BF7194E4000001A85');
    expect(r instanceof Gs1Error ? r : [r.bits.length, r.bits.slice(0, 8)]).toEqual([
      96,
      '00110000',
    ]);
    expect(r instanceof Gs1Error ? r : formatRaw(r.bits, r.control)).toBe(
      'urn:epc:raw:96.x3074257BF7194E4000001A85',
    );
    const d = parseRaw('urn:epc:raw:16.258');
    expect(d instanceof Gs1Error ? d : d.bits).toBe('0000000100000010');
  });
  it('AFI bodies parse to afi bits, values too large fail', () => {
    expect(parseRaw('urn:epc:raw:[umi=1][xpc=x0004]:64.x31.x0123456890ABCDEF')).toMatchObject({
      afi: 0x31,
      control: { umi: true, xpc: 4 },
    });
    expect(failure(parseRaw('urn:epc:raw:8.x1FF'))).toEqual(['INVALID_EPC', 'syntax', 12]);
  });
});

describe('edge cases and error paths', () => {
  it.each([
    ['https://example.com', 'syntax', 0],
    ['urn:epc:id:sgtin', 'syntax', 16],
    ['urn:epc:id:lgtin:9521141.012345.a', 'scheme', 11],
    ['urn:epc:id:sgtin:9521141.012345.', 'component', 32],
    ['urn:epc:id:sgln:952656789012.x.0', 'component', 29],
    ['urn:epc:id:sgcn:9521141.12345.0123456789012', 'component', 30],
    ['urn:epc:id:itip:9521141.012345.4.04.1', 'component', 31],
    ['urn:epc:id:cpi:9521141.12a.1', 'escape', 25],
    ['urn:epc:id:cpi:9521141..1', 'component', 23],
    ['urn:epc:id:usdod:CAGEI.1', 'component', 17],
    ['urn:epc:id:adi:W81X9C.%23.1', 'escape', 22],
    ['urn:epc:id:adi:W81X9C.A.', 'component', 24],
    ['urn:epc:id:adi:W81X9C.A.B%23', 'escape', 25],
    ['urn:epc:id:adi:W81X9C.A.%23', 'component', 24],
    ['urn:epc:id:adi:2S194..%23', 'component', 22],
    ['urn:epc:id:bic:CSQI3054383', 'component', 15],
    ['urn:epc:id:bic:CSQA3054383', 'component', 15],
    ['urn:epc:id:bic:CSQU305438X', 'component', 15],
    ['urn:epc:id:imovn:917618', 'component', 17],
  ])('parsePure(%s) fails with %s at %i', (uri, reason, position) => {
    expect(failure(parsePure(uri))).toEqual(['INVALID_EPC', reason, position]);
  });

  it.each([
    ['urn:epc:id:sgtin:9521141.012345.1', 'syntax', 0],
    ['urn:epc:tag:[att=x01]sgtin-96:3.9521141.012345.1', 'control', 21],
    ['urn:epc:tag:[att=x1]:sgtin-96:3.9521141.012345.1', 'control', 12],
    ['urn:epc:tag:[att=01]:sgtin-96:3.9521141.012345.1', 'control', 12],
    ['urn:epc:tag:[att=xG1]:sgtin-96:3.9521141.012345.1', 'control', 12],
    ['urn:epc:tag:[umi=2]:sgtin-96:3.9521141.012345.1', 'control', 12],
    ['urn:epc:tag:[xpc=x123]:sgtin-96:3.9521141.012345.1', 'control', 12],
    ['urn:epc:tag:[foo=1]:sgtin-96:3.9521141.012345.1', 'control', 12],
    ['urn:epc:tag:[umi=1', 'control', 12],
    ['urn:epc:tag:[umi=1][umi=1]:sgtin-96:3.9521141.012345.1', 'control', 19],
    ['urn:epc:tag:sgtin-96', 'syntax', 20],
    ['urn:epc:tag:sgtin-96:3', 'syntax', 22],
    ['urn:epc:tag:sgtin-96:03.9521141.012345.1', 'filter', 21],
    ['urn:epc:tag:sgtin-96:3.9521141.012345', 'syntax', 37],
  ])('parseTag(%s) fails with %s at %i', (uri, reason, position) => {
    expect(failure(parseTag(uri))).toEqual(['INVALID_EPC', reason, position]);
  });

  it.each([
    ['urn:epc:id:sgtin:1.2.3', 'syntax', 0],
    ['urn:epc:raw:96', 'syntax', 12],
    ['urn:epc:raw:0.x0', 'syntax', 12],
    ['urn:epc:raw:497.x0', 'syntax', 12],
    ['urn:epc:raw:96.01', 'syntax', 15],
    ['urn:epc:raw:96.xG1', 'syntax', 16],
    ['urn:epc:raw:8.256', 'syntax', 12],
    ['urn:epc:raw:96.x1G.x00', 'syntax', 17],
    ['urn:epc:raw:96.x.x00', 'syntax', 15],
    ['urn:epc:raw:96.x100.x00', 'syntax', 15],
    ['urn:epc:raw:96.x10.00', 'syntax', 19],
    ['urn:epc:raw:96.x10.x0G', 'syntax', 21],
    ['urn:epc:raw:8.x10.x100', 'syntax', 12],
    ['urn:epc:raw:[umi=x]:8.x1', 'control', 12],
  ])('parseRaw(%s) fails with %s at %i', (uri, reason, position) => {
    expect(failure(parseRaw(uri))).toEqual(['INVALID_EPC', reason, position]);
  });

  it('rejects a decimal raw body longer than 150 digits before converting it (final review item 11)', () => {
    for (const digits of ['1'.repeat(151), '1'.repeat(1e6)]) {
      const r = parseRaw(`urn:epc:raw:496.${digits}`);
      expect([failure(r), 'code' in r ? r.message : '']).toEqual([
        ['INVALID_EPC', 'syntax', 12],
        'A raw URI decimal value has at most 150 digits',
      ]);
    }
    expect(parseRaw(`urn:epc:raw:496.${'1'.repeat(149)}`)).toMatchObject({ control: {} });
  });

  it('parses empty and lower-case hex raw bodies', () => {
    expect(parseRaw('urn:epc:raw:16.x')).toMatchObject({ bits: '0000000000000000' });
    expect(parseRaw('urn:epc:raw:16.xab')).toMatchObject({ bits: '0000000010101011' });
    expect(parseRaw('urn:epc:raw:8.0')).toMatchObject({ bits: '00000000' });
  });

  it('formats control fields canonically (E13)', () => {
    expect(controlPrefix({})).toBe('');
    expect(controlPrefix({ att: 0, umi: false, xpc: 0 })).toBe('');
    expect(controlPrefix({ att: 0xab, umi: true, xpc: 0x10004 })).toBe(
      '[att=xAB][umi=1][xpc=x00010004]:',
    );
    expect(parseRaw('urn:epc:raw:[att=xab][umi=0][xpc=x00010004]:16.x1')).toMatchObject({
      control: { att: 0xab, umi: false, xpc: 0x10004 },
    });
  });

  it('formats tag URIs canonically, with filter 0 by default and none for gid', () => {
    const sgtin = schemeByName('sgtin-198');
    const gid = schemeByName('gid-96');
    const adi = schemeByName('adi-var');
    expect(sgtin && formatTag(sgtin, undefined, ['9521141', '012345', '32a%2fb'], {})).toBe(
      'urn:epc:tag:sgtin-198:0.9521141.012345.32a%2Fb',
    );
    expect(gid && formatTag(gid, 3, ['952056', '2718', '1414'], { umi: true })).toBe(
      'urn:epc:tag:[umi=1]:gid-96:952056.2718.1414',
    );
    expect(adi && formatTag(adi, 0, ['W81X9C', 'A%2fB', '%23A1'], {})).toBe(
      'urn:epc:tag:adi-var:0.W81X9C.A%2FB.%23A1',
    );
  });

  it('formatPure keeps components it cannot unescape', () => {
    expect(formatPure({ kind: 'id', scheme: 'giai', components: ['9521141', 'a/b'] })).toBe(
      'urn:epc:id:giai:9521141.a/b',
    );
    expect(formatPure({ kind: 'id', scheme: 'cpi', components: ['9521141', 'a', '1'] })).toBe(
      'urn:epc:id:cpi:9521141.a.1',
    );
  });

  it('pureComponentCount', () => {
    expect([
      pureComponentCount('sgtin'),
      pureComponentCount('itip'),
      pureComponentCount('bic'),
    ]).toEqual([3, 5, 1]);
  });
});
