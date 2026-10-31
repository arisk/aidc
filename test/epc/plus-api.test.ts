import { describe, expect, it } from 'vitest';
import file from '../vectors/epc-plus.json' with { type: 'json' };
import { parse } from '../../src/ai/index.ts';
import { Gs1Error, type Result } from '../../src/core/errors.ts';
import {
  type Epc,
  type EpcFromElementStringOptions,
  type PlusEpc,
  type PlusSchemeName,
  epc,
} from '../../src/epc/index.ts';

interface BinaryVector {
  readonly scheme: string;
  readonly elementString: string;
  readonly filter: number;
  readonly toggle: number;
  readonly hostname?: string;
  readonly prioritisedDate?: { readonly ai: string; readonly value: string };
  readonly hexWordPadded: string;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON vector file shape
const binaries = (file.vectors as unknown as { binaries: BinaryVector[] }).binaries;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector names are plus scheme names
const nameOf = (v: BinaryVector): PlusSchemeName => v.scheme.toLowerCase() as PlusSchemeName;

const label = (v: BinaryVector): string =>
  `${v.scheme} ${v.elementString}${v.hostname === undefined ? '' : ` @${v.hostname}`} f${v.filter}`;

/** The PlusEpc of `e`, or a test failure. */
function plus(e: Epc): PlusEpc {
  if (e.kind !== 'plus') throw new Error(`not a plus EPC: ${e.kind}`);
  return e;
}

/** [code, reason or field, why, ai, position] of the first error, or 'ok'. */
function err<T>(r: Result<T>): unknown {
  if (r.ok) return 'ok';
  const e = r.errors[0];
  return [
    e?.code,
    e?.details?.['reason'] ?? e?.details?.['field'] ?? null,
    e?.details?.['why'] ?? null,
    e?.ai ?? null,
  ];
}

const optionsOf = (v: BinaryVector): EpcFromElementStringOptions => ({
  scheme: nameOf(v),
  filter: v.filter,
  ...(v.hostname === undefined ? {} : { hostname: v.hostname }),
  ...(v.prioritisedDate === undefined
    ? {}
    : // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- vector date AIs are prioritised date AIs
      { dateAi: v.prioritisedDate.ai as EpcFromElementStringOptions['dateAi'] & string }),
});

describe('plus binary vectors through the epc API', () => {
  for (const v of binaries) {
    it(`decodes ${label(v)}`, () => {
      const e = plus(epc.decode(v.hexWordPadded));
      expect({
        kind: e.kind,
        binaryScheme: e.binaryScheme,
        filter: e.filter,
        hostname: e.hostname,
        hex: e.hex,
        equivalent: e.elementString.equivalent(parse(v.elementString)),
      }).toEqual({
        kind: 'plus',
        binaryScheme: nameOf(v),
        filter: v.filter,
        hostname: v.hostname,
        hex: v.hexWordPadded,
        equivalent: true,
      });
    });
    it(`encodes ${label(v)}`, () => {
      expect(epc.fromElementString(v.elementString, optionsOf(v)).hex).toBe(v.hexWordPadded);
    });
  }
});

describe('PlusEpc values', () => {
  const sgtinPlus = binaries[0]?.hexWordPadded ?? '';
  it('carries the plus fields and no pure identity or tag URI (F2)', () => {
    const e = plus(epc.decode(sgtinPlus));
    expect({ ...e, elementString: e.elementString.toString() }).toEqual({
      kind: 'plus',
      scheme: 'sgtin',
      fields: { gtin: '79521141123453', serial: '32a/b' },
      binaryScheme: 'sgtin+',
      filter: 3,
      elementString: '(01)79521141123453(21)32a/b',
      aidc: [],
      rawUri: `urn:epc:raw:112.x${sgtinPlus}`,
      hex: sgtinPlus,
      bytes: e.bytes,
      bitLength: 111,
      control: {},
    });
    expect(['pureIdentityUri' in e, 'tagUri' in e, Object.isFrozen(e)]).toEqual([
      false,
      false,
      true,
    ]);
  });
  it('hands out fresh bytes', () => {
    const e = plus(epc.decode(sgtinPlus));
    const b = e.bytes;
    b[0] = 0;
    expect(e.bytes[0]).toBe(0xf7);
    expect(epc.decode(b.slice().fill(0xf7, 0, 1)).hex).toBe(sgtinPlus);
  });
  it('maps to its element string', () => {
    const e = epc.decode(sgtinPlus);
    expect(epc.toElementString(e).toString()).toBe('(01)79521141123453(21)32a/b');
  });
  it('decodes its raw URI to an equal value, with control fields (F14)', () => {
    const e = epc.decode(sgtinPlus, { control: { att: 2, umi: true } });
    expect(e.rawUri).toBe(`urn:epc:raw:[att=x02][umi=1]:112.x${sgtinPlus}`);
    const back = epc.decode(e.rawUri ?? '');
    expect([back, plus(back).elementString.equals(plus(e).elementString)]).toEqual([e, true]);
  });
  it('keeps the input bits on decode', () => {
    // GIAI+ with the optional DTN-free encoding is still decoded as given.
    const giai = binaries.find((v) => v.scheme === 'GIAI+')?.hexWordPadded ?? '';
    expect(epc.decode(giai).hex).toBe(giai);
  });
});

describe('+AIDC data (Review Focus 1)', () => {
  const mudi = '(01)09521141123454(21)A(8014)9521141ABCBB';
  const iban =
    '(01)09521141123454(21)A(415)9506000134352(8020)1(8007)GB48BBBBBBBBBBBBBBBBBBBBBBBBBB';
  it('rejects an AI without a Table F row', () => {
    expect(err(epc.tryFromElementString(mudi, { scheme: 'sgtin+' }))).toEqual([
      'EPC_FIELD_OVERFLOW',
      '8014',
      'not-encodable',
      null,
    ]);
  });
  it('rejects a value over its Table F maximum', () => {
    expect(err(epc.tryFromElementString(iban, { scheme: 'sgtin+' }))).toEqual([
      'EPC_FIELD_OVERFLOW',
      '8007',
      'too-long',
      null,
    ]);
  });
  it('leaves the other AIs out with aidc: false', () => {
    const e = plus(epc.fromElementString(mudi, { scheme: 'sgtin+', aidc: false }));
    expect([e.elementString.toString(), e.aidc]).toEqual(['(01)09521141123454(21)A', []]);
  });
  it('writes the remaining AIs in element string order, identical repeats once (F5)', () => {
    const e = plus(
      epc.fromElementString('(10)LOT(01)09521141123454(90)X(21)S(10)LOT', { scheme: 'sgtin+' }),
    );
    expect([e.elementString.toString(), e.aidc]).toEqual([
      '(01)09521141123454(21)S(10)LOT(90)X',
      [
        ['10', 'LOT'],
        ['90', 'X'],
      ],
    ]);
    expect(plus(epc.decode(e.hex)).elementString.equals(e.elementString)).toBe(true);
  });
  it('writes an identical repeated body AI once', () => {
    const e = epc.fromElementString('(01)09521141123454(21)S(01)09521141123454', {
      scheme: 'sgtin+',
    });
    expect(e.hex).toBe(epc.fromElementString('(01)09521141123454(21)S', { scheme: 'sgtin+' }).hex);
  });
  it('rejects conflicting repeats through element string validation', () => {
    expect(
      err(epc.tryFromElementString('(01)09521141123454(21)S(21)T', { scheme: 'sgtin+' })),
    ).toEqual(['DUPLICATE_AI', null, null, '21']);
  });
  it('rejects an EPC over 496 bits', () => {
    const long = `(01)09521141123454(21)${'A'.repeat(20)}(10)${'B'.repeat(20)}(90)${'C'.repeat(30)}(91)${'D'.repeat(30)}(92)${'E'.repeat(30)}`;
    expect(err(epc.tryFromElementString(long, { scheme: 'sgtin+' }))).toEqual([
      'EPC_FIELD_OVERFLOW',
      'epc',
      'too-long',
      null,
    ]);
  });
  it('validates the input element string (F12)', () => {
    expect(err(epc.tryFromElementString('(01)09521141123455(21)S', { scheme: 'sgtin+' }))).toEqual([
      'CHECK_DIGIT',
      null,
      null,
      '01',
    ]);
  });
  it('requires every body AI except the SGLN extension (F7)', () => {
    expect(err(epc.tryFromElementString('(01)09521141123454', { scheme: 'sgtin+' }))).toEqual([
      'INVALID_EPC',
      'no-epc-key',
      null,
      '21',
    ]);
    const gln = plus(epc.fromElementString('(414)9521141123454', { scheme: 'sgln+' }));
    const zero = plus(epc.fromElementString('(414)9521141123454(254)0', { scheme: 'sgln+' }));
    expect([gln.elementString.toString(), zero.hex, zero.elementString.toString()]).toEqual([
      '(414)9521141123454',
      gln.hex,
      '(414)9521141123454',
    ]);
  });
  it('rejects an epcScheme of another family, and dateAi without a plus scheme', () => {
    expect(
      err(
        epc.tryFromElementString('(01)09521141123454(21)S', {
          scheme: 'sgtin+',
          epcScheme: 'sscc',
        }),
      ),
    ).toEqual(['INVALID_EPC', 'scheme', null, null]);
    expect(
      err(
        epc.tryFromElementString('(01)09521141123454(21)S', {
          scheme: 'sgtin-96',
          dateAi: '17',
          companyPrefixLength: 7,
        }),
      ),
    ).toEqual(['INVALID_EPC', 'component', null, null]);
    expect(
      plus(
        epc.fromElementString(parse('(01)09521141123454(21)S'), {
          scheme: 'sgtin+',
          epcScheme: 'sgtin',
        }),
      ).binaryScheme,
    ).toBe('sgtin+');
  });
});

describe('DSGTIN prioritised date (Review Focus 2)', () => {
  const es = '(01)09521141123454(21)S(17)261231(11)250101';
  it('chooses the first date AI in TDS 14.5.3 order', () => {
    const e = plus(epc.fromElementString(es, { scheme: 'dsgtin+' }));
    expect([e.elementString.toString(), e.aidc]).toEqual([
      '(01)09521141123454(21)S(11)250101(17)261231',
      [['17', '261231']],
    ]);
    expect(plus(epc.decode(e.hex)).elementString.equals(e.elementString)).toBe(true);
  });
  it('takes the date AI from dateAi', () => {
    const e = plus(epc.fromElementString(es, { scheme: 'dsgtin+', dateAi: '17' }));
    expect([e.elementString.toString(), e.aidc]).toEqual([
      '(01)09521141123454(21)S(17)261231(11)250101',
      [['11', '250101']],
    ]);
  });
  it('requires a date AI', () => {
    expect(err(epc.tryFromElementString('(01)09521141123454(21)S', { scheme: 'dsgtin+' }))).toEqual(
      ['INVALID_EPC', 'no-date', null, null],
    );
    expect(err(epc.tryFromElementString(es, { scheme: 'dsgtin+', dateAi: '13' }))).toEqual([
      'INVALID_EPC',
      'no-date',
      null,
      null,
    ]);
  });
  it('does not take a (7007) range as the date (TDS 14.5.3)', () => {
    const range = '(01)09521141123454(21)S(7007)250101250131';
    expect(err(epc.tryFromElementString(range, { scheme: 'dsgtin+' }))).toEqual([
      'INVALID_EPC',
      'no-date',
      null,
      null,
    ]);
    expect(err(epc.tryFromElementString(range, { scheme: 'dsgtin+', dateAi: '7007' }))).toEqual([
      'INVALID_EPC',
      'component',
      null,
      '7007',
    ]);
    const e = plus(epc.fromElementString(`${range}(11)250102`, { scheme: 'dsgtin+' }));
    expect([e.elementString.toString(), e.aidc]).toEqual([
      '(01)09521141123454(21)S(11)250102(7007)250101250131',
      [['7007', '250101250131']],
    ]);
  });
  it('rejects dateAi on a scheme without a date, and a bad dateAi', () => {
    expect(err(epc.tryFromElementString(es, { scheme: 'sgtin+', dateAi: '17' }))).toEqual([
      'INVALID_EPC',
      'component',
      null,
      null,
    ]);
    expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wrong value from untyped callers
      err(epc.tryFromElementString(es, { scheme: 'dsgtin+', dateAi: '12' as '11' })),
    ).toEqual(['INVALID_EPC', 'component', null, null]);
  });
});

