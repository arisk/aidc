import { describe, expect, it } from 'vitest';
import file from '../vectors/digital-link.json' with { type: 'json' };
import { parse } from '../../src/ai/index.ts';
import {
  type DigitalLinkParseOptions,
  fromDigitalLink,
  parseDigitalLink,
  tryFromDigitalLink,
  tryParseDigitalLink,
} from '../../src/digital-link/index.ts';

interface ParseVector {
  readonly source: string;
  readonly kind: string;
  readonly input: string;
  readonly expect: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly bracketed?: string;
  readonly ignored?: readonly string[];
  readonly flags?: Readonly<Record<string, boolean>>;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const vectors = (file.vectors as unknown as ParseVector[]).filter((v) => v.kind === 'parse');

/** Engine options we do not expose; vectors needing them are skipped, and counted. */
const SKIP = (v: ParseVector): string | undefined => {
  if (v.flags?.['permitUnknownAIs'] && v.flags['unknownAInotDLattr'] !== false)
    return 'engine option: unknown AIs allowed but not as DL attributes';
  return undefined;
};

function optionsFor(v: ParseVector): DigitalLinkParseOptions {
  return {
    ...(v.flags?.['permitZeroSuppressedGTIN'] ? { permitZeroSuppressedGtin: true } : {}),
    ...(v.flags?.['permitUnknownAIs'] ? { allowUnknownAIs: true } : {}),
  };
}

// Convenience alphas were removed in DL 1.3.0 (plan decision D3).
// A vector marked ok but carrying an engine error is the DL 4.9 trailing-slash slip; D3 rejects it.
const rejected = (v: ParseVector): boolean =>
  !v.ok || v.error !== undefined || v.flags?.['permitConvenienceAlphas'] === true;
const runnable = vectors.filter((v) => SKIP(v) === undefined);

describe('dl.c and DL URI Syntax 1.7.0 parse vectors', () => {
  it('has every vector', () => {
    expect(vectors.length).toBe(150);
    expect(vectors.filter((v) => SKIP(v) !== undefined).length).toBe(1);
  });

  for (const v of runnable.filter(rejected)) {
    it(`${v.source}: ${v.input} is rejected`, () => {
      expect(tryParseDigitalLink(v.input, optionsFor(v)).ok).toBe(false);
    });
  }

  for (const v of runnable.filter((x) => !rejected(x))) {
    it(`${v.source}: ${v.input}`, () => {
      const r = tryParseDigitalLink(v.input, optionsFor(v));
      const errors = r.ok ? [] : r.errors.map((e) => e.message);
      expect(errors).toEqual([]);
      const link = parseDigitalLink(v.input, optionsFor(v));
      // `expect` is the engine's "^" form (or bracketed for spec examples); both parse as is.
      expect(link.elementString.equals(parse(v.bracketed ?? v.expect, optionsFor(v)))).toBe(true);
    });
  }

  const withIgnored = runnable.filter((x) => !rejected(x) && x.ignored !== undefined);
  it('has the vectors that list ignored parameters', () => {
    expect(withIgnored).toHaveLength(11);
  });

  for (const v of withIgnored) {
    it(`${v.source}: ${v.input} ignores ${JSON.stringify(v.ignored)}`, () => {
      // We skip empty parameters instead of reporting them (dl.c reports one "").
      const ignored = (v.ignored ?? []).filter((s) => s !== '');
      expect(parseDigitalLink(v.input, optionsFor(v)).ignoredQueryParams).toEqual(ignored);
    });
  }
});

describe('custom path prefix and non-GS1 parameters (Review Focus 2)', () => {
  it('keeps the stem and reports ignored parameters', () => {
    const link = parseDigitalLink(
      'https://example.com/my/products/01/09506000134352?linkType=gs1:pip&17=261231#top',
    );
    expect(link.elementString.toString()).toBe('(01)09506000134352(17)261231');
    expect(link.stem).toBe('https://example.com/my/products');
    expect(link.primaryKey).toBe('01');
    expect(link.ignoredQueryParams).toEqual(['linkType=gs1:pip']);
    expect(link.compressed).toBe(false);
  });
});

describe('error positions index the URI (Review Focus 3)', () => {
  it('check digit', () => {
    const r = tryFromDigitalLink('https://id.gs1.org/01/09506000134353');
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({ code: 'CHECK_DIGIT', ai: '01', position: 35, length: 1 }),
    ]);
  });

