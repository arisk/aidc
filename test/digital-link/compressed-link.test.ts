import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import file from '../vectors/dl-compression.json' with { type: 'json' };
import epcPlus from '../vectors/epc-plus.json' with { type: 'json' };
import { epc } from '../../src/epc/index.ts';
import { parse, tryParse } from '../../src/ai/index.ts';
import type { Result } from '../../src/core/index.ts';
import {
  fromDigitalLink,
  parseDigitalLink,
  toDigitalLink,
  tryParseDigitalLink,
  tryToDigitalLink,
} from '../../src/digital-link/index.ts';
import { BASE64URL, bitsToBase64url } from '../../src/core/base64url.ts';
import { compressSegment } from '../../src/digital-link/compress/encode.ts';
import { type Message, messageArb } from '../support/arbitraries.ts';

interface Vector {
  readonly source: string;
  readonly es?: string;
  readonly uncompressed: string;
  readonly compressed: string;
}
const vectors: readonly Vector[] = file.vectors;
// Vectors the code rejects for reasons the brief does not explain; see the task 8 report.
const DISAGREE: Record<string, string> = {
  'http://example.org/gtin/05412345000013/EIiDChplbFkzcAMcW5qmg': 'no-primary-key',
  'https://example.com/ohFKk4XBoIJpA': 'MISSING_REQUIRED_AI',
  'https://example.com/ARFKk4XBoHIh6Rj2': 'MISSING_REQUIRED_AI',
  'https://example.com/mmgI8gP7XbfBy-mRoU': 'INVALID_VALUE',
  'https://example.com/DRFKk4XBoH-N4?linkType=gs1:pip&x_y-z=Hello World': 'uri-chars',
};
const disagrees = (v: Vector): boolean => v.compressed in DISAGREE;
const isEpc = (v: Vector): boolean => /\/e[hx][^/]*$/.test(v.compressed);
const stemOf = (uri: string, segments: number): string =>
  uri.split('/').slice(0, -segments).join('/');
// Our encoder always optimises, so the "without optimisation" vectors are decode-only.
const isEncoderVector = (v: Vector): boolean =>
  v.es !== undefined && !/useOptimisations=false|without optimisation/.test(v.source);

const toBracketed = (m: Message): string =>
  m.map(([a, x]) => `(${a})${x.replaceAll('(', '\\(')}`).join('');

/** Error codes a hostile compressed segment may give (plan Review Focus 4). */
const HOSTILE_CODES = new Set([
  'INVALID_DIGITAL_LINK',
  'UNSUPPORTED',
  'INVALID_LENGTH',
  'INVALID_CHAR',
  'CHECK_DIGIT',
  'INVALID_DATE',
  'INVALID_VALUE',
  'UNKNOWN_AI',
  'MISSING_REQUIRED_AI',
  'INVALID_AI_PAIR',
  'DUPLICATE_AI',
]);
const HOSTILE_REASONS = new Set(['compressed-segment', 'no-primary-key', 'not-data-attribute']);

/** The errors of `r` outside the allowed set, as "CODE reason" strings. */
function disallowed(r: Result<unknown>): string[] {
  return (r.ok ? [] : r.errors)
    .filter(
      (e) =>
        !HOSTILE_CODES.has(e.code) ||
        (e.code === 'INVALID_DIGITAL_LINK' && !HOSTILE_REASONS.has(String(e.details?.['reason']))),
    )
    .map((e) => `${e.code} ${String(e.details?.['reason'])}`);
}

const linkableEs = messageArb
  .map((m) => tryParse(toBracketed(m)))
  .filter((r) => r.ok && tryToDigitalLink(r.value).ok)
  .map((r) => (r.ok ? r.value : parse('(00)006141411234567890')));

/** compressSegment output for valid element strings (those Table F can hold). */
const validSegment = linkableEs
  .map((es) => tryToDigitalLink(es, { compressed: true }))
  .filter((r) => r.ok)
  .map((r) => (r.ok ? (r.value.split('/').pop() ?? '') : ''));

