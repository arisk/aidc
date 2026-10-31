import { describe, expect, it } from 'vitest';
import { Gs1Error } from '../../../src/core/index.ts';
import {
  linearPattern,
  matrixFromRows,
  toSvg,
  tryToSvg,
} from '../../../src/symbology/render/index.ts';
import type {
  LinearPattern,
  ModuleMatrix,
  SvgOptions,
} from '../../../src/symbology/render/index.ts';
import { num } from '../../../src/symbology/render/svg.ts';
import file from '../../vectors/render.json' with { type: 'json' };

function asPattern(v: unknown): LinearPattern {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately hostile or JSON input
  return v as LinearPattern;
}
function asMatrix(v: unknown): ModuleMatrix {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately hostile input
  return v as ModuleMatrix;
}
function asOptions(v: unknown): SvgOptions {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately hostile input
  return v as SvgOptions;
}
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}
function code(fn: () => unknown): string | undefined {
  const e = thrown(fn);
  return e instanceof Gs1Error ? e.code : `non-Gs1Error: ${String(e)}`;
}

const p3 = linearPattern([1, 1, 1]);
const withQz: LinearPattern = { ...p3, quietZone: { left: 2, right: 3, top: 1, bottom: 4 } };
const withHri: LinearPattern = {
  ...p3,
  hri: [{ text: 'a<b', x: 1, y: 2, size: 1, anchor: 'start', role: 'hri' }],
};

describe('num', () => {
  it('formats', () => {
    expect(num(1.23456)).toBe('1.235');
    expect(num(2.5)).toBe('2.5');
    expect(num(1e-7)).toBe('0');
    expect(num(-0)).toBe('0');
    expect(num(-0.0001)).toBe('0');
    expect(num(7)).toBe('7');
    expect(num(-1.5)).toBe('-1.5');
    expect(num(123456789012)).toBe('123456789012');
  });
});

describe('vectors', () => {
  for (const v of file.vectors) {
    it(`vector ${v.id}`, () => {
      expect(toSvg(asPattern(v.pattern), asOptions(v.options))).toBe(v.svg);
    });
  }
});

describe('quiet zone option', () => {
  it('defaults to the pattern minimums', () => {
    expect(toSvg(withQz, { moduleSize: 1 })).toContain('viewBox="0 0 8 6"');
    expect(toSvg(withQz, { moduleSize: 1, quietZone: true })).toContain('viewBox="0 0 8 6"');
    expect(toSvg(withQz, { moduleSize: 1 })).toContain('d="M2 1h1v1h-1zM4 1h1v1h-1z"');
  });
  it('false drops the offsets', () => {
    const s = toSvg(withQz, { moduleSize: 1, quietZone: false });
    expect(s).toContain('viewBox="0 0 3 1"');
    expect(s).toContain('d="M0 0h1v1h-1zM2 0h1v1h-1z"');
  });
  it('a number sets all sides', () => {
    expect(toSvg(withQz, { moduleSize: 1, quietZone: 3 })).toContain('viewBox="0 0 9 7"');
  });
  it('an object overrides single sides', () => {
    expect(toSvg(withQz, { moduleSize: 1, quietZone: { left: 1 } })).toContain('viewBox="0 0 7 6"');
  });
});

describe('background and hri', () => {
  it('background null has no rect', () => {
    expect(toSvg(p3, { background: null })).not.toContain('<rect');
    expect(toSvg(p3, { background: '#eee' })).toContain('fill="#eee"/>');
  });
  it('hri false has no text and no extra height', () => {
    expect(toSvg(withHri)).toContain('<text');
    const off = toSvg(withHri, { hri: false, moduleSize: 1 });
    expect(off).not.toContain('<text');
    expect(off).toContain('viewBox="0 0 3 1"');
  });
  it('hri below the content box adds height', () => {
    expect(toSvg(withHri, { moduleSize: 1 })).toContain('viewBox="0 0 3 2.2"');
  });
  it('writes text escaped', () => {
    expect(toSvg(withHri)).toContain('>a&lt;b</text>');
  });
});

