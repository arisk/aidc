import { describe, expect, it } from 'vitest';
import {
  aiPatternMatches,
  findAiAt,
  getAi,
  resolveAi,
  unknownAiEntry,
} from '../../src/ai/lookup.ts';

describe('getAi / findAiAt', () => {
  it('finds 2, 3 and 4 digit AIs', () => {
    expect(getAi('01')?.title).toBe('GTIN');
    expect(getAi('422')?.title).toBe('ORIGIN');
    expect(getAi('8020')?.title).toBe('REF No.');
    expect(getAi('9999')).toBeUndefined();
    expect(getAi('')).toBeUndefined();
  });

  it('finds the AI at an offset', () => {
    expect(findAiAt('xx0109506000134352', 2)?.ai).toBe('01');
    expect(findAiAt('3103000500', 0)?.ai).toBe('3103');
    expect(findAiAt('89', 0)).toBeUndefined();
    expect(findAiAt('0', 0)).toBeUndefined();
  });

  it('matches patterns with n wildcards', () => {
    expect(aiPatternMatches('310n', '3103')).toBe(true);
    expect(aiPatternMatches('31nn', '3155')).toBe(true);
    expect(aiPatternMatches('31nn', '320')).toBe(false);
    expect(aiPatternMatches('01', '01')).toBe(true);
    expect(aiPatternMatches('01', '02')).toBe(false);
    expect(aiPatternMatches('310n', '310x')).toBe(false);
  });

  it('resolves unknown AIs like the Syntax Engine (oracle regressions)', () => {
    expect(resolveAi('01', false)?.title).toBe('GTIN');
    expect(resolveAi('89', false)).toBeUndefined();
    expect(resolveAi('89', true)?.components).toEqual([
      { cset: 'X', min: 1, max: 88, optional: false, linters: [] },
    ]);
    expect(unknownAiEntry('01')).toBeUndefined();
    expect(unknownAiEntry('8x')).toBeUndefined();
    expect(unknownAiEntry('9')).toBeUndefined();
    expect(unknownAiEntry('9999')).toBeUndefined();
    expect(unknownAiEntry('2399')).toBeUndefined();
    expect(unknownAiEntry('239')).toMatchObject({ lengthKnown: true, entry: { fnc1: true } });
    expect(unknownAiEntry('419')).toMatchObject({ lengthKnown: true, entry: { fnc1: false } });
    expect(unknownAiEntry('0599')).toMatchObject({ lengthKnown: false });
  });

  it('gives unknown AIs a predefined length only under 41 (3 digits) and 31 to 36 (4 digits)', () => {
    const fixed: string[] = [];
    for (let n = 0; n < 10_000; n++) {
      for (const ai of [String(n).padStart(4, '0'), String(n % 1000).padStart(3, '0')]) {
        const u = unknownAiEntry(ai);
        if (u && !u.entry.fnc1)
          fixed.push(`${ai.slice(0, 2)}/${ai.length}/${u.entry.components[0]?.max}`);
      }
    }
    expect(new Set(fixed)).toEqual(
      new Set(['31/4/6', '32/4/6', '33/4/6', '34/4/6', '35/4/6', '36/4/6', '41/3/13']),
    );
  });

  it('finds unknown AIs in raw data only when their length is implied', () => {
    expect(findAiAt('4190000000000000', 0, true)?.ai).toBe('419');
    expect(findAiAt('89ABC', 0, true)).toBeUndefined();
    expect(findAiAt('41', 0, true)).toBeUndefined();
  });
});

describe('table immutability (F7)', () => {
  it('deep-freezes table entries', () => {
    const e = getAi('01');
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen(e?.components)).toBe(true);
    expect(Object.isFrozen(e?.components[0])).toBe(true);
    expect(Object.isFrozen(e?.components[0]?.linters)).toBe(true);
    expect(Object.isFrozen(e?.ex)).toBe(true);
    expect(Object.isFrozen(e?.dlpkey)).toBe(true);
    expect(Object.isFrozen(e?.dlpkey?.[0])).toBe(true);
    const r = getAi('10')?.req;
    expect(Object.isFrozen(r?.[0])).toBe(true);
    expect(Object.isFrozen(r?.[0]?.[0])).toBe(true);
  });

  it('freezes unknown pseudo entries too', () => {
    const u = resolveAi('89', true);
    expect(Object.isFrozen(u)).toBe(true);
    expect(Object.isFrozen(u?.components[0])).toBe(true);
  });
});
