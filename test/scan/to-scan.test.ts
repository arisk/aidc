import { describe, expect, it } from 'vitest';
import file from '../vectors/scan.json' with { type: 'json' };
import { parse } from '../../src/ai/index.ts';
import { type ScanSymbology, fromScan, toScan, tryToScan } from '../../src/scan/index.ts';

interface OutVector {
  readonly source: string;
  readonly dir: string;
  readonly sym: string;
  readonly dataStr?: string;
  readonly aiDataStr?: string;
  readonly addCheckDigit?: boolean;
  readonly expect: string | null;
  readonly ok: boolean;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const vectors = (file.vectors as unknown as OutVector[]).filter((v) => v.dir === 'out');

const AI_SYMS: Record<string, ScanSymbology> = {
  GS1_128_CCA: 'gs1-128',
  GS1_128_CCC: 'gs1-128',
  DataBarExpanded: 'gs1-databar',
  // GenSpecs 5.4.7.4: every DataBar variant scans as ]e0 (plan decision D11).
  DataBarOmni: 'gs1-databar',
  DataBarTruncated: 'gs1-databar',
  DataBarStacked: 'gs1-databar',
  DataBarStackedOmni: 'gs1-databar',
  DataBarLimited: 'gs1-databar',
  QR: 'gs1-qr',
  DM: 'gs1-datamatrix',
  DotCode: 'gs1-dotcode',
};

/**
 * Engine vectors where toScan knowingly differs: the engine applies DataBar variant data
 * restrictions (Omni and relatives carry only (01); Limited needs a first digit 0 or 1),
 * which toScan('gs1-databar') does not model yet. They arrive in M5 (roadmap).
 */
const KNOWN_DIFFERENCES: ReadonlyMap<string, string> = new Map([
  ['DataBarOmni (01)09506000134352(10)ABC', 'DataBar Omni carries only (01): M5'],
  ['DataBarLimited 20000000000004', 'DataBar Limited first digit 0 or 1: M5'],
]);

/**
 * Maps an engine generate vector to our call, or returns why it does not apply:
 * plain non-GS1 text, the named known differences, composite splits and the addCheckDigit
 * option.
 */
function plan(v: OutVector): { symbology: ScanSymbology; input: string } | string {
  const data = v.aiDataStr ?? v.dataStr ?? '';
  const known = KNOWN_DIFFERENCES.get(`${v.sym} ${data}`);
  if (known !== undefined) return known;
  if (data.includes('|')) return 'composite split (linear | CC) is not an element string';
  if (v.addCheckDigit) return 'engine option addCheckDigit';
  // The engine keeps a trailing GS after the last AI; GenSpecs 5.11.4.1 and D12 do not.
  if (data.endsWith('^')) return 'trailing GS after the final AI (D12)';
  // UPC-E data is given as its 12-digit UPC-A expansion, so it maps like UPC-A.
  const upc = v.sym === 'UPCA' || v.sym === 'UPCE';
  if (v.sym === 'EAN13' || upc || v.sym === 'EAN8') {
    const digits = data.startsWith('^01')
      ? data.slice(3)
      : data.startsWith('(01)')
        ? data.slice(4)
        : data;
    if (!/^\d+$/.test(digits)) return 'not digits';
    // The engine checks the primary data length per symbology; an element string has no such
    // length (every GTIN is 14 digits), so wrong-length inputs do not apply.
    const lengths = v.sym === 'EAN13' ? [13, 14] : upc ? [12, 14] : [8, 14];
    if (!lengths.includes(digits.length)) return 'primary data length is an engine input rule';
    // UPC-A is a GTIN-12 (00 prefix once padded to 14); the engine rejects other GTINs for it.
    if (upc && digits.length === 14 && !digits.startsWith('00')) {
      return 'not a UPC-A GTIN (no 00 prefix)';
    }
    return {
      symbology: v.sym === 'EAN8' ? 'ean-8' : 'ean-13',
      input: `(01)${digits.padStart(14, '0')}`,
    };
  }
  const sym = AI_SYMS[v.sym];
  if (!sym) return `symbology ${v.sym}`;
  if (v.aiDataStr) return { symbology: sym, input: v.aiDataStr };
  if (data.startsWith('^')) return { symbology: sym, input: data };
  return 'plain non-GS1 data';
}

/** Vectors that map to a toScan call; the rest return the reason they do not apply. */
const APPLICABLE = 13;

describe('scandata.c and oracle generate vectors', () => {
  const planned = vectors.map((v) => [v, plan(v)] as const);
  it('applies to the expected vectors', () => {
    expect(vectors.length).toBe(56);
    expect(planned.filter(([, p]) => typeof p !== 'string').length).toBe(APPLICABLE);
    const known = planned.filter(([v]) =>
      KNOWN_DIFFERENCES.has(`${v.sym} ${v.aiDataStr ?? v.dataStr ?? ''}`),
    );
    expect(known).toHaveLength(KNOWN_DIFFERENCES.size);
  });
  for (const [v, p] of planned) {
    it.skipIf(typeof p === 'string')(`${v.source} ${v.sym}: ${v.aiDataStr ?? v.dataStr}`, () => {
      if (typeof p === 'string') return;
      const r = tryToScan(p.input, p.symbology);
      // Wrong-length EAN digits are an input error here (our parse), a null scanData there.
      const expected = !v.ok || v.expect === null ? { ok: false } : { ok: true, value: v.expect };
      expect(r.ok ? { ok: true, value: r.value } : { ok: false }).toEqual(expected);
    });
  }
});

function reason(input: string, s: ScanSymbology, addOn?: string): unknown {
  const r = tryToScan(input, s, addOn === undefined ? {} : { addOn });
  return r.ok ? r.value : r.errors[0]?.details?.['reason'];
}

describe('toScan', () => {
  const es = parse('(01)09506000134352(10)ABC123(17)261231');

  it('emits the AIM ID and raw data with GS only after variable-length AIs (D12)', () => {
    expect(toScan(es, 'gs1-128')).toBe(']C1010950600013435210ABC123\u001d17261231');
    expect(toScan(es, 'gs1-128', { optimizeOrder: true })).toBe(
      ']C101095060001343521726123110ABC123',
    );
    expect(toScan(es, 'gs1-datamatrix').startsWith(']d2')).toBe(true);
    expect(toScan(es, 'gs1-qr').startsWith(']Q3')).toBe(true);
    expect(toScan(es, 'gs1-dotcode').startsWith(']J1')).toBe(true);
    expect(toScan(es, 'gs1-databar').startsWith(']e0')).toBe(true);
  });

  it('EAN/UPC and ITF-14 carry only a GTIN of the right form', () => {
    expect(toScan('(01)09506000134352', 'ean-13')).toBe(']E09506000134352');
    expect(toScan('(01)09506000134352', 'ean-13', { addOn: '12' })).toBe(']E3950600013435212');
    expect(toScan('(01)00000002345673', 'ean-8')).toBe(']E402345673');
    expect(toScan('(01)19506000134359', 'itf-14')).toBe(']I119506000134359');
    expect(reason('(01)19506000134359', 'ean-13')).toBe('not-representable');
    expect(reason('(01)09506000134352', 'ean-8')).toBe('not-representable');
    expect(reason('(01)09506000134352(10)A', 'ean-13')).toBe('not-representable');
    expect(reason('(01)09506000134352', 'ean-13', '123')).toBe('not-representable');
    expect(reason('(01)09506000134352', 'gs1-128', '12')).toBe('not-representable');
  });

  it('QR, Data Matrix and DotCode carry a Digital Link', () => {
    expect(toScan(es, 'qr')).toBe(']Q1https://id.gs1.org/01/09506000134352/10/ABC123?17=261231');
    expect(toScan(es, 'datamatrix', { digitalLink: { domain: 'https://example.com' } })).toBe(
      ']d1https://example.com/01/09506000134352/10/ABC123?17=261231',
    );
    expect(tryToScan('(91)A', 'dotcode')).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'INVALID_DIGITAL_LINK' })],
    });
  });

  it('round trips through fromScan', () => {
    for (const s of [
      'gs1-128',
      'gs1-databar',
      'gs1-datamatrix',
      'gs1-qr',
      'gs1-dotcode',
      'qr',
      'datamatrix',
      'dotcode',
    ] as const) {
      expect(fromScan(toScan(es, s)).elementString.equivalent(es)).toBe(true);
    }
  });

  it('guards unknown symbologies from JavaScript callers', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(tryToScan(es, 'aztec' as unknown as ScanSymbology)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'INVALID_SCAN' })],
    });
  });
});

describe('toScan GTIN-8 collision rule (plan decision G8)', () => {
  it('rejects the unused GTIN-8 range for ean-13', () => {
    const r = tryToScan('(01)00000095012346', 'ean-13');
    expect(r.ok).toBe(false);
    expect(r.ok ? undefined : r.errors[0]?.code).toBe('INVALID_SCAN');
    expect(r.ok ? undefined : r.errors[0]?.details).toMatchObject({
      reason: 'not-representable',
    });
  });
  it('still accepts the 0000000 prefix', () => {
    expect(toScan('(01)00000000012348', 'ean-13')).toBe(']E00000000012348');
  });
});