describe('injection', () => {
  const evil = 'a"<>&\'b';
  it('escapes title and attributes', () => {
    const s = toSvg(withHri, { title: evil, fontFamily: evil });
    expect(s).toContain('<title>a"&lt;&gt;&amp;\'b</title>');
    const attrs = s.slice(s.indexOf('</title>'));
    expect(attrs).not.toContain('"<');
    expect(attrs).not.toContain("'b");
    expect(attrs).toContain('a&quot;&lt;&gt;&amp;&#39;b');
    // every attribute value is quote-free and has no raw '<'
    for (const m of s.split('="').slice(1)) {
      const value = m.slice(0, m.indexOf('"'));
      expect(value).not.toContain('<');
    }
  });
  it('rejects control characters', () => {
    expect(code(() => toSvg(p3, { title: 'a\u0001' }))).toBe('INVALID_CHAR');
    expect(code(() => toSvg(p3, { fontFamily: 'a\u0000' }))).toBe('INVALID_CHAR');
    const bad: LinearPattern = {
      ...p3,
      hri: [{ text: 'x\u001f', x: 0, y: 0, size: 1, anchor: 'start', role: 'hri' }],
    };
    expect(code(() => toSvg(bad))).toBe('INVALID_CHAR');
    expect(toSvg(bad, { hri: false })).not.toContain('<text');
    expect(toSvg(p3, { title: 'a\tb\nc\rd' })).toContain('<title>a\tb\nc\rd</title>');
  });
});

describe('colors and size (security review)', () => {
  it.each([
    '#000',
    '#ABCD',
    '#00ff00',
    '#00ff0080',
    'red',
    'transparent',
    'rgb(0, 128, 255)',
    'rgba(0 0 0 / 50%)',
    'hsl(120deg 50% 50%)',
  ])('accepts the color %s', (c) => {
    expect(toSvg(p3, { foreground: c, background: c })).toContain(`fill="${c}"`);
  });
  it.each([
    'url(https://x/y#a)',
    'url(#a)',
    'red;x',
    '#12',
    '#ggg',
    'rgb(1,2,3) url(#a)',
    'a"<>&\'b',
    '',
    'var(--x)',
  ])('rejects the color %j', (c) => {
    for (const option of ['foreground', 'background'] as const) {
      const e = thrown(() => toSvg(p3, { [option]: c }));
      expect(e instanceof Gs1Error ? [e.code, e.details?.['option']] : e).toEqual([
        'INVALID_VALUE',
        option,
      ]);
    }
  });
  it('caps the image at 1,000,000 units wide or high', () => {
    const big = (o: object): unknown => {
      const e = thrown(() => toSvg(p3, o));
      return e instanceof Gs1Error ? e.details?.['option'] : e;
    };
    expect(big({ moduleSize: 1e12 })).toBe('moduleSize');
    expect(big({ quietZone: 1e12 })).toBe('moduleSize');
    expect(toSvg(p3, { moduleSize: 1000 })).toContain('<svg');
  });
});

describe('option and pattern validation', () => {
  it.each([0, -1, Number.NaN, Infinity, '2', null, 1e300])('moduleSize %s', (v) => {
    const e = thrown(() => toSvg(p3, asOptions({ moduleSize: v })));
    expect(e).toBeInstanceOf(Gs1Error);
    expect(e).toMatchObject({ code: 'INVALID_VALUE', details: { option: 'moduleSize' } });
  });
  it.each([
    ['unit', 'cm'],
    ['quietZone', 'yes'],
    ['quietZone', -1],
    ['quietZone', { left: Number.NaN }],
    ['quietZone', { top: '1' }],
    ['quietZone', null],
    ['hri', 1],
    ['foreground', 3],
    ['background', 5],
    ['fontFamily', {}],
    ['title', 3],
  ])('option %s = %j', (name, value) => {
    expect(code(() => toSvg(p3, asOptions({ [name]: value })))).toBe('INVALID_VALUE');
  });
  it('rejects a non-object options', () => {
    expect(code(() => toSvg(p3, asOptions(5)))).toBe('INVALID_VALUE');
    expect(code(() => toSvg(p3, asOptions(null)))).toBe('INVALID_VALUE');
  });
  it('undefined option values use defaults', () => {
    expect(toSvg(p3, asOptions({ moduleSize: undefined }))).toBe(toSvg(p3));
  });
  it.each([null, undefined, 5, 'x', [], {}, { kind: 'matrix' }, { kind: 'linear' }])(
    'hostile pattern %j',
    (v) => {
      expect(code(() => toSvg(asPattern(v)))).toBe('INVALID_SYMBOL');
      const r = tryToSvg(asPattern(v));
      expect(r.ok).toBe(false);
    },
  );
  it('rejects malformed fields', () => {
    const bad = [
      { ...p3, width: 'x' },
      { ...p3, height: Number.NaN },
      { ...p3, width: 1e30 },
      { ...p3, rows: 'x' },
      { ...p3, rows: [null] },
      { ...p3, rows: [{ role: 'symbol', x: 0, y: 0, height: 1, widths: [1, Infinity] }] },
      { ...p3, rows: [{ role: 'symbol', x: 0, y: 0, height: 1, widths: [-1] }] },
      { ...p3, rows: [{ role: 'symbol', x: 'a', y: 0, height: 1, widths: [1] }] },
      { ...p3, rows: [{ role: 'symbol', x: 0, y: 0, height: 1 }] },
      { ...p3, hri: 'x' },
      { ...p3, hri: [{ text: 5, x: 0, y: 0, size: 1, anchor: 'start' }] },
      { ...p3, hri: [{ text: 'a', x: 0, y: 0, size: 1, anchor: 'left' }] },
      { ...p3, hri: [{ text: 'a', x: 0, y: Number.NaN, size: 1, anchor: 'start' }] },
      { ...p3, quietZone: null },
      { ...p3, quietZone: { left: 0, right: 0, top: 0 } },
      { ...p3, quietZone: { left: -1, right: 0, top: 0, bottom: 0 } },
      { ...p3, bearer: { sides: 'x', width: 1 } },
      { ...p3, bearer: { sides: 'frame', width: -1 } },
      { ...p3, bearer: 5 },
    ];
    for (const b of bad) expect(code(() => toSvg(asPattern(b)))).toBe('INVALID_SYMBOL');
  });
  it('survives throwing getters and proxies', () => {
    const evil = asPattern({
      kind: 'linear',
      get rows(): never {
        throw new TypeError('boom');
      },
    });
    expect(code(() => toSvg(evil))).toBe('INVALID_SYMBOL');
    const options = asOptions({
      get moduleSize(): never {
        throw new TypeError('boom');
      },
    });
    expect(tryToSvg(p3, options).ok).toBe(false);
  });
  it('tryToSvg returns ok', () => {
    const r = tryToSvg(p3);
    expect(r.ok).toBe(true);
  });
});

