/* oxlint-disable typescript/no-unsafe-type-assertion -- JSON vector files and deliberately hostile inputs */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import vectorsFile from '../../vectors/itf-14.json' with { type: 'json' };
import type { Result } from '../../../src/core/index.ts';
import { Gs1Error } from '../../../src/core/index.ts';
import { fromScan } from '../../../src/scan/index.ts';
import { itf14 } from '../../../src/symbology/linear/itf.ts';
import { toSvg } from '../../../src/symbology/render/index.ts';
import type { LinearPattern } from '../../../src/symbology/render/index.ts';
import { gtinArb } from '../../support/symbology.ts';

interface Vec {
  id: string;
  kind: string;
  gtin?: string;
  ratio3?: { widths: string };
  ratio2_5?: { widths: string };
  widths?: string;
  expect?: { error?: string; transmitted?: string; reversed?: boolean };
}
const vectors = vectorsFile.vectors as Vec[];

const sum = (a: readonly number[]): number => a.reduce((x, y) => x + y, 0);
function row(p: LinearPattern): readonly number[] {
  return p.rows[0]?.widths ?? [];
}
function digitsToWidths(s: string): number[] {
  return s.split('').map(Number);
}
/** Wraps widths in a pattern via the encoder's shell. */
function withWidths(widths: readonly number[], extra: Partial<LinearPattern> = {}): LinearPattern {
  const base = itf14.encode('15400141288763');
  const r = base.rows[0];
  if (r === undefined) throw new Error('no row');
  return { ...base, ...extra, rows: [{ ...r, widths }] };
}
function backwards(a: readonly number[]): number[] {
  return a.map((_, i) => a[a.length - 1 - i] ?? 0);
}
function errsOf(r: Result<unknown>): readonly Gs1Error[] {
  if (r.ok) throw new Error('expected failure');
  return r.errors;
}
function valueOf<T>(r: Result<T>): T {
  if (!r.ok) throw new Error('expected success');
  return r.value;
}
function errOf(p: unknown): Gs1Error {
  const e = errsOf(itf14.tryDecode(p as LinearPattern))[0];
  if (e === undefined) throw new Error('no error');
  return e;
}
function codeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

function measure(svg: string): { baseline: number; bearerBottom: number; height: number } {
  const baseline = Number(/<text [^>]*y="([\d.]+)"/.exec(svg)?.[1]);
  const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)?.[1]);
  const path = /<path [^>]*d="([^"]*)"/.exec(svg)?.[1] ?? '';
  let bearerBottom = 0;
  for (const m of path.matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)h/g)) {
    if (Number(m[3]) > 100) bearerBottom = Math.max(bearerBottom, Number(m[2]) + Number(m[4]));
  }
  return { baseline, bearerBottom, height };
}

describe('itf14 encode vectors', () => {
  for (const v of vectors.filter((x) => x.kind === 'pattern')) {
    it('vector ' + v.id, () => {
      const gtin = v.gtin ?? '';
      expect(row(itf14.encode(gtin, { wideToNarrow: 3 }))).toEqual(
        digitsToWidths(v.ratio3?.widths ?? ''),
      );
      expect(row(itf14.encode(gtin))).toEqual(
        (v.ratio2_5?.widths ?? '').split(',').map((s) => Number(s) / 2),
      );
      expect(sum(row(itf14.encode(gtin, { wideToNarrow: 3 })))).toBe(135);
      expect(sum(row(itf14.encode(gtin)))).toBe(120.5);
    });
  }
});

describe('itf14 decode vectors', () => {
  for (const v of vectors.filter((x) => x.kind === 'decode')) {
    it('vector ' + v.id, () => {
      const p = withWidths(digitsToWidths(v.widths ?? ''));
      const r = itf14.tryDecode(p);
      expect(r.ok).toBe(v.expect?.error === undefined);
    });
  }
  it('bad check digit is CHECK_DIGIT at 13', () => {
    const v = vectors.find((x) => x.id === 'derived:bad-check');
    const e = errOf(withWidths(digitsToWidths(v?.widths ?? '')));
    expect(e).toMatchObject({ code: 'CHECK_DIGIT', ai: '01', position: 13 });
  });
  it('reversed vector decodes with reversed true', () => {
    const v = vectors.find((x) => x.id === 'derived:reverse');
    const d = valueOf(itf14.tryDecode(withWidths(digitsToWidths(v?.widths ?? ''))));
    expect(d.aimId + d.rawData).toBe(v?.expect?.transmitted);
    expect(d.metadata.reversed).toBe(true);
  });
});

