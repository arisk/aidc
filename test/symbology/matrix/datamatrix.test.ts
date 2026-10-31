/* oxlint-disable typescript/no-unsafe-type-assertion -- JSON vector files and deliberately hostile inputs */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import vectors from '../../vectors/datamatrix.json' with { type: 'json' };
import { Gs1Error } from '../../../src/core/index.ts';
import type { Result } from '../../../src/core/index.ts';
import { format, parse, tryParse } from '../../../src/ai/index.ts';
import type { ElementString } from '../../../src/ai/index.ts';
import { tryParseDigitalLink, tryToDigitalLink } from '../../../src/digital-link/index.ts';
import type { DigitalLinkOptions } from '../../../src/digital-link/index.ts';
import { fromScan, toScan, tryToScan } from '../../../src/scan/index.ts';
import { matrixFromRows, toSvg } from '../../../src/symbology/render/index.ts';
import type { ModuleMatrix } from '../../../src/symbology/render/index.ts';
import { dmSize } from '../../../src/symbology/matrix/dm-tables.ts';
import type { DmSize } from '../../../src/symbology/matrix/dm-tables.ts';
import { placeCodewords } from '../../../src/symbology/matrix/dm-place.ts';
import { dataMatrix, gs1DataMatrix } from '../../../src/symbology/matrix/datamatrix.ts';
import type {
  DataMatrixDlOptions,
  DataMatrixOptions,
} from '../../../src/symbology/matrix/datamatrix.ts';
import { messageArb } from '../../support/arbitraries.ts';
import { gs1MessageArb, toBracketed, xRowsToMatrix } from '../../support/matrix.ts';

interface Sym {
  id: string;
  symbology: string;
  aimId: string;
  rawData: string;
  rows: number;
  cols: number;
  errorsCorrected?: number;
  expectError?: string;
  matrix: string[];
}
const SYMBOLS = vectors.symbols as unknown as Sym[];
const LOOSE = { validateAssociations: false } as const;

function vector(id: string): Sym {
  const v = SYMBOLS.find((s) => s.id === id);
  if (!v) throw new Error(`no vector ${id}`);
  return v;
}

function sizeOf(rows: number, columns: number): DmSize {
  const s = dmSize(rows, columns);
  if (!s) throw new Error(`no size ${rows}x${columns}`);
  return s;
}

function errorOf(r: Result<unknown>): Gs1Error {
  if (r.ok) throw new Error('expected failure');
  const e = r.errors[0];
  if (!e) throw new Error('no error');
  return e;
}

