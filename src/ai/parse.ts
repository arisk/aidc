import { Gs1Error } from '../core/errors.ts';
import { findAiAt, resolveAi } from './lookup.ts';
import { validateValue } from './validate-value.ts';

export interface ParseOptions {
  /**
   * Accept AIs missing from the dictionary. Default false. Follows the Syntax Engine's
   * permitUnknownAIs rules:
   * - the AI must have the length that known AIs with the same two-digit prefix use, and no
   *   known AI may be a prefix of it;
   * - unknown 3-digit AIs under prefix 41 take a fixed 13 characters, and unknown 4-digit AIs
   *   under prefixes 31 to 36 take a fixed 6;
   * - otherwise AI plus value must fit in 90 characters;
   * - if no known AI shares the two-digit prefix, any 2-4 digit AI is accepted in bracketed
   *   input with AI plus value up to 90 characters; such AIs cannot appear in raw input;
   * - raw input can only carry unknown AIs whose length is implied by the prefix;
   * - hri() titles unknown AIs "UNKNOWN".
   */
  readonly allowUnknownAIs?: boolean;
  /**
   * Check mandatory associations (`req` rules). Default true. Like the Syntax Engine's
   * validateAIassociations, false skips only these; invalid pairs, conflicting repeats and the
   * (8030) serialised-key rule are always checked.
   */
  readonly validateAssociations?: boolean;
}

export interface ParsedElement {
  readonly ai: string;
  readonly value: string;
  /** Index of the element in the input string; absent for object input (ruling R15). */
  readonly position?: number;
}

export interface Tokens {
  elements: ParsedElement[];
  errors: Gs1Error[];
}

const GS = 0x1d;
const CARET = 0x5e;
const OPEN = 0x28;
const CLOSE = 0x29;
const BACKSLASH = 0x5c;
const SPACE = 0x20;

