import { describe, expect, it } from 'vitest';
import { ElementString, Gs1Error } from '../../src/index.ts';

describe('ElementString', () => {
  const es = ElementString.from([
    ['01', '09506000134352'],
    ['17', '201225'],
    ['10', 'ABC123'],
  ]);

  it('exposes values and typed accessors', () => {
    expect(es.get('01')).toBe('09506000134352');
    expect(es.gtin).toBe('09506000134352');
    expect(es.expiry).toBe('201225');
    expect(es.batch).toBe('ABC123');
    expect(es.serial).toBeUndefined();
    expect(es.has('17')).toBe(true);
    expect(es.size).toBe(3);
    expect(es.entries()).toEqual([
      ['01', '09506000134352'],
      ['17', '201225'],
      ['10', 'ABC123'],
    ]);
    expect(es.toObject()).toEqual({ '01': '09506000134352', '17': '201225', '10': 'ABC123' });
    expect(String(es)).toBe('(01)09506000134352(17)201225(10)ABC123');
  });

  it('exposes the remaining accessors', () => {
    const o = ElementString.from(
      [
        ['00', '106141411234567897'],
        ['414', '9501101020917'],
        ['21', 'S1'],
        ['15', '201225'],
      ],
      { validateAssociations: false },
    );
    expect(o.sscc).toBe('106141411234567897');
    expect(o.gln).toBe('9501101020917');
    expect(o.serial).toBe('S1');
    expect(o.bestBefore).toBe('201225');
  });

  it('has no public static besides from (no unchecked factory)', () => {
    const statics = Object.getOwnPropertyNames(ElementString).filter(
      (k) => !['length', 'name', 'prototype'].includes(k),
    );
    expect(statics).toEqual(['from']);
    expect(statics).not.toContain('_unchecked');
  });

  it('is frozen and entries() returns a copy', () => {
    expect(Object.isFrozen(es)).toBe(true);
    const copy = es.entries();
    copy.pop();
    expect(es.size).toBe(3);
  });

  it('keeps identical duplicates and exposes them via getAll', () => {
    const d = ElementString.from([
      ['01', '09506000134352'],
      ['10', 'A'],
      ['10', 'A'],
    ]);
    expect(d.getAll('10')).toEqual(['A', 'A']);
    expect(d.size).toBe(3);
    expect(d.toObject()).toEqual({ '01': '09506000134352', '10': 'A' });
  });

  it('validates on construction', () => {
    expect(() => ElementString.from({ '01': '09506000134353' })).toThrow(Gs1Error);
    expect(() => ElementString.from({ '10': 'ABC' })).toThrow(
      expect.objectContaining({ code: 'MISSING_REQUIRED_AI' }),
    );
    expect(() =>
      ElementString.from({ '10': 'ABC' }, { validateAssociations: false }),
    ).not.toThrow();
  });

  it('rejects empty input', () => {
    expect(() => ElementString.from({})).toThrow(expect.objectContaining({ code: 'EMPTY_INPUT' }));
  });

  it('rejects keys that are not AI-shaped, even with allowUnknownAIs', () => {
    for (const k of ['ab', '12345', '1']) {
      expect(() => ElementString.from({ [k]: 'x' }, { allowUnknownAIs: true })).toThrow(
        expect.objectContaining({ code: 'UNKNOWN_AI' }),
      );
    }
  });

  it('allows unknown but well-shaped AIs only when asked', () => {
    expect(() => ElementString.from({ '0599': 'x' })).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_AI' }),
    );
    expect(ElementString.from({ '0599': 'x' }, { allowUnknownAIs: true }).get('0599')).toBe('x');
  });

  it('equals compares entries in order', () => {
    expect(
      es.equals(
        ElementString.from([
          ['01', '09506000134352'],
          ['17', '201225'],
          ['10', 'ABC123'],
        ]),
      ),
    ).toBe(true);
    expect(
      es.equals(
        ElementString.from([
          ['01', '09506000134352'],
          ['10', 'ABC123'],
          ['17', '201225'],
        ]),
      ),
    ).toBe(false);
    expect(es.equals(ElementString.from([['01', '09506000134352']]))).toBe(false);
  });

  it('object input follows JavaScript key order (integer-like keys first)', () => {
    const o = ElementString.from({ '01': '09506000134352', '10': 'ABC' });
    expect(o.entries().map(([a]) => a)).toEqual(['10', '01']);
  });
});

describe('equivalent', () => {
  const a = ElementString.from([
    ['01', '09506000134352'],
    ['10', 'ABC'],
    ['17', '261231'],
  ]);

  it('ignores order', () => {
    const b = ElementString.from([
      ['17', '261231'],
      ['01', '09506000134352'],
      ['10', 'ABC'],
    ]);
    expect(a.equals(b)).toBe(false);
    expect(a.equivalent(b)).toBe(true);
  });

  it('compares values and multiplicity', () => {
    expect(
      a.equivalent(
        ElementString.from([
          ['01', '09506000134352'],
          ['10', 'ABD'],
          ['17', '261231'],
        ]),
      ),
    ).toBe(false);
    const once = ElementString.from([
      ['01', '09506000134352'],
      ['10', 'A'],
    ]);
    const twice = ElementString.from([
      ['01', '09506000134352'],
      ['10', 'A'],
      ['10', 'A'],
    ]);
    expect(once.equivalent(twice)).toBe(false);
    expect(twice.equivalent(once)).toBe(false);
  });

  it('compares multiplicity at the same size ([A, A, B] vs [A, B, B])', () => {
    const aab = ElementString.from([
      ['01', '09506000134352'],
      ['01', '09506000134352'],
      ['10', 'A'],
    ]);
    const abb = ElementString.from([
      ['01', '09506000134352'],
      ['10', 'A'],
      ['10', 'A'],
    ]);
    expect(aab.size).toBe(abb.size);
    expect(aab.equivalent(abb)).toBe(false);
    expect(abb.equivalent(aab)).toBe(false);
  });
});

describe('from(ElementString)', () => {
  it('re-validates the entries of another ElementString', () => {
    const a = ElementString.from({ '01': '09506000134352', '10': 'ABC' });
    const b = ElementString.from(a);
    expect(b.equals(a)).toBe(true);
  });

  it('applies the given options', () => {
    const a = ElementString.from([['89', 'X']], { allowUnknownAIs: true });
    expect(() => ElementString.from(a)).toThrow(expect.objectContaining({ code: 'UNKNOWN_AI' }));
    expect(ElementString.from(a, { allowUnknownAIs: true }).equals(a)).toBe(true);
  });
});
