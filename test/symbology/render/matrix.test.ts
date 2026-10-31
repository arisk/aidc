/* oxlint-disable typescript/no-unsafe-type-assertion -- deliberately hostile inputs */
import { describe, expect, it } from 'vitest';
import { Gs1Error } from '../../../src/core/index.ts';
import { ElementString, parse } from '../../../src/ai/index.ts';
import { matrixFromRows, moduleAt } from '../../../src/symbology/render/index.ts';
import {
  freezeDecoded,
  freezeMatrix,
  readMatrix,
  rsUncorrectable,
} from '../../../src/symbology/render/internal.ts';
import type { ModuleMatrix } from '../../../src/symbology/render/index.ts';

function hostile(v: unknown): never {
  return v as never;
}
function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof Gs1Error ? e.code : `non-Gs1Error: ${String(e)}`;
  }
  return undefined;
}
function reasonOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e instanceof Gs1Error ? e.details?.['reason'] : undefined;
  }
  return undefined;
}

const throwingRows: unknown = {
  kind: 'matrix',
  get rows(): never {
    throw new Error('boom');
  },
};
const proxyRows = new Proxy([], {
  get(): never {
    throw new Error('proxy');
  },
  has(): never {
    throw new Error('proxy');
  },
});

const BAD_ROWS: readonly (readonly [string, unknown])[] = [
  ['ragged', ['101', '01']],
  ['digit 2', ['102']],
  ['empty list', []],
  ['1025 rows', Array.from({ length: 1025 }, () => '1')],
  ['1025 columns', ['1'.repeat(1025)]],
  ['empty row', ['']],
  ['non-array', 'abc'],
  ['null', null],
  ['number cell', [[0, 2]]],
  ['mixed junk', [{}]],
  ['proxy', proxyRows],
];

describe('matrixFromRows', () => {
  it('builds a frozen matrix from strings', () => {
    const m = matrixFromRows(['101', '010']);
    expect(m.kind).toBe('matrix');
    expect(m.width).toBe(3);
    expect(m.height).toBe(2);
    expect(m.rows).toEqual(['101', '010']);
    expect(m.symbology).toBeUndefined();
    expect(m.hri).toEqual([]);
    expect(m.quietZone).toEqual({ left: 0, right: 0, top: 0, bottom: 0 });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.rows)).toBe(true);
    expect(Object.isFrozen(m.hri)).toBe(true);
    expect(Object.isFrozen(m.quietZone)).toBe(true);
  });
  it('accepts arrays of 0, 1 and booleans', () => {
    const want = matrixFromRows(['101', '010']);
    expect(
      matrixFromRows([
        [1, 0, 1],
        [0, 1, 0],
      ]),
    ).toEqual(want);
    expect(
      matrixFromRows([
        [true, false, true],
        [false, true, false],
      ]),
    ).toEqual(want);
  });
  it('accepts the 1024 x 1024 limit', () => {
    const m = matrixFromRows(Array.from({ length: 1024 }, () => '1'.repeat(1024)));
    expect(m.width).toBe(1024);
    expect(m.height).toBe(1024);
  });
  it.each(BAD_ROWS)('rejects %s with INVALID_SYMBOL pattern', (_name, input) => {
    expect(codeOf(() => matrixFromRows(hostile(input)))).toBe('INVALID_SYMBOL');
    expect(reasonOf(() => matrixFromRows(hostile(input)))).toBe('pattern');
  });
  it('rejects a throwing getter', () => {
    const rows = [] as string[];
    Object.defineProperty(rows, 0, {
      get(): never {
        throw new Error('boom');
      },
    });
    expect(codeOf(() => matrixFromRows(rows))).toBe('INVALID_SYMBOL');
  });
});

describe('moduleAt', () => {
  const m = matrixFromRows(['10', '01']);
  it('reads modules', () => {
    expect(moduleAt(m, 0, 0)).toBe(true);
    expect(moduleAt(m, 1, 0)).toBe(false);
    expect(moduleAt(m, 0, 1)).toBe(false);
    expect(moduleAt(m, 1, 1)).toBe(true);
  });
  it.each([
    [-1, 0],
    [2, 0],
    [0, 2],
    [0, -1],
    [0.5, 0],
    [Number.NaN, 0],
  ])('out of range (%s, %s) is INVALID_VALUE', (x, y) => {
    expect(codeOf(() => moduleAt(m, x, y))).toBe('INVALID_VALUE');
  });
  it('a non-matrix is INVALID_SYMBOL, never another error', () => {
    expect(codeOf(() => moduleAt(hostile(null), 0, 0))).toBe('INVALID_SYMBOL');
    expect(codeOf(() => moduleAt(hostile(throwingRows), 0, 0))).toBe('INVALID_SYMBOL');
    expect(codeOf(() => moduleAt(hostile({ kind: 'matrix', rows: [5] }), 0, 0))).toBe(
      'INVALID_SYMBOL',
    );
  });
});

