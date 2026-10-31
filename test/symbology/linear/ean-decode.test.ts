/* oxlint-disable typescript/no-unsafe-type-assertion -- JSON vector files and deliberately hostile inputs */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import vectorsFile from '../../vectors/ean-upc.json' with { type: 'json' };
import { Gs1Error, checkDigit } from '../../../src/core/index.ts';
import { fromScan } from '../../../src/scan/index.ts';
import { encodeEanUpc } from '../../../src/symbology/linear/ean-encode.ts';
import type { EanUpcForm } from '../../../src/symbology/linear/ean-encode.ts';
import { decodeEanUpc } from '../../../src/symbology/linear/ean-decode.ts';
import { SET_A, SET_B, UPCE_GUARD, UPCE_PARITY } from '../../../src/symbology/linear/ean-tables.ts';
import { linearPattern } from '../../../src/symbology/render/index.ts';
import type { LinearPattern } from '../../../src/symbology/render/index.ts';
import { addOnArb, gtinArb, upceGtinArb } from '../../support/symbology.ts';

interface EncodeVector {
  kind: string;
  symbology: string;
  data: string;
  gtin14: string;
  addOn?: string;
}
const vectors = (vectorsFile.vectors as EncodeVector[]).filter(
  (v) => v.kind === 'encode' && ['ean-13', 'upc-a', 'ean-8', 'upc-e'].includes(v.symbology),
);

function enc(form: EanUpcForm, data: string, addOn?: string): LinearPattern {
  const r = encodeEanUpc(form, data, addOn === undefined ? {} : { addOn });
  if (!r.ok) throw r.errors[0];
  return r.value;
}

/** Symbol and add-on rows as one width list, the gap as a light run. */
function concat(p: LinearPattern): number[] {
  const main = p.rows.find((r) => r.role === 'symbol');
  const add = p.rows.find((r) => r.role === 'add-on');
  if (main === undefined) throw new Error('no symbol row');
  const out = [...main.widths];
  if (add !== undefined) {
    out.push(add.x - (main.x + main.widths.reduce((a, b) => a + b, 0)), ...add.widths);
  }
  return out;
}

function rev<T>(a: readonly T[]): T[] {
  return a.reduceRight<T[]>((o, x) => {
    o.push(x);
    return o;
  }, []);
}

function dec(p: LinearPattern, accept: Parameters<typeof decodeEanUpc>[1] = 'any') {
  const r = decodeEanUpc(p, accept);
  if (!r.ok) throw r.errors[0];
  return r.value;
}

function errOf(p: unknown, accept: Parameters<typeof decodeEanUpc>[1] = 'any'): Gs1Error {
  const r = decodeEanUpc(p as LinearPattern, accept);
  if (r.ok) throw new Error('expected failure');
  const e = r.errors[0];
  if (e === undefined) throw new Error('no error');
  return e;
}

const AIM: Record<string, string> = {
  'ean-13': ']E0',
  'upc-a': ']E0',
  'ean-8': ']E4',
  'upc-e': ']E0',
};

describe('decodeEanUpc vectors', () => {
  it.each(vectors.map((v) => [v.symbology, v.data, v] as const))('%s %s', (_s, _d, v) => {
    const form = v.symbology as EanUpcForm;
    const d = dec(enc(form, v.data, v.addOn));
    expect(d.elementString.gtin).toBe(v.gtin14);
    expect(d.symbology).toBe(
      form === 'ean-13' || form === 'upc-a'
        ? v.gtin14.startsWith('00')
          ? 'upc-a'
          : 'ean-13'
        : form,
    );
    expect(d.aimId).toBe(v.addOn === undefined ? AIM[v.symbology] : ']E3');
    expect(d.addOn).toBe(v.addOn);
    expect(d.errorsCorrected).toBe(0);
    expect(d.metadata.reversed).toBe(false);
  });
});

