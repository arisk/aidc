import { describe, expect, it } from 'vitest';
import file from '../vectors/digital-link.json' with { type: 'json' };
import { ElementString, parse } from '../../src/ai/index.ts';
import {
  DEFAULT_DIGITAL_LINK_DOMAIN,
  fromDigitalLink,
  toDigitalLink,
  tryToDigitalLink,
} from '../../src/digital-link/index.ts';

interface GenVector {
  readonly kind: string;
  readonly input: {
    readonly ai?: string;
    readonly stem?: string | null;
    readonly uri?: string;
    readonly dataStr?: string;
  };
  readonly expect: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly flags?: Readonly<Record<string, boolean>>;
}
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const vectors = file.vectors as unknown as GenVector[];
const domainOf = (stem: string | null | undefined): { domain?: string } =>
  stem === null || stem === undefined ? {} : { domain: stem };

// Skipped on purpose (see the task report). Each reason is listed so the skip is auditable:
// - empty stem: D5 validates the domain, covered by the 'validates the domain' test (1 vector);
// - (235)+(10): the D5 tie-break makes it valid, asserted separately below (1 vector).
const SKIPPED_INPUTS: readonly string[] = [
  '(01)12312312312326',
  '(01)12312312312326(235)ABC(10)DEF',
];
const skipped = (x: GenVector): boolean =>
  x.input.stem === '' || x.input.ai === '(01)12312312312326(235)ABC(10)DEF';

/**
 * allowUnknownAIs treats unknown AIs as data attributes, which is the engine's permitUnknownAIs
 * with unknownAInotDLattr off. The vector with only permitUnknownAIs runs without the option
 * (the engine rejects (89) as an attribute; we reject it as unknown).
 */
const unknownAsAttribute = (x: GenVector): { allowUnknownAIs?: true } =>
  x.flags?.['permitUnknownAIs'] === true && x.flags['unknownAInotDLattr'] === false
    ? { allowUnknownAIs: true }
    : {};

describe('dl.c generate vectors (attributeOrder engine)', () => {
  it('skips exactly the two audited vectors', () => {
    const names = vectors.filter((x) => x.kind === 'gen' && skipped(x)).map((x) => x.input.ai);
    expect(new Set(names)).toEqual(new Set(SKIPPED_INPUTS));
    expect(names).toHaveLength(SKIPPED_INPUTS.length);
  });

  for (const v of vectors.filter((x) => x.kind === 'gen' && !skipped(x))) {
    it(`${v.input.ai} @ ${String(v.input.stem)}`, () => {
      const r = tryToDigitalLink(v.input.ai ?? '', {
        ...domainOf(v.input.stem),
        ...unknownAsAttribute(v),
        attributeOrder: 'engine',
      });
      expect(v.ok ? r : r.ok).toEqual(v.ok ? { ok: true, value: v.expect } : false);
    });
  }

  it('D5 tie-break turns the dl.c (235)+(10) failure into a valid URI', () => {
    expect(
      toDigitalLink('(01)12312312312326(235)ABC(10)DEF', {
        domain: 'https://example.com',
        attributeOrder: 'engine',
      }),
    ).toBe('https://example.com/01/12312312312326/235/ABC?10=DEF');
  });

  it('round trip keeps a (235) path (dl.c roundtrip vector, via the D5 tie-break)', () => {
    for (const v of vectors.filter((x) => x.kind === 'roundtrip')) {
      const es = fromDigitalLink(v.input.uri ?? '');
      expect(toDigitalLink(es, { ...domainOf(v.input.stem), attributeOrder: 'engine' })).toBe(
        v.expect,
      );
    }
  });
});

const reason = (s: string): unknown => {
  const r = tryToDigitalLink(parse(s, { validateAssociations: false }));
  return r.ok ? 'ok' : [r.errors[0]?.details?.['reason'], r.errors[0]?.ai];
};

