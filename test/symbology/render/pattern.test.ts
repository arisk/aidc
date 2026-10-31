import { describe, expect, it } from 'vitest';
import { Gs1Error } from '../../../src/core/index.ts';
import { linearPattern } from '../../../src/symbology/render/index.ts';
import {
  dataTooLong,
  notRepresentable,
  readRows,
  symbolError,
} from '../../../src/symbology/render/internal.ts';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe('linearPattern', () => {
  it('builds one frozen symbol row', () => {
    const p = linearPattern([1, 1, 1]);
    expect(p.kind).toBe('linear');
    expect(p.symbology).toBeUndefined();
    expect(p.width).toBe(3);
    expect(p.rows).toEqual([{ role: 'symbol', x: 0, y: 0, height: 1, widths: [1, 1, 1] }]);
    expect(p.hri).toEqual([]);
    expect(p.quietZone).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.rows)).toBe(true);
    expect(Object.isFrozen(p.rows[0])).toBe(true);
    expect(Object.isFrozen(p.rows[0]?.widths)).toBe(true);
  });

  it('ignores a caller-supplied iterator', () => {
    expect(linearPattern(iterArray).rows[0]?.widths).toEqual([1]);
  });

  it('keeps a leading zero', () => {
    expect(linearPattern([0, 2, 1]).rows[0]?.widths).toEqual([0, 2, 1]);
  });

  const getterArray: unknown[] = [1];
  Object.defineProperty(getterArray, 0, {
    get(): number {
      throw new TypeError('boom');
    },
  });
  const iterArray: number[] = [1];
  Object.defineProperty(iterArray, Symbol.iterator, {
    value: function* (): Generator<number> {
      for (let i = 0; i < 20_000; i++) yield 1;
    },
  });
  const bad: [string, unknown][] = [
    ['throwing index getter', getterArray],
    ['empty', []],
    ['negative', [1, -1]],
    ['NaN', [1, Number.NaN]],
    ['Infinity', [Infinity]],
    ['string element', ['1']],
    ['null', null],
    ['too long', Array.from({ length: 10_001 }, () => 1)],
  ];
  for (const [name, input] of bad) {
    it(`rejects ${name}`, () => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately wrong type from plain JS
      const e = thrown(() => linearPattern(input as number[]));
      expect(e).toBeInstanceOf(Gs1Error);
      expect(e).toMatchObject({ code: 'INVALID_SYMBOL', details: { reason: 'pattern' } });
    });
  }
});

describe('readRows', () => {
  const throwing = {
    kind: 'linear',
    get rows(): unknown {
      throw new Error('boom');
    },
  };
  const iterRows: unknown[] = [{ widths: [1] }];
  Object.defineProperty(iterRows, Symbol.iterator, {
    value: function* (): Generator {
      while (true) yield { widths: [1] };
    },
  });
  const rowGetter: unknown[] = [1];
  Object.defineProperty(rowGetter, 0, {
    get(): unknown {
      throw new TypeError('boom');
    },
  });
  const invalid: [string, unknown][] = [
    ['empty object', {}],
    ['no rows', { kind: 'linear' }],
    ['bad widths', { kind: 'linear', rows: [{ widths: 'x' }] }],
    ['null row', { kind: 'linear', rows: [null] }],
    ['null symbol', null],
    ['throwing getter', throwing],
    [
      'too many rows',
      { kind: 'linear', rows: Array.from({ length: 10_001 }, () => ({ widths: [1] })) },
    ],
    ['throwing row getter', { kind: 'linear', rows: rowGetter }],
  ];
  for (const [name, input] of invalid) {
    it(`fails on ${name}`, () => {
      const r = readRows(input, ['symbol']);
      expect(r.ok).toBe(false);
      expect(r.ok ? undefined : r.errors[0]?.code).toBe('INVALID_SYMBOL');
    });
  }

  it('ignores a caller-supplied iterator on rows', () => {
    expect(readRows({ kind: 'linear', rows: iterRows }, ['symbol'])).toEqual({
      ok: true,
      value: [[1]],
    });
  });

  it('returns only the requested roles', () => {
    const p = {
      kind: 'linear',
      rows: [
        { role: 'symbol', widths: [1, 2] },
        { role: 'add-on', widths: [3] },
        { widths: [4, 5] },
      ],
    };
    const r = readRows(p, ['symbol']);
    expect(r).toEqual({
      ok: true,
      value: [
        [1, 2],
        [4, 5],
      ],
    });
    expect(readRows(p, ['add-on'])).toEqual({ ok: true, value: [[3]] });
  });
});

describe('error helpers', () => {
  it('symbolError', () => {
    const e = symbolError('guard', 'bad guard', 3);
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details).toEqual({ reason: 'guard', element: 3 });
    expect(e.position).toBeUndefined();
    expect(symbolError('length', 'x').details).toEqual({ reason: 'length' });
  });
  it('notRepresentable', () => {
    const e = notRepresentable('ean-13', 'why');
    expect(e.code).toBe('NOT_REPRESENTABLE');
    expect(e.details).toEqual({ symbology: 'ean-13' });
  });
  it('dataTooLong', () => {
    const e = dataTooLong(48, 60);
    expect(e.code).toBe('DATA_TOO_LONG');
    expect(e.details).toEqual({ limit: 48, actual: 60 });
  });
});
