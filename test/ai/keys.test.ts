import { describe, expect, it } from 'vitest';
import { identifyKey } from '../../src/index.ts';

describe('identifyKey', () => {
  it('GTIN-8, -12, -13 and -14 normalise to 14 digits', () => {
    expect(identifyKey('96385074')[0]).toMatchObject({
      key: 'gtin',
      ai: '01',
      value: '00000096385074',
    });
    expect(identifyKey('614141000036')[0]).toMatchObject({ key: 'gtin', value: '00614141000036' });
    expect(identifyKey('09506000134352')[0]).toMatchObject({
      key: 'gtin',
      value: '09506000134352',
    });
  });

  it('13 digits: GTIN-13 ranked above GLN', () => {
    expect(identifyKey('9506000134352').map((c) => c.key)).toEqual(['gtin', 'gln']);
  });

  it('18 digits: SSCC ranked above GSRN', () => {
    expect(identifyKey('006141411234567890').map((c) => c.key)).toEqual([
      'sscc',
      'gsrn-provider',
      'gsrn-recipient',
    ]);
  });

  it('17 digits: GSIN', () => {
    expect(identifyKey('06141411234567890')[0]).toMatchObject({ key: 'gsin', ai: '402' });
  });

  it('rejects bad check digits, non-digits and other lengths', () => {
    expect(identifyKey('9506000134353')).toEqual([]);
    expect(identifyKey('95060001343A2')).toEqual([]);
    expect(identifyKey('123')).toEqual([]);
    expect(identifyKey('')).toEqual([]);
  });

  it('strips surrounding whitespace', () => {
    expect(identifyKey(' 09506000134352 ')[0]?.value).toBe('09506000134352');
  });
});