describe('readMatrix', () => {
  it('returns row-major bits', () => {
    const r = readMatrix(matrixFromRows(['101', '010']));
    const v = r.ok ? r.value : undefined;
    expect(v === undefined ? undefined : [v.width, v.height, [...v.bits]]).toEqual([
      3,
      2,
      [1, 0, 1, 0, 1, 0],
    ]);
  });
  it('reads a literal object and ignores width and height', () => {
    const r = readMatrix({ kind: 'matrix', rows: ['11'], width: 99 });
    expect(r.ok && r.value.width).toBe(2);
  });
  const hostileInputs: readonly (readonly [string, unknown])[] = [
    ['undefined', undefined],
    ['null', null],
    ['number', 5],
    ['string', '101'],
    ['wrong kind', { kind: 'linear', rows: ['1'] }],
    ['no rows', { kind: 'matrix' }],
    ['throwing getter', throwingRows],
    [
      'throwing kind',
      {
        get kind(): never {
          throw new Error('boom');
        },
      },
    ],
    ['proxy rows', { kind: 'matrix', rows: proxyRows }],
    ['ragged', { kind: 'matrix', rows: ['10', '1'] }],
    ['digit 2', { kind: 'matrix', rows: ['12'] }],
    ['non-string row', { kind: 'matrix', rows: [[1, 0]] }],
    ['empty', { kind: 'matrix', rows: [] }],
    ['empty row', { kind: 'matrix', rows: [''] }],
    ['1025 rows', { kind: 'matrix', rows: Array.from({ length: 1025 }, () => '1') }],
    ['1025 columns', { kind: 'matrix', rows: ['1'.repeat(1025)] }],
    ['sparse', { kind: 'matrix', rows: Array.from<string>({ length: 3 }) }],
    ['huge length', { kind: 'matrix', rows: { length: 1e9 } }],
  ];
  it.each(hostileInputs)('%s gives ok false and does not throw', (_n, input) => {
    const r = readMatrix(input);
    expect(r.ok ? 'ok' : r.errors[0]?.code).toBe('INVALID_SYMBOL');
  });
});

describe('freezeMatrix', () => {
  it('deep-freezes a matrix', () => {
    const m: ModuleMatrix = freezeMatrix({
      kind: 'matrix',
      symbology: 'datamatrix',
      width: 1,
      height: 1,
      rows: ['1'],
      quietZone: { left: 1, right: 1, top: 1, bottom: 1 },
      hri: [{ text: 'a', x: 0, y: 2, size: 1, anchor: 'start', role: 'hri' }],
    });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m.rows)).toBe(true);
    expect(Object.isFrozen(m.quietZone)).toBe(true);
    expect(Object.isFrozen(m.hri)).toBe(true);
    expect(Object.isFrozen(m.hri[0])).toBe(true);
  });
});

class Plain {
  value = 1;
}

describe('freezeDecoded', () => {
  it('freezes plain objects and arrays but leaves class instances alone', () => {
    const es = parse('(01)09506000134352');
    const d = freezeDecoded({
      elementString: es,
      instance: new Plain(),
      metadata: { list: [1, 2, { a: 1 }], bytes: new Uint8Array(2) },
    });
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.metadata)).toBe(true);
    expect(Object.isFrozen(d.metadata.list)).toBe(true);
    expect(Object.isFrozen(d.metadata.list[2])).toBe(true);
    expect(d.elementString).toBeInstanceOf(ElementString);
    expect(Object.isFrozen(d.instance)).toBe(false);
    expect(Object.isFrozen(d.metadata.bytes)).toBe(false);
  });
  it('handles shared and cyclic references', () => {
    const a: { self?: unknown; list: number[] } = { list: [1] };
    a.self = a;
    expect(Object.isFrozen(freezeDecoded(a))).toBe(true);
  });
  it('passes primitives through', () => {
    expect(freezeDecoded(3)).toBe(3);
  });
});

describe('rsUncorrectable', () => {
  it('builds the error', () => {
    const e = rsUncorrectable({ block: 1, blocks: 2, ecCodewords: 10, capacity: 5 });
    expect(e.code).toBe('RS_UNCORRECTABLE');
    expect(e.details).toEqual({ block: 1, blocks: 2, ecCodewords: 10, capacity: 5 });
  });
});