const B64 = BASE64URL.split('');
/** Bit flips (one base64url character changed), truncation and appended characters. */
const mutation: fc.Arbitrary<(seg: string) => string> = fc.oneof(
  fc.tuple(fc.nat(), fc.integer({ min: 1, max: 63 })).map(([at, xor]) => (seg: string): string => {
    const i = at % seg.length;
    const c = B64[(BASE64URL.indexOf(seg.charAt(i)) ^ xor) & 63] ?? 'A';
    return seg.slice(0, i) + c + seg.slice(i + 1);
  }),
  fc.nat().map(
    (n) =>
      (seg: string): string =>
        seg.slice(0, Math.max(1, n % seg.length)),
  ),
  fc.string({ unit: fc.constantFrom(...B64), minLength: 1, maxLength: 12 }).map(
    (tail) =>
      (seg: string): string =>
        seg + tail,
  ),
);

describe('DL compression vectors', () => {
  it('has the committed vectors', () => expect(vectors.length).toBe(60));

  for (const v of vectors.filter(isEpc)) {
    it(`${v.source}: ${v.compressed} decodes the EPC`, () => {
      const link = parseDigitalLink(v.compressed);
      expect(link.elementString.equivalent(parse(v.es ?? ''))).toBe(true);
      expect(link.compressed).toBe('full');
    });
  }

  for (const v of vectors.filter((x) => !isEpc(x) && !disagrees(x))) {
    it(`${v.source}: ${v.compressed} decodes`, () => {
      const link = parseDigitalLink(v.compressed);
      expect(link.elementString.equivalent(fromDigitalLink(v.uncompressed))).toBe(true);
      expect(link.stem).toBe(stemOf(v.compressed, link.compressed === 'partial' ? 3 : 1));
      const expected = v.es === undefined ? link.elementString : parse(v.es);
      expect(link.elementString.equivalent(expected)).toBe(true);
    });
  }

  for (const v of vectors.filter((x) => !isEpc(x) && !disagrees(x) && isEncoderVector(x))) {
    it(`${v.source}: ${v.compressed} encodes`, () => {
      const mode = parseDigitalLink(v.compressed).compressed === 'partial' ? 'partial' : true;
      const stem = stemOf(v.compressed, mode === 'partial' ? 3 : 1);
      expect(toDigitalLink(parse(v.es ?? ''), { domain: stem, compressed: mode })).toBe(
        v.compressed,
      );
    });
  }
});

describe('epc-plus compressed link vectors', () => {
  for (const v of epcPlus.vectors.compressedLinks) {
    it(`${v.compressedLink} decodes`, () => {
      const link = parseDigitalLink(v.compressedLink);
      expect(link.elementString.toString()).toBe(v.elementString);
      expect(link.compressed).toBe('full');
    });
    it(`${v.compressedLink} matches its Digital Link`, () => {
      expect(
        parseDigitalLink(v.compressedLink).elementString.equivalent(fromDigitalLink(v.digitalLink)),
      ).toBe(true);
    });
  }
});

// A bad compressed segment is reported after the uncompressed reading's error, so look
// for the compressed-segment error (UNSUPPORTED comes back alone).
const reason = (uri: string): unknown => {
  const r = tryParseDigitalLink(uri);
  if (r.ok) return 'ok';
  const e = r.errors.find((x) => x.details?.['reason'] === 'compressed-segment') ?? r.errors[0];
  return [e?.code, e?.details?.['reason'], e?.details?.['cause'] ?? null];
};
/** details.cause and details.epcCode of the compressed-segment error (final review item 9). */
const epcCause = (uri: string): unknown => {
  const r = tryParseDigitalLink(uri);
  const e = r.ok ? undefined : r.errors.find((x) => x.details?.['reason'] === 'compressed-segment');
  return [e?.details?.['cause'] ?? null, e?.details?.['epcCode'] ?? null];
};