describe('toDigitalLink defaults (plan decision D5)', () => {
  const es = parse('(01)09520123456788(3922)0299(17)201225(3103)000195(10)ABC123');

  it('uses id.gs1.org and canonical (lexical) attribute order', () => {
    expect(DEFAULT_DIGITAL_LINK_DOMAIN).toBe('https://id.gs1.org');
    expect(toDigitalLink(es)).toBe(
      'https://id.gs1.org/01/09520123456788/10/ABC123?17=201225&3103=000195&3922=0299',
    );
  });

  it('engine order puts fixed-length AIs first, in input order', () => {
    expect(toDigitalLink(es, { attributeOrder: 'engine' })).toBe(
      'https://id.gs1.org/01/09520123456788/10/ABC123?17=201225&3103=000195&3922=0299',
    );
    expect(
      toDigitalLink(parse('(01)09520123456788(99)X(11)200101(10)A'), { attributeOrder: 'engine' }),
    ).toBe('https://id.gs1.org/01/09520123456788/10/A?11=200101&99=X');
  });

  it('a repeated identical AI builds the same URI as a single one', () => {
    const once = ElementString.from([
      ['01', '09506000134352'],
      ['10', 'A'],
    ]);
    const twice = ElementString.from([
      ['01', '09506000134352'],
      ['10', 'A'],
      ['10', 'A'],
    ]);
    expect(toDigitalLink(twice)).toBe(toDigitalLink(once));
  });

  it('accepts a string and a custom domain with path prefix', () => {
    expect(toDigitalLink('(00)006141411234567890', { domain: 'https://example.com/a/b/' })).toBe(
      'https://example.com/a/b/00/006141411234567890',
    );
  });

  it('validates the domain', () => {
    for (const domain of [
      '',
      'example.com',
      'ftp://example.com',
      'https://',
      'https://a?b',
      'https://a#b',
      'https://us@er',
      'https://a b',
    ]) {
      const r = tryToDigitalLink('(00)006141411234567890', { domain });
      expect(r.ok ? 'ok' : [r.errors[0]?.code, r.errors[0]?.details?.['reason'], domain]).toEqual([
        'INVALID_DIGITAL_LINK',
        'domain',
        domain,
      ]);
    }
  });

  it('drops every trailing slash of the domain', () => {
    expect(toDigitalLink('(00)006141411234567890', { domain: 'https://example.com//' })).toBe(
      'https://example.com/00/006141411234567890',
    );
    expect(toDigitalLink('(00)006141411234567890', { domain: 'https://example.com/a///' })).toBe(
      'https://example.com/a/00/006141411234567890',
    );
  });

  it('rejects a domain path prefix that ends with a GS1 key pair', () => {
    for (const domain of ['https://example.com/01/x', 'https://example.com/p/414/9520123456788/']) {
      for (const compressed of [false, true] as const) {
        const r = tryToDigitalLink('(01)09506000134352(10)ABC', { domain, compressed });
        expect(r.ok ? [] : r.errors).toEqual([
          expect.objectContaining({
            code: 'INVALID_DIGITAL_LINK',
            message: expect.stringContaining('must not end with a GS1 key'),
            details: { reason: 'domain' },
          }),
        ]);
      }
    }
    // A key AI alone, or a non-key pair, is a plain prefix.
    expect(toDigitalLink('(01)09506000134352', { domain: 'https://example.com/10/x' })).toBe(
      'https://example.com/10/x/01/09506000134352',
    );
    expect(toDigitalLink('(01)09506000134352', { domain: 'https://example.com/01' })).toBe(
      'https://example.com/01/01/09506000134352',
    );
  });

  it('allowUnknownAIs puts unknown AIs in the query, as the parser accepts them', () => {
    const uri = 'https://example.com/01/09506000134352?89=ABC';
    const parsed = fromDigitalLink(uri, { allowUnknownAIs: true });
    expect(toDigitalLink(parsed, { domain: 'https://example.com', allowUnknownAIs: true })).toBe(
      uri,
    );
    expect(
      toDigitalLink('(01)09506000134352(89)ABC', {
        domain: 'https://example.com',
        allowUnknownAIs: true,
      }),
    ).toBe(uri);
    const r = tryToDigitalLink(parsed, { domain: 'https://example.com' });
    expect(r.ok ? [] : r.errors).toEqual([
      expect.objectContaining({ ai: '89', details: { reason: 'not-data-attribute' } }),
    ]);
  });

  it('reports a missing key and AIs that are not data attributes', () => {
    expect(reason('(10)ABC')).toEqual(['no-primary-key', undefined]);
    expect(reason('(01)09520123456788(8200)http://example.com')).toEqual([
      'not-data-attribute',
      '8200',
    ]);
    expect(reason('(253)9520123456788X(21)1')).toEqual(['not-data-attribute', '21']);
  });

  it('passes through parse errors of string input', () => {
    expect(tryToDigitalLink('(01)123')).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'INVALID_LENGTH' })],
    });
  });
});

