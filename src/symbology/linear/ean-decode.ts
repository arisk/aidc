import { Gs1Error, fail, isValidCheckDigit, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { tryParse } from '../../ai/index.ts';
import { freezeDecoded, readPlacedRows, symbolError } from '../render/internal.ts';
import type { PlacedRow } from '../render/internal.ts';
import type { DecodedSymbol, LinearPattern, SymbologyName } from '../render/index.ts';
import {
  ADDON2_PARITY,
  ADDON5_PARITY,
  ADDON_DELINEATOR,
  ADDON_GUARD,
  CENTRE_GUARD,
  EAN13_PARITY,
  NORMAL_GUARD,
  SET_A,
  SET_B,
  UPCE_GUARD,
  UPCE_PARITY,
} from './ean-tables.ts';
import { isCanonicalUpce, upceExpand } from './upce.ts';

export interface EanUpcMetadata {
  /** The pattern was read right to left. */
  readonly reversed: boolean;
  /** UPC-E only: false when the body is not the one the encoder would produce (GenSpecs 7.10). */
  readonly upceCanonical?: boolean;
}

/** Which main symbols a decoder accepts. */
export type EanUpcAccept = 'ean-13' | 'ean-8' | 'upc-e' | 'any';

const MAIN_13 = 59;
const MAIN_8 = 43;
const MAIN_E = 33;
const ADDON_2 = 13;
const ADDON_5 = 31;
/** A light run of at least this many modules separates the main symbol from an add-on. */
const SPLIT = 5;
/** More elements than any accepted layout can use; guards against absurd inputs. */
const MAX_ELEMENTS = 2000;
const MAX_ROWS = 8;

/** Maps the width string of a character to its digit. */
function lookup(table: readonly string[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  table.forEach((w, d) => m.set(w, d));
  return m;
}
const A_DIGIT: ReadonlyMap<string, number> = /* @__PURE__ */ lookup(SET_A);
const B_DIGIT: ReadonlyMap<string, number> = /* @__PURE__ */ lookup(SET_B);

/** Digit and set (A or B) of the four widths at `from`, or undefined. */
function readChar(
  w: readonly number[],
  from: number,
  allowB: boolean,
): { digit: number; set: 'A' | 'B' } | undefined {
  const key = `${w[from]}${w[from + 1]}${w[from + 2]}${w[from + 3]}`;
  const a = A_DIGIT.get(key);
  if (a !== undefined) return { digit: a, set: 'A' };
  if (!allowB) return undefined;
  const b = B_DIGIT.get(key);
  return b === undefined ? undefined : { digit: b, set: 'B' };
}

function sameWidths(w: readonly number[], from: number, expected: readonly number[]): boolean {
  for (let i = 0; i < expected.length; i++) if (w[from + i] !== expected[i]) return false;
  return true;
}

/** A failure at element `at` of the row (offset by `base` into the whole width list). */
function bad(
  reason: 'guard' | 'character' | 'parity' | 'symbology' | 'length',
  message: string,
  at: number,
  base: number,
): Gs1Error {
  return symbolError(reason, message, base + at);
}

function checkFailure(position: number): Gs1Error {
  return new Gs1Error({
    code: 'CHECK_DIGIT',
    message: 'Incorrect GTIN check digit',
    ai: '01',
    position,
  });
}

interface Main {
  readonly form: 'ean-13' | 'ean-8' | 'upc-e';
  /** 13 digits (EAN-13, UPC-A, UPC-E as 0 + GTIN-12) or 8 digits (EAN-8). */
  readonly digits: string;
  readonly upceCanonical?: boolean;
}

/** Decodes a 59 element EAN-13 or UPC-A main symbol. */
function decode13(w: readonly number[], base: number): Result<Main> {
  if (!sameWidths(w, 0, NORMAL_GUARD)) return fail([bad('guard', 'Bad start guard', 0, base)]);
  if (!sameWidths(w, 27, CENTRE_GUARD)) return fail([bad('guard', 'Bad centre guard', 27, base)]);
  if (!sameWidths(w, 56, NORMAL_GUARD)) return fail([bad('guard', 'Bad stop guard', 56, base)]);
  let left = '';
  let parity = '';
  for (let k = 0; k < 6; k++) {
    const c = readChar(w, 3 + 4 * k, true);
    if (c === undefined) return fail([bad('character', 'Unknown character', 3 + 4 * k, base)]);
    left += c.digit;
    parity += c.set;
  }
  const first = EAN13_PARITY.indexOf(parity);
  if (first < 0) return fail([bad('parity', 'Invalid left half parity', 3, base)]);
  let right = '';
  for (let k = 0; k < 6; k++) {
    const c = readChar(w, 32 + 4 * k, false);
    if (c === undefined) return fail([bad('character', 'Unknown character', 32 + 4 * k, base)]);
    right += c.digit;
  }
  const digits = `${first}${left}${right}`;
  if (!isValidCheckDigit(digits)) return fail([checkFailure(12)]);
  return ok({ form: 'ean-13', digits });
}

/** Decodes a 43 element EAN-8 main symbol. */
function decode8(w: readonly number[], base: number): Result<Main> {
  if (!sameWidths(w, 0, NORMAL_GUARD)) return fail([bad('guard', 'Bad start guard', 0, base)]);
  if (!sameWidths(w, 19, CENTRE_GUARD)) return fail([bad('guard', 'Bad centre guard', 19, base)]);
  if (!sameWidths(w, 40, NORMAL_GUARD)) return fail([bad('guard', 'Bad stop guard', 40, base)]);
  let digits = '';
  for (let k = 0; k < 8; k++) {
    const from = k < 4 ? 3 + 4 * k : 24 + 4 * (k - 4);
    const c = readChar(w, from, k < 4);
    if (c === undefined) {
      // a set B character in the left half is a parity problem, not an unknown character
      const isB = k < 4 && B_DIGIT.has(`${w[from]}${w[from + 1]}${w[from + 2]}${w[from + 3]}`);
      return fail([bad(isB ? 'parity' : 'character', 'Unknown character', from, base)]);
    }
    if (k < 4 && c.set === 'B') return fail([bad('parity', 'EAN-8 uses set A only', from, base)]);
    digits += c.digit;
  }
  if (!isValidCheckDigit(digits)) return fail([checkFailure(7)]);
  return ok({ form: 'ean-8', digits });
}

/** Decodes a 33 element UPC-E main symbol (number system 0). */
function decodeE(w: readonly number[], base: number): Result<Main> {
  if (!sameWidths(w, 0, NORMAL_GUARD)) return fail([bad('guard', 'Bad start guard', 0, base)]);
  if (!sameWidths(w, 27, UPCE_GUARD)) return fail([bad('guard', 'Bad stop guard', 27, base)]);
  let body = '';
  let parity = '';
  for (let k = 0; k < 6; k++) {
    const c = readChar(w, 3 + 4 * k, true);
    if (c === undefined) return fail([bad('character', 'Unknown character', 3 + 4 * k, base)]);
    body += c.digit;
    parity += c.set;
  }
  const check = UPCE_PARITY.indexOf(parity);
  if (check < 0) return fail([bad('parity', 'Invalid UPC-E parity', 3, base)]);
  const gtin12 = upceExpand(body);
  if (gtin12.charCodeAt(11) - 48 !== check) return fail([checkFailure(12)]);
  return ok({
    form: 'upc-e',
    digits: `0${gtin12}`,
    upceCanonical: isCanonicalUpce(body),
  });
}

/** Decodes a 13 or 31 element add-on to its 2 or 5 digits. */
function decodeAddOn(w: readonly number[], base: number): Result<string> {
  if (!sameWidths(w, 0, ADDON_GUARD)) return fail([bad('guard', 'Bad add-on guard', 0, base)]);
  const n = w.length === ADDON_2 ? 2 : 5;
  let digits = '';
  let parity = '';
  for (let k = 0; k < n; k++) {
    const from = 3 + 6 * k;
    if (k > 0 && !sameWidths(w, from - 2, ADDON_DELINEATOR))
      return fail([bad('guard', 'Bad add-on delineator', from - 2, base)]);
    const c = readChar(w, from, true);
    if (c === undefined) return fail([bad('character', 'Unknown character', from, base)]);
    digits += c.digit;
    parity += c.set;
  }
  let expected: string;
  if (n === 2) {
    expected = ADDON2_PARITY[Number(digits) % 4] ?? '';
  } else {
    const d = (i: number): number => digits.charCodeAt(i) - 48;
    expected = ADDON5_PARITY[(3 * (d(0) + d(2) + d(4)) + 9 * (d(1) + d(3))) % 10] ?? '';
  }
  if (parity !== expected) return fail([bad('parity', 'Add-on parity does not match', 3, base)]);
  return ok(digits);
}

/**
 * Alternating dark/light runs from the rows (rows in x order, the gap between rows a light run),
 * starting and ending dark: leading and trailing light runs are dropped and runs of one colour
 * (from zero-width runs) merge.
 */
interface Origin {
  readonly row: number;
  readonly element: number;
}

interface Runs {
  readonly widths: number[];
  /** Where each run came from in the caller's rows (the first element merged into it). */
  readonly origins: Origin[];
}

function runsOf(rows: readonly PlacedRow[]): Result<Runs> {
  // Insertion sort by x (stable).
  const sorted: PlacedRow[] = [];
  for (const row of rows) {
    let i = sorted.length;
    while (i > 0 && (sorted[i - 1]?.x ?? 0) > row.x) i--;
    sorted.splice(i, 0, row);
  }
  const widths: number[] = [];
  const dark: boolean[] = [];
  const origins: Origin[] = [];
  const push = (w: number, isDark: boolean, origin: Origin): void => {
    if (w === 0) return;
    if (dark.length > 0 && dark[dark.length - 1] === isDark)
      widths[widths.length - 1] = (widths.at(-1) ?? 0) + w;
    else {
      widths.push(w);
      dark.push(isDark);
      origins.push(origin);
    }
  };
  let end: number | undefined;
  let total = 0;
  for (const row of sorted) {
    if (end !== undefined) {
      const gap = row.x - end;
      if (gap < 0 || !Number.isInteger(gap))
        return fail([
          symbolError('pattern', 'Rows overlap or are not on the module grid', 0, row.row),
        ]);
      push(gap, false, { row: row.row, element: 0 });
    }
    let sum = 0;
    for (let i = 0; i < row.widths.length; i++) {
      const w = row.widths[i] ?? 0;
      if (!Number.isInteger(w))
        return fail([symbolError('pattern', 'Widths must be whole modules', i, row.row)]);
      total++;
      if (total > MAX_ELEMENTS)
        return fail([symbolError('length', 'Too many elements for an EAN/UPC symbol', i, row.row)]);
      push(w, i % 2 === 0, { row: row.row, element: i });
      sum += w;
    }
    end = row.x + sum;
  }
  let from = 0;
  let to = widths.length;
  if (from < to && dark[from] === false) from++;
  if (from < to && dark[to - 1] === false) to--;
  return ok({ widths: widths.slice(from, to), origins: origins.slice(from, to) });
}

interface Segment {
  readonly start: number;
  readonly widths: readonly number[];
}

/** Splits at light runs of SPLIT modules or more (`runs` starts and ends dark). */
function split(runs: readonly number[]): Segment[] {
  const out: Segment[] = [];
  let start = 0;
  for (let i = 1; i < runs.length; i += 2) {
    if ((runs[i] ?? 0) >= SPLIT) {
      out.push({ start, widths: runs.slice(start, i) });
      start = i + 1;
    }
  }
  if (runs.length > 0) out.push({ start, widths: runs.slice(start) });
  return out;
}

interface Oriented {
  readonly main: Main;
  readonly addOn: string | undefined;
}

function isMain(n: number): boolean {
  return n === MAIN_13 || n === MAIN_8 || n === MAIN_E;
}
function isAddOn(n: number): boolean {
  return n === ADDON_2 || n === ADDON_5;
}

function acceptable(accept: EanUpcAccept, n: number): boolean {
  if (accept === 'any') return true;
  return n === (accept === 'ean-13' ? MAIN_13 : accept === 'ean-8' ? MAIN_8 : MAIN_E);
}

function decodeOriented(runs: readonly number[], accept: EanUpcAccept): Result<Oriented> {
  const segs = split(runs);
  const first = segs[0];
  if (first === undefined) return fail([symbolError('length', 'The pattern has no bars')]);
  const second = segs[1];
  const n1 = first.widths.length;
  if (segs.length === 1 && isAddOn(n1))
    return fail([symbolError('add-on-only', 'The pattern holds an add-on without a main symbol')]);
  const shape =
    segs.length <= 2 && isMain(n1) && (second === undefined || isAddOn(second.widths.length));
  if (!shape)
    return fail([
      symbolError('length', 'Not one EAN/UPC main symbol with an optional add-on', first.start),
    ]);
  if (!acceptable(accept, n1))
    return fail([symbolError('symbology', 'This is a different EAN/UPC symbol', first.start)]);
  const main =
    n1 === MAIN_13
      ? decode13(first.widths, first.start)
      : n1 === MAIN_8
        ? decode8(first.widths, first.start)
        : decodeE(first.widths, first.start);
  if (!main.ok) return fail(main.errors);
  if (second === undefined) return ok({ main: main.value, addOn: undefined });
  if (n1 === MAIN_8) return fail([symbolError('symbology', 'EAN-8 has no add-on', second.start)]);
  const addOn = decodeAddOn(second.widths, second.start);
  if (!addOn.ok) return fail(addOn.errors);
  return ok({ main: main.value, addOn: addOn.value });
}

function build(o: Oriented, reversed: boolean): Result<DecodedSymbol<EanUpcMetadata>> {
  const { main, addOn } = o;
  const gtin14 = main.form === 'ean-8' ? `000000${main.digits}` : `0${main.digits}`;
  const es = tryParse(`(01)${gtin14}`);
  if (!es.ok) return fail(es.errors);
  const symbology: SymbologyName =
    main.form === 'ean-8'
      ? 'ean-8'
      : main.form === 'upc-e'
        ? 'upc-e'
        : main.digits.startsWith('0')
          ? 'upc-a'
          : 'ean-13';
  const aimId = main.form === 'ean-8' ? ']E4' : addOn === undefined ? ']E0' : ']E3';
  const metadata: EanUpcMetadata =
    main.upceCanonical === undefined
      ? { reversed }
      : { reversed, upceCanonical: main.upceCanonical };
  const base = {
    symbology,
    aimId,
    elementString: es.value,
    rawData: addOn === undefined ? main.digits : main.digits + addOn,
    errorsCorrected: 0,
    metadata,
  };
  return ok(freezeDecoded(addOn === undefined ? base : { ...base, addOn }));
}

/** Rewrites a run index in `details.element` to the caller's row and element indices. */
function toRowIndex(e: Gs1Error, origins: readonly Origin[]): Gs1Error {
  const d = e.details;
  const at = d === undefined ? undefined : d['element'];
  if (e.code !== 'INVALID_SYMBOL' || typeof at !== 'number') return e;
  const o = origins[at];
  if (o === undefined) return e;
  return new Gs1Error({
    code: e.code,
    message: e.message,
    details: { ...d, element: o.element, row: o.row },
  });
}

function reversedCopy(a: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = a.length - 1; i >= 0; i--) out.push(a[i] ?? 0);
  return out;
}

/**
 * Decodes an EAN-13, UPC-A, EAN-8 or UPC-E pattern with an optional 2 or 5 digit add-on (plan
 * decisions G4, G9, G10, G11). The pattern is treated as untrusted. It may be read right to left
 * and may carry quiet zones. Never throws.
 */
export function decodeEanUpc(
  symbol: LinearPattern,
  accept: EanUpcAccept,
): Result<DecodedSymbol<EanUpcMetadata>> {
  try {
    const rows = readPlacedRows(symbol, ['symbol', 'add-on']);
    if (!rows.ok) return fail(rows.errors);
    if (rows.value.length > MAX_ROWS)
      return fail([symbolError('pattern', 'Too many rows for an EAN/UPC symbol')]);
    const runs = runsOf(rows.value);
    if (!runs.ok) return fail(runs.errors);
    const { widths, origins } = runs.value;
    const forward = decodeOriented(widths, accept);
    if (forward.ok) return build(forward.value, false);
    const back = decodeOriented(reversedCopy(widths), accept);
    if (back.ok) return build(back.value, true);
    return fail(forward.errors.map((e) => toRowIndex(e, origins)));
  } catch {
    return fail([symbolError('pattern', 'Symbol could not be decoded')]);
  }
}
