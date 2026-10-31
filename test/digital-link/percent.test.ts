import { describe, expect, it } from 'vitest';
import file from '../vectors/digital-link.json' with { type: 'json' };
import { percentDecode, percentEncode } from '../../src/digital-link/percent.ts';

interface Pair {
  readonly path: string;
  readonly query: string;
}
interface CodecVector {
  readonly kind: string;
  readonly input: string;
  readonly expect: Pair | null;
  readonly ok: boolean;
}
const all: readonly unknown[] = file.vectors;
function isCodecVector(v: unknown): v is CodecVector {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    (v.kind === 'escape' || v.kind === 'unescape')
  );
}
const vectors: readonly CodecVector[] = all.filter(isCodecVector);
const MALFORMED = /%(?![0-9A-Fa-f]{2})/;

describe('percentEncode (dl.c URIescape vectors)', () => {
  for (const v of vectors.filter((x) => x.kind === 'escape')) {
    it(`input ${JSON.stringify(v.input)}`, () => {
      expect(percentEncode(v.input, false)).toBe(v.expect?.path);
      expect(percentEncode(v.input, true)).toBe(v.expect?.query);
    });
  }

  it('encodes every non-unreserved CSET 82 character with uppercase hex', () => {
    expect(percentEncode('A/B%C&D+E(F)', false)).toBe('A%2FB%25C%26D%2BE%28F%29');
  });

  it('rejects characters above U+00FF, which no GS1 value contains', () => {
    expect(() => percentEncode('€', false)).toThrow(RangeError);
  });
});

describe('percentDecode (dl.c URIunescape vectors)', () => {
  const unescapes = vectors.filter((x) => x.kind === 'unescape');
  const malformed = unescapes.filter((v) => MALFORMED.test(v.input));
  const nul = unescapes.filter((v) => !MALFORMED.test(v.input) && !v.ok);
  const normal = unescapes.filter((v) => !MALFORMED.test(v.input) && v.ok);

  for (const v of malformed) {
    // Plan decision D2(b): dl.c keeps a malformed "%" literally; we reject it.
    it(`${JSON.stringify(v.input)} is rejected`, () => {
      expect(percentDecode(v.input, false)).toEqual({
        badPercentAt: MALFORMED.exec(v.input)?.index,
      });
    });
  }
  for (const v of nul) {
    // "%00": dl.c rejects the decoded NUL. We decode it; value validation rejects it later
    // with INVALID_CHAR (pinned in test/digital-link/parse.test.ts).
    it(`${JSON.stringify(v.input)} decodes the NUL`, () => {
      expect(percentDecode(v.input, false)).toMatchObject({ value: 'A\u0000B' });
    });
  }
  for (const v of normal) {
    it(`input ${JSON.stringify(v.input)}`, () => {
      expect(percentDecode(v.input, false)).toMatchObject({ value: v.expect?.path });
      expect(percentDecode(v.input, true)).toMatchObject({ value: v.expect?.query });
    });
  }

  it('records two shifts per escape', () => {
    expect(percentDecode('A%2FB%2f', false)).toEqual({ value: 'A/B/', shifts: [1, 1, 3, 3] });
  });

  it('keeps + in the path and makes it a space in the query', () => {
    expect(percentDecode('a+b', false)).toMatchObject({ value: 'a+b' });
    expect(percentDecode('a+b', true)).toMatchObject({ value: 'a b' });
  });
});
