import { Gs1Error } from '../core/errors.ts';
import { aiPatternMatches, getAi } from './lookup.ts';
import type { ParsedElement } from './parse.ts';

export interface AssociationOptions {
  /** Check `req` rules (default true). Exclusions, repeats and the (8030) rule always apply. */
  readonly requisites?: boolean;
}

/** The element's input position, or nothing for object input (ruling R15). */
function at(el: ParsedElement): { position?: number } {
  return el.position === undefined ? {} : { position: el.position };
}

export function checkAssociations(
  elements: readonly ParsedElement[],
  opts: AssociationOptions = {},
): Gs1Error[] {
  const errors: Gs1Error[] = [];
  const first = new Map<string, ParsedElement>();
  const duplicated = new Set<string>();
  for (const e of elements) {
    const prev = first.get(e.ai);
    if (!prev) first.set(e.ai, e);
    else if (prev.value !== e.value && !duplicated.has(e.ai)) {
      duplicated.add(e.ai);
      errors.push(
        new Gs1Error({
          code: 'DUPLICATE_AI',
          message: `Multiple instances of AI (${e.ai}) have different values`,
          ai: e.ai,
          ...at(e),
        }),
      );
    }
  }
  const present = [...first.keys()];
  const has = (pattern: string): boolean => present.some((ai) => aiPatternMatches(pattern, ai));

  for (const [ai, el] of first) {
    const entry = getAi(ai);
    if (!entry || opts.requisites === false) continue;
    for (const rule of entry.req) {
      if (rule.some((group) => group.every(has))) continue;
      errors.push(
        new Gs1Error({
          code: 'MISSING_REQUIRED_AI',
          message: `Required AIs for AI (${ai}) are not satisfied: ${rule.map((g) => g.join('+')).join(',')}`,
          ai,
          ...at(el),
          details: { required: rule },
        }),
      );
    }
  }

  const reported = new Set<string>();
  for (const [ai, el] of first) {
    const entry = getAi(ai);
    if (!entry) continue;
    for (const pattern of entry.ex) {
      for (const other of present) {
        if (other === ai || !aiPatternMatches(pattern, other)) continue;
        const key = ai < other ? `${ai}|${other}` : `${other}|${ai}`;
        if (reported.has(key)) continue;
        reported.add(key);
        errors.push(
          new Gs1Error({
            code: 'INVALID_AI_PAIR',
            message: `It is invalid to pair AI (${ai}) with AI (${other})`,
            ai,
            ...at(el),
            details: { with: other },
          }),
        );
      }
    }
  }
  errors.push(...checkDigSigSerialKeys(first));
  return errors;
}

/** Keys whose serial component is optional in the dictionary but mandatory alongside (8030). */
const SERIALISABLE_KEYS: readonly string[] = ['253', '255', '8003'];

/**
 * A digital signature (8030) needs instance-level identification (GenSpecs 2.6.16), so
 * (253), (255) and (8003) must carry their optional serial component, i.e. be longer than
 * their mandatory minimum. Mirrors the Syntax Engine's validateDigSigRequiresSerialisedKey.
 */
function checkDigSigSerialKeys(first: ReadonlyMap<string, ParsedElement>): Gs1Error[] {
  if (!first.has('8030')) return [];
  const errors: Gs1Error[] = [];
  for (const ai of SERIALISABLE_KEYS) {
    const el = first.get(ai);
    const entry = getAi(ai);
    if (!el || !entry) continue;
    let min = 0;
    for (const c of entry.components) if (!c.optional) min += c.min;
    if (el.value.length !== min) continue;
    errors.push(
      new Gs1Error({
        code: 'INVALID_VALUE',
        message: `Serial component must be present for AI (${ai}) when used with AI (8030)`,
        ai,
        ...at(el),
        details: { with: '8030' },
      }),
    );
  }
  return errors;
}
