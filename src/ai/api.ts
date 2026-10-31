import { Gs1Error, type Result, fail, guard, ok, unwrap } from '../core/errors.ts';
import { type RawEntry, analyzeEntries, toEntries, withAssociations } from './analyze.ts';
import { ElementString, createElementString } from './element-string.ts';
import { type ParseOptions, tokenize } from './parse.ts';

/**
 * Parses bracketed, HRI or raw element strings and collects every error. Bracketed input may
 * have spaces around AIs, as in HRI text: `(01) 09506000134352 (10) ABC`.
 */
export function tryParse(input: string, opts: ParseOptions = {}): Result<ElementString> {
  return guard(() => tryParseUnguarded(input, opts));
}

function tryParseUnguarded(input: string, opts: ParseOptions = {}): Result<ElementString> {
  if (typeof input !== 'string') {
    return fail([new Gs1Error({ code: 'SYNTAX', message: 'Input must be a string' })]);
  }
  const { elements, errors } = tokenize(input, opts);
  if (errors.some((e) => e.code === 'SYNTAX' || e.code === 'EMPTY_INPUT')) return fail(errors);
  const all = withAssociations(elements, errors, opts);
  if (all.length > 0) return fail(all);
  return ok(createElementString(elements.map((e) => [e.ai, e.value] as const)));
}

/** Like tryParse, but throws the first Gs1Error. */
export function parse(input: string, opts: ParseOptions = {}): ElementString {
  return unwrap(tryParse(input, opts));
}

/**
 * Validates a string (as tryParse), an ElementString, an object of AI values or an iterable of
 * [ai, value] pairs, collecting every error.
 */
export function validate(
  input:
    | string
    | ElementString
    | Readonly<Record<string, string>>
    | Iterable<readonly [string, string]>,
  opts: ParseOptions = {},
): Result<ElementString> {
  return guard(() => validateUnguarded(input, opts));
}

function validateUnguarded(
  input:
    | string
    | ElementString
    | Readonly<Record<string, string>>
    | Iterable<readonly [string, string]>,
  opts: ParseOptions = {},
): Result<ElementString> {
  if (typeof input === 'string') return tryParse(input, opts);
  let entries: readonly RawEntry[];
  if (input instanceof ElementString) entries = input.entries();
  else {
    const r = toEntries(input);
    if (!r.ok) return fail([r.error]);
    entries = r.entries;
  }
  const { elements, errors } = analyzeEntries(entries, opts);
  const all = withAssociations(elements, errors, opts);
  if (all.length > 0) return fail(all);
  return ok(
    input instanceof ElementString
      ? input
      : createElementString(elements.map((e) => [e.ai, e.value] as const)),
  );
}
