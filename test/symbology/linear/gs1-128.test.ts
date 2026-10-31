/* oxlint-disable typescript/no-unsafe-type-assertion -- JSON vector files and deliberately hostile inputs */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import vectorsFile from '../../vectors/gs1-128.json' with { type: 'json' };
import type { Result } from '../../../src/core/index.ts';
import { Gs1Error } from '../../../src/core/index.ts';
import { format, parse, tryParse } from '../../../src/ai/index.ts';
import { fromScan, toScan } from '../../../src/scan/index.ts';
import {
  C128_LOOKUP,
  C128_STOP,
  C128_WIDTHS,
} from '../../../src/symbology/linear/code128-tables.ts';
import { encodeTokens, hriLines } from '../../../src/symbology/linear/gs1-128-encode.ts';
import { gs1128 } from '../../../src/symbology/linear/gs1-128.ts';
import { linearPattern } from '../../../src/symbology/render/index.ts';
import type { LinearPattern } from '../../../src/symbology/render/index.ts';
import { type Message, messageArb } from '../../support/arbitraries.ts';

interface Vec {
  id: string;
  kind: string;
  elementString?: string;
  transmitted?: string;
  widths?: string;
  symbolValues?: number[];
  value?: number;
  data?: string;
  dpSymbolValues?: number[];
  dpWidths?: string;
  dpDataSymbolCharacters?: number;
  engineDataSymbolCharacters?: number;
  linkage?: { value: number };
  derived?: { plainSymbolValues: number[]; plainWidths: string } | string;
  expect?: { transmitted?: string; reversed?: boolean; linkage?: string; error?: string };
}
const vectors = vectorsFile.vectors as Vec[];
const table = vectorsFile.table;

const GS = '\u001d';
/** One symbol may hold part of a label's data: no association rules (as the codec). */
const LOOSE = { validateAssociations: false } as const;
const digits = (s: string): number[] => s.split('').map(Number);
const row = (p: LinearPattern): readonly number[] => p.rows[0]?.widths ?? [];
const backwards = (a: readonly number[]): number[] => a.map((_, i) => a[a.length - 1 - i] ?? 0);
const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
function errsOf(r: Result<unknown>): readonly Gs1Error[] {
  if (r.ok) throw new Error('expected failure');
  return r.errors;
}
function errOf(p: unknown): Gs1Error {
  const e = errsOf(gs1128.tryDecode(p as LinearPattern))[0];
  if (e === undefined) throw new Error('no error');
  return e;
}
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}
/** The widths of symbol values (start .. check) plus the stop. */
function widthsOf(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) out.push(...digits(table.values[v] ?? table.stop.slice(0, 6)));
  out.push(...digits(table.stop));
  return out;
}
function check(values: readonly number[]): number {
  let s = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) s += i * (values[i] ?? 0);
  return s % 103;
}
/** A symbol from start + data values with a correct check character. */
function symbol(values: readonly number[]): LinearPattern {
  return linearPattern(widthsOf([...values, check(values)]));
}

describe('code 128 table', () => {
  it('equals the vector table', () => {
    // 106 characters plus the stop: 107 entries; C128_WIDTHS[106] is the stop's first six
    const entries = [...table.values, table.stop.slice(0, 6)];
    expect(entries).toHaveLength(107);
    expect(C128_WIDTHS).toHaveLength(642);
    for (let v = 0; v < 107; v++) {
      const w = Array.from(C128_WIDTHS.subarray(6 * v, 6 * v + 6));
      expect(w.join('')).toBe(entries[v]);
    }
    for (let v = 0; v < 106; v++) {
      const w = Array.from(C128_WIDTHS.subarray(6 * v, 6 * v + 6));
      expect(sum(w)).toBe(11);
      expect(((w[0] ?? 0) + (w[2] ?? 0) + (w[4] ?? 0)) % 2).toBe(0);
    }
    expect(C128_STOP.join('')).toBe(table.stop);
    expect(sum(C128_STOP)).toBe(13);
  });
  it('lookup inverts the table', () => {
    let known = 0;
    for (const v of C128_LOOKUP) if (v >= 0) known++;
    expect(known).toBe(107);
    for (let v = 0; v < 107; v++) {
      let key = 0;
      for (let k = 0; k < 6; k++) key = key * 4 + ((C128_WIDTHS[6 * v + k] ?? 1) - 1);
      expect(C128_LOOKUP[key]).toBe(v);
    }
  });
  it('character vectors', () => {
    for (const v of vectors.filter((x) => x.kind === 'character')) {
      const w =
        v.value === 106
          ? [...C128_STOP]
          : Array.from(C128_WIDTHS.subarray(6 * (v.value ?? 0), 6 * (v.value ?? 0) + 6));
      expect(w.join('')).toBe(v.widths);
    }
  });
});

