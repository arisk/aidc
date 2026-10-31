import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type Epc,
  type EpcFields,
  type IdentityEpc,
  type PlusEpc,
  epc,
} from '../../src/epc/index.ts';

const fieldsFor = (
  input: string | Uint8Array,
  opts?: Parameters<typeof epc.decode>[1],
): Readonly<Record<string, string>> => epc.decode(input, opts).fields;

// Unannotated so their return types are what control-flow narrowing infers.
const byScheme = (x: Epc) => {
  if (x.scheme !== 'sgtin') throw new Error('not sgtin');
  return x.fields;
};

describe('Epc.fields', () => {
  it.each([
    [
      'urn:epc:id:sgtin:0614141.812345.6789',
      { gtin: '80614141123458', serial: '6789', companyPrefix: '0614141' },
    ],
    [
      'urn:epc:class:lgtin:0614141.812345.ABC1',
      { gtin: '80614141123458', batch: 'ABC1', companyPrefix: '0614141' },
    ],
    [
      'urn:epc:id:sscc:0614141.1234567890',
      { sscc: '106141412345678908', companyPrefix: '0614141' },
    ],
    [
      'urn:epc:id:sgln:0614141.12345.400',
      { gln: '0614141123452', extension: '400', companyPrefix: '0614141' },
    ],
    ['urn:epc:id:sgln:0614141.12345.0', { gln: '0614141123452', companyPrefix: '0614141' }],
    [
      'urn:epc:id:grai:0614141.12345.400',
      { grai: '0614141123452', serial: '400', companyPrefix: '0614141' },
    ],
    ['urn:epc:id:giai:0614141.12345400', { giai: '061414112345400', companyPrefix: '0614141' }],
    [
      'urn:epc:id:gsrn:0614141.1234567890',
      { gsrn: '061414112345678902', companyPrefix: '0614141' },
    ],
    [
      'urn:epc:id:gsrnp:0614141.1234567890',
      { gsrnp: '061414112345678902', companyPrefix: '0614141' },
    ],
    [
      'urn:epc:id:gdti:0614141.12345.400',
      { gdti: '0614141123452', serial: '400', companyPrefix: '0614141' },
    ],
    [
      'urn:epc:id:cpi:0614141.123ABC.123456789',
      { cpid: '0614141123ABC', serial: '123456789', companyPrefix: '0614141' },
    ],
    [
      'urn:epc:id:sgcn:4012345.67890.04711',
      { gcn: '4012345678901', serial: '04711', companyPrefix: '4012345' },
    ],
    ['urn:epc:id:ginc:0614141.xyz47%2F11', { ginc: '0614141xyz47/11', companyPrefix: '0614141' }],
    ['urn:epc:id:gsin:0614141.123456789', { gsin: '06141411234567890', companyPrefix: '0614141' }],
    [
      'urn:epc:id:itip:4012345.012345.01.02.987',
      {
        gtin: '04012345123456',
        piece: '01',
        total: '02',
        serial: '987',
        companyPrefix: '4012345',
      },
    ],
    [
      'urn:epc:id:upui:1234567.089456.51qIgY)%3C%26Jp3*j7%27SDB',
      { gtin: '01234567894560', tpx: "51qIgY)<&Jp3*j7'SDB", companyPrefix: '1234567' },
    ],
    ['urn:epc:id:pgln:1234567.89012', { pgln: '1234567890128', companyPrefix: '1234567' }],
    [
      'urn:epc:id:gid:95100000.12345.400',
      { generalManager: '95100000', objectClass: '12345', serial: '400' },
    ],
    ['urn:epc:id:usdod:2S194.12345678901', { cageOrDodaac: '2S194', serial: '12345678901' }],
    [
      'urn:epc:id:adi:2S194.12345A%2F1.%23A1',
      { cageOrDodaac: '2S194', partNumber: '12345A/1', serial: '#A1' },
    ],
    ['urn:epc:id:bic:CSQU3054383', { containerCode: 'CSQU3054383' }],
    ['urn:epc:id:imovn:9176187', { vesselNumber: '9176187' }],
  ])('%s', (input, want) => {
    const f = fieldsFor(input);
    expect(f).toEqual(want);
    expect(Object.keys(f)).toEqual(Object.keys(want));
  });

  it('decodes a GRAI-96 hex by name', () => {
    expect(fieldsFor('3374257BF40C0E400000162E')).toEqual({
      grai: '0614141123452',
      serial: '5678',
      companyPrefix: '0614141',
    });
  });

  it('unescapes URI components once', () => {
    expect(fieldsFor('urn:epc:id:grai:0614141.12345.A%2fB')).toMatchObject({ serial: 'A/B' });
    expect(fieldsFor('urn:epc:id:sgtin:0614141.812345.A%25B')).toMatchObject({ serial: 'A%B' });
    expect(fieldsFor('urn:epc:id:adi:W81X9C..3KL984PX1')).toMatchObject({ partNumber: '' });
  });

  it('is set even when GS1 rules reject the data (TDT vector, (8011) of 0)', () => {
    const e = epc.decode('urn:epc:id:cpi:15895246363.98.0');
    expect(e.fields).toEqual({ cpid: '1589524636398', serial: '0', companyPrefix: '15895246363' });
    expect(epc.tryToElementString(e).ok).toBe(false);
  });

  it('agrees across the pure, tag and raw URIs, hex and bytes of one EPC', () => {
    const e = epc.decode('urn:epc:tag:sgtin-198:3.0614141.812345.A%2FB');
    const want = { gtin: '80614141123458', serial: 'A/B', companyPrefix: '0614141' };
    expect(e.fields).toEqual(want);
    for (const form of [
      e.kind === 'plus' ? '' : e.pureIdentityUri,
      e.rawUri ?? '',
      e.hex ?? '',
      e.bytes ?? new Uint8Array(),
    ]) {
      expect(epc.decode(form).fields).toEqual(want);
    }
  });

  it('names a plus EPC as its legacy family, without a company prefix', () => {
    const es = '(01)09506000134352(21)12345(17)271231(10)LOT7';
    const legacy = epc.fromElementString(es, { scheme: 'sgtin-96', companyPrefixLength: 7 });
    const plus = epc.decode(
      epc.fromElementString(es, { scheme: 'sgtin++', filter: 3, hostname: 'id.example.com' }).hex ??
        '',
    );
    expect(plus.kind).toBe('plus');
    expect(plus.fields).toEqual({ gtin: '09506000134352', serial: '12345' });
    expect(legacy.fields).toEqual({ ...plus.fields, companyPrefix: '9506000' });
    const grai = '(8003)00614141123452A/B';
    expect(epc.fromElementString(grai, { scheme: 'grai+', filter: 0 }).fields).toEqual({
      grai: '0614141123452',
      serial: 'A/B',
    });
  });

  it('is set on re-encoding decode and fromElementString results', () => {
    expect(fieldsFor('3074257BF7194E4000001A85', { scheme: 'sgtin-198' })).toEqual({
      gtin: '80614141123458',
      serial: '6789',
      companyPrefix: '0614141',
    });
    const f = epc.fromElementString('(8003)00614141123452A/B', {
      scheme: 'grai-170',
      filter: 0,
      companyPrefixLength: 7,
    });
    expect(f.fields).toEqual({ grai: '0614141123452', serial: 'A/B', companyPrefix: '0614141' });
    expect(epc.decode(f.hex ?? '').fields).toEqual(f.fields);
  });

  it('is frozen and serialised', () => {
    const e = epc.decode('3374257BF40C0E400000162E');
    expect(Object.isFrozen(e.fields)).toBe(true);
    expect(JSON.parse(JSON.stringify(e))).toMatchObject({
      fields: { grai: '0614141123452', serial: '5678', companyPrefix: '0614141' },
    });
  });

  it('is typed by scheme, for legacy and plus EPCs alike', () => {
    expectTypeOf(byScheme).returns.toEqualTypeOf<EpcFields<'sgtin'>>();
    expectTypeOf<EpcFields<'sgtin'>>().toEqualTypeOf<
      { readonly gtin: string; readonly serial: string } & { readonly companyPrefix?: string }
    >();
    expectTypeOf<Extract<PlusEpc, { scheme: 'grai' }>['fields']>().toEqualTypeOf<
      EpcFields<'grai'>
    >();
    expectTypeOf<Extract<IdentityEpc, { scheme: 'gid' }>['fields']>().toEqualTypeOf<{
      readonly generalManager: string;
      readonly objectClass: string;
      readonly serial: string;
    }>();
  });
});

