/* oxlint-disable typescript/no-unsafe-type-assertion -- deliberately hostile inputs and option values */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Gs1Error } from '../../../src/core/index.ts';
import type { Result } from '../../../src/core/index.ts';
import { format, parse, tryParse } from '../../../src/ai/index.ts';
import type { ElementString } from '../../../src/ai/index.ts';
import { tryParseDigitalLink, tryToDigitalLink } from '../../../src/digital-link/index.ts';
import type { DigitalLinkOptions } from '../../../src/digital-link/index.ts';
import { fromScan, toScan, tryToScan } from '../../../src/scan/index.ts';
import { matrixFromRows, toSvg } from '../../../src/symbology/render/index.ts';
import type { ModuleMatrix } from '../../../src/symbology/render/index.ts';
import { buildSymbol } from '../../../src/symbology/matrix/qr-place.ts';
import { countBits, qrVersion } from '../../../src/symbology/matrix/qr-tables.ts';
import type { QrEcLevel } from '../../../src/symbology/matrix/qr-tables.ts';
import { gs1Qr, qr } from '../../../src/symbology/matrix/qr.ts';
import type { QrDlOptions, QrOptions } from '../../../src/symbology/matrix/qr.ts';
import { messageArb } from '../../support/arbitraries.ts';
import { gs1MessageArb, toBracketed } from '../../support/matrix.ts';

const LOOSE = { validateAssociations: false } as const;
const GS = '\u001d';
const LEVELS: readonly QrEcLevel[] = ['L', 'M', 'Q', 'H'];

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
      'HTTPS://ID.GS1.ORG',
      'HTTP://EXAMPLE.COM',
    ),
    compressed: fc.constantFrom(false, true, 'partial' as const),
    attributeOrder: fc.constantFrom('canonical' as const, 'engine' as const),
  },
  { requiredKeys: [] },
);