describe('gs1128 encodation vectors', () => {
  const encs = vectors.filter((x) => x.kind === 'encodation');
  /** Vectors whose `data` is an element string that formats to the transmitted data. */
  const viaApi = encs.filter((v) => {
    const es = tryParse((v.data ?? '').split(' ')[0] ?? '', LOOSE);
    return es.ok && format(es.value, 'raw') === (v.transmitted ?? '').slice(3);
  });
  for (const v of encs) {
    it('vector ' + v.id, () => {
      const values = encodeTokens((v.transmitted ?? '').slice(3));
      expect([...values, 106]).toEqual(v.dpSymbolValues);
      expect(widthsOf(values).join('')).toBe(v.dpWidths);
      expect(values.length - 3).toBe(v.dpDataSymbolCharacters);
      expect(v.dpDataSymbolCharacters).toBeLessThanOrEqual(v.engineDataSymbolCharacters ?? 0);
    });
  }
  for (const v of viaApi) {
    it('encode ' + v.id, () => {
      const p = gs1128.encode((v.data ?? '').split(' ')[0] ?? '');
      expect(row(p).join('')).toBe(v.dpWidths);
    });
  }
  it('the valid element string vectors go through the public encoder', () => {
    // the others are raw data, a redundant separator, an invalid pair and a duplicate AI
    expect(new Set(viaApi.map((v) => v.data))).toEqual(
      new Set([
        '(10)123(21)12345678',
        '(10)12345(21)12345678',
        '(01)09506000134352(17)201225(10)ABC123',
        '(10)abc123def',
      ]),
    );
  });
  it('GenSpecs Table 5-27', () => {
    const p = gs1128.encode('(10)2503X');
    const d = gs1128.decode(p);
    expect(d.metadata.symbolValues).toEqual([105, 102, 10, 25, 3, 100, 56, 17]);
    expect(row(p).slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]);
    const v = vectors.find((x) => x.id === 'genspecs:table-5-27');
    expect(row(p).join('')).toBe(v?.widths);
  });
  it('(10)123(21)12345678 needs 10 data symbol characters', () => {
    const d = gs1128.decode(gs1128.encode('(10)123(21)12345678'));
    expect(d.metadata.symbolValues).toEqual([104, 102, 17, 99, 1, 23, 102, 21, 12, 34, 56, 78, 42]);
    expect(d.metadata.symbolValues.length - 3).toBe(10);
  });
});

describe('gs1128 pattern vectors', () => {
  const pats = vectors.filter((x) => x.kind === 'pattern');
  const linked = pats.filter((x) => x.linkage !== undefined);
  const plain = pats.filter((x) => x.linkage === undefined);
  for (const v of plain) {
    it('plain ' + v.id, () => {
      const d = gs1128.decode(linearPattern(digits(v.widths ?? '')));
      expect(d.aimId + d.rawData).toBe(v.transmitted);
      expect([...d.metadata.symbolValues, 106]).toEqual(v.symbolValues);
      expect(d.metadata.linkage).toBeUndefined();
      expect(row(gs1128.encode(v.elementString ?? '')).join('')).toBe(v.widths);
    });
  }
  for (const v of linked) {
    it('engine composite row ' + v.id, () => {
      const d = gs1128.decode(linearPattern(digits(v.widths ?? '')));
      expect(d.aimId + d.rawData).toBe(v.transmitted);
      expect(d.metadata.linkage).toBe(v.linkage?.value === 101 ? 'cc-a-b' : 'cc-c');
      const derived = typeof v.derived === 'object' ? v.derived : undefined;
      const p = gs1128.encode(v.elementString ?? '');
      expect(row(p).join('')).toBe(derived?.plainWidths);
      expect([...gs1128.decode(p).metadata.symbolValues, 106]).toEqual(derived?.plainSymbolValues);
    });
  }
  it('has both linkage kinds', () => {
    expect(new Set(linked.map((v) => v.linkage?.value))).toEqual(new Set([100, 101]));
  });
});

