import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { tryParse } from '../../ai/index.ts';
import { freezeDecoded, readPlacedRows, symbolError } from '../render/internal.ts';
import type { DecodedSymbol, LinearPattern } from '../render/index.ts';
import {
  C128_LOOKUP,
  C128_STOP,
  FNC1,
  START_A,
  START_B,
  START_C,
  c128Key,
} from './code128-tables.ts';

export interface Gs1128Metadata {
  readonly reversed: boolean;
  /** Start .. check character, without the stop. */
  readonly symbolValues: readonly number[];
  /** `rawData` length. */
  readonly dataCharacters: number;
  /** More than 48 data characters (GenSpecs 5.4.4.3). */
  readonly overLength?: true;
  /** The composite linkage flag. */
  readonly linkage?: 'cc-a-b' | 'cc-c';
}

const MAX_DATA = 48;
const REVERSED_STOP: readonly number[] = [2, 1, 1, 1, 3, 3, 2];
const SET_A = 0;
const SET_B = 1;
const SET_C = 2;
type CodeSet = typeof SET_A | typeof SET_B | typeof SET_C;

interface Origin {
  readonly row: number;
  readonly element: number;
}

/** Merged alternating runs of one row with light ends trimmed, and where each run starts. */
function runsOf(row: number, widths: readonly number[]): { runs: number[]; origins: Origin[] } {
  const runs: number[] = [];
  const dark: boolean[] = [];
  const origins: Origin[] = [];
  for (let i = 0; i < widths.length; i++) {
    const w = widths[i] ?? 0;
    if (w === 0) continue;
    const isDark = i % 2 === 0;
    if (dark.length > 0 && dark[dark.length - 1] === isDark)
      runs[runs.length - 1] = (runs.at(-1) ?? 0) + w;
    else {
      runs.push(w);
      dark.push(isDark);
      origins.push({ row, element: i });
    }
  }
  let from = 0;
  let to = runs.length;
  if (from < to && dark[from] === false) from++;
  if (from < to && dark[to - 1] === false) to--;
  return { runs: runs.slice(from, to), origins: origins.slice(from, to) };
}

function sameAs(runs: readonly number[], from: number, pattern: readonly number[]): boolean {
  for (let k = 0; k < pattern.length; k++) if (runs[from + k] !== pattern[k]) return false;
  return true;
}

/** A problem found while interpreting symbol values; `at` is a symbol character index. */
type Fault =
  | { readonly kind: 'fnc2' | 'fnc3' | 'fnc4' }
  | { readonly kind: 'sequence'; readonly at: number };

interface Text {
  readonly text: string;
  readonly linkage?: 'cc-a-b' | 'cc-c';
}

/**
 * Linkage flag of a code set character before the check character, by the set it leaves and
 * the set it selects (gs1-barcode-engine `linkChar`, research ITF/GS1-128 3.5 item 5).
 */
function linkageOf(from: CodeSet, to: CodeSet): 'cc-a-b' | 'cc-c' {
  if (from === SET_A) return to === SET_B ? 'cc-a-b' : 'cc-c';
  if (from === SET_B) return to === SET_C ? 'cc-a-b' : 'cc-c';
  return to === SET_A ? 'cc-a-b' : 'cc-c';
}

function charOf(set: CodeSet, v: number): string {
  return String.fromCharCode(set === SET_A && v >= 64 ? v - 64 : v + 32);
}

/**
 * The transmitted text of symbol values `[start, ...data, check]`. `skip` is the index of an
 * FNC1 that is a mode flag (not transmitted), or -1. Later FNC1s transmit as GS.
 */
function interpret(values: readonly number[], skip: number): Fault | Text {
  const last = values.length - 2;
  const start = values[0];
  let set: CodeSet = start === START_C ? SET_C : start === START_B ? SET_B : SET_A;
  let text = '';
  let linkage: 'cc-a-b' | 'cc-c' | undefined;
  let i = 1;
  while (i <= last) {
    const v = values[i] ?? 0;
    let to: CodeSet | undefined;
    if (v === FNC1) {
      if (i !== skip) text += '\u001d';
    } else if (set === SET_C) {
      if (v < 100) text += v < 10 ? `0${v}` : `${v}`;
      else to = v === 100 ? SET_B : SET_A;
    } else if (v < 96) text += charOf(set, v);
    else if (v === 96) return { kind: 'fnc3' };
    else if (v === 97) return { kind: 'fnc2' };
    else if (v === 98) {
      const t = values[i + 1] ?? 0;
      if (i + 1 > last) return { kind: 'sequence', at: i };
      if (t >= 96) return { kind: 'sequence', at: i + 1 };
      text += charOf(set === SET_A ? SET_B : SET_A, t);
      i++;
    } else if (v === 99) to = SET_C;
    else if (v === (set === SET_A ? 100 : 101)) to = set === SET_A ? SET_B : SET_A;
    else return { kind: 'fnc4' };
    if (to !== undefined) {
      if (i === last) linkage = linkageOf(set, to);
      set = to;
    }
    i++;
  }
  return linkage === undefined ? { text } : { text, linkage };
}

function isStart(v: number): boolean {
  return v >= START_A && v <= START_C;
}

function isDataValue(start: number, v: number | undefined): boolean {
  return v !== undefined && v < (start === START_C ? 100 : 96);
}

