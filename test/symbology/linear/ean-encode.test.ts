/* oxlint-disable typescript/no-unsafe-type-assertion -- JSON vector files and deliberately hostile inputs */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import vectorsFile from '../../vectors/ean-upc.json' with { type: 'json' };
import { ElementString } from '../../../src/ai/index.ts';
import { encodeEanUpc } from '../../../src/symbology/linear/ean-encode.ts';
import type { EanUpcForm } from '../../../src/symbology/linear/ean-encode.ts';
import { toSvg } from '../../../src/symbology/render/index.ts';
import type { LinearPattern } from '../../../src/symbology/render/index.ts';
import { addOnArb, gtinArb, patternToBitmap, upceGtinArb } from '../../support/symbology.ts';

interface EncodeVector {
  id: string;
  kind: string;
  symbology: string;
  data: string;
  gtin14: string;
  addOn?: string;
  expect: { widths: number[]; addOnWidths?: number[]; hri?: string };
}
const encodeVectors = (vectorsFile.vectors as EncodeVector[]).filter((v) => v.kind === 'encode');
const forms = new Set(['ean-13', 'upc-a', 'ean-8', 'upc-e']);
const figureVectors = encodeVectors.filter((v) => forms.has(v.symbology));
const withAddOn = figureVectors.filter((v) => v.addOn !== undefined);
const withoutAddOn = figureVectors.filter((v) => v.addOn === undefined);
const hriVectors = figureVectors.filter((v) => v.expect.hri !== undefined);

function enc(
  form: EanUpcForm,
  data: string | ElementString,
  options?: Parameters<typeof encodeEanUpc>[2],
): LinearPattern {
  const r = encodeEanUpc(form, data, options);
  if (!r.ok) throw r.errors[0];
  return r.value;
}

function rowOf(p: LinearPattern, role: string) {
  const row = p.rows.find((r) => r.role === role);
  if (row === undefined) throw new Error(`no ${role} row`);
  return row;
}

/** Element indices that are dark in the guard-extension row. */
function darkIndices(p: LinearPattern): number[] {
  const main = rowOf(p, 'symbol').widths;
  const ext = rowOf(p, 'guard-extension').widths;
  const out: number[] = [];
  let pos = 0;
  let acc = 0;
  // Walk the main elements, tracking where each extension run starts.
  const bounds: { start: number; end: number; dark: boolean }[] = [];
  ext.forEach((w, i) => {
    bounds.push({ start: pos, end: pos + w, dark: i % 2 === 0 });
    pos += w;
  });
  main.forEach((w, i) => {
    const hit = bounds.find((b) => b.dark && b.start <= acc && acc < b.end && w > 0);
    if (hit !== undefined) out.push(i);
    acc += w;
  });
  return out;
}

describe('EAN/UPC vectors', () => {
  it('has 12 figure vectors with hri', () => {
    expect(hriVectors).toHaveLength(12);
  });
  it.each(withoutAddOn)('encodes $id', (v) => {
    const p = enc(v.symbology as EanUpcForm, v.data);
    expect(rowOf(p, 'symbol').widths).toEqual(v.expect.widths);
    expect(p.rows.some((r) => r.role === 'add-on')).toBe(false);
  });
  it.each(withAddOn)('encodes $id with its add-on', (v) => {
    const p = enc(v.symbology as EanUpcForm, v.data, { addOn: v.addOn ?? '' });
    expect(rowOf(p, 'symbol').widths).toEqual(v.expect.widths);
    expect(rowOf(p, 'add-on').widths).toEqual(v.expect.addOnWidths);
  });
  it.each(figureVectors)('accepts the gtin14 form of $id', (v) => {
    const a = enc(
      v.symbology as EanUpcForm,
      v.gtin14,
      v.addOn === undefined ? {} : { addOn: v.addOn },
    );
    const b = enc(
      v.symbology as EanUpcForm,
      v.data,
      v.addOn === undefined ? {} : { addOn: v.addOn },
    );
    expect(a).toEqual(b);
  });
  it.each(hriVectors)('prints the digits of $id', (v) => {
    const p = enc(
      v.symbology as EanUpcForm,
      v.data,
      v.addOn === undefined ? {} : { addOn: v.addOn },
    );
    const printed = (v.expect.hri ?? '').replaceAll(/[^0-9]/g, '');
    const ours = p.hri
      .filter((t) => t.role === 'hri')
      .map((t) => t.text)
      .join('');
    expect(ours).toBe(printed);
  });
});