describe('decodeEanUpc symbology names', () => {
  it('reports upc-a for a leading 0 and ean-13 otherwise', () => {
    expect(dec(enc('ean-13', '4006381333931')).symbology).toBe('ean-13');
    expect(dec(enc('upc-a', '036000291452')).symbology).toBe('upc-a');
    expect(dec(enc('ean-13', '0036000291452')).symbology).toBe('upc-a');
  });
  it('builds rawData per aim id', () => {
    const d = dec(enc('ean-13', '4006381333931', '12'));
    expect(d).toMatchObject({
      aimId: ']E3',
      rawData: '400638133393112',
      addOn: '12',
    });
    const u = dec(enc('upc-e', '042100005264'));
    expect(u).toMatchObject({
      aimId: ']E0',
      rawData: '0042100005264',
      symbology: 'upc-e',
    });
    expect(u.metadata).toEqual({ reversed: false, upceCanonical: true });
    const e = dec(enc('ean-8', '96385074'));
    expect(e).toMatchObject({ aimId: ']E4', rawData: '96385074' });
    expect(e.metadata).toEqual({ reversed: false });
  });
});

describe('decodeEanUpc properties', () => {
  const cases: [string, fc.Arbitrary<{ form: EanUpcForm; data: string }>][] = [
    [
      'ean-13',
      gtinArb(13)
        .map((data) => ({ form: 'ean-13' as const, data }))
        .filter((c) => !(c.data.startsWith('00000') && c.data.slice(5, 7) !== '00')),
    ],
    [
      'upc-a',
      gtinArb(12)
        .map((data) => ({ form: 'upc-a' as const, data }))
        .filter((c) => !(c.data.startsWith('0000') && c.data.slice(4, 6) !== '00')),
    ],
    ['ean-8', gtinArb(8).map((data) => ({ form: 'ean-8' as const, data }))],
    [
      'upc-e',
      upceGtinArb
        .filter((data) => !(data.startsWith('0000') && data.slice(4, 6) !== '00'))
        .map((data) => ({ form: 'upc-e' as const, data })),
    ],
  ];
  for (const [name, arb] of cases) {
    const withAddOn = name !== 'ean-8';
    const full = fc.record({
      c: arb,
      addOn: withAddOn ? fc.option(addOnArb, { nil: undefined }) : fc.constant(undefined),
    });
    it(`${name}: round trip, reversed, quiet zones, scan oracle`, () => {
      fc.assert(
        fc.property(full, ({ c, addOn }) => {
          const p = enc(c.form, c.data, addOn);
          const d = dec(p);
          const w = concat(p);
          expect(d.elementString.gtin).toBe(c.data.padStart(14, '0'));
          expect(d.addOn).toBe(addOn);
          expect(d.metadata.reversed).toBe(false);
          const s = fromScan(d.aimId + d.rawData);
          expect(s.elementString.equals(d.elementString)).toBe(true);
          expect(s.addOn).toBe(d.addOn);
          const r = dec(linearPattern(rev(w)));
          expect(r.metadata.reversed).toBe(true);
          expect(r.elementString.equals(d.elementString)).toBe(true);
          expect(r.addOn).toBe(addOn);
          expect(r.rawData).toBe(d.rawData);
          const q = dec(linearPattern([0, 9, ...w, 9]));
          expect(q.elementString.equals(d.elementString)).toBe(true);
          expect(q.metadata.reversed).toBe(false);
          expect(q.aimId).toBe(d.aimId);
        }),
        { numRuns: 500 },
      );
    });
  }
});

/** Hand-built UPC-E main widths for a six digit body and a check digit. */
function upceWidths(body: string, check: number, complement = false): number[] {
  let parity = UPCE_PARITY[check] ?? '';
  if (complement)
    parity = Array.from(parity)
      .map((c) => (c === 'A' ? 'B' : 'A'))
      .join('');
  const out = [1, 1, 1];
  Array.from(body).forEach((ch, i) => {
    const t = parity[i] === 'A' ? SET_A : SET_B;
    for (const c of t[Number(ch)] ?? '') out.push(Number(c));
  });
  out.push(...UPCE_GUARD);
  return out;
}