describe('top-bottom bearer', () => {
  it('adds two full-width rectangles', () => {
    const p: LinearPattern = {
      ...p3,
      quietZone: { left: 1, right: 1, top: 0, bottom: 0 },
      bearer: { sides: 'top-bottom', width: 2 },
    };
    const s = toSvg(p, { moduleSize: 1 });
    expect(s).toContain('viewBox="0 0 5 5"');
    expect(s).toContain('d="M0 0h5v2h-5zM0 3h5v2h-5zM1 2h1v1h-1zM3 2h1v1h-1z"');
  });
});

describe('matrices', () => {
  const m = matrixFromRows(['101', '101']);
  const withQuiet: ModuleMatrix = { ...m, quietZone: { left: 1, right: 1, top: 1, bottom: 1 } };
  it('uses the matrix quiet zone by default and with true', () => {
    expect(toSvg(withQuiet, { moduleSize: 1 })).toContain('viewBox="0 0 5 4"');
    expect(toSvg(withQuiet, { moduleSize: 1, quietZone: true })).toContain('viewBox="0 0 5 4"');
  });
  it('quietZone false drops the margin', () => {
    const s = toSvg(withQuiet, { moduleSize: 1, quietZone: false });
    expect(s).toContain('viewBox="0 0 3 2"');
    expect(s).toContain('d="M0 0h1v2h-1zM2 0h1v2h-1z"');
  });
  it('a bearer on a matrix is ignored', () => {
    const withBearer = { ...withQuiet, bearer: { sides: 'frame', width: 3 } };
    expect(toSvg(asMatrix(withBearer), { moduleSize: 1 })).toBe(
      toSvg(withQuiet, { moduleSize: 1 }),
    );
  });
  it('places text below the content by the bottom rule', () => {
    const t: ModuleMatrix = {
      ...withQuiet,
      hri: [{ text: 'ab', x: 0, y: 3.4, size: 1, anchor: 'start', role: 'hri' }],
    };
    // body height 4; y - height = 1.4 below the body bottom: baseline 4 + 1.4 = 5.4
    const s = toSvg(t, { moduleSize: 1 });
    expect(s).toContain('<text x="1" y="5.4"');
    expect(s).toContain('viewBox="0 0 5 5.6"');
    expect(toSvg(t, { moduleSize: 1, hri: false })).toContain('viewBox="0 0 5 4"');
  });
  it('tryToSvg and hostile matrices give Gs1Error only', () => {
    expect(tryToSvg(withQuiet).ok).toBe(true);
    for (const bad of [
      { kind: 'matrix', rows: ['12'], quietZone: { left: 0, right: 0, top: 0, bottom: 0 } },
      { kind: 'matrix', rows: ['1'] },
      { kind: 'matrix', rows: ['1'], quietZone: null },
      { kind: 'matrix', rows: Array.from({ length: 1025 }, () => '1') },
    ]) {
      const r = tryToSvg(asMatrix(bad));
      expect(r.ok).toBe(false);
      expect(code(() => toSvg(asMatrix(bad)))).toBe('INVALID_SYMBOL');
    }
  });
});
