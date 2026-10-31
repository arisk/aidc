import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import file from '../vectors/epc-plus.json' with { type: 'json' };
import { BitReader, BitWriter } from '../../src/core/bits.ts';
import { CSET82 } from '../../src/core/cset.ts';
import { Gs1Error } from '../../src/core/errors.ts';
import { checkHostname, decodeHostname, encodeHostname } from '../../src/epc/hostname.ts';
import { HOSTNAME_TABLE_A, HOSTNAME_TABLE_B } from '../../src/epc/tables.gen.ts';

interface MethodVector {
  readonly method: string;
  readonly input: string;
  readonly bits: string;
  readonly correctBits?: string;
}
interface BinaryVector {
  readonly source: string;
  readonly hostname?: string;
  readonly epcBits: number;
  readonly hex: string;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON vector file shape
const vectors = file.vectors as unknown as {
  methods: MethodVector[];
  binaries: BinaryVector[];
};

const enc = (host: string): string | Gs1Error => {
  const w = new BitWriter();
  return encodeHostname(host, w) ?? w.toString();
};
const dec = (bits: string): string | Gs1Error => decodeHostname(new BitReader(bits));

const hexBits = (hex: string): string => {
  let out = '';
  for (const h of hex) out += Number.parseInt(h, 16).toString(2).padStart(4, '0');
  return out;
};

const reasonOf = (v: unknown): unknown =>
  v instanceof Gs1Error ? [v.code, v.details?.['reason']] : v;

const hostMethods = vectors.methods.filter((m) => m.method.startsWith('14.5.16'));
const defective = hostMethods.filter((m) => m.correctBits !== undefined);
const regular = hostMethods.filter((m) => m.correctBits === undefined);
const referenceEncodings = regular.filter((m) => !m.method.includes('no optimisation'));

describe('hostname method vectors (Fig 14-14 to 14-16, reference demo)', () => {
  it.each(referenceEncodings.map((m) => [m.input, m.bits] as const))(
    'encodes %s as the reference does',
    (input, bits) => {
      expect(enc(input)).toBe(bits);
    },
  );
  it.each(regular.map((m) => [m.input, m.bits] as const))('decodes %s', (input, bits) => {
    expect(dec(bits)).toBe(input);
  });
  it.each(defective.map((m) => [m.input, m.correctBits ?? ''] as const))(
    'encodes %s with the corrected bits (research 3 row 21)',
    (input, bits) => {
      expect(enc(input)).toBe(bits);
    },
  );
});

/** Body bits of the "++" binaries that carry a hostname, from the research layout. */
const BODY_BITS: Readonly<Record<string, number>> = {
  // E.3 SGTIN+ (same body) is 111 bits.
  'id.example.com': 111,
  // (01) FLN 68 bits after the header, toggle and filter; serial 32a/b is 7-bit ALN: 3 + 5 + 35.
  'id.gs1.org': 111,
  // Serial 987XYZ is URN Code 40 ALN: 68 + 3 + 5 + 2 * 16 = 108.
  'id.abcde.com': 108,
};
const sgtinPlusPlus = vectors.binaries.filter(
  (b) => b.hex.startsWith('FD') && b.hostname !== undefined,
);

describe('hostname bits inside SGTIN++ binaries', () => {
  it.each(
    sgtinPlusPlus.map(
      (b) => [b.hostname ?? '', b.hex, b.epcBits, BODY_BITS[b.hostname ?? '']] as const,
    ),
  )('encodes %s as the binary carries it', (host, hex, epcBits, body) => {
    expect(enc(host)).toBe(hexBits(hex).slice(body, epcBits));
  });
  it('covers all three hostnames', () => {
    expect(new Set(sgtinPlusPlus.map((b) => b.hostname))).toEqual(
      new Set(['id.example.com', 'id.gs1.org', 'id.abcde.com']),
    );
  });
});

describe('encoding choice', () => {
  it('uses URN Code 40 for an upper-case host and keeps its case', () => {
    const bits = String(enc('ID.EXAMPLE.COM'));
    expect(bits.charAt(0)).toBe('0');
    expect(dec(bits)).toBe('ID.EXAMPLE.COM');
  });
  it('uses 7-bit with id. and .com for a lower-case host', () => {
    // 1, L = 9, id. (0100000), 7 ASCII letters, .com (1011011)
    expect(enc('id.example.com')).toBe(
      `10010010100000${Array.from('example')
        .map((c) => c.charCodeAt(0).toString(2).padStart(7, '0'))
        .join('')}1011011`,
    );
  });
  it('starts www.host.co.uk with the www. code', () => {
    expect(String(enc('www.host.co.uk')).slice(7, 14)).toBe('0011111');
  });
  it('uses 7-bit when URN Code 40 would be longer', () => {
    // "A" is 16 URN40 bits but 7 ASCII bits
    expect(enc('A')).toBe('10000011000001');
  });
  it('picks .com.au over .com and .au', () => {
    // 1, L = 3 (x, 14-bit .com.au), x, B3 .com.au
    expect(enc('x.com.au')).toBe('1000011111100000000100000000');
  });
  it('removes only the first occurrence of each pick, as the reference does', () => {
    // gs1-tdt TDTtranslator.js internalHostname2Binary: found .co.uk (B3), www. (A), .co (B1).
    // Removing the first .co.uk leaves "www.co.uk", so www. is kept, leaving "co.uk", so .co is
    // not. Scan: www., c, o, '.', u, k (no .uk entry), .co.uk = 8 units.
    expect(enc('www.co.uk.co.uk')).toBe(
      [
        '1001000',
        '0011111',
        '1100011',
        '1101111',
        '0101110',
        '1110101',
        '1101011',
        '00000100011001',
      ].join(''),
    );
  });
  it('joins the text around a removed pick, as the reference does', () => {
    // Found .gov (A), id. (A), .id (B1), .al (B1); sorted .gov, id., .id, .al. Removing .gov
    // leaves "x.id.al": id. kept, leaving "x.al": .id dropped, .al kept. Scan: x, '.', id.,
    // g, o, v (.gov starts at 4 but id. consumed it), .al = 8 units.
    expect(enc('x.id.gov.al')).toBe(
      [
        '1001000',
        '1111000',
        '0101110',
        '0100000',
        '1100111',
        '1101111',
        '1110110',
        '00000000000110',
      ].join(''),
    );
  });
  it('encodes repeated table strings', () => {
    expect(enc('x.com.y.com')).toBe(
      ['1000101', '1111000', '1011011', '0101110', '1111001', '1011011'].join(''),
    );
    expect(enc('www.www.example.com')).toBe(
      `1001010${'0011111'.repeat(2)}${Array.from('example')
        .map((c) => c.charCodeAt(0).toString(2).padStart(7, '0'))
        .join('')}1011011`,
    );
  });
  it('uses .tech from B4', () => {
    expect(enc('a.tech')).toBe('1000011110000100000110000000');
  });
});

const HOST_CHARS = Array.from(CSET82).filter((c) => /[\w.-]/.test(c));
const TABLE_STRINGS = [...HOSTNAME_TABLE_A.values(), ...HOSTNAME_TABLE_B.values()];
const hostArb = fc
  .array(fc.oneof(fc.constantFrom(...HOST_CHARS), fc.constantFrom(...TABLE_STRINGS)), {
    minLength: 1,
    maxLength: 30,
  })
  .map((parts) => parts.join('').slice(0, 63));
const urnArb = fc
  .array(fc.constantFrom(...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-.')), {
    minLength: 1,
    maxLength: 63,
  })
  .map((cs) => cs.join(''));

describe('round trip', () => {
  it('decodes what it encodes (hostname characters and table pieces)', () => {
    fc.assert(
      fc.property(hostArb, (h) => {
        const bits = enc(h);
        expect(typeof bits === 'string' ? dec(bits) : bits).toBe(h);
      }),
      { numRuns: 2000 },
    );
  });
  it('decodes what it encodes (URN Code 40 hosts)', () => {
    fc.assert(
      fc.property(urnArb, (h) => {
        const bits = enc(h);
        expect(typeof bits === 'string' ? dec(bits) : bits).toBe(h);
      }),
      { numRuns: 500 },
    );
  });
  it('reads exactly L units and leaves the rest', () => {
    const r = new BitReader(`${String(enc('id.gs1.org'))}1111`);
    expect(decodeHostname(r)).toBe('id.gs1.org');
    expect(r.rest()).toBe('1111');
  });
  it('round trips every table string on its own', () => {
    const bad = TABLE_STRINGS.filter((s) => {
      const bits = enc(s);
      return typeof bits !== 'string' || dec(bits) !== s;
    });
    expect(bad).toEqual([]);
  });
});

describe('checkHostname', () => {
  it.each([
    '',
    'x'.repeat(64),
    'a b',
    'https://x',
    'x/y',
    'é.com',
    'a?b',
    'a#b',
    'a:1',
    'u@evil.com',
    'x"onload=a',
    'a<b>',
    'a%2Fb',
  ])('rejects %j', (h) => {
    expect(reasonOf(checkHostname(h))).toEqual(['INVALID_EPC', 'hostname']);
  });
  it('gives the bad character index', () => {
    expect(checkHostname('ab/c')?.details?.['at']).toBe(2);
  });
  it.each(['a', 'x'.repeat(63), 'ID.EXAMPLE.COM', 'a-b_c.d9'])('accepts %s', (h) => {
    expect(checkHostname(h)).toBeUndefined();
  });
  it('makes encodeHostname fail the same way', () => {
    expect(reasonOf(encodeHostname('a b', new BitWriter()))).toEqual(['INVALID_EPC', 'hostname']);
  });
});

const seven = (n: number): string => n.toString(2).padStart(7, '0');
const g16 = (n: number): string => n.toString(2).padStart(16, '0');

describe('decode errors', () => {
  it.each([
    ['reserved 7-bit code 0000100', `1000001${seven(4)}`],
    ['reserved 7-bit code 0011101', `1000001${seven(29)}`],
    ['reserved 7-bit code 0100100 ($)', `1000001${seven(36)}`],
    ['reserved 7-bit code 1000000 (@)', `1000001${seven(64)}`],
    ['unassigned B2 code', '100001000000011111111'],
    ['unassigned B4 code', '100001000000110000001'],
    ['14-bit code past L', '100000100000000000000'],
    ['URN Code 40 group 0', `0000001${g16(0)}`],
    ['URN Code 40 group 64001', `0000001${g16(64001)}`],
    ['URN Code 40 PAD inside', `0000010${g16(1600 * 1 + 1)}`],
    ['URN Code 40 non-PAD padding', `0000001${g16(1600 * 1 + 40 * 2 + 1)}`],
    ['length 0', '0000000'],
    ['7-bit length 0', '1000000'],
    [
      '7-bit length 63 giving over 63 characters',
      `1111111${'00000100000000'.repeat(31)}${seven(97)}`,
    ],
    ['a decoded # (Table 14-9 has it, CSET 82 does not)', `1000001${seven(35)}`],
    // CSET 82, but not hostname characters (security review).
    ['a decoded /', `1000001${seven(47)}`],
    ['a decoded ?', `1000001${seven(63)}`],
    ['a decoded "', `1000001${seven(34)}`],
    ['a decoded <', `1000001${seven(60)}`],
    ['a decoded %', `1000001${seven(37)}`],
  ])('%s gives binary', (_name, bits) => {
    expect(reasonOf(dec(bits))).toEqual(['INVALID_EPC', 'binary']);
  });
  it.each([
    [':', `0000001${g16(1600 * 29 + 1)}`],
    ['A:1', `0000011${g16(1600 * 1 + 40 * 29 + 31 + 1)}`],
  ])('accepts a decoded %s (a port; encoding does not allow it)', (host, bits) => {
    expect(dec(bits)).toBe(host);
  });
  it('accepts a decoded host of exactly 63 characters', () => {
    expect(dec(`1111111${seven(97).repeat(63)}`)).toBe('a'.repeat(63));
  });
  it('throws RangeError when the bits run out', () => {
    expect(() => dec('10000101100001')).toThrow(RangeError);
  });
});
