import { beforeAll, describe, expect, it } from 'vitest';
import file from '../vectors/epc-legacy.json' with { type: 'json' };
import uriFile from '../vectors/epc-uri.json' with { type: 'json' };
import { parse } from '../../src/ai/index.ts';
import { Gs1Error, type Result } from '../../src/core/errors.ts';
import { elementStringFromPure, pureFromElementString } from '../../src/epc/gs1.ts';
import { formatPure, parsePure } from '../../src/epc/uri.ts';
import { ensureGcpSnapshot, gcpSnapshotLength } from '../support/gcp-snapshot.ts';

interface MapVector {
  readonly source: string;
  readonly elementString?: string;
  readonly pureIdentityUri?: string;
  readonly companyPrefixLength?: number | null;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON import typed loosely
const pairs = (file.vectors as unknown as MapVector[]).filter(
  (v) =>
    v.elementString !== undefined &&
    v.pureIdentityUri !== undefined &&
    typeof v.companyPrefixLength === 'number',
);

const result = (r: unknown): unknown =>
  r instanceof Gs1Error ? [r.code, r.details?.['reason'] ?? null] : r;
/** A failed Result as [ok, code, reason] of its first error; a good one as [ok, value]. */
const failure = (r: Result<unknown>): unknown[] =>
  r.ok ? [true, r.value] : [false, r.errors[0]?.code, r.errors[0]?.details?.['reason']];

describe('TDS section 7 mappings', () => {
  for (const v of pairs) {
    it(`${v.source}: ${v.elementString} <-> ${v.pureIdentityUri}`, () => {
      const es = parse(v.elementString ?? '');
      const p = pureFromElementString(es, { companyPrefixLength: v.companyPrefixLength ?? 0 });
      const back = parsePure(v.pureIdentityUri ?? '');
      const r = back instanceof Gs1Error ? back : elementStringFromPure(back);
      expect([
        p instanceof Gs1Error ? result(p) : formatPure(p),
        r instanceof Gs1Error ? result(r) : r.ok ? r.value.equivalent(es) : r.errors[0]?.message,
      ]).toEqual([v.pureIdentityUri, true]);
    });
  }
});

describe('GCP length sources (Review Focus 4, E1, E9)', () => {
  const es = parse('(01)09521141123454(21)32a/b');
  it('needs a length except for GTIN-8', () => {
    expect(result(pureFromElementString(es, {}))).toEqual(['GCP_LENGTH_UNKNOWN', null]);
    const g8 = pureFromElementString(parse('(01)00000095010939(21)1'), {});
    expect(g8 instanceof Gs1Error ? result(g8) : formatPure(g8)).toBe(
      'urn:epc:id:sgtin:00000950.01093.1',
    );
  });
  it('maps lookup results', () => {
    expect(result(pureFromElementString(es, { companyPrefixLength: () => undefined }))).toEqual([
      'GCP_LENGTH_UNKNOWN',
      null,
    ]);
    expect(result(pureFromElementString(es, { companyPrefixLength: () => 0 }))).toEqual([
      'INVALID_EPC',
      'not-a-gcp',
    ]);
    const five = pureFromElementString(parse('(00)195211410000000004'), {
      companyPrefixLength: () => 5,
    });
    expect(five instanceof Gs1Error ? result(five) : formatPure(five)).toBe(
      'urn:epc:id:sscc:952114.11000000000',
    );
    expect(result(pureFromElementString(es, { companyPrefixLength: 13 }))).toEqual([
      'INVALID_EPC',
      'gcp-length',
    ]);
  });
  it('needs a digit GCP and a non-empty rest for GIAI, CPI and GINC', () => {
    const cases = [
      pureFromElementString(parse('(8004)95211A1X'), { companyPrefixLength: 7 }),
      pureFromElementString(parse('(8004)9521141'), { companyPrefixLength: 7 }),
      pureFromElementString(parse('(401)952114'), { companyPrefixLength: 6 }),
      pureFromElementString(parse('(01)09521141123454(21)1'), { companyPrefixLength: 6.5 }),
    ];
    expect(cases.map(result)).toEqual(
      Array.from({ length: 4 }, () => ['INVALID_EPC', 'gcp-length']),
    );
  });
  it('maps a numeric length of 4 or 5 to 6 like a lookup result (TDS 7.1)', () => {
    const p = pureFromElementString(parse('(00)195211410000000004'), { companyPrefixLength: 4 });
    expect(p instanceof Gs1Error ? result(p) : formatPure(p)).toBe(
      'urn:epc:id:sscc:952114.11000000000',
    );
  });
  it('fails without throwing on a malformed hand-built pure identity', () => {
    const cases = [
      { kind: 'id', scheme: 'giai', components: ['9521141', '%zz'] },
      { kind: 'id', scheme: 'sgtin', components: ['95211A1', '012345', '1'] },
      { kind: 'id', scheme: 'sscc', components: ['', '01234567890123456'] },
      { kind: 'id', scheme: 'gsrn', components: ['9521141'] },
    ] as const;
    expect(cases.map((p) => failure(elementStringFromPure(p)))).toEqual([
      [false, 'INVALID_EPC', 'escape'],
      [false, 'INVALID_EPC', 'component'],
      [false, 'INVALID_EPC', 'component'],
      [false, 'INVALID_EPC', 'component'],
    ]);
  });
  it('passes the key digits from the GCP position to the lookup', () => {
    const seen: string[] = [];
    pureFromElementString(es, { companyPrefixLength: (d) => (seen.push(d), 7) });
    pureFromElementString(parse('(00)106141412345678908'), {
      companyPrefixLength: (d) => (seen.push(d), 7),
    });
    expect(seen).toEqual(['9521141123454', '06141412345678908']);
  });
  // The 14 MB snapshot is downloaded once (see test/support/gcp-snapshot.ts), so allow for it.
  beforeAll(() => ensureGcpSnapshot(), 120_000);
  it('agrees with the GCP snapshot on TDS examples (test-only lookup)', () => {
    const p = pureFromElementString(parse('(01)09506000134352(21)6789'), {
      companyPrefixLength: gcpSnapshotLength,
    });
    expect(p instanceof Gs1Error ? result(p) : formatPure(p)).toBe(
      'urn:epc:id:sgtin:95060001343.05.6789',
    );
  });
});

describe('scheme choice and restrictions (E8, E20)', () => {
  it('infers the scheme by priority and honours an explicit one', () => {
    const es = parse('(01)09521141123454(21)S1(10)L1');
    const p = pureFromElementString(es, { companyPrefixLength: 7 });
    expect(p instanceof Gs1Error ? result(p) : p.scheme).toBe('sgtin');
    const l = pureFromElementString(es, { companyPrefixLength: 7, epcScheme: 'lgtin' });
    expect(l instanceof Gs1Error ? result(l) : formatPure(l)).toBe(
      'urn:epc:class:lgtin:9521141.012345.L1',
    );
    expect(
      result(
        pureFromElementString(parse('(17)261231(10)A(01)09521141123454'), {
          companyPrefixLength: 7,
          epcScheme: 'sscc',
        }),
      ),
    ).toEqual(['INVALID_EPC', 'no-epc-key']);
    expect(result(pureFromElementString(parse('(91)X'), { companyPrefixLength: 7 }))).toEqual([
      'INVALID_EPC',
      'no-epc-key',
    ]);
  });
  it('rejects restricted GTIN prefixes', () => {
    for (const g of [
      '02012345678903',
      '00000000123457',
      '02012345000001',
      '09771234567003',
      '09801234567007',
      '09912345678909',
      '00401234567893',
      '00212345678909',
      '00003123456785',
      '09841234567898',
    ]) {
      const es = parse(`(01)${g}(21)1`);
      expect([g, result(pureFromElementString(es, { companyPrefixLength: 7 }))]).toEqual([
        g,
        ['INVALID_EPC', 'restricted-prefix'],
      ]);
    }
    const isbn = pureFromElementString(parse('(01)09781234567897(21)1'), {
      companyPrefixLength: 7,
    });
    expect(isbn instanceof Gs1Error ? result(isbn) : isbn.scheme).toBe('sgtin');
  });
  it('rejects keys needing a serial when none is present', () => {
    expect(
      result(pureFromElementString(parse('(253)9521141123454'), { companyPrefixLength: 7 })),
    ).toEqual(['INVALID_EPC', 'no-epc-key']);
  });
  it('schemes without an element string', () => {
    for (const uri of [
      'urn:epc:id:gid:952056.2718.1414',
      'urn:epc:id:usdod:CAGEY.5678',
      'urn:epc:id:bic:CSQU3054383',
    ]) {
      const p = parsePure(uri);
      expect(p instanceof Gs1Error ? p : failure(elementStringFromPure(p))).toEqual([
        false,
        'INVALID_EPC',
        'no-gs1-key',
      ]);
    }
  });
});

interface UriVector {
  readonly input: string;
  readonly expect: { readonly elementString?: string };
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON import typed loosely
const uriVectors = uriFile.vectors as unknown as UriVector[];
const esExamples = uriVectors.filter(
  (v) =>
    (v.input.startsWith('urn:epc:id:') || v.input.startsWith('urn:epc:class:')) &&
    v.expect.elementString !== undefined,
);

describe('every TDS section 7 element string example', () => {
  for (const v of esExamples) {
    it(`${v.input} to its element string`, () => {
      const p = parsePure(v.input);
      const r = p instanceof Gs1Error ? p : elementStringFromPure(p);
      expect(
        r instanceof Gs1Error ? result(r) : r.ok ? r.value.toString() : r.errors[0]?.message,
      ).toBe(parse(v.expect.elementString ?? '').toString());
    });
  }
});