function brief(e: Gs1Error): { code: string; details: unknown } {
  return { code: e.code, details: e.details };
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

const esOf = (m: readonly (readonly [string, string])[]): ElementString =>
  parse(toBracketed(m), LOOSE);

/** Association-valid messages (a Digital Link needs a primary key). */
const dlMessageArb = messageArb.filter((m) => tryParse(toBracketed(m)).ok);

const dlOptionsArb: fc.Arbitrary<DigitalLinkOptions> = fc.record(
  {
    domain: fc.constantFrom(
      'https://id.gs1.org',
      'https://example.com',
      'https://brand.example.org/shop/p',
      'http://x.example',
    ),
    compressed: fc.constantFrom(false, true, 'partial' as const),
    attributeOrder: fc.constantFrom('canonical' as const, 'engine' as const),
  },
  { requiredKeys: [] },
);

const sizeArb: fc.Arbitrary<NonNullable<DataMatrixOptions['size']>> = fc.constantFrom(
  'square' as const,
  'rectangular' as const,
  'auto' as const,
  { rows: 144, columns: 144 },
  { rows: 32, columns: 32 },
  { rows: 16, columns: 48 },
);

// ---------------------------------------------------------------------------------------------
// Round trips

describe('gs1DataMatrix round trips', () => {
  it('encodes and decodes GS1 messages with every size option; fromScan agrees', () => {
    fc.assert(
      fc.property(gs1MessageArb, sizeArb, fc.boolean(), (m, size, optimizeOrder) => {
        const es = esOf(m);
        const r = gs1DataMatrix.tryEncode(es, { size, optimizeOrder });
        // Only a fixed shape or size can be too small for the data.
        const tooLong = !r.ok && errorOf(r).code === 'DATA_TOO_LONG' && size !== 'square';
        expect(r.ok || tooLong).toBe(true);
        if (!r.ok) return;
        const sym = r.value;
        expect(sym.kind).toBe('matrix');
        expect(sym.symbology).toBe('gs1-datamatrix');
        expect(sym.quietZone).toEqual({ left: 1, right: 1, top: 1, bottom: 1 });
        expect(sym.hri).toEqual([]);
        expect(Object.isFrozen(sym)).toBe(true);
        const d = gs1DataMatrix.decode(sym);
        const raw = format(es, 'raw', { optimizeOrder });
        expect(d.symbology).toBe('gs1-datamatrix');
        expect(d.aimId).toBe(']d2');
        expect(d.rawData).toBe(raw);
        expect(d.digitalLink).toBeUndefined();
        expect(d.errorsCorrected).toBe(0);
        expect(d.elementString.equivalent(es)).toBe(true);
        expect(fromScan(d.aimId + d.rawData, LOOSE).elementString.equals(d.elementString)).toBe(
          true,
        );
        expect(d.aimId + d.rawData).toBe(toScan(es, 'gs1-datamatrix', { optimizeOrder }));
        const md = d.metadata;
        expect([md.rows, md.columns]).toEqual([sym.height, sym.width]);
        const dm = sizeOf(md.rows, md.columns);
        expect(md.shape).toBe(dm.shape);
        expect(md.ecCodewords).toBe(dm.ecCodewords);
        expect(md.blocks).toBe(dm.blocks);
        expect(md.codewords[0]).toBe(232);
        expect(md.codewords.length).toBeLessThanOrEqual(dm.dataCodewords);
        expect(md.orientation).toEqual({ rotation: 0, mirrored: false });
        expect(md.inverted).toBe(false);
        expect(Object.isFrozen(d)).toBe(true);
        expect(Object.isFrozen(md)).toBe(true);
        expect(Object.isFrozen(md.codewords)).toBe(true);
        const got =
          typeof size === 'object' ? [md.rows, md.columns] : size === 'auto' ? 0 : md.shape;
        const want =
          typeof size === 'object' ? [size.rows, size.columns] : size === 'auto' ? 0 : size;
        expect(got).toEqual(want);
        // The same data through the Digital Link carrier's decoder is reported as GS1 DataMatrix.
        const viaDl = dataMatrix.decode(sym);
        expect(viaDl.symbology).toBe('gs1-datamatrix');
        expect(viaDl.rawData).toBe(raw);
      }),
      { numRuns: 500 },
    );
  }, 60_000);

  it('accepts bracketed strings without association rules', () => {
    const d = gs1DataMatrix.decode(gs1DataMatrix.encode('(10)ABC123(21)XYZ'));
    expect(d.rawData).toBe('10ABC123\u001d21XYZ');
  });

  it('encodes a GTIN as FNC1 then digit pairs, pads excluded from metadata.codewords', () => {
    const d = gs1DataMatrix.decode(gs1DataMatrix.encode('(01)09501101020917'));
    expect(d.metadata.codewords).toEqual([232, 131, 139, 180, 141, 131, 132, 139, 147]);
    expect([d.metadata.rows, d.metadata.columns]).toEqual([16, 16]);
  });
});

describe('dataMatrix round trips', () => {
  it('carries Digital Link URIs verbatim (custom domains, compressed forms)', () => {
    const uriArb = fc
      .tuple(dlMessageArb, dlOptionsArb)
      .map(([m, o]) => tryToDigitalLink(parse(toBracketed(m)), o))
      .filter((r) => r.ok)
      .map((r) => (r.ok ? r.value : ''));
    fc.assert(
      fc.property(uriArb, fc.constantFrom('square' as const, 'auto' as const), (uri, size) => {
        const sym = dataMatrix.encode(uri, { size });
        expect(sym.symbology).toBe('datamatrix');
        expect(Object.isFrozen(sym)).toBe(true);
        const d = dataMatrix.decode(sym);
        expect(d.symbology).toBe('datamatrix');
        expect(d.aimId).toBe(']d1');
        expect(d.rawData).toBe(uri);
        expect(d.digitalLink).toBe(uri);
        expect(d.metadata.codewords[0]).not.toBe(232);
        const parsed = tryParseDigitalLink(uri);
        expect(parsed.ok && parsed.value.elementString.equals(d.elementString)).toBe(true);
        const scan = fromScan(d.aimId + d.rawData);
        expect(scan.digitalLink).toBe(uri);
        expect(scan.elementString.equals(d.elementString)).toBe(true);
        expect(Object.isFrozen(d)).toBe(true);
      }),
      { numRuns: 500 },
    );
  }, 60_000);

  it('builds the URI from an element string exactly as toScan does', () => {
    fc.assert(
      fc.property(dlMessageArb, dlOptionsArb, (m, digitalLink) => {
        const es = parse(toBracketed(m));
        const scan0 = tryToScan(es, 'datamatrix', { digitalLink });
        fc.pre(scan0.ok);
        const want = scan0.ok ? scan0.value : '';
        const d = dataMatrix.decode(dataMatrix.encode(es, { digitalLink }));
        expect(d.aimId + d.rawData).toBe(want);
        const s = dataMatrix.decode(dataMatrix.encode(toBracketed(m), { digitalLink }));
        expect(s.aimId + s.rawData).toBe(want);
        const scan = fromScan(d.aimId + d.rawData);
        expect(scan.digitalLink).toBe(d.digitalLink);
        expect(scan.elementString.equals(d.elementString)).toBe(true);
      }),
      { numRuns: 500 },
    );
  }, 60_000);

  it('uses the default domain without options', () => {
    const d = dataMatrix.decode(dataMatrix.encode('(01)09501101020917(10)ABC'));
    expect(d.digitalLink).toBe('https://id.gs1.org/01/09501101020917/10/ABC');
  });

  it('validates element strings with the association rules (a URI needs a primary key)', () => {
    expect(errorOf(dataMatrix.tryEncode('(10)ABC')).code).toBe('MISSING_REQUIRED_AI');
    expect(gs1DataMatrix.tryEncode('(10)ABC').ok).toBe(true);
  });

  it('validates URI input with tryParseDigitalLink; the scheme test ignores case', () => {
    expect(errorOf(dataMatrix.tryEncode('https://example.com/hello')).code).toBe(
      'INVALID_DIGITAL_LINK',
    );
    expect(errorOf(dataMatrix.tryEncode('Https://id.gs1.org/01/09501101020917')).code).toBe(
      'INVALID_DIGITAL_LINK',
    );
    expect(errorOf(dataMatrix.tryEncode('HTTP://')).code).toBe('INVALID_DIGITAL_LINK');
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 1 at the API

describe('data that does not fit (Review Focus 1)', () => {
  it('explicit 10x10 with more than 3 data codewords is DATA_TOO_LONG limit 3', () => {
    expect(
      brief(
        errorOf(gs1DataMatrix.tryEncode('(01)09501101020917', { size: { rows: 10, columns: 10 } })),
      ),
    ).toEqual({
      code: 'DATA_TOO_LONG',
      details: { limit: 3, actual: 9, unit: 'codewords', size: { rows: 10, columns: 10 } },
    });
  });

  it("'rectangular' beyond 49 data codewords is DATA_TOO_LONG limit 49", () => {
    const data = `(01)09501101020917(10)ABCDEFGHIJKLMNOPQRST(21)abcdefghijklmnopqrst(91)${'A!B"C%D&E'.repeat(4)}`;
    const e = errorOf(gs1DataMatrix.tryEncode(data, { size: 'rectangular' }));
    expect(e.code).toBe('DATA_TOO_LONG');
    expect(e.details).toMatchObject({ limit: 49, unit: 'codewords' });
    expect(Number(e.details?.['actual'])).toBeGreaterThan(49);
    expect(gs1DataMatrix.tryEncode(data, { size: 'square' }).ok).toBe(true);
  });

  it('the DATA_TOO_LONG message says which size option helps', () => {
    expect(
      errorOf(gs1DataMatrix.tryEncode('(01)09501101020917', { size: { rows: 10, columns: 10 } }))
        .message,
    ).toBe(
      "Data needs 9 codewords, the limit is 3. Use size 'square' (the default) or 'auto', which pick the smallest size that fits.",
    );
    const data = `(01)09501101020917(10)ABCDEFGHIJKLMNOPQRST(21)abcdefghijklmnopqrst(91)${'A!B"C%D&E'.repeat(4)}`;
    expect(errorOf(gs1DataMatrix.tryEncode(data, { size: 'rectangular' })).message).toMatch(
      /^Data needs \d+ codewords, the limit is 49\. Use size 'square' \(the default\) or 'auto', which pick the smallest size that fits\.$/,
    );
    const uri = `https://id.gs1.org/01/09501101020917?x=${'A'.repeat(4000)}`;
    for (const size of ['square', 'auto'] as const)
      expect(errorOf(dataMatrix.tryEncode(uri, { size })).message).toMatch(
        /^Data needs \d+ codewords, the limit is 1558\. It does not fit the largest symbol \(144x144\); use less data\.$/,
      );
  });

  it('DMRE and unknown explicit sizes are INVALID_VALUE size', () => {
    for (const size of [
      { rows: 20, columns: 44 },
      { rows: 11, columns: 11 },
    ]) {
      expect(brief(errorOf(gs1DataMatrix.tryEncode('(01)09501101020917', { size })))).toEqual({
        code: 'INVALID_VALUE',
        details: { option: 'size' },
      });
      expect(
        brief(errorOf(dataMatrix.tryEncode('https://id.gs1.org/01/09501101020917', { size }))),
      ).toEqual({ code: 'INVALID_VALUE', details: { option: 'size' } });
    }
  });

  it('the largest square (1558 codewords) is the global limit', () => {
    const uri = `https://id.gs1.org/01/09501101020917?x=${'A'.repeat(4000)}`;
    for (const size of ['square', 'auto'] as const) {
      const e = errorOf(dataMatrix.tryEncode(uri, { size }));
      expect(e.code).toBe('DATA_TOO_LONG');
      expect(e.details).toMatchObject({ limit: 1558, unit: 'codewords' });
    }
    expect(thrown(() => dataMatrix.encode(uri))).toBeInstanceOf(Gs1Error);
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 5 at the API

describe('not GS1 (Review Focus 5)', () => {
  const both = [gs1DataMatrix, dataMatrix] as const;
  const specials: [string, string][] = [
    ['mode:macro05', 'macro'],
    ['mode:macro06', 'macro'],
    ['mode:eci26-base256', 'eci'],
    ['mode:structured-append-gs1', 'structured-append'],
    ['mode:reader-programming', 'reader-programming'],
    ['mode:fnc1-second-position', 'fnc1-second'],
  ];
  for (const [id, reason] of specials) {
    it(`${id} is UNSUPPORTED ${reason} through both objects`, () => {
      const v = vector(id);
      for (const s of both) {
        const e = errorOf(s.tryDecode(xRowsToMatrix(v.matrix)));
        expect(e.code).toBe('UNSUPPORTED');
        expect(e.details).toMatchObject({ reason, aimId: v.aimId, rawData: v.rawData });
      }
    });
  }

  it('plain text Data Matrix is not-gs1 with the text through both objects', () => {
    // "HELLO" in ASCII, hand-built: no FNC1.
    const m = placeCodewords(sizeOf(12, 12), [73, 70, 77, 77, 80]);
    expect(brief(errorOf(gs1DataMatrix.tryDecode(m)))).toEqual({
      code: 'UNSUPPORTED',
      details: { reason: 'not-gs1', aimId: ']d1', text: 'HELLO' },
    });
    expect(brief(errorOf(dataMatrix.tryDecode(m)))).toEqual({
      code: 'UNSUPPORTED',
      details: { reason: 'not-gs1', aimId: ']d1', text: 'HELLO' },
    });
  });

  it('gs1DataMatrix.decode of a Digital Link symbol is not-gs1', () => {
    const uri = 'https://id.gs1.org/01/09501101020917';
    expect(brief(errorOf(gs1DataMatrix.tryDecode(dataMatrix.encode(uri))))).toEqual({
      code: 'UNSUPPORTED',
      details: { reason: 'not-gs1', aimId: ']d1', text: uri },
    });
    const e = thrown(() => gs1DataMatrix.decode(dataMatrix.encode(uri)));
    expect(e).toBeInstanceOf(Gs1Error);
  });

  it('dataMatrix.decode of ]d1 text that is not a Digital Link URI is not-gs1', () => {
    for (const text of ['https://example.com/hello', 'Https://id.gs1.org/01/09501101020917']) {
      const m = placeCodewords(
        sizeOf(26, 26),
        Array.from({ length: text.length }, (_, i) => text.charCodeAt(i) + 1),
      );
      expect(brief(errorOf(dataMatrix.tryDecode(m)))).toEqual({
        code: 'UNSUPPORTED',
        details: { reason: 'not-gs1', aimId: ']d1', text },
      });
    }
  });

  const readable = SYMBOLS.filter((v) => v.expectError === undefined);
  const gs1Vectors = readable.filter(
    (v) => v.symbology === 'gs1-datamatrix' && !v.id.includes('structured-append'),
  );
  const dlVectors = readable.filter((v) => v.rawData.startsWith('https://'));
  const otherVectors = readable.filter((v) => !gs1Vectors.includes(v) && !dlVectors.includes(v));

  it('an uncorrectable vector is RS_UNCORRECTABLE through both objects', () => {
    const v = vector('damage:dmg-19-20x20-10-codewords');
    for (const s of [gs1DataMatrix, dataMatrix])
      expect(errorOf(s.tryDecode(xRowsToMatrix(v.matrix))).code).toBe(v.expectError);
  });

  it('decodes the GS1 vector symbols through both objects', () => {
    expect(gs1Vectors.length).toBeGreaterThan(15);
    for (const v of gs1Vectors) {
      const m = xRowsToMatrix(v.matrix);
      const d = gs1DataMatrix.decode(m);
      expect([d.symbology, d.aimId, d.rawData, d.errorsCorrected]).toEqual([
        'gs1-datamatrix',
        ']d2',
        v.rawData,
        v.errorsCorrected ?? 0,
      ]);
      expect(dataMatrix.decode(m).symbology).toBe('gs1-datamatrix');
    }
  });

  it('decodes the Digital Link vector symbols only through dataMatrix', () => {
    expect(dlVectors.length).toBeGreaterThan(1);
    for (const v of dlVectors) {
      const m = xRowsToMatrix(v.matrix);
      const d = dataMatrix.decode(m);
      expect([d.symbology, d.aimId, d.rawData, d.digitalLink]).toEqual([
        'datamatrix',
        ']d1',
        v.rawData,
        v.rawData,
      ]);
      expect(errorOf(gs1DataMatrix.tryDecode(m)).details?.['reason']).toBe('not-gs1');
    }
  });

  it('rejects the other vector symbols through both objects', () => {
    expect(otherVectors.length).toBeGreaterThan(30);
    for (const v of otherVectors) {
      const m = xRowsToMatrix(v.matrix);
      expect(errorOf(gs1DataMatrix.tryDecode(m)).code).toBe('UNSUPPORTED');
      expect(errorOf(dataMatrix.tryDecode(m)).code).toBe('UNSUPPORTED');
    }
  });

  it('GS1 data errors index rawData', () => {
    // FNC1, then "01" "23" (AI 01 with a too short GTIN).
    const m = placeCodewords(sizeOf(10, 10), [232, 131, 153]);
    const e = errorOf(gs1DataMatrix.tryDecode(m));
    expect(e.code).not.toBe('UNSUPPORTED');
    expect(errorOf(dataMatrix.tryDecode(m)).code).toBe(e.code);
  });
});

// ---------------------------------------------------------------------------------------------
// Decoder input

describe('decoder input', () => {
  it('reports orientation and inversion', () => {
    const sym = gs1DataMatrix.encode('(01)09501101020917(10)ABC');
    const flipped = matrixFromRows(sym.rows.map((_, i, a) => a[a.length - 1 - i] ?? ''));
    const d = gs1DataMatrix.decode(flipped);
    expect(d.metadata.orientation).toEqual({ rotation: 180, mirrored: true });
    const inv = matrixFromRows(
      sym.rows.map((r) => r.replaceAll('1', 'x').replaceAll('0', '1').replaceAll('x', '0')),
    );
    expect(dataMatrix.decode(inv).metadata.inverted).toBe(true);
  });

  it('passes errorsCorrected through for a damaged symbol', () => {
    const v = vector('damage:dmg-19-20x20-9-codewords');
    const d = gs1DataMatrix.decode(xRowsToMatrix(v.matrix));
    expect(d.errorsCorrected).toBe(v.errorsCorrected);
    expect(d.rawData).toBe(v.rawData);
  });

  it('throws only Gs1Error for hostile input', () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      'x',
      {},
      { kind: 'matrix', rows: ['01', '1'] },
      new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        },
      ),
      matrixFromRows(['1']),
      matrixFromRows(Array.from({ length: 20 }, () => '1'.repeat(20))),
    ];
    for (const h of hostile)
      for (const s of [gs1DataMatrix, dataMatrix]) {
        expect(s.tryDecode(h as ModuleMatrix).ok).toBe(false);
        expect(thrown(() => s.decode(h as ModuleMatrix))).toBeInstanceOf(Gs1Error);
      }
  });
});

// ---------------------------------------------------------------------------------------------
// Options

describe('options', () => {
  const data = '(01)09501101020917(10)ABC';
  const bad: [string, unknown][] = [
    ['size', 'big'],
    ['size', { rows: 10 }],
    ['size', 10],
    ['size', null],
    ['hriSize', 0],
    ['hriSize', -1],
    ['hriSize', Number.NaN],
    ['hriSize', Number.POSITIVE_INFINITY],
    ['hriSize', 1e308],
    ['hriSize', 1001],
    ['hriSize', '3'],
    ['encodation', 'base256'],
    ['encodation', 1],
    ['hri', 'yes'],
    ['optimizeOrder', 1],
  ];
  for (const [option, value] of bad) {
    it(`${option}: ${String(value)} is INVALID_VALUE`, () => {
      for (const s of [gs1DataMatrix, dataMatrix]) {
        const opts = { [option]: value } as DataMatrixOptions;
        expect(brief(errorOf(s.tryEncode(data, opts)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option },
        });
        expect(thrown(() => s.encode(data, opts))).toBeInstanceOf(Gs1Error);
      }
    });
  }

  it('collects every option error', () => {
    const r = gs1DataMatrix.tryEncode(data, {
      size: 'big',
      hri: 'yes',
    } as unknown as DataMatrixOptions);
    expect(r.ok ? [] : r.errors.map((e) => e.details?.['option'])).toEqual(['size', 'hri']);
  });

  it('digitalLink must be an object with valid fields (dataMatrix)', () => {
    const throwing = {
      get domain(): string {
        throw new Error('boom');
      },
    };
    for (const digitalLink of [
      5,
      'x',
      null,
      [],
      { domain: 5 },
      { attributeOrder: 'x' },
      { compressed: 'x' },
      { allowUnknownAIs: 'x' },
      throwing,
    ])
      expect(
        brief(
          errorOf(dataMatrix.tryEncode(data, { digitalLink } as unknown as DataMatrixDlOptions)),
        ),
      ).toEqual({ code: 'INVALID_VALUE', details: { option: 'digitalLink' } });
  });

  it('passes every digitalLink field on', () => {
    const digitalLink = {
      domain: 'https://example.com',
      attributeOrder: 'engine',
      compressed: false,
      allowUnknownAIs: true,
    } as const;
    const d = dataMatrix.decode(dataMatrix.encode('(01)09501101020917(99)X', { digitalLink }));
    expect(d.digitalLink).toBe(
      toScan('(01)09501101020917(99)X', 'datamatrix', { digitalLink }).slice(3),
    );
  });

  it('rejects options that are not objects and hostile getters', () => {
    for (const s of [gs1DataMatrix, dataMatrix]) {
      for (const o of [null, 'x', 5])
        expect(brief(errorOf(s.tryEncode(data, o as unknown as DataMatrixOptions)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option: 'options' },
        });
      const getter = {
        get size(): string {
          throw new Error('boom');
        },
      };
      expect(brief(errorOf(s.tryEncode(data, getter as unknown as DataMatrixOptions)))).toEqual({
        code: 'INVALID_VALUE',
        details: { option: 'size' },
      });
      const sizeGetter = {
        size: {
          rows: 10,
          get columns(): number {
            throw new Error('boom');
          },
        },
      };
      expect(brief(errorOf(s.tryEncode(data, sizeGetter as unknown as DataMatrixOptions)))).toEqual(
        { code: 'INVALID_VALUE', details: { option: 'size' } },
      );
      const proxy = new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        },
      );
      const r = s.tryEncode(data, proxy);
      expect(r.ok).toBe(false);
      expect(errorOf(r).code).toBe('INVALID_VALUE');
    }
  });

  it('rejects data that is neither a string nor an ElementString', () => {
    for (const s of [gs1DataMatrix, dataMatrix])
      for (const d of [42, null, undefined, {}])
        expect(brief(errorOf(s.tryEncode(d as string)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option: 'data' },
        });
  });

  it("encodation 'ascii' uses ASCII only; 'auto' may use fewer codewords", () => {
    const text = '(10)ABCDEFGHIJKLMNOPQRST';
    const ascii = gs1DataMatrix.decode(gs1DataMatrix.encode(text, { encodation: 'ascii' }));
    const auto = gs1DataMatrix.decode(gs1DataMatrix.encode(text));
    expect(ascii.metadata.encodation).toEqual(['ascii']);
    expect(auto.metadata.encodation).toContain('c40');
    expect(auto.metadata.codewords.length).toBeLessThan(ascii.metadata.codewords.length);
  });

  it('hri: true gives one line per element string below the symbol (H17)', () => {
    const sym = gs1DataMatrix.encode(data, { hri: true });
    const h = sym.height;
    expect(sym.hri).toEqual([
      { text: '(01)09501101020917', x: 0, y: h + 1 + 2.4, size: 3, anchor: 'start', role: 'hri' },
      { text: '(10)ABC', x: 0, y: h + 1 + 2.4 + 3.6, size: 3, anchor: 'start', role: 'hri' },
    ]);
    expect(Object.isFrozen(sym.hri[0])).toBe(true);
    const big = gs1DataMatrix.encode(data, { hri: true, hriSize: 5 });
    expect(big.hri.map((t) => [t.y, t.size])).toEqual([
      [big.height + 1 + 4, 5],
      [big.height + 1 + 4 + 6, 5],
    ]);
    expect(gs1DataMatrix.encode(data, { hri: false }).hri).toEqual([]);
  });

  it('toSvg accepts encode output for the largest hriSize', () => {
    const sym = gs1DataMatrix.encode(data, { hri: true, hriSize: 1000 });
    expect(thrown(() => toSvg(sym))).toBeUndefined();
  });

  it('data whose prototype lookup throws is INVALID_VALUE with option data', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    for (const s of [gs1DataMatrix, dataMatrix]) {
      expect(brief(errorOf(s.tryEncode(hostile as never)))).toEqual({
        code: 'INVALID_VALUE',
        details: { option: 'data' },
      });
    }
  });

  it('hri lines follow the encoded order with optimizeOrder', () => {
    const sym = gs1DataMatrix.encode('(10)ABC(01)09501101020917(17)271231', {
      hri: true,
      optimizeOrder: true,
    });
    expect(sym.hri.map((t) => t.text)).toEqual(['(01)09501101020917', '(17)271231', '(10)ABC']);
    expect(gs1DataMatrix.decode(sym).rawData).toBe('01095011010209171727123110ABC');
  });

  it('the Digital Link carrier shows the element string the URI carries', () => {
    const uri = 'https://example.com/01/09501101020917/10/ABC?17=271231';
    const sym = dataMatrix.encode(uri, { hri: true });
    expect(sym.hri.map((t) => t.text)).toEqual(['(01)09501101020917', '(10)ABC', '(17)271231']);
    const fromEs = dataMatrix.encode(parse('(01)09501101020917(10)ABC'), { hri: true });
    expect(fromEs.hri.map((t) => t.text)).toEqual(['(01)09501101020917', '(10)ABC']);
  });
});

describe('input meant for the other object', () => {
  it('a Digital Link URI given to gs1DataMatrix is INVALID_VALUE data pointing to dataMatrix', () => {
    const uri = 'https://id.gs1.org/01/09506000134352';
    const e = errorOf(gs1DataMatrix.tryEncode(uri));
    expect(brief(e)).toEqual({
      code: 'INVALID_VALUE',
      details: { option: 'data', hint: 'Encode GS1 Digital Link URIs with dataMatrix' },
    });
    expect(e.message).toBe(
      'gs1DataMatrix takes a GS1 element string such as "(01)09506000134352", not a URI. Encode GS1 Digital Link URIs with dataMatrix.',
    );
    expect(dataMatrix.tryEncode(uri).ok).toBe(true);
  });

  it('plain text given to dataMatrix is INVALID_VALUE data naming the accepted inputs', () => {
    const e = errorOf(dataMatrix.tryEncode('hello world'));
    expect(e.code).toBe('INVALID_VALUE');
    expect(e.details).toMatchObject({ option: 'data' });
    expect(e.message).toMatch(
      /^dataMatrix carries a GS1 Digital Link URI or a GS1 element string; plain text is not supported\. Pass /,
    );
    expect(errorOf(dataMatrix.tryEncode('(01)09506000134353')).code).toBe('CHECK_DIGIT');
    expect(errorOf(gs1DataMatrix.tryEncode('hello world')).code).toBe('SYNTAX');
  });
});

describe('objects', () => {
  it('have their names and are frozen', () => {
    expect(gs1DataMatrix.name).toBe('gs1-datamatrix');
    expect(dataMatrix.name).toBe('datamatrix');
    expect(Object.isFrozen(gs1DataMatrix)).toBe(true);
    expect(Object.isFrozen(dataMatrix)).toBe(true);
  });
});