describe('guard extension rows', () => {
  it.each([
    ['ean-13', '9501101531000', [0, 2, 28, 30, 56, 58]],
    ['upc-a', '416000336108', [0, 2, 4, 6, 28, 30, 52, 54, 56, 58]],
    ['ean-8', '02345673', [0, 2, 20, 22, 40, 42]],
    ['upc-e', '001234000057', [0, 2, 28, 30, 32]],
  ] as const)('%s', (form, data, indices) => {
    const p = enc(form, data);
    const ext = rowOf(p, 'guard-extension');
    const main = rowOf(p, 'symbol');
    expect(darkIndices(p)).toEqual(indices);
    expect(ext.y).toBe(main.height);
    expect(ext.height).toBe(5);
    expect(ext.widths.reduce((a, b) => a + b, 0)).toBe(main.widths.reduce((a, b) => a + b, 0));
  });

  it('folds light elements into runs', () => {
    const p = enc('ean-13', '9501101531000');
    const ext = rowOf(p, 'guard-extension').widths;
    expect(ext.slice(0, 5)).toEqual([1, 1, 1, 43, 1]);
  });
});

describe('geometry', () => {
  it('lays out an EAN-13 with a 5 digit add-on', () => {
    const p = enc('ean-13', '9780877799306', { addOn: '54321' });
    expect(p.symbology).toBe('ean-13');
    expect(p.width).toBe(95 + 7 + 47);
    expect(p.height).toBe(69 + 5 + 9);
    expect(p.quietZone).toEqual({ left: 11, right: 5, top: 0, bottom: 0 });
    const a = rowOf(p, 'add-on');
    expect([a.x, a.y, a.height]).toEqual([102, 8, 66]);
    expect(p.hri.at(-1)).toMatchObject({ text: '>', x: p.width + 5, anchor: 'end' });
  });

  it('honours options', () => {
    const p = enc('upc-a', '416000336108', { addOn: '12', addOnGap: 12, height: 40, hri: false });
    expect(p.width).toBe(95 + 12 + 20);
    expect(p.height).toBe(45);
    expect(p.hri).toEqual([]);
    expect(enc('ean-8', '02345673').rows[0]?.height).toBe(55);
    expect(enc('ean-8', '02345673').quietZone).toEqual({ left: 7, right: 7, top: 0, bottom: 0 });
  });

  it('hides markers on request', () => {
    const p = enc('ean-13', '9501101531000', { quietZoneMarkers: false });
    expect(p.hri.some((t) => t.role === 'quiet-zone-marker')).toBe(false);
    const q = enc('ean-8', '02345673');
    expect(q.hri.filter((t) => t.role === 'quiet-zone-marker').map((t) => t.text)).toEqual([
      '<',
      '>',
    ]);
  });

  it('has the same bars for EAN-13 0xxxxxxxxxxxx and UPC-A', () => {
    const u = enc('upc-a', '416000336108');
    const e = enc('ean-13', '0416000336108');
    expect(rowOf(u, 'symbol').widths).toEqual(rowOf(e, 'symbol').widths);
    expect(u.quietZone).toEqual({ left: 9, right: 9, top: 0, bottom: 0 });
  });
});

describe('HRI', () => {
  it('EAN-13', () => {
    const p = enc('ean-13', '9501101531000');
    expect(p.hri.map((t) => t.text).join(',')).toBe('9,5,0,1,1,0,1,5,3,1,0,0,0,>');
    expect(p.hri[0]).toMatchObject({ x: -4, anchor: 'end', y: 78, size: 11, role: 'hri' });
    expect(p.hri[1]?.x).toBe(6.5);
    expect(p.hri[6]?.x).toBe(3 + 35 + 3.5);
    expect(p.hri[7]?.x).toBe(53.5);
    expect(p.hri[12]?.x).toBe(50 + 35 + 3.5);
    expect(p.hri[13]).toMatchObject({ x: 102, anchor: 'end', role: 'quiet-zone-marker' });
  });

  it('UPC-E', () => {
    const p = enc('upc-e', '001234000057');
    expect(p.hri.map((t) => t.text).join(',')).toBe('0,0,1,2,3,4,5,7');
    expect(p.hri[0]).toMatchObject({ x: -5, anchor: 'end', size: 8 });
    expect(p.hri[1]?.x).toBe(6.5);
    expect(p.hri[7]).toMatchObject({ x: 54, anchor: 'start', size: 8 });
  });

  it('UPC-A', () => {
    const p = enc('upc-a', '416000336108');
    expect(p.hri.map((t) => t.text).join('')).toBe('416000336108');
    expect(p.hri[0]).toMatchObject({ x: -5, anchor: 'end', size: 8 });
    expect(p.hri.at(-1)).toMatchObject({ x: 100, anchor: 'start', size: 8 });
    expect(p.hri[1]?.x).toBe(13.5);
  });

  it('EAN-8 and add-on digits', () => {
    const p = enc('ean-8', '02345673');
    expect(p.hri.map((t) => t.text).join('')).toBe('<02345673>');
    expect(p.hri[1]?.x).toBe(6.5);
    expect(p.hri[5]?.x).toBe(39.5);
    expect(p.hri[0]).toMatchObject({ x: -7, anchor: 'start' });
    const a = enc('ean-13', '9771384524017', { addOn: '12' });
    const d = a.hri.filter((t) => t.y === 7.5);
    expect(d.map((t) => [t.text, t.x])).toEqual([
      ['1', 102 + 4 + 3.5],
      ['2', 102 + 13 + 3.5],
    ]);
  });
});

