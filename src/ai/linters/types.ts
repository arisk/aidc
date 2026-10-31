import type { LintCode } from './lint-codes.gen.ts';

export interface LintError {
  readonly code: LintCode;
  readonly pos: number;
  readonly len: number;
}

export type LintResult = LintError | null;
export type Linter = (data: string) => LintResult;

export function err(code: LintCode, pos: number, len: number): LintError {
  return { code, pos, len };
}

export function isDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Index of the first non-ASCII-digit character, or -1. */
export function firstNonDigit(data: string, from = 0, to: number = data.length): number {
  for (let i = from; i < to; i++) if (!isDigitCode(data.charCodeAt(i))) return i;
  return -1;
}

/** Shifts a nested linter's error position, as the C code does with *err_pos + offset. */
export function shift(r: LintResult, offset: number): LintResult {
  return r === null ? null : err(r.code, r.pos + offset, r.len);
}
