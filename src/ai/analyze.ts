import { Gs1Error } from '../core/errors.ts';
import { checkAssociations } from './associations.ts';
import { resolveAi } from './lookup.ts';
import { checkElement } from './parse.ts';
import type { ParseOptions, ParsedElement } from './parse.ts';

function isAiShape(ai: string): boolean {
  if (ai.length < 2 || ai.length > 4) return false;
  for (let i = 0; i < ai.length; i++) {
    const c = ai.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

/** An (ai, value) pair as received; JavaScript callers may pass non-strings. */
export type RawEntry = readonly [ai: unknown, value: unknown];

function isIterable(input: object): input is Iterable<unknown> {
  return Symbol.iterator in input;
}

function badInput(message: string): { ok: false; error: Gs1Error } {
  return { ok: false, error: new Gs1Error({ code: 'SYNTAX', message }) };
}

const MAX_ENTRIES = 10_000;

/**
 * Object input as (ai, value) pairs: a record, or an iterable of [ai, value] pairs. Guards
 * against JavaScript callers passing something else: a SYNTAX error instead of a TypeError.
 */
export function toEntries(
  input: unknown,
): { ok: true; entries: RawEntry[] } | { ok: false; error: Gs1Error } {
  if (typeof input !== 'object' || input === null)
    return badInput('Expected an object of AI values or an iterable of [ai, value] pairs');
  if (!isIterable(input)) return { ok: true, entries: Object.entries(input) };
  const entries: RawEntry[] = [];
  for (const pair of input) {
    // An iterable may never end; no element string comes near this many AIs.
    if (entries.length === MAX_ENTRIES) return badInput(`At most ${MAX_ENTRIES} entries`);
    if (!Array.isArray(pair) || pair.length !== 2)
      return badInput('Each entry must be an [ai, value] pair');
    entries.push([pair[0], pair[1]]);
  }
  return { ok: true, entries };
}

/**
 * Validates (ai, value) pairs from object input. Value errors carry positions relative to
 * the value; elements carry no position, so association errors omit it (ruling R15).
 */
export function analyzeEntries(
  entries: readonly RawEntry[],
  opts: ParseOptions,
): { elements: ParsedElement[]; errors: Gs1Error[] } {
  const errors: Gs1Error[] = [];
  const elements: ParsedElement[] = [];
  if (entries.length === 0)
    errors.push(new Gs1Error({ code: 'EMPTY_INPUT', message: 'No AIs given' }));
  for (const [rawAi, value] of entries) {
    const ai = typeof rawAi === 'string' ? rawAi : undefined;
    const entry =
      ai !== undefined && isAiShape(ai) ? resolveAi(ai, opts.allowUnknownAIs ?? false) : undefined;
    if (ai === undefined || !entry) {
      // Only an AI-shaped key is echoed: any other key is caller data of any length and content.
      const shaped = ai !== undefined && isAiShape(ai);
      errors.push(
        new Gs1Error({
          code: 'UNKNOWN_AI',
          message: shaped
            ? `Unrecognised AI: ${ai}`
            : `Unrecognised AI: a ${ai === undefined ? typeof rawAi : 'string'} key that is not 2 to 4 digits`,
          ...(shaped ? { ai } : {}),
        }),
      );
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(
        new Gs1Error({ code: 'INVALID_VALUE', message: `AI (${ai}) value must be a string`, ai }),
      );
      continue;
    }
    checkElement({ elements, errors }, { ai, value, valueStart: 0 }, opts.allowUnknownAIs ?? false);
  }
  return { elements, errors };
}

/**
 * Appends association errors. `validateAssociations: false` turns off only the `req` rules,
 * as the Syntax Engine's validateAIassociations does; invalid pairs, conflicting repeats and
 * the (8030) serialised-key rule are always checked.
 */
export function withAssociations(
  elements: readonly ParsedElement[],
  errors: readonly Gs1Error[],
  opts: ParseOptions,
): Gs1Error[] {
  if (elements.length === 0) return [...errors];
  return [
    ...errors,
    ...checkAssociations(elements, { requisites: opts.validateAssociations ?? true }),
  ];
}
