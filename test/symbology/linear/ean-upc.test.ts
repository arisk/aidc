/* oxlint-disable typescript/no-unsafe-type-assertion -- deliberately hostile inputs */
import { describe, expect, it } from 'vitest';
import { Gs1Error } from '../../../src/core/index.ts';
import {
  ean13,
  ean8,
  eanUpc,
  upcA,
  upcE,
  upceCompress,
  upceExpand,
} from '../../../src/symbology/linear/ean-upc.ts';
import type { LinearPattern } from '../../../src/symbology/render/index.ts';

describe('ean-upc entry', () => {
  it('names', () => {
    expect([ean13.name, upcA.name, ean8.name, upcE.name, eanUpc.name]).toEqual([
      'ean-13',
      'upc-a',
      'ean-8',
      'upc-e',
      'ean-13',
    ]);
  });
  it('round trips through each symbology', () => {
    expect(ean13.decode(ean13.encode('4006381333931')).elementString.gtin).toBe('04006381333931');
    expect(upcA.decode(upcA.encode('036000291452')).symbology).toBe('upc-a');
    expect(ean8.decode(ean8.encode('96385074')).rawData).toBe('96385074');
    expect(upcE.decode(upcE.encode('042100005264')).symbology).toBe('upc-e');
    expect(upcE.tryDecode(upcE.encode('042100005264')).ok).toBe(true);
    expect(ean13.tryEncode('4006381333931').ok).toBe(true);
  });
  it('decoders enforce their symbology', () => {
    expect(ean8.tryDecode(ean13.encode('4006381333931')).ok).toBe(false);
    expect(upcE.tryDecode(ean8.encode('96385074')).ok).toBe(false);
    expect(ean13.tryDecode(ean8.encode('96385074')).ok).toBe(false);
    expect(upcA.tryDecode(upcE.encode('042100005264')).ok).toBe(false);
    expect(eanUpc.decode(ean8.encode('96385074')).symbology).toBe('ean-8');
    expect(eanUpc.decode(upcE.encode('042100005264')).symbology).toBe('upc-e');
  });
  it('form auto picks per G9', () => {
    expect(eanUpc.encode('96385074').symbology).toBe('ean-8');
    expect(eanUpc.encode('036000291452').symbology).toBe('upc-a');
    expect(eanUpc.encode('4006381333931').symbology).toBe('ean-13');
    expect(eanUpc.encode('4006381333931', { form: 'auto' }).symbology).toBe('ean-13');
    expect(eanUpc.encode('042100005264', { form: 'upc-e' }).symbology).toBe('upc-e');
    expect(eanUpc.encode('036000291452', { form: 'ean-13' }).symbology).toBe('ean-13');
    expect(eanUpc.encode('4006381333931', { form: 'ean-13', addOn: '12' }).rows).toHaveLength(3);
  });
  it('form errors', () => {
    const bad = eanUpc.tryEncode('4006381333931', { form: 'nope' as never });
    expect(bad.ok).toBe(false);
    expect(eanUpc.tryEncode('4006381333931', { form: 'ean-8' }).ok).toBe(false);
    expect(eanUpc.tryEncode('4006381333930').ok).toBe(false);
    expect(eanUpc.tryEncode('4006381333931', 3 as never).ok).toBe(false);
    expect(() => eanUpc.encode('4006381333930')).toThrow(Gs1Error);
    expect(() => eanUpc.decode({} as LinearPattern)).toThrow(Gs1Error);
  });
  it('re-exports the UPC-E helpers', () => {
    expect(upceCompress('042100005264')).toBe('425261');
    expect(upceExpand('425261')).toBe('042100005264');
  });
  it('is frozen', () => {
    expect(Object.isFrozen(eanUpc)).toBe(true);
    expect(Object.isFrozen(ean13)).toBe(true);
  });
});