describe('eh / ex links carrying an EPC (E15)', () => {
  const uris = [
    'https://example.com/eh30164596f40c0e5cbe991a83',
    'https://example.com/eh30164596F40C0E5CBE991A83',
    'https://example.com/exMBZFlvQMDly-mRqD',
  ];
  for (const uri of uris) {
    it(`decodes ${uri}`, () => {
      expect(parseDigitalLink(uri).elementString.toString()).toBe(
        '(01)09528765123457(21)123456789123',
      );
    });
  }

  it('reports an EPC without a GS1 key', () => {
    expect(reason('https://example.com/eh350000000000000000000000')).toEqual([
      'INVALID_DIGITAL_LINK',
      'compressed-segment',
      'epc-no-gs1-key',
    ]);
  });
  // A short "+" binary ends inside its GTIN: a compressed-segment error with cause binary.
  it('reports a truncated + scheme EPC', () => {
    expect(reason('https://example.com/ehf7379521141123453')).toEqual([
      'INVALID_DIGITAL_LINK',
      'compressed-segment',
      'binary',
    ]);
    const r = tryParseDigitalLink('https://example.com/ehf7379521141123453');
    const e = r.ok
      ? undefined
      : r.errors.find((x) => x.details?.['reason'] === 'compressed-segment');
    expect([e?.position, e?.length]).toEqual([20, 19]);
  });
  it('reports an unknown header', () => {
    expect(reason('https://example.com/eh01')).toEqual([
      'INVALID_DIGITAL_LINK',
      'compressed-segment',
      'EPC_UNKNOWN_HEADER',
    ]);
  });
  it('reports a bad binary', () => {
    expect(reason('https://example.com/eh3016')).toEqual([
      'INVALID_DIGITAL_LINK',
      'compressed-segment',
      'binary',
    ]);
  });
  it('reports bad hex digits', () => {
    expect(reason('https://example.com/ehzz')).toEqual([
      'INVALID_DIGITAL_LINK',
      'compressed-segment',
      'syntax',
    ]);
  });
  it('details.cause is the EPC reason, else its code; details.epcCode is the code', () => {
    expect(
      [
        'https://example.com/eh350000000000000000000000',
        'https://example.com/eh01',
        'https://example.com/eh3016',
        'https://example.com/ehzz',
        'https://example.com/eh',
        `https://example.com/eh30${'0'.repeat(123)}`,
        'https://example.com/eh3C76451FDF00C0E680F03039',
      ].map(epcCause),
    ).toEqual([
      ['epc-no-gs1-key', 'INVALID_EPC'],
      ['EPC_UNKNOWN_HEADER', 'EPC_UNKNOWN_HEADER'],
      ['binary', 'INVALID_EPC'],
      ['syntax', 'INVALID_EPC'],
      ['EMPTY_INPUT', 'EMPTY_INPUT'],
      ['binary', 'INVALID_EPC'],
      ['binary', 'INVALID_EPC'],
    ]);
  });
  it('applies Digital Link rules to the decoded data', () => {
    const r = tryParseDigitalLink('https://example.com/eh30164596f40c0e5cbe991a83?21=X');
    expect(r.ok ? 'ok' : r.errors[0]?.code).toBe('DUPLICATE_AI');
  });
});

describe('vectors the code rejects (reported, not edited)', () => {
  for (const v of vectors.filter(disagrees)) {
    it(`${v.compressed} is rejected`, () => {
      const r = tryParseDigitalLink(v.compressed);
      const e = r.ok ? undefined : r.errors[0];
      expect(e?.details?.['reason'] ?? e?.code).toBe(DISAGREE[v.compressed]);
    });
  }
});

describe('compressed links round trip', () => {
  it('full and partial', () => {
    fc.assert(
      fc.property(linkableEs, fc.constantFrom<true | 'partial'>(true, 'partial'), (es, mode) => {
        const r = tryToDigitalLink(es, { compressed: mode });
        // (8007) values longer than Table F's 24 characters cannot be compressed.
        const failure = r.ok ? undefined : r.errors[0];
        expect(
          failure === undefined ||
            (failure.code === 'UNSUPPORTED' && failure.details?.['reason'] === 'compression-table'),
        ).toBe(true);
        if (!r.ok) return;
        const back = parseDigitalLink(r.value);
        // Identical repeated AIs collapse in every Digital Link, so compare with the plain link.
        expect(back.elementString.equivalent(fromDigitalLink(toDigitalLink(es)))).toBe(true);
        // Partial with nothing besides the key gives the plain, uncompressed link.
        const distinct = new Set(es.entries().map(([ai]) => ai)).size;
        expect(back.compressed).toBe(mode === true ? 'full' : distinct > 1 ? 'partial' : false);
      }),
      { numRuns: 2000 },
    );
  });

  it('a partial link with nothing to compress is the plain link', () => {
    expect(toDigitalLink(parse('(01)09506000134352'), { compressed: 'partial' })).toBe(
      'https://id.gs1.org/01/09506000134352',
    );
  });

  it('keeps uncompressed query attributes and non-GS1 parameters', () => {
    const seg =
      toDigitalLink(parse('(01)09506000134352(21)12345'), { compressed: true }).split('/').pop() ??
      '';
    const link = parseDigitalLink(`https://example.com/${seg}?17=261231&linkType=all`);
    expect(link.elementString.toString()).toBe('(01)09506000134352(21)12345(17)261231');
    expect(link.ignoredQueryParams).toEqual(['linkType=all']);
    expect(link.stem).toBe('https://example.com');
    const tail = segOf([['21', '12345']]);
    const partial = parseDigitalLink(`https://example.com/a/b/01/09506000134352/${tail}?17=261231`);
    expect(partial.stem).toBe('https://example.com/a/b');
  });
});