describe('decodeEanUpc UPC-E', () => {
  const cd = Number(checkDigit('00123000005'));
  const gtin12 = `00123000005${cd}`;
  it('accepts a non-canonical body and flags it', () => {
    const d = dec(linearPattern(upceWidths('012305', cd)), 'upc-e');
    expect(d.symbology).toBe('upc-e');
    expect(d.rawData).toBe(`0${gtin12}`);
    expect(d.metadata).toEqual({ reversed: false, upceCanonical: false });
  });
  it('rejects a complemented parity row', () => {
    const e = errOf(linearPattern(upceWidths('012305', cd, true)), 'upc-e');
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details).toMatchObject({ reason: 'parity' });
  });
});

describe('decodeEanUpc errors', () => {
  it('flipped bar in a character gives character with an element index', () => {
    const w = [...(enc('ean-13', '4006381333931').rows[0]?.widths ?? [])];
    // no character has widths 4 4 .. : a lookup miss
    w[3] = 4;
    w[4] = 4;
    const e = errOf(linearPattern(w));
    expect(e.code).toBe('INVALID_SYMBOL');
    expect(e.details).toMatchObject({ reason: 'character' });
    expect(typeof (e.details as { element?: unknown }).element).toBe('number');
  });
  it('a bad guard gives guard', () => {
    const w = [...(enc('ean-13', '4006381333931').rows[0]?.widths ?? [])];
    w[0] = 2;
    expect(errOf(linearPattern(w)).details).toMatchObject({ reason: 'guard' });
  });
  it('a wrong check digit gives CHECK_DIGIT', () => {
    const w = [...(enc('ean-13', '4006381333931').rows[0]?.widths ?? [])];
    // replace the last character (digit 1) by digit 2 (set C is set A's widths)
    for (let i = 0; i < 4; i++) w[52 + i] = Number((SET_A[2] ?? '')[i]);
    const e = errOf(linearPattern(w));
    expect(e.code).toBe('CHECK_DIGIT');
    expect(e.position).toBe(12);
  });
  it('ean8 rejects an EAN-13 pattern with symbology', () => {
    expect(errOf(enc('ean-13', '4006381333931'), 'ean-8').details).toMatchObject({
      reason: 'symbology',
    });
    expect(errOf(enc('ean-8', '96385074'), 'ean-13').details).toMatchObject({
      reason: 'symbology',
    });
    expect(errOf(enc('ean-8', '96385074'), 'upc-e').details).toMatchObject({
      reason: 'symbology',
    });
  });
  it('an add-on alone gives add-on-only', () => {
    const p = enc('ean-13', '4006381333931', '12');
    const add = p.rows.find((r) => r.role === 'add-on');
    expect(errOf(linearPattern([...(add?.widths ?? [])])).details).toMatchObject({
      reason: 'add-on-only',
    });
  });
  it('a non-integer width gives pattern', () => {
    const w = [...(enc('ean-13', '4006381333931').rows[0]?.widths ?? [])];
    w[5] = 1.5;
    expect(errOf(linearPattern(w)).details).toMatchObject({
      reason: 'pattern',
    });
  });
  it('wrong lengths give length, and the forward error wins', () => {
    expect(errOf(linearPattern([1, 1, 1])).details).toMatchObject({
      reason: 'length',
    });
    expect(errOf(linearPattern([0, 5])).details).toMatchObject({
      reason: 'length',
    });
    const p = enc('ean-13', '4006381333931', '12');
    const w = concat(p);
    // two main symbols
    const two = [...w.slice(0, 59), 9, ...w.slice(0, 59)];
    expect(errOf(linearPattern(two)).details).toMatchObject({
      reason: 'length',
    });
    // an add-on first in forward order and no main after it
    const addOnly = [...w.slice(60), 9, ...w.slice(60)];
    expect(errOf(linearPattern(addOnly)).details).toMatchObject({
      reason: 'length',
    });
  });
  it('an EAN-8 with an add-on is rejected', () => {
    const w = [
      ...concat(enc('ean-8', '96385074')),
      7,
      ...concat(enc('ean-13', '4006381333931', '12')).slice(60),
    ];
    expect(errOf(linearPattern(w)).details).toMatchObject({
      reason: 'symbology',
    });
  });
  it('a bad add-on parity gives parity', () => {
    const w = concat(enc('ean-13', '4006381333931', '12'));
    // value 12 needs set A twice: put digit 2 in set B (2212) as the second character
    const bad = [...w];
    for (let i = 0; i < 4; i++) bad[69 + i] = Number((SET_B[2] ?? '')[i]);
    expect(errOf(linearPattern(bad)).details).toMatchObject({ reason: 'parity' });
  });
  it('bad add-on guard, delineator and character', () => {
    const w = concat(enc('ean-13', '4006381333931', '12'));
    const g = [...w];
    g[60] = 2;
    expect(errOf(linearPattern(g)).details).toMatchObject({ reason: 'guard' });
    const c = [...w];
    c[63] = 4;
    c[64] = 4;
    expect(errOf(linearPattern(c)).details).toMatchObject({
      reason: 'character',
    });
    const d = [...w];
    d[67] = 2;
    d[68] = 2;
    expect(errOf(linearPattern(d)).details).toMatchObject({ reason: 'guard' });
  });
  it('bad centre guard, stop guard, EAN-8 left half in set B, and UPC-E guard', () => {
    const w = [...(enc('ean-13', '4006381333931').rows[0]?.widths ?? [])];
    const c = [...w];
    c[27] = 2;
    expect(errOf(linearPattern(c)).details).toMatchObject({ reason: 'guard' });
    const s = [...w];
    s[58] = 2;
    expect(errOf(linearPattern(s)).details).toMatchObject({ reason: 'guard' });
    const u = [...upceWidths('012305', 1)];
    u[32] = 2;
    expect(errOf(linearPattern(u)).details).toMatchObject({ reason: 'guard' });
    const e = [...(enc('ean-8', '96385074').rows[0]?.widths ?? [])];
    const b = SET_B[3] ?? '';
    for (let i = 0; i < 4; i++) e[3 + i] = Number(b[i]);
    expect(errOf(linearPattern(e)).details).toMatchObject({ reason: 'parity' });
    const e2 = [...(enc('ean-8', '96385074').rows[0]?.widths ?? [])];
    e2[3] = 4;
    e2[4] = 4;
    expect(errOf(linearPattern(e2)).details).toMatchObject({
      reason: 'character',
    });
  });
  it('an unusable parity pattern in EAN-13 gives parity', () => {
    // left half ABABAB... use an invalid combination: all B characters
    const w = [...(enc('ean-13', '4006381333931').rows[0]?.widths ?? [])];
    for (let k = 0; k < 6; k++)
      for (let i = 0; i < 4; i++) w[3 + 4 * k + i] = Number((SET_B[k] ?? '')[i]);
    expect(errOf(linearPattern(w)).details).toMatchObject({ reason: 'parity' });
  });
  it('hostile inputs give pattern', () => {
    for (const bad of [
      null,
      3,
      {},
      { kind: 'linear' },
      { kind: 'linear', rows: [{ widths: 'x' }] },
    ])
      expect(errOf(bad).details).toMatchObject({ reason: 'pattern' });
    expect(
      errOf({
        kind: 'linear',
        rows: [{ role: 'symbol', x: Number.NaN, widths: [1] }],
      }).details,
    ).toMatchObject({ reason: 'pattern' });
  });
  it('overlapping rows give pattern', () => {
    const p = enc('ean-13', '4006381333931', '12');
    const rows = p.rows.map((r) => (r.role === 'add-on' ? { ...r, x: 10 } : r));
    expect(errOf({ ...p, rows }).details).toMatchObject({ reason: 'pattern' });
  });
  it('rows are read in x order', () => {
    const p = enc('ean-13', '4006381333931', '12');
    const rows = rev(p.rows);
    expect(dec({ ...p, rows }).addOn).toBe('12');
  });
});