/** Appends a SYNTAX error, keeping the elements and errors collected so far. */
function syntax(out: Tokens, message: string, position: number): Tokens {
  out.errors.push(new Gs1Error({ code: 'SYNTAX', message, position }));
  return out;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** One element as found in some input, for checkElement. */
export interface SourceElement {
  readonly ai: string;
  readonly value: string;
  /** Input index of the element (its AI); omitted for object input (ruling R15). */
  readonly position?: number;
  /** Input index of value character 0. */
  readonly valueStart: number;
  /**
   * Value indexes before which the input spends extra characters, one entry per extra
   * character, in increasing order: "\(" in bracketed input adds one entry, "%2F" in a
   * Digital Link adds two.
   */
  readonly shifts?: readonly number[];
}

/** Resolves and validates one element, appending the element and any error to `out`. */
export function checkElement(out: Tokens, el: SourceElement, allowUnknown: boolean): void {
  const entry = resolveAi(el.ai, allowUnknown);
  if (!entry) {
    out.errors.push(
      new Gs1Error({
        code: 'UNKNOWN_AI',
        message: `Unrecognised AI: ${el.ai}`,
        ai: el.ai,
        ...(el.position === undefined ? {} : { position: el.position, length: el.ai.length }),
      }),
    );
    return;
  }
  const e = validateValue(el.ai, el.value, entry, el.valueStart, el.shifts);
  if (e) out.errors.push(e);
  out.elements.push(
    el.position === undefined
      ? { ai: el.ai, value: el.value }
      : { ai: el.ai, value: el.value, position: el.position },
  );
}

/**
 * Bracketed (and HRI) input. Ruling R14: ASCII spaces (0x20) directly after an AI's ")" and
 * directly before the next "(" or the end of input are skipped, so `(01) 095... (10) ABC`
 * parses. A space is in no GS1 character set, so this is unambiguous; a space anywhere else
 * in a value is still INVALID_CHAR. All positions index the original input.
 */
function tokenizeBracketed(s: string, opts: ParseOptions): Tokens {
  const out: Tokens = { elements: [], errors: [] };
  const allowUnknown = opts.allowUnknownAIs ?? false;
  // Invariant: s[i] is "(" at the top of the loop. tokenize() dispatches here only when s[0]
  // is "(", and the value scan below stops only at an unescaped "(" or the end of input.
  let i = 0;
  while (i < s.length) {
    const aiStart = i + 1;
    let j = aiStart;
    while (j < s.length && isDigit(s.charCodeAt(j))) j++;
    if (j >= s.length || s.charCodeAt(j) !== CLOSE)
      return syntax(out, 'AI must be digits closed by ")"', i);
    const ai = s.slice(aiStart, j);
    if (ai.length < 2 || ai.length > 4) return syntax(out, 'AI must be 2 to 4 digits', i);
    let valueStart = j + 1;
    while (valueStart < s.length && s.charCodeAt(valueStart) === SPACE) valueStart++;
    let k = valueStart;
    while (k < s.length && s.charCodeAt(k) !== OPEN) {
      k += s.charCodeAt(k) === BACKSLASH && s.charCodeAt(k + 1) === OPEN ? 2 : 1;
    }
    // Trailing spaces before the next "(" or the end. s[end - 1] is never the "\" of an
    // escape: an escape's "(" never stops the scan, and a space is not "(".
    let end = k;
    while (end > valueStart && s.charCodeAt(end - 1) === SPACE) end--;
    let value = '';
    const escapes: number[] = [];
    for (let p = valueStart; p < end; p++) {
      if (s.charCodeAt(p) === BACKSLASH && s.charCodeAt(p + 1) === OPEN) {
        escapes.push(value.length);
        value += '(';
        p++;
      } else value += s[p];
    }
    checkElement(out, { ai, value, position: i, valueStart, shifts: escapes }, allowUnknown);
    i = k;
  }
  return out;
}

/** `base` is the index of `s[0]` in the caller's input, so positions refer to the original string. */
function tokenizeRaw(s: string, sep: number, base: number, allowUnknown: boolean): Tokens {
  const out: Tokens = { elements: [], errors: [] };
  let i = 0;
  if (s.length === 0) {
    return {
      elements: [],
      errors: [new Gs1Error({ code: 'EMPTY_INPUT', message: 'No AI data', position: base })],
    };
  }
  while (i < s.length) {
    const entry = findAiAt(s, i, allowUnknown);
    if (!entry) {
      out.errors.push(
        new Gs1Error({
          code: 'UNKNOWN_AI',
          message: `No known AI is a prefix of: ${s.slice(i, i + 4)}...`,
          // No `ai`: raw data has no delimiter, so no candidate AI is defined. `length` spans
          // the (at most 4) characters that were examined as AI digits.
          position: base + i,
          length: Math.min(4, s.length - i),
        }),
      );
      return out;
    }
    const valueStart = i + entry.ai.length;
    let end: number;
    if (!entry.fnc1) {
      let len = 0;
      for (const c of entry.components) len += c.max;
      end = Math.min(valueStart + len, s.length);
    } else {
      end = valueStart;
      while (end < s.length && s.charCodeAt(end) !== sep) end++;
    }
    checkElement(
      out,
      {
        ai: entry.ai,
        value: s.slice(valueStart, end),
        position: base + i,
        valueStart: base + valueStart,
      },
      allowUnknown,
    );
    i = end;
    if (i < s.length && s.charCodeAt(i) === sep) i++;
  }
  return out;
}

export function tokenize(input: string, opts: ParseOptions): Tokens {
  if (input.length === 0) {
    return {
      elements: [],
      errors: [new Gs1Error({ code: 'EMPTY_INPUT', message: 'Input is empty', position: 0 })],
    };
  }
  const first = input.charCodeAt(0);
  if (first === OPEN) return tokenizeBracketed(input, opts);
  if (first === CARET) return tokenizeRaw(input.slice(1), CARET, 1, opts.allowUnknownAIs ?? false);
  // One leading GS stands for FNC1 in first position, like the leading "^". A second one is an
  // empty element, which the Syntax Engine rejects ("No known AI is a prefix of").
  if (first === GS) return tokenizeRaw(input.slice(1), GS, 1, opts.allowUnknownAIs ?? false);
  if (isDigit(first)) return tokenizeRaw(input, GS, 0, opts.allowUnknownAIs ?? false);
  return syntax({ elements: [], errors: [] }, 'Input must start with "(", "^", GS or a digit', 0);
}