const segOf = (pairs: readonly (readonly [string, string])[]): string => {
  const seg = compressSegment(pairs);
  expect(typeof seg).toBe('string');
  return typeof seg === 'string' ? seg : '';
};

describe('hostile compressed segments (Review Focus 4)', () => {
  it('never throw and fail only with the allowed errors (random segments)', () => {
    const start = performance.now();
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...BASE64URL.split('')), minLength: 1, maxLength: 2000 }),
        (seg) => {
          expect(disallowed(tryParseDigitalLink(`https://example.com/${seg}`))).toEqual([]);
        },
      ),
      { numRuns: 2000 },
    );
    expect(performance.now() - start).toBeLessThan(20_000);
  });

  it('never throw and fail only with the allowed errors (mutated valid segments)', () => {
    const start = performance.now();
    fc.assert(
      fc.property(validSegment, mutation, (seg, mutate) => {
        const r = tryParseDigitalLink(`https://example.com/${mutate(seg)}`);
        expect(disallowed(r)).toEqual([]);
      }),
      { numRuns: 2000 },
    );
    expect(performance.now() - start).toBeLessThan(20_000);
  });

  it('reports the cause and position of a bad segment', () => {
    const r = tryParseDigitalLink('https://example.com/SgAA');
    // The uncompressed reading's error comes first, then the compressed one.
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({ details: { reason: 'no-primary-key' } }),
      expect.objectContaining({
        code: 'INVALID_DIGITAL_LINK',
        position: 20,
        details: { reason: 'compressed-segment', cause: 'reserved-code' },
      }),
    ]);
  });

  it('rejects a compressed AI that is neither a qualifier of the key nor a data attribute', () => {
    const seg = segOf([
      ['01', '09506000134352'],
      ['8200', 'http://x.example'],
    ]);
    // The same data uncompressed is rejected, and toDigitalLink refuses to build it.
    expect(
      tryParseDigitalLink('https://example.com/01/09506000134352?8200=http://x.example').ok,
    ).toBe(false);
    expect(tryParseDigitalLink(`https://example.com/${seg}`)).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: 'INVALID_DIGITAL_LINK',
          ai: '8200',
          position: 20,
          length: seg.length,
          details: { reason: 'not-data-attribute' },
        }),
      ],
    });
  });

  it("rejects a compressed qualifier that belongs to another key's path", () => {
    const seg = segOf([
      ['01', '09506000134352'],
      ['254', 'ABC'],
    ]);
    const r = tryParseDigitalLink(`https://example.com/${seg}`);
    expect(r.ok ? [] : r.errors[0]).toMatchObject({
      code: 'INVALID_DIGITAL_LINK',
      ai: '254',
      position: 20,
      length: seg.length,
      details: { reason: 'not-data-attribute' },
    });
  });

  it('checks compressed AIs against the readable key of a partial link', () => {
    const seg = segOf([['8200', 'http://x.example']]);
    const uri = `https://example.com/01/09506000134352/${seg}`;
    const r = tryParseDigitalLink(uri);
    expect(r.ok ? [] : r.errors[0]).toMatchObject({
      code: 'INVALID_DIGITAL_LINK',
      position: uri.length - seg.length,
      length: seg.length,
      details: { reason: 'not-data-attribute' },
    });
  });

  it("accepts the key's qualifiers and data attributes in any compressed order", () => {
    const seg = segOf([
      ['17', '261231'],
      ['21', 'S1'],
      ['01', '09506000134352'],
      ['22', 'V'],
    ]);
    const es = parseDigitalLink(`https://example.com/${seg}`).elementString;
    expect(es.equivalent(parse('(17)261231(21)S1(01)09506000134352(22)V'))).toBe(true);
  });

  it('picks the key AI the other compressed AIs fit when there are several', () => {
    const es = parse('(415)1611286532292(8020)H/a4A(00)807081157236246259');
    const link = parseDigitalLink(toDigitalLink(es, { compressed: true }));
    expect(link.primaryKey).toBe('415');
    expect(link.elementString.equivalent(es)).toBe(true);
  });

  it('places value errors over the compressed segment, path errors in the path', () => {
    const bad = segOf([['01', '09506000134353']]);
    const r = tryParseDigitalLink(`https://example.com/${bad}`);
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({ code: 'CHECK_DIGIT', position: 20, length: bad.length }),
    ]);
    const tail = segOf([['21', '12345']]);
    const p = tryParseDigitalLink(`https://example.com/01/09506000134353/${tail}`);
    expect(p.ok ? [] : p.errors).toEqual([
      expect.objectContaining({ code: 'CHECK_DIGIT', ai: '01', position: 36 }),
    ]);
  });

  it('a partial link with a broken path key reports only the path error', () => {
    const tail = segOf([['99', 'X']]);
    const r = tryParseDigitalLink(`https://example.com/01/0950%zz/${tail}`);
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({ position: 27, details: { reason: 'percent-encoding' } }),
    ]);
  });

  it('requires a primary key in the decompressed data', () => {
    const only10 = compressSegment([['10', 'A']]);
    expect(typeof only10).toBe('string');
    const r = tryParseDigitalLink(
      `https://example.com/${typeof only10 === 'string' ? only10 : ''}`,
    );
    expect(r.ok ? 'ok' : r.errors[0]?.details?.['reason']).toBe('no-primary-key');
  });
});