describe('decodeEanUpc hostile arrays', () => {
  it('never throws and returns ok false or a valid result', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.integer({ min: -2, max: 6 }), fc.double()), {
          maxLength: 400,
        }),
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 100 }),
        (widths, xs) => {
          const pattern = {
            kind: 'linear',
            symbology: undefined,
            width: 0,
            height: 1,
            rows: [
              { role: 'symbol', x: 0, y: 0, height: 1, widths },
              { role: 'add-on', x: xs[0] ?? 0, y: 0, height: 1, widths: xs },
            ],
            hri: [],
            quietZone: { left: 0, right: 0, top: 0, bottom: 0 },
          };
          const r = decodeEanUpc(pattern as unknown as LinearPattern, 'any');
          expect(r.ok || r.errors.every((e) => e instanceof Gs1Error)).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('decodeEanUpc mutated symbols', () => {
  it('never throws on corrupted real symbols', () => {
    const bases = [
      concat(enc('ean-13', '4006381333931', '12')),
      concat(enc('ean-8', '96385074')),
      concat(enc('upc-e', '042100005264', '12345')),
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...bases),
        fc.array(fc.tuple(fc.nat(100), fc.integer({ min: -1, max: 9 })), { maxLength: 6 }),
        fc.boolean(),
        (base, edits, flip) => {
          const w = [...base];
          for (const [i, v] of edits) if (i < w.length) w[i] = v;
          const r = decodeEanUpc(
            {
              kind: 'linear',
              rows: [{ widths: flip ? rev(w) : w }],
            } as unknown as LinearPattern,
            'any',
          );
          expect(r.ok || r.errors.every((e) => e instanceof Gs1Error)).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

const bareWidths = (): number[] => [...(enc('ean-13', '4006381333931').rows[0]?.widths ?? [])];
const corrupt = (w: number[], at: number): number[] => {
  const c = [...w];
  c[at] = 4;
  c[at + 1] = 4;
  return c;
};
describe('decodeEanUpc error indices (row and element of the caller rows)', () => {
  it('bare row', () => {
    expect(errOf(linearPattern(corrupt(bareWidths(), 7))).details).toEqual({
      reason: 'character',
      element: 7,
      row: 0,
    });
  });
  it('quiet zones in front do not shift the element', () => {
    const w = [0, 9, ...corrupt(bareWidths(), 7), 9];
    expect(errOf(linearPattern(w)).details).toEqual({ reason: 'character', element: 9, row: 0 });
  });
  it('a bad add-on character reports the add-on row and its own element', () => {
    const p = enc('ean-13', '4006381333931', '12');
    const rows = p.rows.map((r) =>
      r.role === 'add-on' ? { ...r, widths: corrupt([...r.widths], 3) } : r,
    );
    expect(errOf({ ...p, rows }).details).toEqual({ reason: 'character', element: 3, row: 2 });
  });
  it('a reversed corrupted symbol reports the forward read in caller indices', () => {
    const w = rev(corrupt(bareWidths(), 7));
    const d = errOf(linearPattern(w)).details;
    expect(d).toMatchObject({ row: 0 });
    expect(typeof d?.['element']).toBe('number');
    expect(d).toEqual({ reason: 'parity', element: 3, row: 0 });
  });
  it('a non-integer width reports row and element', () => {
    const w = bareWidths();
    w[5] = 1.5;
    expect(errOf(linearPattern([0, 9, ...w])).details).toEqual({
      reason: 'pattern',
      element: 7,
      row: 0,
    });
  });
});