describe('itf14 properties', () => {
  it('round trips at each ratio, reversed and padded', () => {
    fc.assert(
      fc.property(
        gtinArb(14),
        fc.constantFrom(2.25, 2.5, 2.75, 3),
        fc.integer({ min: 0, max: 12 }),
        (gtin, ratio, pad) => {
          const p = itf14.encode(gtin, { wideToNarrow: ratio });
          const d = itf14.decode(p);
          expect(d.rawData).toBe(gtin);
          expect(d.metadata).toEqual({ reversed: false, wideToNarrow: ratio });
          expect(d.symbology).toBe('itf-14');
          expect(d.aimId).toBe(']I1');
          expect(fromScan(d.aimId + d.rawData).elementString.toString()).toBe(
            d.elementString.toString(),
          );
          const w = row(p);
          const back = itf14.decode(withWidths(backwards(w)));
          expect(back.rawData).toBe(gtin);
          expect(back.metadata.reversed).toBe(true);
          const padded = itf14.decode(withWidths([0, pad, ...w, pad + 1, 0].slice(0)));
          expect(padded.rawData).toBe(gtin);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('itf14 encode', () => {
  it('pads GTIN-8, 12 and 13', () => {
    expect(itf14.decode(itf14.encode('96385074')).elementString.toString()).toBe(
      '(01)00000096385074',
    );
    expect(itf14.decode(itf14.encode('036000291452')).rawData).toBe('00036000291452');
    expect(itf14.decode(itf14.encode('4006381333931')).rawData).toBe('04006381333931');
    expect(itf14.decode(itf14.encode('(01)15400141288763')).rawData).toBe('15400141288763');
  });
  it('rejects more than a lone GTIN', () => {
    const r = itf14.tryEncode('(01)09506000134352(10)ABC');
    expect(errsOf(r)[0]?.code).toBe('NOT_REPRESENTABLE');
  });
  it('rejects a bad check digit', () => {
    const r = itf14.tryEncode('15400141288764');
    expect(errsOf(r)[0]?.code).toBe('CHECK_DIGIT');
  });
  it('option errors', () => {
    const bad: Record<string, unknown>[] = [
      { wideToNarrow: 2.2 },
      { wideToNarrow: 3.1 },
      { wideToNarrow: Number.NaN },
      { wideToNarrow: '2.5' },
      { bearerWidth: 1 },
      { bearerWidth: Number.NaN },
      { bearerWidth: 101 },
      { bearer: 'side' },
      { height: 0 },
      { height: Infinity },
      { height: 1001 },
      { hri: 'yes' },
    ];
    for (const o of bad) {
      const r = itf14.tryEncode('15400141288763', o);
      const e = errsOf(r)[0];
      expect(e?.code).toBe('INVALID_VALUE');
      expect(e?.details?.['option']).toBe(Object.keys(o)[0]);
    }
    const r = itf14.tryEncode('15400141288763', 3 as never);
    expect(errsOf(r)[0]?.details?.['option']).toBe('options');
    expect(itf14.tryEncode(5 as never).ok).toBe(false);
  });
  it('geometry', () => {
    const p = itf14.encode('15400141288763');
    expect(p.symbology).toBe('itf-14');
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]?.widths).toHaveLength(77);
    expect(p.width).toBe(120.5);
    expect(p.height).toBe(64);
    expect(p.bearer).toEqual({ sides: 'frame', width: 5 });
    expect(p.quietZone).toEqual({ left: 10, right: 10, top: 0, bottom: 0 });
    expect(p.hri).toEqual([
      {
        text: '15400141288763',
        x: 60.25,
        y: 64 + 3 + 6.4,
        size: 8,
        anchor: 'middle',
        role: 'hri',
      },
    ]);
    const n = itf14.encode('15400141288763', { bearer: 'none', hri: false, height: 30 });
    expect('bearer' in n).toBe(false);
    expect(n.hri).toEqual([]);
    expect(n.height).toBe(30);
    expect(itf14.encode('15400141288763', { bearer: 'none' }).hri[0]?.y).toBeCloseTo(73.4);
    expect(itf14.encode('15400141288763', { bearer: 'top-bottom', bearerWidth: 7 }).bearer).toEqual(
      { sides: 'top-bottom', width: 7 },
    );
    expect(Object.isFrozen(p)).toBe(true);
  });
  for (const bearer of ['frame', 'top-bottom'] as const) {
    it(`HRI clears the bottom bearer (${bearer})`, () => {
      const moduleSize = 2;
      const svg = toSvg(itf14.encode('15400141288763', { bearer }), { moduleSize });
      const text = /<text [^>]*y="([\d.]+)"/.exec(svg);
      const baseline = Number(text?.[1]);
      // the bottom bearer is the last rectangle of the sorted path; take the greatest bottom edge of wide runs
      const path = /<path [^>]*d="([^"]*)"/.exec(svg)?.[1] ?? '';
      let bottom = 0;
      for (const m of path.matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)h/g)) {
        if (Number(m[3]) > 100) bottom = Math.max(bottom, Number(m[2]) + Number(m[4]));
      }
      expect(bottom).toBeGreaterThan(0);
      expect(baseline - bottom).toBeGreaterThanOrEqual(3 * moduleSize);
    });
  }
});

describe('itf14 decode errors', () => {
  const good = itf14.encode('15400141288763');
  const gw = [...row(good)];
  it('row count', () => {
    expect(errOf({ ...good, rows: [] }).details?.['reason']).toBe('pattern');
    const r0 = good.rows[0];
    expect(errOf({ ...good, rows: [r0, r0] }).details?.['reason']).toBe('pattern');
  });
  it('length', () => {
    const e = errOf(withWidths(gw.slice(0, 76)));
    expect(e.details?.['reason']).toBe('length');
  });
  it('ratio and classes', () => {
    expect(errOf(withWidths(gw.map((w) => (w > 1 ? 1.5 : w)))).details?.['reason']).toBe('pattern');
    expect(errOf(withWidths(gw.map((w) => (w > 1 ? 4 : w)))).details?.['reason']).toBe('pattern');
    expect(errOf(withWidths(gw.map(() => 1))).details?.['reason']).toBe('pattern');
    const mid = [...gw];
    mid[6] = 1.7;
    const e = errOf(withWidths(mid));
    expect(e.details?.['reason']).toBe('pattern');
    expect(e.details?.['element']).toBe(6);
    expect(e.details?.['row']).toBe(0);
  });
  it('start, stop, characters report forward error with caller indices', () => {
    const noStart = [...gw];
    noStart[1] = 2.5;
    const s = errOf(withWidths(noStart));
    expect(s.details).toMatchObject({ reason: 'no-start', element: 1, row: 0 });
    const noStop = [...gw];
    noStop[74] = 1;
    expect(errOf(withWidths(noStop)).details).toMatchObject({
      reason: 'no-stop',
      element: 74,
      row: 0,
    });
    const badChar = [...gw];
    badChar[4] = 1;
    badChar[6] = 1;
    badChar[8] = 1;
    badChar[10] = 1;
    badChar[12] = 1;
    expect(errOf(withWidths(badChar)).details).toMatchObject({ reason: 'character', element: 4 });
    const badSpace = [...gw];
    for (const i of [5, 7, 9, 11, 13]) badSpace[i] = 1;
    expect(errOf(withWidths(badSpace)).details).toMatchObject({ reason: 'character', element: 5 });
  });
  it('indices map through leading quiet runs and rows', () => {
    const p = withWidths([0, 3, ...gw.slice(0, 1), 2.5, ...gw.slice(2)]);
    expect(errOf(p).details).toMatchObject({ reason: 'no-start', element: 3, row: 0 });
    const r0 = good.rows[0];
    const guard = { ...r0, role: 'guard-extension' };
    const q = { ...withWidths([...gw.slice(0, 1), 2.5, ...gw.slice(2)]) };
    expect(errOf({ ...q, rows: [guard, ...q.rows] }).details).toMatchObject({ element: 1, row: 1 });
  });
  it('rejects non-integer module gaps nowhere, accepts fractional widths', () => {
    expect(itf14.decode(itf14.encode('15400141288763', { wideToNarrow: 2.3 })).rawData).toBe(
      '15400141288763',
    );
  });
  it('never throws anything but Gs1Error', () => {
    const hostile = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.anything(),
      fc.record({
        kind: fc.constant('linear'),
        rows: fc.array(
          fc.record({
            role: fc.constantFrom('symbol', 'add-on', undefined),
            x: fc.oneof(fc.integer({ min: -3, max: 30 }), fc.double()),
            widths: fc.oneof(
              fc.array(fc.oneof(fc.integer({ min: 0, max: 4 }), fc.double()), { maxLength: 100 }),
              fc.array(fc.constantFrom(1, 2.5, 3, 0), { minLength: 70, maxLength: 85 }),
            ),
          }),
          { maxLength: 4 },
        ),
      }),
    );
    fc.assert(
      fc.property(hostile, (p) => {
        const e = codeOf(() => itf14.decode(p as LinearPattern));
        expect(e === undefined || e instanceof Gs1Error).toBe(true);
        expect(() => itf14.tryDecode(p as LinearPattern)).not.toThrow();
      }),
      { numRuns: 2000 },
    );
  });
  it('encode never throws on hostile input', () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (d, o) => {
        expect(() => itf14.tryEncode(d as never, o as never)).not.toThrow();
        const e = codeOf(() => itf14.encode(d as never, o as never));
        expect(e === undefined || e instanceof Gs1Error).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
  it('name', () => {
    expect(itf14.name).toBe('itf-14');
  });
  describe('HRI below the bearer under toSvg', () => {
    for (const bearer of ['frame', 'top-bottom'] as const) {
      for (const qz of [undefined, 0, 10] as const) {
        it(`${bearer}, quietZone ${String(qz)}`, () => {
          const p = itf14.encode('15012345678907', { bearer });
          const svg = toSvg(p, { moduleSize: 1, ...(qz === undefined ? {} : { quietZone: qz }) });
          const m = measure(svg);
          expect(m.bearerBottom).toBeGreaterThan(0);
          // cap top (0.8 x size) at least 3 modules below the bearer
          expect(m.baseline - 0.8 * 8 - m.bearerBottom).toBeGreaterThanOrEqual(3 - 1e-9);
          // no blank bearer-width gap below the text
          expect(m.height).toBeCloseTo(m.baseline + 0.2 * 8, 6);
        });
      }
    }
  });
});
