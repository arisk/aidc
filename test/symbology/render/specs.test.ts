import { describe, expect, it } from 'vitest';
import { SYMBOL_SPECS } from '../../../src/symbology/render/index.ts';
import type { SymbologyName } from '../../../src/symbology/render/index.ts';

const NAMES: readonly SymbologyName[] = ['ean-13', 'upc-a', 'ean-8', 'upc-e', 'itf-14', 'gs1-128'];
const NAMES_2D: readonly SymbologyName[] = ['gs1-datamatrix', 'datamatrix'];

describe('SYMBOL_SPECS', () => {
  it('pins the EAN-13 retail entry', () => {
    const first = SYMBOL_SPECS['ean-13'][0];
    expect(first).toMatchObject({
      xMin: 0.264,
      xTarget: 0.33,
      xMax: 0.66,
      minHeight: 22.85,
      quietZone: { left: 11, right: 7 },
    });
    expect(typeof first?.source).toBe('string');
  });

  it.each(NAMES)('%s has frozen entries', (name) => {
    const list = SYMBOL_SPECS[name];
    expect(list.length).toBeGreaterThan(0);
    expect(Object.isFrozen(list)).toBe(true);
    for (const e of list) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.quietZone)).toBe(true);
      expect(e.xMin).toBeLessThanOrEqual(e.xTarget);
      expect(e.xTarget).toBeLessThanOrEqual(e.xMax);
    }
  });

  it('is frozen and GS1-128 has the length limit', () => {
    expect(Object.isFrozen(SYMBOL_SPECS)).toBe(true);
    for (const e of SYMBOL_SPECS['gs1-128']) expect(e.maxLength).toBe(165.1);
    expect(SYMBOL_SPECS['itf-14'][0]?.quietZone).toEqual({ left: 10, right: 10 });
    expect(SYMBOL_SPECS['ean-8'][0]?.minHeight).toBe(18.23);
  });

  it.each(NAMES_2D)('%s has the GenSpecs 2D rows', (name) => {
    const list = SYMBOL_SPECS[name];
    expect(list).toHaveLength(2);
    expect(Object.isFrozen(list)).toBe(true);
    expect(list[0]).toMatchObject({
      xMin: 0.396,
      xTarget: 0.495,
      xMax: 0.99,
      quietZone: { left: 1, right: 1 },
    });
    expect(list[1]).toMatchObject({
      xMin: 0.743,
      xTarget: 0.743,
      xMax: 1.5,
      quietZone: { left: 1, right: 1 },
    });
    expect(list[0]?.source).toContain('Table 5-46');
    expect(list[1]?.source).toContain('Table 5-47');
    for (const e of list) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.quietZone)).toBe(true);
      expect('minHeight' in e).toBe(false);
    }
  });

  it('gs1-qr has the GenSpecs rows (table 1 addendum 1 and table 2)', () => {
    const list = SYMBOL_SPECS['gs1-qr'];
    expect(list).toHaveLength(2);
    expect(Object.isFrozen(list)).toBe(true);
    expect(list[0]).toMatchObject({
      xMin: 0.396,
      xTarget: 0.495,
      xMax: 0.743,
      quietZone: { left: 4, right: 4 },
    });
    expect(list[1]).toMatchObject({
      xMin: 0.743,
      xTarget: 0.743,
      xMax: 1.5,
      quietZone: { left: 4, right: 4 },
    });
    expect(list[0]?.source).toContain('Table 5-45');
    expect(list[1]?.source).toContain('Table 5-47');
  });

  it('qr has the GenSpecs rows (table 1 addendum 2 and table 3 addendum 1)', () => {
    const list = SYMBOL_SPECS.qr;
    expect(list).toHaveLength(2);
    expect(Object.isFrozen(list)).toBe(true);
    expect(list[0]).toMatchObject({
      xMin: 0.396,
      xTarget: 0.495,
      xMax: 0.99,
      quietZone: { left: 4, right: 4 },
    });
    expect(list[1]).toMatchObject({
      xMin: 0.743,
      xTarget: 0.99,
      xMax: 0.99,
      quietZone: { left: 4, right: 4 },
    });
    expect(list[0]?.source).toContain('Table 5-46');
    expect(list[1]?.source).toContain('Table 5-49');
  });

  it.each(['gs1-qr', 'qr'] as const)('%s rows are frozen 2D rows', (name) => {
    for (const e of SYMBOL_SPECS[name]) {
      expect(Object.isFrozen(e)).toBe(true);
      expect(Object.isFrozen(e.quietZone)).toBe(true);
      expect('minHeight' in e).toBe(false);
      expect(e.xMin).toBeLessThanOrEqual(e.xTarget);
      expect(e.xTarget).toBeLessThanOrEqual(e.xMax);
    }
  });
});
