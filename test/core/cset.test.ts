import { describe, expect, it } from 'vitest';
import {
  CSET32,
  CSET39,
  CSET64,
  CSET82,
  firstInvalidChar,
  isDigits,
} from '../../src/core/index.ts';

describe('character sets', () => {
  it('have the sizes their names promise', () => {
    expect(CSET82.length).toBe(82);
    expect(CSET39.length).toBe(39);
    expect(CSET64.length).toBe(64);
    expect(CSET32.length).toBe(32);
  });

  it('finds the first invalid character per set', () => {
    expect(firstInvalidChar('0123', 'N')).toBe(-1);
    expect(firstInvalidChar('01A3', 'N')).toBe(2);
    expect(firstInvalidChar('AB~C', 'X')).toBe(2);
    expect(firstInvalidChar('AB C', 'X')).toBe(2);
    expect(firstInvalidChar('AB-/#9Z', 'Y')).toBe(-1);
    expect(firstInvalidChar('ABa', 'Y')).toBe(2);
    expect(firstInvalidChar('Ab0-_=', 'Z')).toBe(-1);
    expect(firstInvalidChar('Ab+', 'Z')).toBe(2);
  });

  it('rejects non-ASCII characters at the right index', () => {
    expect(firstInvalidChar('ABé', 'X')).toBe(2);
    expect(firstInvalidChar('A\u{1F600}', 'X')).toBe(1);
    expect(firstInvalidChar('A\u0000', 'X')).toBe(1);
  });

  it('isDigits', () => {
    expect(isDigits('0123456789')).toBe(true);
    expect(isDigits('')).toBe(false);
    expect(isDigits('12a')).toBe(false);
    expect(isDigits('１２')).toBe(false);
  });
});