describe('gs1128 decode vectors', () => {
  const decs = vectors.filter((x) => x.kind === 'decode');
  const good = decs.filter((x) => x.expect?.error === undefined);
  const bad = decs.filter((x) => x.expect?.error !== undefined);
  for (const v of good) {
    it('decodes ' + v.id, () => {
      const d = gs1128.decode(linearPattern(digits(v.widths ?? '')));
      expect(d.aimId + d.rawData).toBe(v.expect?.transmitted);
      expect(d.metadata.reversed).toBe(v.expect?.reversed === true);
      expect(d.metadata.linkage).toBe(v.expect?.linkage);
      expect(fromScan(d.aimId + d.rawData, LOOSE).elementString.equals(d.elementString)).toBe(true);
    });
  }
  const expected: Record<string, Record<string, unknown>> = {
    'derived:code128-no-fnc1': {
      code: 'UNSUPPORTED',
      details: { reason: 'not-gs1', aimId: ']C0', text: 'ABC' },
    },
    'derived:bad-check': { code: 'INVALID_SYMBOL', details: { reason: 'check-character' } },
    'derived:FNC2': { code: 'UNSUPPORTED', details: { reason: 'fnc2' } },
    'derived:FNC3': { code: 'UNSUPPORTED', details: { reason: 'fnc3' } },
    'derived:FNC4': { code: 'UNSUPPORTED', details: { reason: 'fnc4' } },
  };
  for (const v of bad) {
    it('rejects ' + v.id, () => {
      expect(errOf(linearPattern(digits(v.widths ?? '')))).toMatchObject(expected[v.id] ?? {});
    });
  }
  it('covers every error vector', () => {
    expect(new Set(bad.map((v) => v.id))).toEqual(new Set(Object.keys(expected)));
  });
  it('specific cases', () => {
    const ids = good.map((v) => v.id);
    for (const id of [
      'derived:reverse-5-27',
      'derived:gs-in-code-a',
      'derived:trailing-fnc1',
      'derived:shift',
      'derived:linkage-from-A',
    ])
      expect(ids).toContain(id);
  });
});

describe('gs1128 length boundary (Review Focus 4)', () => {
  const at48 = '(01)09506000134352(10)ABCDEFGHIJKLMNOPQRST(21)ABCDEFG';
  const at49 = '(01)09506000134352(10)ABCDEFGHIJKLMNOPQRST(21)ABCDEFGH';
  const reordered = '(21)ABCDEFG(10)ABCDEFGHIJKLMNOPQRST(01)09506000134352';
  it('48 raw characters encode', () => {
    expect(format(parse(at48), 'raw')).toHaveLength(48);
    const d = gs1128.decode(gs1128.encode(at48));
    expect(d.rawData).toHaveLength(48);
    expect(d.metadata.dataCharacters).toBe(48);
    expect(d.metadata.overLength).toBeUndefined();
  });
  it('49 raw characters are DATA_TOO_LONG', () => {
    expect(format(parse(at49), 'raw')).toHaveLength(49);
    const e = errsOf(gs1128.tryEncode(at49))[0];
    expect(e?.code).toBe('DATA_TOO_LONG');
    expect(e?.details).toEqual({ limit: 48, actual: 49 });
  });
  it('optimizeOrder makes a 49 character string fit', () => {
    expect(format(parse(reordered), 'raw')).toHaveLength(49);
    expect(format(parse(reordered), 'raw', { optimizeOrder: true })).toHaveLength(48);
    expect(errsOf(gs1128.tryEncode(reordered))[0]?.details).toEqual({ limit: 48, actual: 49 });
    const p = gs1128.encode(reordered, { optimizeOrder: true });
    const d = gs1128.decode(p);
    expect(d.rawData.startsWith('0109506000134352')).toBe(true);
    expect(d.rawData).toHaveLength(48);
    expect(p.hri.map((h) => h.text).join('')).toBe(
      '(01)09506000134352(21)ABCDEFG(10)ABCDEFGHIJKLMNOPQRST',
    );
  });
  it('decode flags an over-length symbol', () => {
    const values = encodeTokens(format(parse(at49), 'raw'));
    const d = gs1128.decode(linearPattern(widthsOf(values)));
    expect(d.rawData).toHaveLength(49);
    expect(d.metadata.overLength).toBe(true);
    expect(d.metadata.dataCharacters).toBe(49);
  });
});

