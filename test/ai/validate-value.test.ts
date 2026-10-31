import { describe, expect, it } from 'vitest';
import type { AiEntry } from '../../src/ai/dictionary.ts';
import { LINT_MESSAGES } from '../../src/ai/linters/index.ts';
import type { LintCode } from '../../src/ai/linters/index.ts';
import { getAi, resolveAi } from '../../src/ai/lookup.ts';
import { lintCodeToErrorCode, validateValue } from '../../src/ai/validate-value.ts';

const isLintCode = (k: string): k is LintCode => k in LINT_MESSAGES;

const entryOf = (ai: string): AiEntry => {
  const e = getAi(ai);
  if (!e) throw new Error(`no AI ${ai}`);
  return e;
};
const v = (ai: string, value: string, offset = 0) => validateValue(ai, value, entryOf(ai), offset);

describe('validateValue', () => {
  it('accepts valid values', () => {
    expect(v('01', '09506000134352')).toBeNull();
    expect(v('10', 'ABC123')).toBeNull();
    expect(v('17', '201225')).toBeNull();
    expect(v('423', '056')).toBeNull();
    expect(v('423', '056056')).toBeNull();
    expect(v('8013', '1987654Ad4X4bL5ttr2310c2K')).toBeNull();
    expect(v('4330', '000123-')).toBeNull();
  });

  it('reports length problems', () => {
    expect(v('01', '0950600013435')).toMatchObject({ code: 'INVALID_LENGTH', ai: '01' });
    expect(v('10', '')).toMatchObject({ code: 'INVALID_LENGTH' });
    expect(v('10', 'A'.repeat(21))).toMatchObject({ code: 'INVALID_LENGTH' });
    expect(v('423', '0560')).toMatchObject({ code: 'INVALID_LENGTH' });
  });

  it('maps linter failures to error codes with absolute positions', () => {
    expect(v('01', '09506000134353', 4)).toMatchObject({
      code: 'CHECK_DIGIT',
      ai: '01',
      position: 17,
      length: 1,
      details: { lint: 'INCORRECT_CHECK_DIGIT' },
    });
    expect(v('10', 'AB~C', 4)).toMatchObject({ code: 'INVALID_CHAR', position: 6, length: 1 });
    expect(v('10', 'ABé', 0)).toMatchObject({ code: 'INVALID_CHAR', position: 2 });
    expect(v('17', '201232')).toMatchObject({ code: 'INVALID_DATE', position: 4, length: 2 });
    expect(v('422', '999')).toMatchObject({
      code: 'INVALID_VALUE',
      details: { lint: 'NOT_ISO3166' },
    });
  });

  it('messages follow the Syntax Engine style', () => {
    expect(v('01', '09506000134353')?.message).toBe(
      'AI (01): The numeric check digit is incorrect.',
    );
  });

  it('validates unknown AIs as CSET 82 with the AI and value within 90 characters', () => {
    const unknown = resolveAi('89', true);
    if (!unknown) throw new Error('89 should resolve as unknown');
    expect(validateValue('89', 'ABC', unknown, 0)).toBeNull();
    expect(validateValue('89', 'A~', unknown, 0)).toMatchObject({ code: 'INVALID_CHAR' });
    expect(validateValue('89', 'A'.repeat(88), unknown, 0)).toBeNull();
    expect(validateValue('89', 'A'.repeat(89), unknown, 0)).toMatchObject({
      code: 'INVALID_LENGTH',
    });
  });

  it('skips a trailing optional component when the value ends', () => {
    const e: AiEntry = {
      ai: 'ZZ',
      title: 'T',
      fnc1: false,
      dlAttr: false,
      req: [],
      ex: [],
      components: [
        { cset: 'N', min: 2, max: 2, optional: false, linters: [] },
        { cset: 'X', min: 1, max: 3, optional: true, linters: [] },
      ],
    };
    expect(validateValue('ZZ', '12', e, 0)).toBeNull();
    expect(validateValue('ZZ', '12ab', e, 0)).toBeNull();
  });

  it('rejects a fixed component running past the end', () => {
    const e: AiEntry = {
      ai: 'ZZ',
      title: 'T',
      fnc1: false,
      dlAttr: false,
      req: [],
      ex: [],
      components: [
        { cset: 'N', min: 2, max: 2, optional: false, linters: [] },
        { cset: 'N', min: 3, max: 3, optional: true, linters: [] },
      ],
    };
    expect(validateValue('ZZ', '1234', e, 0)).toMatchObject({ code: 'INVALID_LENGTH' });
  });

  it('rejects a value below the required minimum', () => {
    const e: AiEntry = {
      ai: 'ZZ',
      title: 'T',
      fnc1: false,
      dlAttr: false,
      req: [],
      ex: [],
      components: [
        { cset: 'N', min: 2, max: 2, optional: false, linters: [] },
        { cset: 'N', min: 1, max: 3, optional: true, linters: [] },
        { cset: 'N', min: 1, max: 1, optional: true, linters: [] },
      ],
    };
    expect(validateValue('ZZ', '1', e, 0)).toMatchObject({ code: 'INVALID_LENGTH' });
  });
});

const expected = (code: string): string => {
  if (code === 'NON_DIGIT_CHARACTER' || code.startsWith('INVALID_CSET')) return 'INVALID_CHAR';
  if (code === 'INCORRECT_CHECK_DIGIT' || code === 'INCORRECT_CHECK_PAIR') return 'CHECK_DIGIT';
  if (
    ['ILLEGAL_MONTH', 'ILLEGAL_DAY', 'ILLEGAL_HOUR', 'ILLEGAL_MINUTE', 'ILLEGAL_SECOND'].includes(
      code,
    ) ||
    code.startsWith('DATE_') ||
    code.startsWith('HOUR_') ||
    code.startsWith('MINUTE_') ||
    code.startsWith('SECOND_')
  ) {
    return 'INVALID_DATE';
  }
  return 'INVALID_VALUE';
};

describe('lintCodeToErrorCode', () => {
  it('pins the mapping for every lint code', () => {
    const codes = Object.keys(LINT_MESSAGES).filter(isLintCode);
    expect(codes.length).toBeGreaterThan(30);
    for (const code of codes)
      expect(`${code}:${lintCodeToErrorCode(code)}`).toBe(`${code}:${expected(code)}`);
  });

  it('pins explicit examples per branch', () => {
    expect(lintCodeToErrorCode('NON_DIGIT_CHARACTER')).toBe('INVALID_CHAR');
    expect(lintCodeToErrorCode('INCORRECT_CHECK_PAIR')).toBe('CHECK_DIGIT');
    expect(lintCodeToErrorCode('ILLEGAL_ZERO_VALUE')).toBe('INVALID_VALUE');
    expect(lintCodeToErrorCode('ILLEGAL_ZERO_PREFIX')).toBe('INVALID_VALUE');
    expect(lintCodeToErrorCode('ILLEGAL_IBAN_COUNTRY_CODE')).toBe('INVALID_VALUE');
    expect(lintCodeToErrorCode('ILLEGAL_MONTH')).toBe('INVALID_DATE');
    expect(lintCodeToErrorCode('ILLEGAL_DAY')).toBe('INVALID_DATE');
    expect(lintCodeToErrorCode('ILLEGAL_HOUR')).toBe('INVALID_DATE');
    expect(lintCodeToErrorCode('ILLEGAL_MINUTE')).toBe('INVALID_DATE');
    expect(lintCodeToErrorCode('ILLEGAL_SECOND')).toBe('INVALID_DATE');
  });
});
