import type { Gs1ErrorCode } from '../core/errors.ts';
import { Gs1Error } from '../core/errors.ts';
import type { AiEntry } from './dictionary.ts';
import { LINTERS, LINT_MESSAGES } from './linters/index.ts';
import type { LintCode, LintError } from './linters/index.ts';

const CSET_LINTER = {
  N: LINTERS.csetnumeric,
  X: LINTERS.cset82,
  Y: LINTERS.cset39,
  Z: LINTERS.cset64,
} as const;

const ILLEGAL_DATE_CODES: ReadonlySet<string> = new Set([
  'ILLEGAL_MONTH',
  'ILLEGAL_DAY',
  'ILLEGAL_HOUR',
  'ILLEGAL_MINUTE',
  'ILLEGAL_SECOND',
]);

export function lintCodeToErrorCode(code: LintCode): Gs1ErrorCode {
  if (code === 'NON_DIGIT_CHARACTER' || code.startsWith('INVALID_CSET')) return 'INVALID_CHAR';
  if (code === 'INCORRECT_CHECK_DIGIT' || code === 'INCORRECT_CHECK_PAIR') return 'CHECK_DIGIT';
  const isDateTimeLength =
    code.startsWith('DATE_') ||
    code.startsWith('HOUR_') ||
    code.startsWith('MINUTE_') ||
    code.startsWith('SECOND_');
  if (isDateTimeLength || ILLEGAL_DATE_CODES.has(code)) return 'INVALID_DATE';
  return 'INVALID_VALUE';
}

/**
 * Input index of value index `at`. `escapes` lists, in increasing order, one value index per
 * extra input character spent before that value character: "\\(" in bracketed input adds one
 * entry, a "%XX" escape in a Digital Link adds two.
 */
function inputIndex(offset: number, escapes: readonly number[], at: number): number {
  let shift = 0;
  for (const e of escapes) {
    if (e >= at) break;
    shift++;
  }
  return offset + at + shift;
}

/** The input span of value characters [at, at + len). */
function span(
  offset: number,
  escapes: readonly number[],
  at: number,
  len: number,
): { position: number; length: number } {
  const position = inputIndex(offset, escapes, at);
  return { position, length: inputIndex(offset, escapes, at + len) - position };
}

function lengthError(
  ai: string,
  value: string,
  offset: number,
  escapes: readonly number[],
  tooShort: boolean,
): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_LENGTH',
    message:
      value.length === 0
        ? `AI (${ai}) value is empty`
        : `AI (${ai}) value is too ${tooShort ? 'short' : 'long'}`,
    ai,
    ...span(offset, escapes, 0, value.length),
  });
}

function lintError(
  ai: string,
  lint: LintError,
  offset: number,
  escapes: readonly number[],
  at: number,
): Gs1Error {
  return new Gs1Error({
    code: lintCodeToErrorCode(lint.code),
    message: `AI (${ai}): ${LINT_MESSAGES[lint.code]}`,
    ai,
    ...span(offset, escapes, at + lint.pos, lint.len),
    details: { lint: lint.code },
  });
}

/**
 * Checks `value` against the AI's components and linters. Error positions are `offset` plus
 * the value index, adjusted for `escapes` (see inputIndex).
 */
export function validateValue(
  ai: string,
  value: string,
  entry: AiEntry,
  offset: number,
  escapes: readonly number[] = [],
): Gs1Error | null {
  const { components } = entry;
  let min = 0;
  let max = 0;
  for (const c of components) {
    if (!c.optional) min += c.min;
    max += c.max;
  }
  if (value.length < min || value.length === 0)
    return lengthError(ai, value, offset, escapes, true);
  if (value.length > max) return lengthError(ai, value, offset, escapes, false);

  let at = 0;
  for (const c of components) {
    if (at === value.length && c.optional) break;
    const fixed = c.min === c.max;
    const len = fixed ? c.min : value.length - at;
    if (at + len > value.length || len < c.min || len > c.max) {
      return lengthError(ai, value, offset, escapes, at + len > value.length);
    }
    const part = value.slice(at, at + len);
    const csetResult = CSET_LINTER[c.cset](part);
    if (csetResult) return lintError(ai, csetResult, offset, escapes, at);
    for (const name of c.linters) {
      const r = LINTERS[name](part);
      if (r) return lintError(ai, r, offset, escapes, at);
    }
    at += len;
  }
  // Invariant: at === value.length here. Fixed components consume exactly their length, the
  // first variable one takes the rest, and value.length <= max was checked above.
  return null;
}