describe('reserved characters round trip (Review Focus 1)', () => {
  it('encodes and decodes every reserved character', () => {
    const es = ElementString.from([
      ['01', '09506000134352'],
      ['10', 'A/B%C&D+E(F)'],
      ['99', "!*'(),;:=?"],
    ]);
    const uri = toDigitalLink(es);
    expect(uri).toBe(
      'https://id.gs1.org/01/09506000134352/10/A%2FB%25C%26D%2BE%28F%29?99=%21%2A%27%28%29%2C%3B%3A%3D%3F',
    );
    expect(fromDigitalLink(uri).equivalent(es)).toBe(true);
  });

  it('a raw "+" in a query value is a space, so INVALID_CHAR', () => {
    expect(() => fromDigitalLink('https://id.gs1.org/01/09506000134352?99=A+B')).toThrow(
      expect.objectContaining({ code: 'INVALID_CHAR', ai: '99' }),
    );
  });
});

const buildFailure = (r: ReturnType<typeof tryToDigitalLink>): unknown =>
  r.ok ? r.value : [r.errors[0]?.code, r.errors[0]?.details?.['reason'], r.errors[0]?.ai];

describe('dot segments (security review)', () => {
  it('rejects a path value a browser would resolve away', () => {
    for (const v of ['.', '..']) {
      expect(buildFailure(tryToDigitalLink(`(01)09520123456788(22)X(10)${v}(21)S`))).toEqual([
        'INVALID_DIGITAL_LINK',
        'dot-segment',
        '10',
      ]);
    }
  });

  it('keeps dots that are not a whole segment, and dot values in the query or compressed', () => {
    expect(toDigitalLink('(01)09520123456788(10)1.2')).toBe(
      'https://id.gs1.org/01/09520123456788/10/1.2',
    );
    expect(toDigitalLink('(01)09520123456788(91)..')).toBe(
      'https://id.gs1.org/01/09520123456788?91=..',
    );
    const packed = toDigitalLink('(01)09520123456788(10)..', { compressed: true });
    expect(fromDigitalLink(packed).toString()).toBe('(01)09520123456788(10)..');
  });

  it('rejects a domain path with a dot segment', () => {
    for (const domain of [
      'https://brand.com/dl/..',
      'https://brand.com/./dl',
      'https://a.com/%2E',
    ]) {
      expect(buildFailure(tryToDigitalLink('(01)09520123456788', { domain }))).toEqual([
        'INVALID_DIGITAL_LINK',
        'domain',
        undefined,
      ]);
    }
  });
});

describe('domain authority (security review)', () => {
  it.each(['https://good.com:evil.com', 'https://[evil]', 'https://a.com:99999'])(
    'rejects %s',
    (domain) => {
      expect(buildFailure(tryToDigitalLink('(01)09520123456788', { domain }))).toEqual([
        'INVALID_DIGITAL_LINK',
        'domain',
        undefined,
      ]);
    },
  );
  it('accepts a port and an IPv6 host', () => {
    expect(toDigitalLink('(01)09520123456788', { domain: 'https://[::1]:8443/dl' })).toBe(
      'https://[::1]:8443/dl/01/09520123456788',
    );
  });
});