describe('"++" hostnames (Review Focus 3)', () => {
  const es = '(01)09521141123454(21)S';
  it('keeps the case of a hostname', () => {
    const e = plus(epc.fromElementString(es, { scheme: 'sgtin++', hostname: 'ID.EXAMPLE.COM' }));
    expect([e.hostname, plus(epc.decode(e.hex)).hostname]).toEqual([
      'ID.EXAMPLE.COM',
      'ID.EXAMPLE.COM',
    ]);
  });
  it('rejects a missing or bad hostname', () => {
    for (const hostname of [
      undefined,
      'a'.repeat(64),
      'id.example.com/x',
      'https://id.example.com',
    ]) {
      expect(
        err(
          epc.tryFromElementString(es, {
            scheme: 'sgtin++',
            ...(hostname === undefined ? {} : { hostname }),
          }),
        ),
      ).toEqual(['INVALID_EPC', 'hostname', null, null]);
    }
  });
  it('rejects a hostname on other schemes', () => {
    for (const scheme of ['sgtin+', 'sgtin-96'] as const) {
      expect(
        err(
          epc.tryFromElementString(es, {
            scheme,
            hostname: 'id.example.com',
            companyPrefixLength: 7,
          }),
        ),
      ).toEqual(['INVALID_EPC', 'hostname', null, null]);
    }
    expect(err(epc.tryFromElementString(es, { hostname: 'id.example.com' }))).toEqual([
      'INVALID_EPC',
      'hostname',
      null,
      null,
    ]);
    expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wrong type from untyped callers
      err(epc.tryFromElementString(es, { scheme: 'sgtin++', hostname: 7 as unknown as string })),
    ).toEqual(['INVALID_EPC', 'hostname', null, null]);
  });
});