/** A big-endian bit writer for hand-built streams (as in qr-decode.test.ts). */
class Bits {
  readonly bits: number[] = [];
  put(value: number, n: number): this {
    for (let i = n - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
    return this;
  }
  /** Terminator, zero bits to the codeword boundary, 0xEC/0x11 pads. */
  codewords(version: number, level: QrEcLevel): number[] {
    const capacity = qrVersion(version).levels[level].dataCodewords;
    const bits = this.bits.slice();
    for (let i = 0; i < 4 && bits.length < capacity * 8; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const out: number[] = [];
    for (let i = 0; i < bits.length; i += 8)
      out.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
    for (let k = 0; out.length < capacity; k++) out.push(k % 2 === 0 ? 0xec : 0x11);
    return out;
  }
  symbol(version = 2, level: QrEcLevel = 'L'): ModuleMatrix {
    return buildSymbol(version, level, this.codewords(version, level), 'auto');
  }
}

const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function alnum(b: Bits, text: string, version = 2): Bits {
  b.put(0b0010, 4).put(text.length, countBits('alphanumeric', version));
  let i = 0;
  for (; i + 2 <= text.length; i += 2)
    b.put(ALNUM.indexOf(text[i] ?? '') * 45 + ALNUM.indexOf(text[i + 1] ?? ''), 11);
  if (i < text.length) b.put(ALNUM.indexOf(text[i] ?? ''), 6);
  return b;
}

function bytes(b: Bits, text: string, version = 2): Bits {
  b.put(0b0100, 4).put(text.length, countBits('byte', version));
  for (const c of text) b.put(c.charCodeAt(0), 8);
  return b;
}

// ---------------------------------------------------------------------------------------------
// Round trips

describe('gs1Qr round trips', () => {
  it('encodes and decodes GS1 messages at every ecLevel; fromScan agrees', () => {
    fc.assert(
      fc.property(
        gs1MessageArb,
        fc.constantFrom(...LEVELS),
        fc.boolean(),
        (m, ecLevel, optimizeOrder) => {
          const es = esOf(m);
          const sym = gs1Qr.encode(es, { ecLevel, optimizeOrder });
          expect(sym.kind).toBe('matrix');
          expect(sym.symbology).toBe('gs1-qr');
          expect(sym.quietZone).toEqual({ left: 4, right: 4, top: 4, bottom: 4 });
          expect(sym.hri).toEqual([]);
          expect(Object.isFrozen(sym)).toBe(true);
          const d = gs1Qr.decode(sym);
          const raw = format(es, 'raw', { optimizeOrder });
          expect(d.symbology).toBe('gs1-qr');
          expect(d.aimId).toBe(']Q3');
          expect(d.rawData).toBe(raw);
          expect(d.digitalLink).toBeUndefined();
          expect(d.errorsCorrected).toBe(0);
          expect(d.elementString.equivalent(es)).toBe(true);
          expect(fromScan(d.aimId + d.rawData, LOOSE).elementString.equals(d.elementString)).toBe(
            true,
          );
          expect(d.aimId + d.rawData).toBe(toScan(es, 'gs1-qr', { optimizeOrder }));
          const md = d.metadata;
          expect(md.ecLevel).toBe(ecLevel);
          expect(sym.width).toBe(17 + 4 * md.version);
          const info = qrVersion(md.version).levels[ecLevel];
          expect(md.codewords).toHaveLength(info.dataCodewords);
          expect(md.ecCodewords).toBe(qrVersion(md.version).totalCodewords - info.dataCodewords);
          expect(md.mask).toBeGreaterThanOrEqual(0);
          expect(md.mask).toBeLessThanOrEqual(7);
          expect(md.dataBits).toBeLessThanOrEqual(info.dataCodewords * 8);
          expect(md.segments.length).toBeGreaterThan(0);
          expect(md.orientation).toEqual({ rotation: 0, mirrored: false });
          expect(md.inverted).toBe(false);
          expect(Object.isFrozen(d)).toBe(true);
          expect(Object.isFrozen(md)).toBe(true);
          expect(Object.isFrozen(md.codewords)).toBe(true);
          expect(Object.isFrozen(md.segments)).toBe(true);
          // The same symbol through the Digital Link carrier's decoder is reported as GS1 QR Code.
          const viaDl = qr.decode(sym);
          expect(viaDl.symbology).toBe('gs1-qr');
          expect(viaDl.aimId).toBe(']Q3');
          expect(viaDl.rawData).toBe(raw);
          expect(Object.isFrozen(viaDl)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  }, 120_000);

  it('accepts bracketed strings without association rules', () => {
    const d = gs1Qr.decode(gs1Qr.encode('(10)ABC123(21)XYZ'));
    expect(d.rawData).toBe(`10ABC123${GS}21XYZ`);
  });

  it('the standard example is 2-M', () => {
    const sym = gs1Qr.encode('(01)09506000134352(17)201225(10)ABC123');
    expect(sym.width).toBe(25);
    const d = gs1Qr.decode(sym);
    expect([d.metadata.version, d.metadata.ecLevel]).toEqual([2, 'M']);
    expect(d.rawData).toBe('01095060001343521720122510ABC123');
  });

  it('an explicit version is used when the data fits', () => {
    const d = gs1Qr.decode(gs1Qr.encode('(01)09506000134352', { version: 7, ecLevel: 'H' }));
    expect([d.metadata.version, d.metadata.ecLevel]).toEqual([7, 'H']);
  });
});

describe('qr round trips', () => {
  it('carries Digital Link URIs verbatim (custom and upper-case domains, compressed forms)', () => {
    const uriArb = fc
      .tuple(dlMessageArb, dlOptionsArb)
      .map(([m, o]) => tryToDigitalLink(parse(toBracketed(m)), o))
      .filter((r) => r.ok)
      .map((r) => (r.ok ? r.value : ''));
    fc.assert(
      fc.property(uriArb, fc.constantFrom(...LEVELS), (uri, ecLevel) => {
        const sym = qr.encode(uri, { ecLevel });
        expect(sym.symbology).toBe('qr');
        expect(Object.isFrozen(sym)).toBe(true);
        const d = qr.decode(sym);
        expect(d.symbology).toBe('qr');
        expect(d.aimId).toBe(']Q1');
        expect(d.rawData).toBe(uri);
        expect(d.digitalLink).toBe(uri);
        expect(d.metadata.ecLevel).toBe(ecLevel);
        const parsed = tryParseDigitalLink(uri);
        expect(parsed.ok && parsed.value.elementString.equals(d.elementString)).toBe(true);
        const scan = fromScan(d.aimId + d.rawData);
        expect(scan.digitalLink).toBe(uri);
        expect(scan.elementString.equals(d.elementString)).toBe(true);
        expect(Object.isFrozen(d)).toBe(true);
      }),
      { numRuns: 500 },
    );
  }, 120_000);

  it('builds the URI from an element string exactly as toScan does', () => {
    fc.assert(
      fc.property(dlMessageArb, dlOptionsArb, (m, digitalLink) => {
        const es = parse(toBracketed(m));
        const scan0 = tryToScan(es, 'qr', { digitalLink });
        fc.pre(scan0.ok);
        const want = scan0.ok ? scan0.value : '';
        const d = qr.decode(qr.encode(es, { digitalLink }));
        expect(d.aimId + d.rawData).toBe(want);
        const s = qr.decode(qr.encode(toBracketed(m), { digitalLink }));
        expect(s.aimId + s.rawData).toBe(want);
        const scan = fromScan(d.aimId + d.rawData);
        expect(scan.digitalLink).toBe(d.digitalLink);
        expect(scan.elementString.equals(d.elementString)).toBe(true);
      }),
      { numRuns: 500 },
    );
  }, 120_000);

  it('the upper-case standard URI is 2-M and its lower-case form 3-M (QR research 2.4)', () => {
    const upper = 'HTTPS://ID.GS1.ORG/01/09506000134352';
    const du = qr.decode(qr.encode(upper));
    expect([du.metadata.version, du.metadata.ecLevel, du.digitalLink]).toEqual([2, 'M', upper]);
    expect(du.metadata.segments.every((g) => g.mode !== 'byte')).toBe(true);
    expect(du.metadata.segments.reduce((n, g) => n + g.count, 0)).toBe(upper.length);
    const lower = upper.toLowerCase();
    const dl = qr.decode(qr.encode(lower));
    expect([dl.metadata.version, dl.metadata.ecLevel, dl.digitalLink]).toEqual([3, 'M', lower]);
  });

  it('uses the default domain without options', () => {
    const d = qr.decode(qr.encode('(01)09501101020917(10)ABC'));
    expect(d.digitalLink).toBe('https://id.gs1.org/01/09501101020917/10/ABC');
  });

  it('validates element strings with the association rules (a URI needs a primary key)', () => {
    expect(errorOf(qr.tryEncode('(10)ABC')).code).toBe('MISSING_REQUIRED_AI');
    expect(gs1Qr.tryEncode('(10)ABC').ok).toBe(true);
  });

  it('validates URI input with tryParseDigitalLink', () => {
    expect(errorOf(qr.tryEncode('https://example.com/hello')).code).toBe('INVALID_DIGITAL_LINK');
    expect(errorOf(qr.tryEncode('')).code).toBe('EMPTY_INPUT');
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 1 at the API

describe('data that does not fit and options out of range (Review Focus 1)', () => {
  it('version 1 with more data bits than 1-M holds is DATA_TOO_LONG limit 128 bits', () => {
    const e = errorOf(
      gs1Qr.tryEncode('(01)09506000134352(10)ABCDEFGHIJKLMNOPQRST', { version: 1 }),
    );
    expect(e.code).toBe('DATA_TOO_LONG');
    expect(e.details).toMatchObject({ limit: 128, unit: 'bits', version: 1 });
    expect(Number(e.details?.['actual'])).toBeGreaterThan(128);
    expect(
      thrown(() => gs1Qr.encode('(01)09506000134352(10)ABCDEFGHIJKLMNOPQRST', { version: 1 })),
    ).toBeInstanceOf(Gs1Error);
  });

  it('a 3,000-character URI at ecLevel H is DATA_TOO_LONG', () => {
    const uri = `https://id.gs1.org/01/09501101020917?foo=${'A'.repeat(3000)}`;
    expect(tryParseDigitalLink(uri).ok).toBe(true);
    const e = errorOf(qr.tryEncode(uri, { ecLevel: 'H' }));
    expect(e.code).toBe('DATA_TOO_LONG');
    expect(e.details).toMatchObject({ unit: 'bits' });
    expect(e.details?.['version']).toBeUndefined();
    expect(thrown(() => qr.encode(uri, { ecLevel: 'H' }))).toBeInstanceOf(Gs1Error);
  });

  it('the DATA_TOO_LONG message names the version and level and says what to do', () => {
    const long = '(01)09506000134352(10)ABCDEFGHIJKLMNOPQRST';
    expect(errorOf(gs1Qr.tryEncode(long, { version: 1 })).message).toMatch(
      /^Data needs \d+ bits; version 1-M holds 128\. Use version 'auto' \(or a larger version\) or a lower ecLevel\.$/,
    );
    expect(errorOf(gs1Qr.tryEncode(long, { version: 1, ecLevel: 'L' })).message).toMatch(
      /^Data needs \d+ bits; version 1-L holds 152\. Use version 'auto' \(or a larger version\)\.$/,
    );
    const uri = `https://id.gs1.org/01/09501101020917?foo=${'A'.repeat(7100)}`;
    expect(errorOf(qr.tryEncode(uri, { ecLevel: 'H' })).message).toMatch(
      /^Data needs \d+ bits; version 40-H holds 10208\. Use a lower ecLevel or less data\.$/,
    );
    expect(errorOf(qr.tryEncode(uri, { ecLevel: 'L' })).message).toMatch(
      /^Data needs \d+ bits; version 40-L holds 23648\. Use less data\.$/,
    );
    expect(errorOf(qr.tryEncode(uri, { ecLevel: 'Q', version: 40 })).message).toMatch(
      /; version 40-Q holds \d+\. Use a lower ecLevel or less data\.$/,
    );
  });

  const outOfRange: [string, unknown][] = [
    ['version', 0],
    ['version', 41],
    ['version', 1.5],
    ['version', '7'],
    ['version', Number.NaN],
    ['mask', 8],
    ['mask', -1],
    ['mask', 2.5],
    ['ecLevel', 'X'],
  ];
  for (const [option, value] of outOfRange) {
    it(`${option}: ${String(value)} is INVALID_VALUE with the option name`, () => {
      for (const s of [gs1Qr, qr]) {
        const opts = { [option]: value } as QrOptions;
        expect(brief(errorOf(s.tryEncode('(01)09506000134352', opts)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option },
        });
        expect(thrown(() => s.encode('(01)09506000134352', opts))).toBeInstanceOf(Gs1Error);
      }
    });
  }

  it('a byte 0x80 in carrier input never gives a symbol (DL validation rejects it first)', () => {
    for (const uri of [
      'https://id.gs1.org/01/09501101020917?99=A\u0080',
      'https://id.gs1.org/01/09501101020917?foo=\u0080',
      'https://example.com/\u0080/01/09501101020917',
    ]) {
      const r = qr.tryEncode(uri);
      expect(r.ok).toBe(false);
      expect(['NOT_REPRESENTABLE', 'INVALID_DIGITAL_LINK']).toContain(errorOf(r).code);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Review Focus 5 at the API

describe('the % character and FNC1 in alphanumeric segments (Review Focus 5)', () => {
  const cases = [
    '(10)%A',
    '(99)%%%',
    '(10)ABC%(21)XYZ',
    '(10)ABC%(21)%%',
    '(10)A(21)%B',
    '(10)%(91)%',
    '(10)AB%CD%(99)%12345%ABC',
    '(01)09506000134352(10)%%(21)%',
  ];
  for (const text of cases) {
    it(`${text} round-trips at every level; rawData equals format(es, 'raw')`, () => {
      const es = parse(text, LOOSE);
      for (const ecLevel of LEVELS) {
        const d = gs1Qr.decode(gs1Qr.encode(es, { ecLevel }));
        expect(d.rawData).toBe(format(es, 'raw'));
        expect(d.elementString.equivalent(es)).toBe(true);
        expect(qr.decode(gs1Qr.encode(es, { ecLevel })).rawData).toBe(format(es, 'raw'));
      }
    });
  }

  it('alphanumeric segments are used for the separated % cases', () => {
    const d = gs1Qr.decode(gs1Qr.encode('(10)ABCDEF%(21)XYZXYZ'));
    expect(d.metadata.segments.some((s) => s.mode === 'alphanumeric')).toBe(true);
    expect(d.rawData).toBe(`10ABCDEF%${GS}21XYZXYZ`);
  });

  it('a carrier URI with percent escapes is plain alphanumeric with no doubling', () => {
    const uri = 'HTTPS://ID.GS1.ORG/01/09506000134352/10/AB%2FC%25D';
    const d = qr.decode(qr.encode(uri));
    expect(d.rawData).toBe(uri);
    expect(d.digitalLink).toBe(uri);
    // Character counts add up to the URI length: no `%` is doubled outside GS1 mode.
    expect(d.metadata.segments.every((g) => g.mode !== 'byte')).toBe(true);
    expect(d.metadata.segments.reduce((n, g) => n + g.count, 0)).toBe(uri.length);
    expect(d.elementString.get('10')).toBe('AB/C%D');
  });
});

// ---------------------------------------------------------------------------------------------
// Not GS1

describe('not GS1', () => {
  const both = [gs1Qr, qr] as const;

  it('plain ]Q1 text is not-gs1 with the text through both objects', () => {
    const m = bytes(new Bits(), 'hello').symbol();
    for (const s of both)
      expect(brief(errorOf(s.tryDecode(m)))).toEqual({
        code: 'UNSUPPORTED',
        details: { reason: 'not-gs1', aimId: ']Q1', text: 'hello', rawData: 'hello' },
      });
  });

  it('ECI is UNSUPPORTED eci through both objects', () => {
    const m = bytes(new Bits().put(0b0111, 4).put(26, 8), 'AB').symbol();
    for (const s of both)
      expect(brief(errorOf(s.tryDecode(m)))).toEqual({
        code: 'UNSUPPORTED',
        details: { reason: 'eci', aimId: ']Q1', rawData: 'AB', eci: 26 },
      });
  });

  it('structured append is UNSUPPORTED structured-append through both objects', () => {
    const m = bytes(new Bits().put(0b0011, 4).put(2, 4).put(3, 4).put(0x5a, 8), 'AB').symbol();
    for (const s of both)
      expect(brief(errorOf(s.tryDecode(m)))).toEqual({
        code: 'UNSUPPORTED',
        details: {
          reason: 'structured-append',
          aimId: ']Q1',
          rawData: 'AB',
          position: 2,
          total: 4,
          parity: 0x5a,
        },
      });
  });

  it('structured append in GS1 mode is UNSUPPORTED through both objects', () => {
    const m = numeric0110(new Bits().put(0b0011, 4).put(0, 4).put(1, 4).put(0x11, 8)).symbol();
    for (const s of both) {
      const e = errorOf(s.tryDecode(m));
      expect(e.code).toBe('UNSUPPORTED');
      expect(e.details).toMatchObject({ reason: 'structured-append', aimId: ']Q3' });
    }
  });

  it('FNC1 in second position is UNSUPPORTED fnc1-second through both objects', () => {
    const m = alnum(new Bits().put(0b1001, 4).put(37, 8), 'AB%C').symbol();
    for (const s of both)
      expect(brief(errorOf(s.tryDecode(m)))).toEqual({
        code: 'UNSUPPORTED',
        details: {
          reason: 'fnc1-second',
          aimId: ']Q5',
          rawData: `37AB${GS}C`,
          applicationIndicator: 37,
        },
      });
  });

  it('Kanji is UNSUPPORTED kanji through both objects', () => {
    const m = new Bits()
      .put(0b1000, 4)
      .put(2, countBits('kanji', 2))
      .put(0xd9f, 13)
      .put(0x1aaa, 13)
      .symbol();
    for (const s of both)
      expect(brief(errorOf(s.tryDecode(m)))).toEqual({
        code: 'UNSUPPORTED',
        details: { reason: 'kanji', aimId: ']Q1', rawData: '\u0093_äª' },
      });
  });

  it('gs1Qr.decode of a Digital Link symbol is not-gs1', () => {
    const uri = 'https://id.gs1.org/01/09501101020917';
    expect(brief(errorOf(gs1Qr.tryDecode(qr.encode(uri))))).toEqual({
      code: 'UNSUPPORTED',
      details: { reason: 'not-gs1', aimId: ']Q1', text: uri, rawData: uri },
    });
    expect(thrown(() => gs1Qr.decode(qr.encode(uri)))).toBeInstanceOf(Gs1Error);
  });

  it('qr.decode of ]Q1 text that is not a Digital Link URI is not-gs1 with the text', () => {
    for (const text of [
      'https://example.com/hello',
      'Https://id.gs1.org/01/09501101020917',
      'HELLO',
    ]) {
      const m = bytes(new Bits(), text, 3).symbol(3);
      expect(brief(errorOf(qr.tryDecode(m)))).toEqual({
        code: 'UNSUPPORTED',
        details: { reason: 'not-gs1', aimId: ']Q1', text, rawData: text },
      });
    }
  });

  it('GS1 data errors index rawData and are the same through both objects', () => {
    // FNC1 first, then "0123": AI 01 with a too short GTIN.
    const m = new Bits().put(0b0101, 4).put(0b0001, 4).put(4, 10).put(12, 10).put(3, 4).symbol();
    const e = errorOf(gs1Qr.tryDecode(m));
    expect(e.code).not.toBe('UNSUPPORTED');
    expect(errorOf(qr.tryDecode(m)).code).toBe(e.code);
  });
});

/** FNC1 first after a structured append header, then numeric "0109506000134352". */
function numeric0110(b: Bits): Bits {
  b.put(0b0101, 4).put(0b0001, 4).put(16, 10);
  for (const g of ['010', '950', '600', '013', '435']) b.put(Number(g), 10);
  return b.put(2, 4);
}

// ---------------------------------------------------------------------------------------------
// Decoder input

describe('decoder input', () => {
  it('reports orientation and inversion', () => {
    const sym = gs1Qr.encode('(01)09501101020917(10)ABC');
    const flipped = matrixFromRows(sym.rows.map((_, i, a) => a[a.length - 1 - i] ?? ''));
    const d = gs1Qr.decode(flipped);
    expect(d.metadata.orientation).toEqual({ rotation: 180, mirrored: true });
    const inv = matrixFromRows(
      sym.rows.map((r) => r.replaceAll('1', 'x').replaceAll('0', '1').replaceAll('x', '0')),
    );
    expect(qr.decode(inv).metadata.inverted).toBe(true);
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
      matrixFromRows(Array.from({ length: 21 }, () => '1'.repeat(21))),
    ];
    for (const h of hostile)
      for (const s of [gs1Qr, qr]) {
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
    ['ecLevel', 'm'],
    ['ecLevel', 1],
    ['version', 'max'],
    ['version', null],
    ['mask', 'best'],
    ['mask', '5'],
    ['hriSize', 0],
    ['hriSize', -1],
    ['hriSize', Number.NaN],
    ['hriSize', 1001],
    ['hriSize', '3'],
    ['hri', 'yes'],
    ['optimizeOrder', 1],
  ];
  for (const [option, value] of bad) {
    it(`${option}: ${String(value)} is INVALID_VALUE`, () => {
      for (const s of [gs1Qr, qr]) {
        const opts = { [option]: value } as QrOptions;
        expect(brief(errorOf(s.tryEncode(data, opts)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option },
        });
        expect(thrown(() => s.encode(data, opts))).toBeInstanceOf(Gs1Error);
      }
    });
  }

  it('collects every option error', () => {
    const r = gs1Qr.tryEncode(data, {
      ecLevel: 'm',
      version: 'max',
      mask: 'best',
      hri: 'yes',
    } as unknown as QrOptions);
    expect(r.ok ? [] : r.errors.map((e) => e.details?.['option'])).toEqual([
      'ecLevel',
      'version',
      'mask',
      'hri',
    ]);
  });

  it('digitalLink must be an object with valid fields (qr)', () => {
    const throwing = {
      get domain(): string {
        throw new Error('boom');
      },
    };
    for (const digitalLink of [5, 'x', null, [], { domain: 5 }, { compressed: 'x' }, throwing])
      expect(brief(errorOf(qr.tryEncode(data, { digitalLink } as unknown as QrDlOptions)))).toEqual(
        { code: 'INVALID_VALUE', details: { option: 'digitalLink' } },
      );
    // gs1Qr does not read digitalLink.
    expect(gs1Qr.tryEncode(data, { digitalLink: 5 } as unknown as QrOptions).ok).toBe(true);
  });

  it('rejects options that are not objects and hostile getters', () => {
    for (const s of [gs1Qr, qr]) {
      for (const o of [null, 'x', 5])
        expect(brief(errorOf(s.tryEncode(data, o as unknown as QrOptions)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option: 'options' },
        });
      for (const name of ['ecLevel', 'version', 'mask', 'hri']) {
        const getter = Object.defineProperty({}, name, {
          get() {
            throw new Error('boom');
          },
        });
        expect(brief(errorOf(s.tryEncode(data, getter as QrOptions)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option: name },
        });
      }
      const proxy = new Proxy(
        {},
        {
          get() {
            throw new Error('boom');
          },
        },
      );
      expect(errorOf(s.tryEncode(data, proxy)).code).toBe('INVALID_VALUE');
    }
  });

  it('rejects data that is neither a string nor an ElementString', () => {
    for (const s of [gs1Qr, qr])
      for (const d of [42, null, undefined, {}])
        expect(brief(errorOf(s.tryEncode(d as string)))).toEqual({
          code: 'INVALID_VALUE',
          details: { option: 'data' },
        });
  });

  it('a Digital Link URI given to gs1Qr is INVALID_VALUE data pointing to qr', () => {
    for (const uri of [
      'https://id.gs1.org/01/09506000134352',
      'HTTP://EXAMPLE.COM/01/09506000134352',
    ]) {
      const e = errorOf(gs1Qr.tryEncode(uri));
      expect(brief(e)).toEqual({
        code: 'INVALID_VALUE',
        details: { option: 'data', hint: 'Encode GS1 Digital Link URIs with qr' },
      });
      expect(e.message).toBe(
        'gs1Qr takes a GS1 element string such as "(01)09506000134352", not a URI. Encode GS1 Digital Link URIs with qr.',
      );
      expect(qr.tryEncode(uri).ok).toBe(true);
    }
  });

  it('plain text given to qr is INVALID_VALUE data naming the accepted inputs', () => {
    for (const text of ['hello world', 'www.example.com', 'ftp://example.com/01/1', ']Q3011']) {
      const e = errorOf(qr.tryEncode(text));
      expect(e.code).toBe('INVALID_VALUE');
      expect(e.details).toMatchObject({ option: 'data' });
      expect(String(e.details?.['hint'])).toContain('GS1 Digital Link URI');
      expect(e.message).toMatch(
        /^qr carries a GS1 Digital Link URI or a GS1 element string; plain text is not supported\. Pass a GS1 Digital Link URI such as "https:\/\/id\.gs1\.org\/01\/09506000134352" or a GS1 element string such as "\(01\)09506000134352"\.$/,
      );
    }
    // Element strings that fail keep the parser's error, and gs1Qr keeps its own for text.
    expect(errorOf(qr.tryEncode('(01)09506000134353')).code).toBe('CHECK_DIGIT');
    expect(errorOf(qr.tryEncode('')).code).toBe('EMPTY_INPUT');
    expect(errorOf(gs1Qr.tryEncode('hello world')).code).toBe('SYNTAX');
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
    for (const s of [gs1Qr, qr])
      expect(brief(errorOf(s.tryEncode(hostile as never)))).toEqual({
        code: 'INVALID_VALUE',
        details: { option: 'data' },
      });
  });

  it('mask forces the mask pattern; auto picks one', () => {
    for (let mask = 0; mask < 8; mask++) {
      expect(gs1Qr.decode(gs1Qr.encode(data, { mask })).metadata.mask).toBe(mask);
      expect(qr.decode(qr.encode(data, { mask })).metadata.mask).toBe(mask);
    }
    const auto = gs1Qr.decode(gs1Qr.encode(data, { mask: 'auto' })).metadata.mask;
    expect(gs1Qr.decode(gs1Qr.encode(data)).metadata.mask).toBe(auto);
  });

  it('hri: true gives one line per element string below the symbol (Q14)', () => {
    const sym = gs1Qr.encode(data, { hri: true });
    const h = sym.height;
    expect(sym.hri).toEqual([
      { text: '(01)09501101020917', x: 0, y: h + 1 + 2.4, size: 3, anchor: 'start', role: 'hri' },
      { text: '(10)ABC', x: 0, y: h + 1 + 2.4 + 3.6, size: 3, anchor: 'start', role: 'hri' },
    ]);
    expect(Object.isFrozen(sym.hri[0])).toBe(true);
    const big = gs1Qr.encode(data, { hri: true, hriSize: 5 });
    expect(big.hri.map((t) => [t.y, t.size])).toEqual([
      [big.height + 1 + 4, 5],
      [big.height + 1 + 4 + 6, 5],
    ]);
    expect(gs1Qr.encode(data, { hri: false }).hri).toEqual([]);
    expect(thrown(() => toSvg(gs1Qr.encode(data, { hri: true, hriSize: 1000 })))).toBeUndefined();
  });

  it('hri lines follow the encoded order with optimizeOrder', () => {
    const sym = gs1Qr.encode('(10)ABC(01)09501101020917(17)271231', {
      hri: true,
      optimizeOrder: true,
    });
    expect(sym.hri.map((t) => t.text)).toEqual(['(01)09501101020917', '(17)271231', '(10)ABC']);
    expect(gs1Qr.decode(sym).rawData).toBe('01095011010209171727123110ABC');
  });

  it('the Digital Link carrier shows the element string the URI carries', () => {
    const uri = 'https://example.com/01/09501101020917/10/ABC?17=271231';
    const sym = qr.encode(uri, { hri: true });
    expect(sym.hri.map((t) => t.text)).toEqual(['(01)09501101020917', '(10)ABC', '(17)271231']);
  });
});

describe('objects', () => {
  it('have their names and are frozen', () => {
    expect(gs1Qr.name).toBe('gs1-qr');
    expect(qr.name).toBe('qr');
    expect(Object.isFrozen(gs1Qr)).toBe(true);
    expect(Object.isFrozen(qr)).toBe(true);
  });
});