  it('after percent escapes', () => {
    const r = tryFromDigitalLink('https://id.gs1.org/01/09506000134352/10/%41%42%E9');
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({ code: 'INVALID_CHAR', ai: '10', position: 46 }),
    ]);
  });

  it('decoded NUL is INVALID_CHAR', () => {
    const r = tryFromDigitalLink('https://a/01/12312312312333?99=ABC%00DEF');
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual(['INVALID_CHAR']);
  });
});

const reasonOf = (uri: string, opts: DigitalLinkParseOptions = {}): unknown => {
  const r = tryFromDigitalLink(uri, opts);
  return r.ok ? 'ok' : [r.errors[0]?.code, r.errors[0]?.details?.['reason'], r.errors[0]?.position];
};

describe('structural errors', () => {
  it('reports each reason with its position', () => {
    expect(reasonOf('https://a/01/1231231231233 3')).toEqual([
      'INVALID_DIGITAL_LINK',
      'uri-chars',
      26,
    ]);
    expect(reasonOf('HtTp://a/01/12312312312333')).toEqual(['INVALID_DIGITAL_LINK', 'scheme', 0]);
    expect(reasonOf('https://a')).toEqual(['INVALID_DIGITAL_LINK', 'domain', 8]);
    expect(reasonOf('https://us@er/01/12312312312333')).toEqual([
      'INVALID_DIGITAL_LINK',
      'domain',
      10,
    ]);
    expect(reasonOf('https://a/01/12312312312333/')).toEqual([
      'INVALID_DIGITAL_LINK',
      'no-primary-key',
      undefined,
    ]);
    expect(reasonOf('https://a/01/12312312312333/21/X/10/Y')).toEqual([
      'INVALID_DIGITAL_LINK',
      'key-qualifier-sequence',
      28,
    ]);
    expect(reasonOf('https://a/01/12312312312333/10/')).toEqual([
      'INVALID_DIGITAL_LINK',
      'empty-value',
      31,
    ]);
    expect(reasonOf('https://a/01/12312312312333?10=X')).toEqual([
      'INVALID_DIGITAL_LINK',
      'should-be-in-path',
      28,
    ]);
    expect(reasonOf('https://a/01/12312312312333?21=X')).toEqual([
      'INVALID_DIGITAL_LINK',
      'not-data-attribute',
      28,
    ]);
    expect(reasonOf('https://a/01/12312312312333?99=%zz')).toEqual([
      'INVALID_DIGITAL_LINK',
      'percent-encoding',
      31,
    ]);
    expect(reasonOf('https://a/01/12312312312333?236=1')).toEqual(['UNKNOWN_AI', undefined, 28]);
    expect(reasonOf('https://a/01/12312312312333?99=A&99=A')).toEqual([
      'DUPLICATE_AI',
      undefined,
      33,
    ]);
  });

  it('reports both readings when neither the uncompressed nor the compressed parse works', () => {
    const r = tryParseDigitalLink('https://id.gs1.org/01/09506000134352/10');
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({
        code: 'INVALID_DIGITAL_LINK',
        details: { reason: 'no-primary-key' },
      }),
      expect.objectContaining({
        code: 'INVALID_DIGITAL_LINK',
        position: 37,
        details: { reason: 'compressed-segment', cause: 'version' },
      }),
    ]);
  });

  it('says a trailing slash is not allowed (DL 4.12)', () => {
    const r = tryParseDigitalLink('https://a/01/12312312312333/');
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({
        code: 'INVALID_DIGITAL_LINK',
        message: expect.stringContaining('trailing slash'),
        details: { reason: 'no-primary-key', trailingSlash: true },
      }),
    ]);
    const plain = tryParseDigitalLink('https://a/');
    expect(plain.ok ? [] : plain.errors).toEqual([
      expect.objectContaining({ details: { reason: 'no-primary-key' } }),
    ]);
  });

  it('accepts ";" as a query delimiter (plan decision D2(a))', () => {
    expect(fromDigitalLink('https://a/01/12312312312333?99=A;98=B').toString()).toBe(
      '(01)12312312312333(99)A(98)B',
    );
  });

  it('pads a short GTIN in the path only on request, and in the query always (D3)', () => {
    expect(reasonOf('https://a/01/9520123456788')).toEqual(['INVALID_LENGTH', undefined, 13]);
    expect(
      fromDigitalLink('https://a/01/9520123456788', { permitZeroSuppressedGtin: true }).gtin,
    ).toBe('09520123456788');
    expect(fromDigitalLink('https://a/00/006141411234567890?01=9520123456788').get('01')).toBe(
      '09520123456788',
    );
  });

  it('guards non-string and empty input', () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    expect(tryParseDigitalLink(undefined as unknown as string)).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'SYNTAX' })],
    });
    expect(tryParseDigitalLink('')).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'EMPTY_INPUT' })],
    });
    expect(() => parseDigitalLink('ftp://x')).toThrow(
      expect.objectContaining({ code: 'INVALID_DIGITAL_LINK' }),
    );
  });

  it('collects value and association errors together', () => {
    const r = tryFromDigitalLink('https://a/01/12312312312334?17=991399&3103=1');
    expect(r.ok ? [] : r.errors.map((e) => e.code)).toEqual([
      'CHECK_DIGIT',
      'INVALID_DATE',
      'INVALID_LENGTH',
    ]);
  });
});