describe('re-encoding a decoded plus EPC (F13)', () => {
  const sgtinPlus = plus(
    epc.fromElementString('(01)09521141123454(21)S(17)261231(10)L', {
      scheme: 'sgtin+',
      filter: 1,
    }),
  ).hex;
  it('re-encodes into a "++" scheme of the same family', () => {
    const e = plus(epc.decode(sgtinPlus, { scheme: 'sgtin++', hostname: 'id.example.com' }));
    expect([e.binaryScheme, e.hostname, e.filter, e.elementString.toString()]).toEqual([
      'sgtin++',
      'id.example.com',
      1,
      '(01)09521141123454(21)S(17)261231(10)L',
    ]);
    const back = plus(epc.decode(e.hex, { scheme: 'sgtin+' }));
    expect([back.hex, back.hostname]).toEqual([sgtinPlus, undefined]);
    expect(epc.decode(e.hex, { scheme: 'sgtin++' }).hex).toBe(e.hex);
    expect(plus(epc.decode(e.hex, { scheme: 'sgtin++', hostname: 'x.org' })).hostname).toBe(
      'x.org',
    );
  });
  it('moves the date between DSGTIN and SGTIN', () => {
    const d = plus(epc.decode(sgtinPlus, { scheme: 'dsgtin+', filter: 2 }));
    expect([d.filter, d.elementString.toString(), d.aidc]).toEqual([
      2,
      '(01)09521141123454(21)S(17)261231(10)L',
      [['10', 'L']],
    ]);
    expect(epc.decode(d.hex, { scheme: 'sgtin+', filter: 1 }).hex).toBe(sgtinPlus);
  });
  it('refuses legacy and other-family schemes', () => {
    expect(err(epc.tryDecode(sgtinPlus, { scheme: 'sgtin-96' }))).toEqual([
      'INVALID_EPC',
      'scheme',
      null,
      null,
    ]);
    expect(err(epc.tryDecode(sgtinPlus, { scheme: 'sscc+' }))).toEqual([
      'INVALID_EPC',
      'scheme',
      null,
      null,
    ]);
    expect(err(epc.tryDecode('3074257BF7194E4000001A85', { scheme: 'sgtin+' }))).toEqual([
      'INVALID_EPC',
      'scheme',
      null,
      null,
    ]);
  });
  it('refuses a hostname for a scheme without one', () => {
    expect(err(epc.tryDecode(sgtinPlus, { hostname: 'id.example.com' }))).toEqual([
      'INVALID_EPC',
      'hostname',
      null,
      null,
    ]);
    expect(err(epc.tryDecode('3074257BF7194E4000001A85', { hostname: 'id.example.com' }))).toEqual([
      'INVALID_EPC',
      'hostname',
      null,
      null,
    ]);
  });
  it('validates filter and control options', () => {
    expect(err(epc.tryDecode(sgtinPlus, { filter: 8 }))).toEqual([
      'INVALID_EPC',
      'filter',
      null,
      null,
    ]);
    expect(err(epc.tryDecode(sgtinPlus, { control: { att: 256 } }))).toEqual([
      'INVALID_EPC',
      'control',
      null,
      null,
    ]);
    expect(epc.decode(sgtinPlus, { filter: 5 }).filter).toBe(5);
  });
  it('rejects a bad aidc option type', () => {
    expect(
      err(
        epc.tryFromElementString('(01)09521141123454(21)S', {
          scheme: 'sgtin+',
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a wrong type from untyped callers
          aidc: 1 as unknown as boolean,
        }),
      ),
    ).toEqual(['INVALID_EPC', 'aidc', null, null]);
  });
});

