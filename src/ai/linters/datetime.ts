// Ported to TypeScript from gs1-syntax-dictionary src/lint_*.c @ c63d8a1 (Apache-2.0, Copyright (c) 2022-2026 GS1 AISBL); modified for aidc.
// Covers: lint_yyyymmd0.c, lint_yyyymmdd.c, lint_yymmd0.c, lint_yymmdd.c, lint_hh.c, lint_mi.c, lint_ss.c, lint_hhmi.c.
import { type Linter, type LintResult, err, firstNonDigit, shift } from './types.ts';

const DAYS_IN_MONTH: readonly number[] = [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function two(data: string, at: number): number {
  return (data.charCodeAt(at) - 48) * 10 + (data.charCodeAt(at + 1) - 48);
}

export const yyyymmd0: Linter = (data) => {
  if (data.length !== 8)
    return err(data.length < 8 ? 'DATE_TOO_SHORT' : 'DATE_TOO_LONG', 0, data.length);
  const bad = firstNonDigit(data);
  if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);
  const year = two(data, 0) * 100 + two(data, 2);
  const month = two(data, 4);
  const day = two(data, 6);
  if (month < 1 || month > 12) return err('ILLEGAL_MONTH', 4, 2);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 ? (leap ? 29 : 28) : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day > maxDay ? err('ILLEGAL_DAY', 6, 2) : null;
};

export const yyyymmdd: Linter = (data) => {
  const r = yyyymmd0(data);
  if (r !== null) return r;
  return two(data, 6) === 0 ? err('ILLEGAL_DAY', 6, 2) : null;
};

function currentYear2(): number {
  return new Date().getUTCFullYear() % 100;
}

/** GenSpecs 7.12: resolve YY to a century relative to the current year. */
function expandYY(data: string): string {
  const diff = two(data, 0) - currentYear2();
  const century = diff >= 51 ? '19' : diff > -50 ? '20' : '21';
  return century + data;
}

function shortDate(full: Linter): Linter {
  return (data: string): LintResult => {
    if (data.length !== 6)
      return err(data.length < 6 ? 'DATE_TOO_SHORT' : 'DATE_TOO_LONG', 0, data.length);
    const bad = firstNonDigit(data);
    if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);
    return shift(full(expandYY(data)), -2);
  };
}

export const yymmd0: Linter = shortDate(yyyymmd0);
export const yymmdd: Linter = shortDate(yyyymmdd);

function twoDigitField(
  max: number,
  short: 'HOUR_TOO_SHORT' | 'MINUTE_TOO_SHORT' | 'SECOND_TOO_SHORT',
  long: 'HOUR_TOO_LONG' | 'MINUTE_TOO_LONG' | 'SECOND_TOO_LONG',
  illegal: 'ILLEGAL_HOUR' | 'ILLEGAL_MINUTE' | 'ILLEGAL_SECOND',
): Linter {
  return (data) => {
    if (data.length !== 2) return err(data.length < 2 ? short : long, 0, data.length);
    const bad = firstNonDigit(data);
    if (bad !== -1) return err('NON_DIGIT_CHARACTER', bad, 1);
    return two(data, 0) > max ? err(illegal, 0, 2) : null;
  };
}

export const hh: Linter = twoDigitField(23, 'HOUR_TOO_SHORT', 'HOUR_TOO_LONG', 'ILLEGAL_HOUR');
export const mi: Linter = twoDigitField(
  59,
  'MINUTE_TOO_SHORT',
  'MINUTE_TOO_LONG',
  'ILLEGAL_MINUTE',
);
export const ss: Linter = twoDigitField(
  59,
  'SECOND_TOO_SHORT',
  'SECOND_TOO_LONG',
  'ILLEGAL_SECOND',
);

export const hhmi: Linter = (data) => {
  if (data.length !== 4) {
    return err(
      data.length < 4 ? 'HOUR_WITH_MINUTE_TOO_SHORT' : 'HOUR_WITH_MINUTE_TOO_LONG',
      0,
      data.length,
    );
  }
  return hh(data.slice(0, 2)) ?? shift(mi(data.slice(2)), 2);
};
