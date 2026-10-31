// Ported to TypeScript from gs1-syntax-dictionary src/lint_*.c @ c63d8a1 (Apache-2.0, Copyright (c) 2022-2026 GS1 AISBL); modified for aidc.
// Covers: lint_csetnumeric.c, lint_cset82.c, lint_cset39.c, lint_cset64.c, lint_hasnondigit.c, lint_nozeroprefix.c.
import { CSET39, CSET64, CSET82 } from '../../core/cset.ts';
import type { LintCode } from './lint-codes.gen.ts';
import { type Linter, type LintResult, err, firstNonDigit } from './types.ts';

function table(chars: string): Uint8Array {
  const t = new Uint8Array(128);
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = 1;
  return t;
}

function setLinter(chars: string, code: LintCode): Linter {
  const t = table(chars);
  return (data: string): LintResult => {
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i);
      if (c > 127 || t[c] === 0) return err(code, i, 1);
    }
    return null;
  };
}

export const csetnumeric: Linter = (data) => {
  const i = firstNonDigit(data);
  return i === -1 ? null : err('NON_DIGIT_CHARACTER', i, 1);
};

export const cset82: Linter = setLinter(CSET82, 'INVALID_CSET82_CHARACTER');
export const cset39: Linter = setLinter(CSET39, 'INVALID_CSET39_CHARACTER');

const cset64chars = setLinter(CSET64, 'INVALID_CSET64_CHARACTER');
export const cset64: Linter = (data) => {
  let pads = 0;
  while (pads < data.length && data.charCodeAt(data.length - pads - 1) === 61) pads++;
  const len = data.length - pads;
  if (pads > 2 || (pads > 0 && data.length % 3 !== 0))
    return err('INVALID_CSET64_PADDING', len, pads);
  return cset64chars(data.slice(0, len));
};

export const hasnondigit: Linter = (data) =>
  firstNonDigit(data) === -1 ? err('REQUIRES_NON_DIGIT_CHARACTER', 0, data.length) : null;

export const nozeroprefix: Linter = (data) => {
  if (data.length > 0 && data.charCodeAt(0) === 48) return err('ILLEGAL_ZERO_PREFIX', 0, 1);
  return csetnumeric(data);
};