describe('element string validation of decoded binaries (F12)', () => {
  // SGTIN+ (01)79521141123453(21)32a/b with the GTIN check digit changed to 4.
  const bad = 'F73795211411234548566CB0AFC4';
  it('reports a wrong check digit over the whole hex input', () => {
    const r = epc.tryDecode(bad);
    const e = r.ok ? undefined : r.errors[0];
    expect([e?.code, e?.ai, e?.position, e?.length]).toEqual(['CHECK_DIGIT', '01', 0, bad.length]);
  });
  it('reports it without a position for bytes', () => {
    const bytes = plus(epc.decode('F73795211411234538566CB0AFC4')).bytes;
    bytes[8] = 0x48;
    const r = epc.tryDecode(bytes);
    const e = r.ok ? undefined : r.errors[0];
    expect([e?.code, e?.ai, e?.position]).toEqual(['CHECK_DIGIT', '01', undefined]);
  });
  it('places bit errors at their hex digit', () => {
    const r = epc.tryDecode('F7379521141123453');
    const e = r.ok ? undefined : r.errors[0];
    expect([e?.code, e?.details?.['reason'], e instanceof Gs1Error, e?.position]).toEqual([
      'INVALID_EPC',
      'binary',
      true,
      17,
    ]);
  });
  it('places AI errors over a raw URI', () => {
    const uri = `urn:epc:raw:112.x${bad}`;
    const r = epc.tryDecode(uri);
    const e = r.ok ? undefined : r.errors[0];
    expect([e?.code, e?.position, e?.length]).toEqual(['CHECK_DIGIT', 0, uri.length]);
  });
});