function unsupported(
  reason: string,
  message: string,
  extra: Record<string, unknown> = {},
): Gs1Error {
  return new Gs1Error({ code: 'UNSUPPORTED', message, details: { reason, ...extra } });
}

function dataError(message: string, position: number): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_SYMBOL',
    message,
    position,
    length: 1,
    details: { reason: 'sequence' },
  });
}

/**
 * The fromScan pre-checks on AI data, then the element string (positions index `data`). The
 * association rules are not applied: one symbol may hold only part of a label's data.
 */
function elementsOf(data: string): Result<DecodedSymbol['elementString']> {
  if (data.length === 0)
    return fail([
      new Gs1Error({ code: 'EMPTY_INPUT', message: 'The AI data is empty', position: 0 }),
    ]);
  const caret = data.indexOf('^');
  if (caret >= 0) return fail([dataError('Data contains an illegal "^" character', caret)]);
  const c = data.charCodeAt(0);
  if (c < 48 || c > 57)
    return fail([dataError('AI data must start with an AI, not a separator or "("', 0)]);
  return tryParse(data, { validateAssociations: false });
}

/** GS1-128 decoder (research ITF/GS1-128 section 4). Never throws. Internal. */
export function decodeGs1128(symbol: LinearPattern): Result<DecodedSymbol<Gs1128Metadata>> {
  try {
    const rows = readPlacedRows(symbol, ['symbol']);
    if (!rows.ok) return fail(rows.errors);
    const only = rows.value[0];
    if (rows.value.length !== 1 || only === undefined)
      return fail([symbolError('pattern', 'A GS1-128 symbol has exactly one symbol row')]);
    const { runs, origins } = runsOf(only.row, only.widths);
    const n = runs.length;
    for (let i = 0; i < n; i++) {
      const w = runs[i] ?? 0;
      if (!Number.isInteger(w) || w < 1 || w > 4) {
        const o = origins[i];
        return fail([
          symbolError('pattern', 'Element widths must be 1 to 4 modules', o?.element, o?.row),
        ]);
      }
    }
    const count = (n - 7) / 6;
    if (!Number.isInteger(count) || count < 3)
      return fail([symbolError('length', 'A GS1-128 symbol has 6k + 7 elements, k at least 3')]);
    let reversed = false;
    const first = C128_LOOKUP[c128Key(runs, 0)] ?? -1;
    if (!isStart(first)) {
      // The forward error, also when the reversed read has no start character either.
      const noStart = symbolError('no-start', 'No start character', origins[0]?.element, only.row);
      if (!sameAs(runs, 0, REVERSED_STOP)) return fail([noStart]);
      runs.reverse();
      reversed = true;
      if (!isStart(C128_LOOKUP[c128Key(runs, 0)] ?? -1)) return fail([noStart]);
    }
    /** A symbol error at element `e` of the reading order, at the caller's index. */
    const at = (
      reason: 'no-stop' | 'character' | 'check-character' | 'sequence',
      message: string,
      e: number,
    ): Gs1Error =>
      symbolError(reason, message, origins[reversed ? n - 1 - e : e]?.element, only.row);
    if (!sameAs(runs, n - 7, C128_STOP)) return fail([at('no-stop', 'No stop character', n - 7)]);
    const values: number[] = [];
    for (let c = 0; c < count; c++) {
      const v = C128_LOOKUP[c128Key(runs, 6 * c)] ?? -1;
      if (v < 0 || (c > 0 && v >= START_A))
        return fail([at('character', 'Not a symbol character here', 6 * c)]);
      values.push(v);
    }
    const start = values[0] ?? 0;
    let sum = start;
    for (let k = 1; k < count - 1; k++) sum += k * (values[k] ?? 0);
    if (sum % 103 !== values[count - 1])
      return fail([at('check-character', 'Incorrect symbol check character', 6 * (count - 1))]);
    const gs1 = values[1] === FNC1;
    const c2 = !gs1 && count > 3 && values[2] === FNC1 && isDataValue(start, values[1]);
    const t = interpret(values, gs1 ? 1 : c2 ? 2 : -1);
    if (!gs1) {
      const aimId = c2 ? ']C2' : ']C0';
      const message = 'Code 128 without FNC1 in first position is not GS1-128';
      return fail([
        unsupported('not-gs1', message, 'text' in t ? { aimId, text: t.text } : { aimId }),
      ]);
    }
    if (!('text' in t)) {
      if (t.kind === 'sequence')
        return fail([at('sequence', 'SHIFT must precede a data character', 6 * t.at)]);
      return fail([unsupported(t.kind, `${t.kind.toUpperCase()} is not used in GS1-128`)]);
    }
    const es = elementsOf(t.text);
    if (!es.ok) return fail(es.errors);
    const base = { reversed, symbolValues: values, dataCharacters: t.text.length };
    const over = t.text.length > MAX_DATA ? { overLength: true as const } : {};
    const link = t.linkage === undefined ? {} : { linkage: t.linkage };
    return ok(
      freezeDecoded({
        symbology: 'gs1-128',
        aimId: ']C1',
        elementString: es.value,
        rawData: t.text,
        errorsCorrected: 0,
        metadata: { ...base, ...over, ...link },
      }),
    );
  } catch {
    return fail([symbolError('pattern', 'Symbol could not be decoded')]);
  }
}