const toBracketed = (m: Message): string =>
  m.map(([a, v]) => `(${a})${v.replaceAll('(', '\\(')}`).join('');
const fits = messageArb
  .map(toBracketed)
  .filter((s) => {
    const r = tryParse(s);
    return r.ok && format(r.value, 'raw').length <= 48;
  })
  .map((s) => parse(s));

/** Data symbol characters of a simple greedy: B, with C for even digit runs of 4 or more. */
function greedy(raw: string): number {
  const isDigit = (i: number): boolean => raw.charCodeAt(i) >= 48 && raw.charCodeAt(i) <= 57;
  let n = 0;
  let set: 'B' | 'C' | undefined;
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === GS) {
      n++;
      i++;
      set ??= 'B';
      continue;
    }
    let r = 0;
    while (isDigit(i + r)) r++;
    if (r >= 4 && r % 2 === 0) {
      if (set === 'B') n++;
      set = 'C';
      n += r / 2;
      i += r;
      continue;
    }
    if (set === 'C') n++;
    set = 'B';
    n++;
    i++;
  }
  return n;
}

describe('gs1128 properties', () => {
  it('round trips, reversed and padded, agrees with fromScan, beats greedy', () => {
    fc.assert(
      fc.property(fits, fc.boolean(), fc.integer({ min: 0, max: 12 }), (es, opt, pad) => {
        const p = gs1128.encode(es, { optimizeOrder: opt });
        const raw = format(es, 'raw', { optimizeOrder: opt });
        const d = gs1128.decode(p);
        expect(d.symbology).toBe('gs1-128');
        expect(d.aimId).toBe(']C1');
        expect(d.rawData).toBe(raw);
        expect(d.errorsCorrected).toBe(0);
        expect(d.metadata.reversed).toBe(false);
        expect(d.metadata.dataCharacters).toBe(raw.length);
        expect(fromScan(d.aimId + d.rawData).elementString.equals(d.elementString)).toBe(true);
        const plain = gs1128.decode(gs1128.encode(es));
        expect(plain.elementString.equals(es)).toBe(true);
        expect(plain.aimId + plain.rawData).toBe(toScan(es, 'gs1-128'));
        const w = row(p);
        expect(w).toHaveLength(6 * (d.metadata.symbolValues.length + 1) + 1);
        expect(sum(w)).toBe(p.width);
        const back = gs1128.decode(linearPattern(backwards(w)));
        expect(back.rawData).toBe(raw);
        expect(back.metadata.reversed).toBe(true);
        expect(back.metadata.symbolValues).toEqual(d.metadata.symbolValues);
        const padded = gs1128.decode(linearPattern([0, pad, ...w, pad + 1]));
        expect(padded.rawData).toBe(raw);
        expect(d.metadata.symbolValues.length - 3).toBeLessThanOrEqual(greedy(raw));
      }),
      { numRuns: 1000 },
    );
  });
});

