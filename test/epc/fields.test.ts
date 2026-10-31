import { describe, expect, it } from 'vitest';
import { FIELD_NAMES, gs1Fields, isGs1Scheme } from '../../src/epc/fields.ts';
import { fieldsOf, pureComponentCount } from '../../src/epc/uri.ts';

describe('FIELD_NAMES', () => {
  it('names every component of every scheme without a GS1 key', () => {
    const schemes = ['gid', 'usdod', 'adi', 'bic', 'imovn'] as const;
    expect(Object.keys(FIELD_NAMES)).toEqual(schemes);
    for (const s of schemes) {
      expect(isGs1Scheme(s)).toBe(false);
      expect(FIELD_NAMES[s]).toHaveLength(pureComponentCount(s));
    }
  });
});

describe('fieldsOf', () => {
  it('pairs names with components in order', () => {
    const f = fieldsOf('gid', ['95100000', '12345', '400']);
    expect(Object.keys(f)).toEqual(['generalManager', 'objectClass', 'serial']);
  });

  it('removes 6-bit escapes in ADI components and keeps empty ones', () => {
    expect(fieldsOf('adi', ['2S194', '12345A%2F1', '%23A1'])).toEqual({
      cageOrDodaac: '2S194',
      partNumber: '12345A/1',
      serial: '#A1',
    });
    expect(fieldsOf('adi', ['W81X9C', '', '3KL984PX1']).partNumber).toBe('');
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(fieldsOf('bic', ['CSQU3054383']))).toBe(true);
  });
});

describe('gs1Fields', () => {
  it('splits (8006) into GTIN, piece and total', () => {
    expect(
      gs1Fields('itip', [
        ['8006', '040123451234560102'],
        ['21', '987'],
      ]),
    ).toEqual({ gtin: '04012345123456', piece: '01', total: '02', serial: '987' });
  });

  it('leaves out an SGLN extension of 0 or none', () => {
    expect(gs1Fields('sgln', [['414', '0614141123452']])).toEqual({ gln: '0614141123452' });
    expect(
      gs1Fields('sgln', [
        ['414', '0614141123452'],
        ['254', '0'],
      ]),
    ).toEqual({ gln: '0614141123452' });
  });

  it('adds the company prefix when given, and freezes', () => {
    const f = gs1Fields('sscc', [['00', '106141412345678908']], '0614141');
    expect(f).toEqual({ sscc: '106141412345678908', companyPrefix: '0614141' });
    expect(Object.isFrozen(f)).toBe(true);
  });
});