describe('not representable', () => {
  it.each([
    ['ean-13', '(01)19506000134359'],
    ['ean-13', '(01)00000095012346'],
    ['upc-a', '5901234123457'],
    ['ean-8', '9506000134352'],
    ['upc-e', '012345678905'],
    ['upc-a', '(01)00000095012346'],
  ] as const)('%s with %s', (form, data) => {
    const r = encodeEanUpc(form, data);
    expect(r.ok ? [] : [r.errors[0]?.code, r.errors[0]?.details?.['symbology']]).toEqual([
      'NOT_REPRESENTABLE',
      form,
    ]);
  });

  it('rejects an add-on on EAN-8', () => {
    const r = encodeEanUpc('ean-8', '96385074', { addOn: '12' });
    expect(!r.ok && r.errors[0]?.code).toBe('NOT_REPRESENTABLE');
  });

  it('still allows 0000000 RCNs', () => {
    expect(encodeEanUpc('ean-13', '(01)00000000123457').ok).toBe(true);
    expect(encodeEanUpc('ean-13', '0000012345670').ok).toBe(false);
  });

  it('passes data errors through', () => {
    const r = encodeEanUpc('ean-13', '9506000134353');
    expect(!r.ok && r.errors[0]?.code).toBe('CHECK_DIGIT');
    const s = encodeEanUpc('ean-13', 7 as unknown as string);
    expect(!s.ok && s.errors[0]?.code).toBe('INVALID_VALUE');
  });
});

describe('option checks', () => {
  const bad: [string, EanUpcForm, Record<string, unknown>, string][] = [
    ['addOn 3 digits', 'ean-13', { addOn: '123' }, 'addOn'],
    ['addOn letter', 'ean-13', { addOn: '1a' }, 'addOn'],
    ['addOn number', 'ean-13', { addOn: 12 }, 'addOn'],
    ['gap 6 on EAN-13', 'ean-13', { addOn: '12', addOnGap: 6 }, 'addOnGap'],
    ['gap 8 on UPC-A', 'upc-a', { addOn: '12', addOnGap: 8 }, 'addOnGap'],
    ['gap fractional', 'ean-13', { addOn: '12', addOnGap: 7.5 }, 'addOnGap'],
    ['gap 13', 'ean-13', { addOn: '12', addOnGap: 13 }, 'addOnGap'],
    ['gap string', 'ean-13', { addOnGap: '9' }, 'addOnGap'],
    ['height 0', 'ean-13', { height: 0 }, 'height'],
    ['height NaN', 'ean-13', { height: Number.NaN }, 'height'],
    ['height string', 'ean-13', { height: '5' }, 'height'],
    ['height over 1000', 'ean-13', { height: 1001 }, 'height'],
    ['hri string', 'ean-13', { hri: 'yes' }, 'hri'],
    ['markers number', 'ean-13', { quietZoneMarkers: 1 }, 'quietZoneMarkers'],
  ];
  it.each(bad)('%s', (_name, form, options, option) => {
    const data = form === 'upc-a' ? '416000336108' : '9501101531000';
    const r = encodeEanUpc(form, data, options);
    expect(r.ok ? [] : [r.errors[0]?.code, r.errors[0]?.details?.['option']]).toEqual([
      'INVALID_VALUE',
      option,
    ]);
  });

  it('rejects hostile options and forms without throwing', () => {
    expect(encodeEanUpc('ean-13', '9501101531000', 5 as never).ok).toBe(false);
    expect(encodeEanUpc('ean-13', '9501101531000', null as never).ok).toBe(false);
    expect(encodeEanUpc('code-39' as never, '9501101531000').ok).toBe(false);
    const thrower = new Proxy(
      {},
      {
        get: () => {
          throw new Error('boom');
        },
      },
    );
    expect(encodeEanUpc('ean-13', '9501101531000', thrower as never).ok).toBe(false);
  });
});

function expectFrozen(p: LinearPattern): void {
  expect(Object.isFrozen(p)).toBe(true);
  expect(Object.isFrozen(p.rows)).toBe(true);
  expect(Object.isFrozen(p.hri)).toBe(true);
  expect(Object.isFrozen(p.quietZone)).toBe(true);
  for (const r of p.rows) {
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.widths)).toBe(true);
  }
  for (const t of p.hri) expect(Object.isFrozen(t)).toBe(true);
}

