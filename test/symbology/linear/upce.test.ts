/* oxlint-disable typescript/no-unsafe-type-assertion -- JSON vector files and deliberately hostile inputs */
import { describe, expect, it } from 'vitest';
import vectorsFile from '../../vectors/ean-upc.json' with { type: 'json' };
import { Gs1Error } from '../../../src/core/index.ts';
import { isCanonicalUpce, upceCompress, upceExpand } from '../../../src/symbology/linear/upce.ts';

interface CompressVector {
  id: string;
  kind: string;
  gtin12: string;
  expect: { upce6?: string; rule?: string };
}
const all = vectorsFile.vectors as CompressVector[];
const vectors = all.filter((v) => v.kind === 'upce-compress');
const compressible = vectors.filter((v) => v.expect.upce6 !== undefined);
const plain = vectors.filter((v) => v.expect.upce6 === undefined);

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof Gs1Error ? e.code : 'other';
  }
  return undefined;
}

describe('upceCompress / upceExpand vectors', () => {
  it('has 36 vectors', () => {
    expect(vectors).toHaveLength(36);
  });
  it.each(compressible)('compresses $id', (v) => {
    expect(upceCompress(v.gtin12)).toBe(v.expect.upce6);
  });
  it.each(compressible)('expands $id', (v) => {
    expect(upceExpand(v.expect.upce6 ?? '')).toBe(v.gtin12);
  });
  it.each(plain)('does not compress $id', (v) => {
    expect(upceCompress(v.gtin12)).toBeUndefined();
  });
});

describe('upceCompress input', () => {
  it('rejects bad input', () => {
    expect(upceCompress('12345')).toBeUndefined();
    expect(upceCompress('01234500005x')).toBeUndefined();
    expect(upceCompress('112345000058')).toBeUndefined();
    expect(upceCompress(5 as unknown as string)).toBeUndefined();
  });
});

describe('upceExpand errors', () => {
  it('checks length, characters and the optional check digit', () => {
    expect(codeOf(() => upceExpand('12345'))).toBe('INVALID_LENGTH');
    expect(codeOf(() => upceExpand('12a456'))).toBe('INVALID_CHAR');
    expect(codeOf(() => upceExpand(5 as unknown as string))).toBe('INVALID_CHAR');
    expect(upceExpand('123455', '8')).toBe('012345000058');
    expect(codeOf(() => upceExpand('123455', '7'))).toBe('CHECK_DIGIT');
    expect(codeOf(() => upceExpand('123455', 'x'))).toBe('INVALID_CHAR');
    expect(codeOf(() => upceExpand('123455', '88'))).toBe('INVALID_CHAR');
  });
});

describe('isCanonicalUpce', () => {
  it('rejects bad input', () => {
    expect(isCanonicalUpce('12345')).toBe(false);
    expect(isCanonicalUpce('12345a')).toBe(false);
    expect(isCanonicalUpce(1 as unknown as string)).toBe(false);
  });

  // Takes about a second: all 10^6 bodies.
  it('agrees with compress(expand(x)) for every body; 910,000 are canonical', () => {
    let canonical = 0;
    let mismatches = 0;
    for (let n = 0; n < 1_000_000; n++) {
      const x = n.toString().padStart(6, '0');
      const c = isCanonicalUpce(x);
      if (c) canonical++;
      if (c !== (upceCompress(upceExpand(x)) === x)) mismatches++;
    }
    expect(mismatches).toBe(0);
    expect(canonical).toBe(910_000);
  });
});