/** Options with values of any type, as untyped callers pass them. */
const opts = (o: Record<string, unknown>): EpcFromElementStringOptions => o;

describe('option values of the wrong type never throw', () => {
  const hostile: readonly unknown[] = [Symbol('x'), Object.create(null), true, {}];
  const hex = 'F73795211411234538566CB0AFC4';
  const es = '(01)09521141123454(21)A';
  for (const v of hostile) {
    const name =
      typeof v === 'symbol'
        ? 'a Symbol'
        : v === null
          ? 'null'
          : `${typeof v} ${Object.getPrototypeOf(v) === null ? '(null prototype)' : JSON.stringify(v)}`;
    it(`rejects ${name} as scheme or epcScheme`, () => {
      expect([
        err(epc.tryDecode(hex, opts({ scheme: v }))),
        err(epc.tryDecode('3074257BF7194E4000001A85', opts({ scheme: v }))),
        err(epc.tryFromElementString(es, opts({ scheme: v }))),
        err(epc.tryFromElementString(es, opts({ scheme: 'sgtin+', epcScheme: v }))),
        err(epc.tryFromElementString(es, opts({ scheme: 'sgtin-96', epcScheme: v }))),
      ]).toEqual(Array.from({ length: 5 }, () => ['INVALID_EPC', 'scheme', null, null]));
    });
    it(`rejects ${name} as dateAi, hostname or companyPrefixLength`, () => {
      expect([
        err(epc.tryFromElementString(es, opts({ scheme: 'dsgtin+', dateAi: v }))),
        err(epc.tryFromElementString(es, opts({ scheme: 'sgtin++', hostname: v }))),
        err(epc.tryDecode(hex, opts({ scheme: 'sgtin++', hostname: v }))),
        err(epc.tryFromElementString(es, opts({ scheme: 'sgtin-96', companyPrefixLength: v }))),
        err(
          epc.tryFromElementString(es, opts({ scheme: 'sgtin-96', companyPrefixLength: () => v })),
        ),
      ]).toEqual([
        ['INVALID_EPC', 'component', null, null],
        ['INVALID_EPC', 'hostname', null, null],
        ['INVALID_EPC', 'hostname', null, null],
        // A wrong type fails with the other options, before the key AI is read.
        ['INVALID_EPC', 'gcp-length', null, null],
        ['INVALID_EPC', 'gcp-length', null, '01'],
      ]);
    });
    it(`rejects ${name} as filter`, () => {
      expect([
        err(epc.tryDecode(hex, opts({ filter: v }))),
        err(epc.tryFromElementString(es, opts({ scheme: 'sgtin+', filter: v }))),
      ]).toEqual(Array.from({ length: 2 }, () => ['INVALID_EPC', 'filter', null, null]));
    });
  }
});