describe('gs1128 encode', () => {
  it('geometry', () => {
    const p = gs1128.encode('(10)2503X');
    expect(p.symbology).toBe('gs1-128');
    expect(p.kind).toBe('linear');
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({ role: 'symbol', x: 0, y: 0, height: 64 });
    expect(row(p)).toHaveLength(6 * 8 + 7);
    expect(p.width).toBe(11 * 8 + 13);
    expect(p.height).toBe(64);
    expect(p.quietZone).toEqual({ left: 10, right: 10, top: 0, bottom: 0 });
    expect('bearer' in p).toBe(false);
    expect(p.hri).toEqual([
      { text: '(10)2503X', x: 50.5, y: 64 + 3 + 6.4, size: 8, anchor: 'middle', role: 'hri' },
    ]);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.rows[0]?.widths)).toBe(true);
    const n = gs1128.encode('(10)2503X', { hri: false, height: 30 });
    expect(n.hri).toEqual([]);
    expect(n.height).toBe(30);
    expect(n.rows[0]?.height).toBe(30);
  });
  it('HRI lines follow the encoded order', () => {
    const p = gs1128.encode('(01)09506000134352(17)201225(10)ABC123');
    expect(p.width).toBe(11 * 20 + 46);
    expect(p.hri.map((h) => h.text)).toEqual(['(01)09506000134352(17)201225(10)ABC123']);
  });
  it('wraps HRI between elements only', () => {
    const pieces = ['(01)09506000134352', '(17)201225', '(10)ABC123', '(21)X'];
    // 0.6 * 8 = 4.8 modules per character
    const lines = hriLines(pieces, 30 * 4.8, 64);
    expect(lines.map((h) => h.text)).toEqual(['(01)09506000134352(17)201225', '(10)ABC123(21)X']);
    expect(lines.map((h) => h.y)).toEqual([64 + 3 + 6.4, 64 + 3 + 6.4 + 9.6]);
    for (const h of lines)
      expect(h).toMatchObject({ x: 72, size: 8, anchor: 'middle', role: 'hri' });
    // a piece alone wider than the symbol sits on its own line
    expect(hriLines(pieces, 12 * 4.8, 10).map((h) => h.text)).toEqual(pieces);
    expect(hriLines(['(10)A'], 1, 10).map((h) => h.text)).toEqual(['(10)A']);
  });
  it('HRI follows optimizeOrder when the last element is variable length', () => {
    const p = gs1128.encode('(10)ABC(01)09506000134352(21)X', { optimizeOrder: true });
    expect(p.hri.map((h) => h.text)).toEqual(['(01)09506000134352(10)ABC(21)X']);
    expect(gs1128.decode(p).rawData).toBe(`010950600013435210ABC${GS}21X`);
  });
  it('accepts an ElementString', () => {
    const es = parse('(01)09506000134352(10)ABC');
    expect(gs1128.decode(gs1128.encode(es)).elementString.equals(es)).toBe(true);
  });
  it('data errors', () => {
    expect(errsOf(gs1128.tryEncode('(01)09506000134353'))[0]?.code).toBe('CHECK_DIGIT');
    expect(errsOf(gs1128.tryEncode(''))[0]?.code).toBe('EMPTY_INPUT');
    const e = errsOf(gs1128.tryEncode(5 as never))[0];
    expect(e?.code).toBe('INVALID_VALUE');
    expect(e?.details?.['option']).toBe('data');
    expect(() => gs1128.encode('(01)09506000134353')).toThrow(Gs1Error);
  });
  it('option errors', () => {
    const bad: Record<string, unknown>[] = [
      { optimizeOrder: 'yes' },
      { height: 0 },
      { height: 1001 },
      { height: Number.NaN },
      { height: '64' },
      { hri: 1 },
    ];
    for (const o of bad) {
      const e = errsOf(gs1128.tryEncode('(10)2503X', o))[0];
      expect(e?.code).toBe('INVALID_VALUE');
      expect(e?.details?.['option']).toBe(Object.keys(o)[0]);
    }
    expect(errsOf(gs1128.tryEncode('(10)2503X', 3 as never))[0]?.details?.['option']).toBe(
      'options',
    );
  });
  it('never throws on hostile input', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (d, o) => {
        expect(() => gs1128.tryEncode(d as never, o as never)).not.toThrow();
        const e = thrown(() => gs1128.encode(d as never, o as never));
        expect(e === undefined || e instanceof Gs1Error).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
  it('name', () => {
    expect(gs1128.name).toBe('gs1-128');
  });
});

