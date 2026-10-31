import { describe, expect, it } from 'vitest';
import { CSET82 } from '../../src/core/index.ts';
import {
  decode6,
  encode6,
  escape6,
  escapeGs3a3,
  isCage,
  unescape6,
  unescapeGs3a3,
} from '../../src/epc/charsets.ts';

describe('Table A-1 (GS3A3) escapes, TDS Annex A', () => {
  it('escapes exactly " % & / < > ? with uppercase hex', () => {
    expect(escapeGs3a3('"%&/<>?')).toBe('%22%25%26%2F%3C%3E%3F');
    // oxlint-disable-next-line typescript/no-misused-spread -- CSET82 is plain ASCII
    const others = [...CSET82].filter((c) => !'"%&/<>?'.includes(c)).join('');
    expect(escapeGs3a3(others)).toBe(others);
  });

  it('round trips every CSET 82 character', () => {
    expect(unescapeGs3a3(escapeGs3a3(CSET82))).toEqual({ value: CSET82 });
  });

  it('accepts either hex case and over-escaping (E5)', () => {
    expect(unescapeGs3a3('32a%2fb')).toEqual({ value: '32a/b' });
    expect(unescapeGs3a3('%41')).toEqual({ value: 'A' });
  });

  it('rejects literal characters that must be escaped, bad escapes and empty input', () => {
    expect(unescapeGs3a3('32a/b')).toEqual({ badAt: 3 });
    expect(unescapeGs3a3('a%2')).toEqual({ badAt: 1 });
    expect(unescapeGs3a3('a%00')).toEqual({ badAt: 1 });
    expect(unescapeGs3a3('a%23')).toEqual({ badAt: 1 }); // '#' is not in Table A-1
    expect(unescapeGs3a3('a b')).toEqual({ badAt: 1 });
    expect(unescapeGs3a3('')).toEqual({ badAt: 0 });
  });
});

describe('Table G-1 (6-bit) and CPRef/ADI rules', () => {
  it('maps characters to 6-bit values and back', () => {
    const chars = '#-/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (const c of chars) expect(decode6(encode6(c))).toBe(c);
    expect(encode6('A')).toBe(1);
    expect(encode6('#')).toBe(0x23);
    expect(decode6(0)).toBe('');
    expect(decode6(0x3b)).toBe(''); // ';' is not in Table G-1
  });

  it('escapes / and # and unescapes per hash rule', () => {
    expect(escape6('A/B#C')).toBe('A%2FB%23C');
    expect(unescape6('123ABC%2f-', 'any')).toEqual({ value: '123ABC/-' });
    expect(unescape6('%23A1', 'first')).toEqual({ value: '#A1' });
    expect(unescape6('A%23', 'first')).toEqual({ badAt: 1 });
    expect(unescape6('%23A', 'none')).toEqual({ badAt: 0 });
    expect(unescape6('ab', 'any')).toEqual({ badAt: 0 });
    expect(unescape6('', 'none')).toEqual({ value: '' });
  });

  it('isCage accepts 5 or 6 CAGE characters (no I or O)', () => {
    expect(isCage('2S194')).toBe(true);
    expect(isCage('W81X9C')).toBe(true);
    expect(isCage('ABCDI')).toBe(false);
    expect(isCage('ABCD')).toBe(false);
    expect(isCage('ABCDEFG')).toBe(false);
  });
});
