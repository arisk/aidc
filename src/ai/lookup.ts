import { isDigits } from '../core/cset.ts';
import type { AiEntry } from './dictionary.ts';
import { AI_TABLE } from './table.gen.ts';

/** Freezes a table value and everything reachable from it (plain objects and arrays). */
function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const v of Object.values(value)) deepFreeze(v);
}

// getAi() hands out table entries, so freeze them once: callers cannot corrupt the table.
deepFreeze(AI_TABLE);

const BY_AI: ReadonlyMap<string, AiEntry> = new Map(AI_TABLE.map((e) => [e.ai, e]));

export function getAi(ai: string): AiEntry | undefined {
  return BY_AI.get(ai);
}

/** AI length shared by every known AI starting with the given two digits. */
const AI_LENGTH_BY_PREFIX: ReadonlyMap<string, number> = new Map(
  AI_TABLE.map((e) => [e.ai.slice(0, 2), e.ai.length]),
);

/**
 * Data field lengths from GenSpecs Table 7-6 (predefined length element strings, minus the AI).
 * The Syntax Engine consults them only for unknown 3- and 4-digit AIs, see unknownAiEntry.
 */
const PREDEFINED_VALUE_LENGTH: ReadonlyMap<string, number> = new Map([
  ['00', 18],
  ['01', 14],
  ['02', 14],
  ['03', 14],
  ['04', 16],
  ['11', 6],
  ['12', 6],
  ['13', 6],
  ['14', 6],
  ['15', 6],
  ['16', 6],
  ['17', 6],
  ['18', 6],
  ['19', 6],
  ['20', 2],
  ['31', 6],
  ['32', 6],
  ['33', 6],
  ['34', 6],
  ['35', 6],
  ['36', 6],
  ['41', 13],
]);

/** Maximum element length (AI plus value) the Syntax Engine permits for an unknown AI. */
const UNKNOWN_MAX = 90;

function unknownEntry(ai: string, fnc1: boolean, min: number, max: number): AiEntry {
  const entry: AiEntry = {
    ai,
    title: 'UNKNOWN',
    fnc1,
    dlAttr: false,
    components: [{ cset: 'X', min, max, optional: false, linters: [] }],
    req: [],
    ex: [],
  };
  deepFreeze(entry);
  return entry;
}

/**
 * The pseudo entry for an AI that is not in the table, following the Syntax Engine's
 * permitUnknownAIs rules (gs1_lookupAIentry): the AI must be 2 to 4 digits, no known AI may be
 * a prefix of it, and it must have the AI length of the known AIs sharing its first two
 * digits. Unknown 3-digit AIs under "41" and 4-digit AIs under "31" to "36" take the Table 7-6
 * predefined length; others are variable length X1..90. Where no known AI shares the prefix,
 * the engine counts the AI digits within the 90 characters (`lengthKnown` false: raw data
 * cannot delimit such an AI). Returns undefined when the AI is known or not acceptable.
 */
export function unknownAiEntry(ai: string): { entry: AiEntry; lengthKnown: boolean } | undefined {
  if (ai.length < 2 || ai.length > 4 || !isDigits(ai) || BY_AI.has(ai)) return undefined;
  for (let len = 2; len < ai.length; len++) if (BY_AI.has(ai.slice(0, len))) return undefined;
  const prefix = ai.slice(0, 2);
  const aiLength = AI_LENGTH_BY_PREFIX.get(prefix) ?? 0;
  if (aiLength === 0) {
    return { entry: unknownEntry(ai, true, 1, UNKNOWN_MAX - ai.length), lengthKnown: false };
  }
  if (aiLength !== ai.length) return undefined;
  // With the current table only "41" (3-digit AIs, 13) and "31" to "36" (4-digit AIs, 6) get
  // here with a predefined length, which are exactly the engine's fixed-length pseudo entries.
  const fixed = PREDEFINED_VALUE_LENGTH.get(prefix);
  return {
    entry:
      fixed === undefined
        ? unknownEntry(ai, true, 1, UNKNOWN_MAX)
        : unknownEntry(ai, false, fixed, fixed),
    lengthKnown: true,
  };
}

/** The known entry for `ai`, or with `allowUnknown` its pseudo entry (see unknownAiEntry). */
export function resolveAi(ai: string, allowUnknown: boolean): AiEntry | undefined {
  return BY_AI.get(ai) ?? (allowUnknown ? unknownAiEntry(ai)?.entry : undefined);
}

/**
 * The AI at `s[at]` in raw data. Unknown AIs are accepted with `allowUnknown` only when their
 * length is implied by the prefix, as raw data has no other way to delimit them.
 */
export function findAiAt(s: string, at: number, allowUnknown = false): AiEntry | undefined {
  for (let len = 2; len <= 4 && at + len <= s.length; len++) {
    const e = BY_AI.get(s.slice(at, at + len));
    if (e) return e;
  }
  if (!allowUnknown) return undefined;
  const len = AI_LENGTH_BY_PREFIX.get(s.slice(at, at + 2)) ?? 0;
  if (len === 0 || at + len > s.length) return undefined;
  const unknown = unknownAiEntry(s.slice(at, at + len));
  return unknown?.lengthKnown ? unknown.entry : undefined;
}

export function aiPatternMatches(pattern: string, ai: string): boolean {
  if (pattern.length !== ai.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern.charCodeAt(i);
    if (p === 110 /* n */) {
      const c = ai.charCodeAt(i);
      if (c < 48 || c > 57) return false;
    } else if (p !== ai.charCodeAt(i)) return false;
  }
  return true;
}
