import { describe, expect, it } from 'vitest';
import file from '../vectors/scan.json' with { type: 'json' };
import { parse } from '../../src/ai/index.ts';
import { fromScan, tryFromScan } from '../../src/scan/index.ts';

interface InVector {
  readonly source: string;
  readonly dir: string;
  readonly input: string;
  readonly expect:
    | string
    | {
        readonly sym?: string;
        readonly dataStr?: string;
        readonly ai?: string | null;
        readonly dlAIbuffer?: string;
        readonly err?: string;
      };
  readonly ok: boolean;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const vectors = (file.vectors as unknown as InVector[]).filter((v) => v.dir === 'in');
/** IDs we accept and the engine does not (plan decision D10); covered by hand-written tests below. */
const OUR_EXTENSIONS = new Set([']E3', ']I1', ']I0']);
/**
 * Joined EAN + composite scans whose CC needs the EAN's GTIN to satisfy its associations: the
 * engine checks the CC alone and rejects them; we check the merged data (plan decision D10).
 */
const JOINED_CC_ACCEPTED = new Set([']E09506000134352|]e010ABC']);

/** The element string the engine's result stands for, or undefined for non-GS1 data. */
function expected(v: InVector): string | undefined {
  if (typeof v.expect === 'string') return v.expect.slice(v.expect.indexOf('('));
  const e = v.expect;
  if (e.ai) return e.ai;
  if (e.dlAIbuffer !== undefined) return e.dlAIbuffer === '' ? undefined : e.dlAIbuffer;
  const d = e.dataStr ?? '';
  if (d.startsWith('^')) return d;
  const bar = d.indexOf('|');
  const digits = bar < 0 ? d : d.slice(0, bar);
  if (digits.length > 0 && /^\d+$/.test(digits) && (e.sym === 'EAN13' || e.sym === 'EAN8')) {
    const gtin = `(01)${digits.padStart(14, '0')}`;
    return bar < 0 ? gtin : gtin + parse(d.slice(bar + 1)).toString();
  }
  return undefined; // plain non-GS1 text
}

const literalInputs = vectors.map((v) => v.input);

function first(s: string): unknown {
  const r = tryFromScan(s);
  return r.ok ? 'ok' : [r.errors[0]?.code, r.errors[0]?.details?.['reason'], r.errors[0]?.position];
}

describe('scandata.c, oracle and GenSpecs scan vectors', () => {
  const literal = vectors.filter((v) => !v.input.includes('(MAX_DATA'));
  const ours = literal.filter(
    (v) => !OUR_EXTENSIONS.has(v.input.slice(0, 3)) && !JOINED_CC_ACCEPTED.has(v.input),
  );
  const cases = ours.map((v) => ({ v, want: v.ok ? expected(v) : undefined }));
  const rejected = cases.filter((c) => c.want === undefined).map((c) => c.v);
  const accepted = cases.flatMap((c) => (c.want === undefined ? [] : [{ v: c.v, want: c.want }]));

  it('has the committed vectors', () => {
    expect(vectors.length).toBe(86);
    expect(literal.length).toBe(vectors.length - 1);
  });

  for (const v of rejected) {
    it(`${v.source}: rejects ${JSON.stringify(v.input)}`, () => {
      expect(tryFromScan(v.input).ok).toBe(false);
    });
  }

  for (const { v, want } of accepted) {
    it(`${v.source}: accepts ${JSON.stringify(v.input)}`, () => {
      const r = tryFromScan(v.input);
      expect(
        r.ok ? r.value.elementString.equals(parse(want)) : r.errors.map((e) => e.message),
      ).toBe(true);
    });
  }
});

describe('fromScan by identifier', () => {
  it('GenSpecs 5.4.7.4 GS1-128', () => {
    expect(fromScan(']C1010950600013435217201225\u001d10ABC123')).toEqual({
      symbology: 'gs1-128',
      aimId: ']C1',
      elementString: parse('(01)09506000134352(17)201225(10)ABC123'),
    });
  });

  it('EAN/UPC digits become AI (01), padded to 14 digits (D10)', () => {
    expect(fromScan(']E09506000134352').elementString.toString()).toBe('(01)09506000134352');
    expect(fromScan(']E00416000336108').elementString.toString()).toBe('(01)00416000336108');
    expect(fromScan(']E402345673')).toMatchObject({ symbology: 'ean-8' });
    expect(fromScan(']E402345673').elementString.gtin).toBe('00000002345673');
    expect(fromScan(']I109506000134352')).toMatchObject({ symbology: 'itf-14', aimId: ']I1' });
    expect(fromScan(']I009506000134352').elementString.gtin).toBe('09506000134352');
  });

  it('EAN/UPC with add-on (]E3)', () => {
    expect(fromScan(']E3950600013435212')).toMatchObject({ symbology: 'ean-13', addOn: '12' });
    expect(fromScan(']E3950600013435212345').addOn).toBe('12345');
    expect(tryFromScan(']E39506000134352123').ok).toBe(false);
  });

  it("the engine's joined EAN + composite form", () => {
    expect(fromScan(']E09506000134352|]e099COMPOSITE\u001d98XYZ').elementString.toString()).toBe(
      '(01)09506000134352(99)COMPOSITE(98)XYZ',
    );
  });

  it('the joined form checks associations on the merged GTIN and CC data', () => {
    expect(literalInputs.filter((i) => JOINED_CC_ACCEPTED.has(i))).toHaveLength(1);
    expect(fromScan(']E09506000134352|]e010ABC').elementString.toString()).toBe(
      '(01)09506000134352(10)ABC',
    );
    expect(fromScan(']E09506000134352|]e017261231').elementString.toString()).toBe(
      '(01)09506000134352(17)261231',
    );
    expect(fromScan(']E09506000134352|]e021S123').elementString.toString()).toBe(
      '(01)09506000134352(21)S123',
    );
    expect(fromScan(']E402345673|]e010ABC\u001d21XYZ').elementString.toString()).toBe(
      '(01)00000002345673(10)ABC(21)XYZ',
    );
    // A CC value error still points into the scan string (the bad month).
    expect(first(']E09506000134352|]e017261332')).toEqual(['INVALID_DATE', undefined, 24]);
  });

  it('Digital Link in QR, Data Matrix and DotCode', () => {
    const r = fromScan(']Q1https://example.com/01/09506000134352/10/ABC');
    expect(r).toMatchObject({
      symbology: 'qr',
      aimId: ']Q1',
      digitalLink: 'https://example.com/01/09506000134352/10/ABC',
    });
    expect(r.elementString.toString()).toBe('(01)09506000134352(10)ABC');
    expect(fromScan(']d1HTTPS://Example.com/01/09506000134352').symbology).toBe('datamatrix');
  });

  it('reports errors with positions in the scan string', () => {
    expect(first(']C1010950600013435317201225')).toEqual(['CHECK_DIGIT', undefined, 18]);
    expect(first(']E09506000134353')).toEqual(['CHECK_DIGIT', undefined, 15]);
    expect(first(']Q1https://example.com/01/09506000134353')).toEqual([
      'CHECK_DIGIT',
      undefined,
      39,
    ]);
    expect(first(']E1')).toEqual(['UNSUPPORTED', 'aim-id', 0]);
    expect(first(']e1011234')).toEqual(['UNSUPPORTED', 'aim-id', 0]);
    expect(first(']Q1TESTING')).toEqual(['INVALID_SCAN', 'not-gs1', 3]);
    expect(first(']Q1HtTps://example.com/01/09506000134352')).toEqual([
      'INVALID_SCAN',
      'not-gs1',
      3,
    ]);
  });
});

describe('keyboard-wedge input (Review Focus 5)', () => {
  it('tolerates one trailing CR, LF or CRLF', () => {
    for (const end of ['\r\n', '\n', '\r']) expect(first(`]C10109506000134352${end}`)).toBe('ok');
    expect(first(']C10109506000134352\n\n')).not.toBe('ok');
  });
  it('rejects malformed scans with a Gs1Error and a position', () => {
    expect(first('010950600013435217201225')).toEqual(['INVALID_SCAN', 'missing-id', 0]);
    expect(first(']C')).toEqual(['INVALID_SCAN', 'missing-id', 0]);
    expect(first(']c1010950600013435217201225')).toEqual(['INVALID_SCAN', 'unknown-id', 0]);
    expect(first(']C1(01)09506000134352')).toEqual(['INVALID_SCAN', 'payload', 3]);
    expect(first(']C1\u001d0109506000134352')).toEqual(['INVALID_SCAN', 'payload', 3]);
    expect(first(']C10109506000134352^10A')).toEqual(['INVALID_SCAN', 'payload', 19]);
    expect(first(']C1')).toEqual(['EMPTY_INPUT', undefined, 3]);
    expect(first(']E0950600013435')).toEqual(['INVALID_SCAN', 'payload', 3]);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(tryFromScan(42 as unknown as string)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'SYNTAX' })],
    });
  });
});
