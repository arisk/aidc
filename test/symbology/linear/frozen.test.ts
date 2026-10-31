import { describe, expect, it } from 'vitest';
import { ean13, gs1128, itf14 } from '../../../src/symbology/linear/index.ts';

describe('decode results are frozen', () => {
  it('ean13', () => {
    const d = ean13.decode(ean13.encode('4006381333931'));
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.metadata)).toBe(true);
  });
  it('ean13 with an add-on', () => {
    const d = ean13.decode(ean13.encode('4006381333931', { addOn: '12' }));
    expect(Object.isFrozen(d)).toBe(true);
    expect(d.addOn).toBe('12');
  });
  it('itf14', () => {
    const d = itf14.decode(itf14.encode('15400141288763'));
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.metadata)).toBe(true);
  });
  it('gs1128', () => {
    const d = gs1128.decode(gs1128.encode('(10)123(21)12345678'));
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.metadata)).toBe(true);
    expect(Object.isFrozen(d.metadata.symbolValues)).toBe(true);
  });
});