describe('eh / ex links carrying a + or ++ EPC (F9)', () => {
  const sgtinPlus = 'f73795211411234538566cb0afc4';
  const dsgtinPlus = 'FB342CDE795211411234538566CB0AFC4';
  const sgtinPlusPlus = 'FD3795211411234538566CB0AFC525065F1876F0D996D800';
  it('decodes SGTIN+ (E.3)', () => {
    expect(parseDigitalLink(`https://example.com/eh${sgtinPlus}`).elementString.toString()).toBe(
      '(01)79521141123453(21)32a/b',
    );
  });
  it('decodes DSGTIN+ (E.3), the date being a data attribute', () => {
    expect(parseDigitalLink(`https://example.com/eh${dsgtinPlus}`).elementString.toString()).toBe(
      '(01)79521141123453(21)32a/b(17)220630',
    );
  });
  it('decodes SGTIN++ (E.3) under the URI stem, not the binary hostname', () => {
    const link = parseDigitalLink(`https://example.com/eh${sgtinPlusPlus}`);
    expect([link.elementString.toString(), link.stem]).toEqual([
      '(01)79521141123453(21)32a/b',
      'https://example.com',
    ]);
  });
  it('decodes the ex form of SGTIN+', () => {
    const bits = sgtinPlus
      .split('')
      .map((c) => Number.parseInt(c, 16).toString(2).padStart(4, '0'))
      .join('');
    const b64 = bitsToBase64url(bits);
    expect(parseDigitalLink(`https://example.com/ex${b64}`).elementString.toString()).toBe(
      '(01)79521141123453(21)32a/b',
    );
  });
  it('rejects +AIDC that is not a data attribute', () => {
    const es = parse('(01)79521141123453(21)32a/b(8200)https://a.example/x');
    const hex = epc.fromElementString(es, { scheme: 'sgtin+' }).hex ?? '';
    const r = tryParseDigitalLink(`https://example.com/eh${hex}`);
    const e = r.ok
      ? undefined
      : r.errors.find((x) => x.details?.['reason'] === 'not-data-attribute');
    expect([e?.code, e?.ai, e?.position, e?.length]).toEqual([
      'INVALID_DIGITAL_LINK',
      '8200',
      20,
      hex.length + 2,
    ]);
  });
});
