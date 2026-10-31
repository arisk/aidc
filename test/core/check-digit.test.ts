import { describe, expect, it } from 'vitest';
import {
  Gs1Error,
  checkCharacterPair,
  checkDigit,
  isValidCheckCharacterPair,
  isValidCheckDigit,
} from '../../src/core/index.ts';

describe('mod 10 check digit (GenSpecs 7.9)', () => {
  it.each([
    ['0950600013435', '2'],
    ['629104150021', '3'],
    ['00614141123456789', '0'],
    ['1234567', '0'],
    ['41600033610', '8'],
    ['12345678901234567', '5'],
  ])('checkDigit(%s) = %s', (data, cd) => {
    expect(checkDigit(data)).toBe(cd);
    expect(isValidCheckDigit(data + cd)).toBe(true);
  });

  it('detects a wrong check digit', () => {
    expect(isValidCheckDigit('09506000134353')).toBe(false);
  });

  it('isValidCheckDigit is false for non-digits and too-short input', () => {
    expect(isValidCheckDigit('')).toBe(false);
    expect(isValidCheckDigit('7')).toBe(false);
    expect(isValidCheckDigit('0950600013435X')).toBe(false);
  });

  it('checkDigit throws Gs1Error for bad input', () => {
    expect(() => checkDigit('')).toThrow(Gs1Error);
    expect(() => checkDigit('12a')).toThrow(
      expect.objectContaining({ code: 'INVALID_CHAR', position: 2 }),
    );
  });
});

describe('GMN check character pair (GenSpecs 7.9.5)', () => {
  it('matches the GenSpecs example', () => {
    expect(checkCharacterPair('1987654Ad4X4bL5ttr2310c')).toBe('2K');
    expect(isValidCheckCharacterPair('1987654Ad4X4bL5ttr2310c2K')).toBe(true);
    expect(isValidCheckCharacterPair('1987654Ad4X4bL5ttr2310c2L')).toBe(false);
  });

  it('empty data gives "22"', () => {
    expect(checkCharacterPair('')).toBe('22');
  });

  it('rejects non-CSET82 data and data longer than 97 characters', () => {
    expect(() => checkCharacterPair('AB~')).toThrow(
      expect.objectContaining({ code: 'INVALID_CHAR', position: 2 }),
    );
    expect(() => checkCharacterPair('A'.repeat(98))).toThrow(
      expect.objectContaining({ code: 'INVALID_LENGTH' }),
    );
    expect(isValidCheckCharacterPair('2')).toBe(false);
    expect(() => checkCharacterPair('ABé')).toThrow(
      expect.objectContaining({ code: 'INVALID_CHAR', position: 2 }),
    );
    expect(isValidCheckCharacterPair('AB~C')).toBe(false);
    expect(isValidCheckCharacterPair('A'.repeat(99) + '22')).toBe(false);
  });
});