describe('dot segments (security review)', () => {
  it.each([
    'https://brand.com/dl/../../admin/01/09520123456788',
    'https://id.gs1.org/01/09520123456788/10/%2e%2e/21/S',
    'https://id.gs1.org/./01/09520123456788',
    'https://id.gs1.org/01/09520123456788/10/.%2E',
    'https://id.gs1.org/01/09520123456788/10/..?17=201225',
  ])('rejects %s, which a browser resolves to another path', (uri) => {
    const r = tryParseDigitalLink(uri);
    expect(r.ok ? 'ok' : r.errors[0]?.details?.['reason']).toBe('dot-segment');
  });

  it('accepts dots inside a segment and in the query', () => {
    expect(fromDigitalLink('https://id.gs1.org/01/09520123456788/10/1.2').toString()).toBe(
      '(01)09520123456788(10)1.2',
    );
    expect(fromDigitalLink('https://a.example/x.y/01/09520123456788?91=..').get('91')).toBe('..');
  });
});

const stemOrReason = (authority: string): unknown => {
  const r = tryParseDigitalLink(`https://${authority}/01/09520123456788`);
  return r.ok ? r.value.stem : r.errors[0]?.details?.['reason'];
};

describe('authority (security review)', () => {
  it.each([
    'good.com:evil.com',
    '[evil]',
    'a.com:99999',
    'a.com:',
    ':80',
    '[1:2:3:4:5:6:7:8:9]',
    '[::1::2]',
    '[::1]x',
  ])('rejects %s', (authority) => {
    expect(stemOrReason(authority)).toBe('domain');
  });
  it.each([
    'id.gs1.org',
    'localhost',
    'a.com:8080',
    'a.com:65535',
    '[::1]',
    '[::]',
    '[2001:db8::1]:443',
    '[::ffff:192.0.2.1]',
    '[1:2:3:4:5:6:7:8]',
  ])('accepts %s', (authority) => {
    expect(stemOrReason(authority)).toBe(`https://${authority}`);
  });
});