describe('results', () => {
  it('are deeply frozen and rows fit in the width', () => {
    for (const [form, data, options] of [
      ['ean-13', '9501101531000', { addOn: '12' }],
      ['upc-a', '416000336108', { addOn: '54321', addOnGap: 11 }],
      ['ean-8', '02345673', {}],
      ['upc-e', '001234000057', { addOn: '99' }],
    ] as const) {
      const p = enc(form, data, options);
      expectFrozen(p);
      for (const r of p.rows)
        expect(r.x + r.widths.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(p.width);
    }
  });

  it('renders as a bitmap', () => {
    const p = enc('ean-8', '02345673');
    const [main] = patternToBitmap(p);
    expect(main).toBe('X X   XX X  X  XX XXXX X X   XX X X X  XXX X X    X   X  X    X X X');
  });

  it('accepts an ElementString', () => {
    const es = ElementString.from({ '01': '09501101531000' });
    expect(enc('ean-13', es)).toEqual(enc('ean-13', '9501101531000'));
  });

  it('encodes any valid GTIN', () => {
    fc.assert(
      fc.property(gtinArb(13), (g) => {
        fc.pre(!g.startsWith('00000') || g.slice(5, 7) === '00');
        const p = enc('ean-13', g);
        expect(rowOf(p, 'symbol').widths).toHaveLength(59);
        expect(rowOf(p, 'symbol').widths.reduce((a, b) => a + b, 0)).toBe(95);
      }),
    );
    fc.assert(
      fc.property(gtinArb(8), (g) => {
        expect(rowOf(enc('ean-8', g), 'symbol').widths.reduce((a, b) => a + b, 0)).toBe(67);
      }),
    );
    fc.assert(
      fc.property(upceGtinArb, addOnArb, (g, a) => {
        fc.pre(!g.startsWith('0000') || g.slice(4, 6) === '00');
        const p = enc('upc-e', g, { addOn: a });
        expect(rowOf(p, 'symbol').widths).toHaveLength(33);
        expect(rowOf(p, 'symbol').widths.reduce((x, y) => x + y, 0)).toBe(51);
        expect(rowOf(p, 'add-on').widths).toHaveLength(a.length === 2 ? 13 : 31);
      }),
    );
    fc.assert(
      fc.property(gtinArb(12), (g) => {
        fc.pre(!g.startsWith('0000') || g.slice(4, 6) === '00');
        expect(rowOf(enc('upc-a', g), 'symbol').widths).toHaveLength(59);
      }),
    );
  });
});

describe('toSvg keeps HRI inside the viewBox', () => {
  interface Placed {
    text: string;
    x: number;
    y: number;
    size: number;
    anchor: string;
  }
  function parse(svg: string): { w: number; h: number; texts: Placed[] } {
    const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
    const texts: Placed[] = [];
    for (const m of svg.matchAll(
      /<text x="(-?[\d.]+)" y="(-?[\d.]+)"[^>]*font-size="([\d.]+)" text-anchor="(\w+)"[^>]*>([^<]*)<\/text>/g,
    ))
      texts.push({
        x: Number(m[1]),
        y: Number(m[2]),
        size: Number(m[3]),
        anchor: m[4] ?? '',
        text: m[5] ?? '',
      });
    return { w: Number(vb?.[1]), h: Number(vb?.[2]), texts };
  }
  function expectInside(svg: string): void {
    const { w, h, texts } = parse(svg);
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      const adv = 0.6 * t.size * t.text.length;
      const x0 = t.anchor === 'start' ? t.x : t.anchor === 'middle' ? t.x - adv / 2 : t.x - adv;
      expect(x0).toBeGreaterThanOrEqual(-1e-6);
      expect(x0 + adv).toBeLessThanOrEqual(w + 1e-6);
      expect(t.y - 0.8 * t.size).toBeGreaterThanOrEqual(-1e-6);
      expect(t.y + 0.2 * t.size).toBeLessThanOrEqual(h + 1e-6);
    }
  }
  it('EAN-13 without a quiet zone shows the leading digit and the marker', () => {
    const p = enc('ean-13', '9506000134352');
    const svg = toSvg(p, { quietZone: false, moduleSize: 1 });
    expectInside(svg);
    expect(svg).toContain('>9</text>');
    expect(svg).toContain('&gt;</text>');
    expect(parse(svg).w).toBeGreaterThan(p.width);
  });
  it('EAN-13 with an add-on without a quiet zone keeps the add-on digits below the top edge', () => {
    const p = enc('ean-13', '9506000134352', { addOn: '12' });
    const svg = toSvg(p, { quietZone: false, moduleSize: 1 });
    expectInside(svg);
    const { texts } = parse(svg);
    expect(texts.some((t) => t.text === '1' || t.text === '2')).toBe(true);
  });
});
