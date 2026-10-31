import { describe, expect, it } from 'vitest';
import { type Tokens, checkElement } from '../../src/ai/internal.ts';

const fresh = (): Tokens => ({ elements: [], errors: [] });

describe('checkElement', () => {
  it('appends a valid element with its position', () => {
    const out = fresh();
    checkElement(out, { ai: '10', value: 'ABC', position: 4, valueStart: 8 }, false);
    expect(out.errors).toEqual([]);
    expect(out.elements).toEqual([{ ai: '10', value: 'ABC', position: 4 }]);
  });

  it('omits position for object input', () => {
    const out = fresh();
    checkElement(out, { ai: '10', value: 'ABC', valueStart: 0 }, false);
    expect(out.elements).toEqual([{ ai: '10', value: 'ABC' }]);
  });

  it('maps value indexes through shifts (two per %XX escape)', () => {
    // Value "ABé" decoded from raw "%41%42%E9" starting at input index 40: each escape
    // spends two extra input characters, so value index 2 sits at input index 40 + 2 + 4.
    const out = fresh();
    checkElement(
      out,
      { ai: '10', value: 'ABé', position: 37, valueStart: 40, shifts: [0, 0, 1, 1, 2, 2] },
      false,
    );
    expect(out.errors[0]).toMatchObject({ code: 'INVALID_CHAR', ai: '10', position: 46 });
  });

  it('reports an unknown AI with position when one is given', () => {
    const out = fresh();
    checkElement(out, { ai: '89', value: 'X', position: 7, valueStart: 11 }, false);
    expect(out.errors[0]).toMatchObject({ code: 'UNKNOWN_AI', ai: '89', position: 7, length: 2 });
    expect(out.elements).toEqual([]);
  });

  it('reports an unknown AI without position for object input', () => {
    const out = fresh();
    checkElement(out, { ai: '89', value: 'X', valueStart: 0 }, false);
    expect(out.errors[0]?.position).toBeUndefined();
  });
});