const reason = (r: ReturnType<typeof epc.tryDecode>): unknown =>
  r.ok ? 'ok' : [r.errors[0]?.code, r.errors[0]?.details?.['reason']];
const lookup = (d: string): number | undefined => (d.startsWith('0614141') ? 7 : undefined);
const plusFields = (es: string, scheme: 'sgtin+' | 'sscc+' | 'grai+' | 'cpi+'): unknown =>
  epc.fromElementString(es, { scheme, companyPrefixLength: 7 }).fields;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an untyped caller's options
const bad = { companyPrefixLength: '7' } as unknown as Parameters<typeof epc.decode>[1];

describe('companyPrefixLength on plus EPCs', () => {
  const sgtinPlus = 'F7380614141123458046A140';
  const legacy = epc.decode('3074257BF7194E4000001A85');

  it('is optional: without it a plus EPC has no company prefix', () => {
    expect(epc.decode(sgtinPlus).fields).toEqual({ gtin: '80614141123458', serial: '6789' });
  });

  it('fills fields.companyPrefix from a length or a lookup, as on the legacy EPC', () => {
    expect(epc.decode(sgtinPlus, { companyPrefixLength: 7 }).fields).toEqual(legacy.fields);
    expect(epc.decode(sgtinPlus, { companyPrefixLength: lookup }).fields).toEqual(legacy.fields);
    expect(
      epc.decode(sgtinPlus, {
        scheme: 'sgtin++',
        hostname: 'id.example.com',
        companyPrefixLength: 7,
      }).fields,
    ).toEqual(legacy.fields);
  });

  it('leaves it out when the lookup does not know the length', () => {
    expect(epc.decode(sgtinPlus, { companyPrefixLength: () => undefined }).fields).toEqual({
      gtin: '80614141123458',
      serial: '6789',
    });
  });

  it('applies to fromElementString with a plus scheme, for every key layout', () => {
    expect(plusFields('(01)80614141123458(21)6789', 'sgtin+')).toEqual(legacy.fields);
    expect(plusFields('(00)106141412345678908', 'sscc+')).toMatchObject({
      companyPrefix: '0614141',
    });
    expect(plusFields('(8003)00614141123452A/B', 'grai+')).toMatchObject({
      companyPrefix: '0614141',
    });
    expect(plusFields('(8010)0614141123ABC(8011)1', 'cpi+')).toMatchObject({
      companyPrefix: '0614141',
    });
  });

  it('needs no lookup for GTIN-8 (TDS 7.3.2)', () => {
    const es = '(01)00000040170725(21)1';
    const plus = epc.fromElementString(es, {
      scheme: 'sgtin+',
      companyPrefixLength: () => undefined,
    });
    expect(plus.fields).toEqual(epc.fromElementString(es, { scheme: 'sgtin-96' }).fields);
  });

  it('is ignored by legacy EPCs, which encode their own', () => {
    expect(epc.decode('3074257BF7194E4000001A85', { companyPrefixLength: 9 }).fields).toEqual(
      legacy.fields,
    );
  });

  it('fails on a length that does not fit or a value of the wrong type', () => {
    expect(reason(epc.tryDecode(sgtinPlus, { companyPrefixLength: 3 }))).toEqual([
      'INVALID_EPC',
      'gcp-length',
    ]);
    expect(reason(epc.tryDecode(sgtinPlus, bad))).toEqual(['INVALID_EPC', 'gcp-length']);
    expect(reason(epc.tryDecode('3074257BF7194E4000001A85', bad))).toEqual([
      'INVALID_EPC',
      'gcp-length',
    ]);
  });
});