describe('trailing zero fill after a plus EPC (E4)', () => {
  const cases: readonly [PlusSchemeName, string][] = [
    ['sgtin+', '(01)09521141123454(21)A(10)LOT'],
    ['sscc+', '(00)095211411234567892(400)ORD1'],
    ['sgtin+', '(01)09521141123454(21)A'],
  ];
  // Hex digits of zero fill: 80 and 96 bits, and padded up to 62 bytes (496 bits, the most
  // epc.decode takes) in all. decodePlus tests the 432 bit fill without that limit.
  const fills = [20, 24];

  for (const [scheme, es] of cases) {
    const plain = plus(epc.fromElementString(es, { scheme }));
    const upTo62 = '0'.repeat(124 - plain.hex.length);
    for (const fill of [...fills.map((n) => '0'.repeat(n)), upTo62]) {
      it(`ignores ${fill.length * 4} bits of zero fill after ${scheme} ${es} (toggle ${plain.aidc.length > 0 ? 1 : 0})`, () => {
        const r = epc.tryDecode(plain.hex + fill);
        if (!r.ok) throw new Error(r.errors[0]?.message);
        const e = plus(r.value);
        expect(e.hex).toBe(plain.hex);
        expect(e.bitLength).toBe(plain.bitLength);
        expect(e.aidc).toEqual(plain.aidc);
        expect(e.elementString.toString()).toBe(plain.elementString.toString());
      });
    }
  }

  it('covers both toggle values', () => {
    const aidcs = cases.map(
      ([scheme, es]) => plus(epc.fromElementString(es, { scheme })).aidc.length,
    );
    expect(aidcs).toEqual([1, 1, 0]);
  });
});

describe('plus scheme option on an identity EPC', () => {
  it('points to toElementString and fromElementString', () => {
    const r = epc.tryDecode('urn:epc:id:sscc:0952114.1123456789', { scheme: 'sgtin+' });
    expect(r.ok ? '' : r.errors[0]?.message).toContain(
      'use toElementString, then fromElementString',
    );
  });
});

describe('decoded hostnames are safe in a URL host (security review)', () => {
  it.each([
    ['evil.com/x', 'FD00952123454321323ABC9597B69D8BB1EFDABFC000'],
    ['x"onload=a', 'FD00952123454321323ABC95E116FDDB37E1C8F70800'],
    ['a<b>c"d.ex', 'FD00952123454321323ABC9585E627D8D1645D97C000'],
  ])('rejects an SGTIN++ whose hostname is %s', (_host, hex) => {
    const r = epc.tryDecode(hex);
    expect(r.ok ? r.value : r.errors[0]?.details?.['reason']).toBe('binary');
  });

  it('accepts a host with a port', () => {
    const r = epc.tryDecode('FD00952123454321323ABC9585763DFB5D3860E18000');
    expect(r.ok && r.value.kind === 'plus' ? r.value.hostname : r).toBe('a.com:8080');
  });
});