describe('gs1128 decode errors', () => {
  const good = gs1128.encode('(10)2503X');
  const gw = [...row(good)];
  it('rows', () => {
    expect(errOf(undefined).details?.['reason']).toBe('pattern');
    expect(errOf({ ...good, rows: [] }).details?.['reason']).toBe('pattern');
    const r0 = good.rows[0];
    expect(errOf({ ...good, rows: [r0, r0] }).details?.['reason']).toBe('pattern');
    expect(() => gs1128.decode({} as LinearPattern)).toThrow(Gs1Error);
  });
  it('widths must be integers 1 to 4, with caller indices', () => {
    const w = [...gw];
    w[7] = 5;
    expect(errOf(linearPattern(w)).details).toEqual({ reason: 'pattern', element: 7, row: 0 });
    const f = [0, 10, ...gw];
    f[9] = 1.5;
    expect(errOf(linearPattern(f)).details).toEqual({ reason: 'pattern', element: 9, row: 0 });
  });
  it('length', () => {
    expect(errOf(linearPattern(gw.slice(0, 54))).details?.['reason']).toBe('length');
    expect(errOf(linearPattern(gw.slice(0, 6 * 2 + 1))).details?.['reason']).toBe('length');
    expect(errOf(linearPattern(gw.slice(0, 6 * 2 + 7))).details?.['reason']).toBe('length');
  });
  it('no start, no stop, characters', () => {
    const ns = [...gw];
    ns[0] = 1;
    ns[1] = 2;
    expect(errOf(linearPattern(ns)).details).toEqual({ reason: 'no-start', element: 0, row: 0 });
    const nstop = [...gw];
    nstop[50] = 1;
    nstop[51] = 4;
    expect(errOf(linearPattern(nstop)).details).toEqual({
      reason: 'no-stop',
      element: 48,
      row: 0,
    });
    const bc = [...gw];
    bc[12] = 1; // value 10 "221312" -> "131312", not a character
    bc[13] = 3;
    expect(errOf(linearPattern(bc)).details).toEqual({ reason: 'character', element: 12, row: 0 });
    // a reversed read maps back to the caller's indices
    const rb = backwards(bc);
    expect(errOf(linearPattern([0, 4, ...rb])).details).toEqual({
      reason: 'character',
      element: 2 + (gw.length - 1 - 12),
      row: 0,
    });
  });
  it('a reversed read needs a start character too', () => {
    for (const startValue of [17, 0]) {
      const w = widthsOf([startValue, 102, 17, 16, 33, check([startValue, 102, 17, 16, 33])]);
      expect(errOf(linearPattern(w)).details).toEqual({ reason: 'no-start', element: 0, row: 0 });
      expect(errOf(linearPattern(backwards(w))).details).toEqual({
        reason: 'no-start',
        element: 0,
        row: 0,
      });
      expect(errOf(linearPattern([0, 3, ...backwards(w)])).details).toEqual({
        reason: 'no-start',
        element: 2,
        row: 0,
      });
    }
  });
  it('start or stop value inside', () => {
    expect(errOf(symbol([104, 102, 17, 103, 17])).details).toEqual({
      reason: 'character',
      element: 18,
      row: 0,
    });
    expect(errOf(symbol([104, 102, 17, 106, 17])).details).toMatchObject({
      reason: 'character',
      element: 18,
    });
  });
  it('check character', () => {
    const values = [104, 102, 17, 16, 33];
    const w = widthsOf([...values, (check(values) + 1) % 103]);
    expect(errOf(linearPattern(w)).details).toEqual({
      reason: 'check-character',
      element: 30,
      row: 0,
    });
  });
  it('not GS1: ]C0, ]C2', () => {
    expect(errOf(symbol([104, 33, 34])).details).toEqual({
      reason: 'not-gs1',
      aimId: ']C0',
      text: 'AB',
    });
    expect(errOf(symbol([104, 33, 102, 34])).details).toEqual({
      reason: 'not-gs1',
      aimId: ']C2',
      text: 'AB',
    });
    expect(errOf(symbol([105, 12, 102, 34])).details).toEqual({
      reason: 'not-gs1',
      aimId: ']C2',
      text: '1234',
    });
    // not interpretable: no text
    expect(errOf(symbol([104, 33, 97, 34])).details).toEqual({ reason: 'not-gs1', aimId: ']C0' });
    expect(errOf(symbol([104, 33, 102, 34])).code).toBe('UNSUPPORTED');
  });
  it('code sets, SHIFT and latches', () => {
    // Start A, FNC1, "1", "0", SHIFT b (B 66), CODE B, "c", CODE C, 12, CODE A, GS (93), "2", "1", "X"
    const v = [103, 102, 17, 16, 98, 66, 100, 67, 99, 12, 101, 93, 18, 17, 56];
    const d = gs1128.decode(symbol(v));
    expect(d.rawData).toBe(`10bc12${GS}21X`);
    expect(d.elementString.toString()).toBe('(10)bc12(21)X');
    // Start B, SHIFT to A: control character via A
    expect(gs1128.decode(symbol([104, 102, 17, 16, 98, 33])).rawData).toBe('10A');
    // C latches: CODE B, CODE A
    expect(gs1128.decode(symbol([105, 102, 10, 100, 33, 101, 34])).rawData).toBe('10AB');
    // B latch to A
    expect(gs1128.decode(symbol([104, 102, 17, 16, 101, 33])).rawData).toBe('10A');
    // A to C
    expect(gs1128.decode(symbol([103, 102, 99, 10, 100, 33])).rawData).toBe('10A');
  });
  it('bad SHIFT targets', () => {
    expect(errOf(symbol([104, 102, 17, 16, 98, 99, 33])).details).toEqual({
      reason: 'sequence',
      element: 30,
      row: 0,
    });
    expect(errOf(symbol([104, 102, 17, 16, 33, 98])).details).toEqual({
      reason: 'sequence',
      element: 30,
      row: 0,
    });
  });
  it('FNC4 in set A and FNC3 in set C is digits', () => {
    expect(errOf(symbol([103, 102, 17, 16, 101, 33])).details).toEqual({ reason: 'fnc4' });
    expect(gs1128.decode(symbol([105, 102, 10, 96])).rawData).toBe('1096');
  });
  it('linkage flags from each set', () => {
    const cases: [number[], string][] = [
      [[103, 102, 17, 16, 33, 100], 'cc-a-b'],
      [[103, 102, 17, 16, 33, 99], 'cc-c'],
      [[104, 102, 17, 16, 33, 99], 'cc-a-b'],
      [[104, 102, 17, 16, 33, 101], 'cc-c'],
      [[105, 102, 10, 12, 101], 'cc-a-b'],
      [[105, 102, 10, 12, 100], 'cc-c'],
    ];
    for (const [v, linkage] of cases) {
      const d = gs1128.decode(symbol(v));
      expect(d.metadata.linkage).toBe(linkage);
      expect(d.rawData).toMatch(/^10(A|12)$/);
    }
  });
  it('data errors index rawData (fromScan pre-checks)', () => {
    // empty data
    const empty = errOf(symbol([104, 102]));
    expect(empty).toMatchObject({ code: 'EMPTY_INPUT', position: 0 });
    // leading GS
    const lead = errOf(symbol([104, 102, 102, 17, 16, 33]));
    expect(lead).toMatchObject({ code: 'INVALID_SYMBOL', position: 0, length: 1 });
    expect(lead.details).toEqual({ reason: 'sequence' });
    // a caret
    const caret = errOf(symbol([104, 102, 17, 16, 62, 33]));
    expect(caret).toMatchObject({ code: 'INVALID_SYMBOL', position: 2, length: 1 });
    expect(caret.details).toEqual({ reason: 'sequence' });
    // an ai error
    const ai = errOf(symbol([105, 102, 1, 9, 50, 60, 0, 13, 43, 53]));
    expect(ai).toMatchObject({ code: 'CHECK_DIGIT', ai: '01', position: 15 });
    expect(thrown(() => fromScan(']C10109506000134353'))).toMatchObject({
      code: 'CHECK_DIGIT',
      position: 18,
    });
  });
  it('never throws anything but Gs1Error', () => {
    const fromWidths = fc
      .array(
        fc.oneof(
          fc.integer({ min: 0, max: 4 }),
          fc.double(),
          fc.constantFrom(Number.NaN, Infinity, -1, 1e9, 0.5),
        ),
        { maxLength: 2000 },
      )
      .map((w): unknown => {
        try {
          return linearPattern(w);
        } catch {
          return w;
        }
      });
    const fromValues = fc
      .tuple(
        fc.constantFrom(103, 104, 105),
        fc.array(fc.integer({ min: 0, max: 106 }), { maxLength: 30 }),
      )
      .map(([s, vs]) => symbol([s, ...vs]));
    const hostile = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.anything(),
      fromWidths,
      fromValues,
      fc.record({
        kind: fc.constant('linear'),
        rows: fc.array(
          fc.record({
            role: fc.constantFrom('symbol', 'add-on', undefined),
            x: fc.oneof(fc.integer({ min: -3, max: 30 }), fc.double()),
            widths: fc.array(fc.oneof(fc.integer({ min: 0, max: 4 }), fc.double()), {
              maxLength: 100,
            }),
          }),
          { maxLength: 3 },
        ),
      }),
    );
    fc.assert(
      fc.property(hostile, (p) => {
        const e = thrown(() => gs1128.decode(p as LinearPattern));
        expect(e === undefined || e instanceof Gs1Error).toBe(true);
        expect(() => gs1128.tryDecode(p as LinearPattern)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });
});
