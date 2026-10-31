import { fail, Gs1Error, ok, type Result } from '../../core/index.ts';
import { dataTooLong, notRepresentable } from '../render/internal.ts';
import { DM_SIZES, dmSize, type DmSize } from './dm-tables.ts';
import type { DmMode } from './dm-decode.ts';

/** The FNC1 input symbol. */
export const DM_FNC1 = -1;

/** The `size` option of `gs1DataMatrix` and `dataMatrix`. */
export type DmSizeOption =
  | 'square'
  | 'rectangular'
  | 'auto'
  | { readonly rows: number; readonly columns: number };

/** Encodation modes the encoder uses: every decoder mode but Base 256 (decision H9). */
export type DmEncodeMode = Exclude<DmMode, 'base256'>;

/**
 * How the encodation of `fit(capacity)` ends (DataMatrix research 3.5, decision H9):
 * - `ascii`: in ASCII mode (pads follow, if any). "Unlatch then pad" (254 after C40, Text or X12;
 *   the unlatch value after EDIFACT) is this ending, reached through the zero-length unlatch
 *   transition, which also wins every tie with a separate unlatch candidate;
 * - `exact`: C40, Text or X12 on a triplet boundary filling the symbol, no unlatch;
 * - `ascii-last`: C40, Text or X12 on a triplet boundary with one codeword left, which holds the
 *   last character (or digit pair) in ASCII without unlatch;
 * - `edifact-end`: EDIFACT on a quad boundary with at most 2 codewords left, no unlatch;
 * - `edifact-ascii-tail`: EDIFACT on a quad boundary with at most 2 codewords left, which hold the
 *   remaining characters in ASCII without unlatch.
 */
export type DmEndingKind = 'ascii' | 'exact' | 'ascii-last' | 'edifact-end' | 'edifact-ascii-tail';

export interface DmEnding {
  readonly kind: DmEndingKind;
  /** Mode of the last segment before the ending. */
  readonly mode: DmEncodeMode;
  /** ASCII codewords written after that segment without unlatch (`ascii-last`, `edifact-ascii-tail`). */
  readonly tail: number;
  /** Data codewords in all (without pads), leading FNC1 included. */
  readonly total: number;
}

export interface DmEncodation {
  /** The minimal codewords that fit `capacity` exactly or with padding room, or undefined if none fits. */
  fit(capacity: number): readonly number[] | undefined;
  /** How `fit(capacity)` ends, or undefined if none fits. */
  ending(capacity: number): DmEnding | undefined;
  /** The fewest codewords over all endings (used for DATA_TOO_LONG details); Infinity if the data has no encodation. */
  readonly minimum: number;
}

// DP modes. EDIFACT is E0..E3: k characters of the current quad pending.
const A = 0;
const C40 = 1;
const TEXT = 2;
const X12 = 3;
const E0 = 4;
const MODES = 8;
const MODE_NAMES: readonly DmEncodeMode[] = [
  'ascii',
  'c40',
  'text',
  'x12',
  'edifact',
  'edifact',
  'edifact',
  'edifact',
];
/** Latch codewords from ASCII, by mode. */
const LATCH: readonly number[] = [0, 230, 239, 238, 240];
/** Cost of leaving EDIFACT with k pending characters: values plus unlatch, padded to a byte. */
const EDF_UNLATCH: readonly number[] = [1, 2, 3, 3];
const SHIFT2 = '!"#$%&\'()*+,-./:;<=>?@[\\]^_';

function isByte7(c: number | undefined): c is number {
  return c !== undefined && Number.isInteger(c) && c >= 0 && c <= 127;
}

function isDigit(c: number | undefined): boolean {
  return c !== undefined && c >= 48 && c <= 57;
}

function asciiOk(c: number | undefined): boolean {
  return c === DM_FNC1 || isByte7(c);
}

/** C40 (`text` false) or Text values of one symbol; empty if it has none (research 3.1). */
function ctValues(c: number, text: boolean): number[] {
  if (c === DM_FNC1) return [1, 27];
  if (!isByte7(c)) return [];
  if (c === 32) return [3];
  if (isDigit(c)) return [c - 44];
  const basic = text ? 97 : 65;
  if (c >= basic && c < basic + 26) return [c - basic + 14];
  if (c < 32) return [0, c];
  const k = SHIFT2.indexOf(String.fromCharCode(c));
  if (k >= 0) return [1, k];
  if (!text) return [2, c - 96];
  if (c === 96) return [2, 0];
  if (c >= 65 && c <= 90) return [2, c - 64];
  return [2, c - 123 + 27];
}

/** The X12 value of one symbol, or -1. */
function x12Value(c: number | undefined): number {
  if (c === 13) return 0;
  if (c === 42) return 1;
  if (c === 62) return 2;
  if (c === 32) return 3;
  if (c !== undefined && isDigit(c)) return c - 44;
  if (c !== undefined && c >= 65 && c <= 90) return c - 51;
  return -1;
}

function edifactOk(c: number | undefined): boolean {
  return c !== undefined && Number.isInteger(c) && c >= 32 && c <= 94;
}

function packTriplets(values: readonly number[], out: number[]): void {
  for (let i = 0; i + 2 < values.length; i += 3) {
    const v = 1600 * (values[i] ?? 0) + 40 * (values[i + 1] ?? 0) + (values[i + 2] ?? 0) + 1;
    out.push(v >> 8, v & 255);
  }
}

function packEdifact(chars: readonly number[], unlatch: boolean, out: number[]): void {
  const values = chars.map((c) => c & 63);
  if (unlatch) values.push(31);
  let bits = 0;
  let count = 0;
  for (const v of values) {
    bits = (bits << 6) | v;
    count += 6;
    while (count >= 8) {
      out.push((bits >> (count - 8)) & 255);
      count -= 8;
      bits &= (1 << count) - 1;
    }
  }
  if (count > 0) out.push((bits << (8 - count)) & 255);
}

/** ASCII codewords of s[i..end) (greedy digit pairs, which is minimal for plain ASCII). */
function asciiRun(s: readonly number[], i: number, end: number, out: number[]): void {
  let q = i;
  while (q < end) {
    const c = s[q] ?? 0;
    if (isDigit(c) && q + 1 < end && isDigit(s[q + 1])) {
      out.push(130 + (c - 48) * 10 + ((s[q + 1] ?? 48) - 48));
      q += 2;
    } else {
      out.push(c === DM_FNC1 ? 232 : c + 1);
      q += 1;
    }
  }
}

/** Number of ASCII codewords of s[i..n), or Infinity if a symbol has none. */
function asciiLength(s: readonly number[], i: number): number {
  let n = 0;
  let q = i;
  while (q < s.length) {
    if (!asciiOk(s[q])) return Number.POSITIVE_INFINITY;
    q += isDigit(s[q]) && isDigit(s[q + 1]) ? 2 : 1;
    n++;
  }
  return n;
}

interface Candidate {
  readonly kind: DmEndingKind;
  /** DP state index (position * MODES + mode) the ending starts from. */
  readonly node: number;
  /** Codewords up to `node`. */
  readonly cost: number;
  /** Codewords the ending adds. */
  readonly extra: number;
  /** Candidate applies only when `capacity - cost` is in this range. */
  readonly minLeft: number;
  readonly maxLeft: number;
}

/**
 * For C40 or Text: per position i, the smallest j > i such that the symbols i..j-1 have a value
 * count divisible by 3 (the minimal run that completes whole triplets), or -1. `pref` receives the
 * prefix value counts.
 */
function minimalRuns(s: readonly number[], text: boolean, pref: Int32Array): Int32Array {
  const n = s.length;
  for (let i = 0; i < n; i++) pref[i + 1] = (pref[i] ?? 0) + ctValues(s[i] ?? 0, text).length;
  const next = new Int32Array(n + 1).fill(-1);
  const last = [-1, -1, -1];
  last[(pref[n] ?? 0) % 3] = n;
  for (let i = n - 1; i >= 0; i--) {
    if (ctValues(s[i] ?? 0, text).length === 0) last.fill(-1);
    const r = (pref[i] ?? 0) % 3;
    next[i] = last[r] ?? -1;
    last[r] = i;
  }
  return next;
}

/**
 * The exact minimal-codeword encodation of DataMatrix research 3.6 (decision H9). `symbols` are
 * 0..127 or DM_FNC1; a leading FNC1 is always the first codeword (232). Pure and total: symbols
 * without an encodation (see `checkSymbols`) leave nothing that fits.
 */
export function encodeCodewords(
  symbols: readonly number[],
  encodation: 'auto' | 'ascii',
): DmEncodation {
  const lead = symbols[0] === DM_FNC1 ? 1 : 0;
  const s = symbols.slice(lead);
  const n = s.length;
  const all = encodation === 'auto';
  const states = (n + 1) * MODES;
  const cost = new Float64Array(states).fill(Number.POSITIVE_INFINITY);
  // Secondary key: ASCII single digits taken where a digit pair was possible (keeps ISO pairs on ties).
  const pen = new Int32Array(states);
  const prev = new Int32Array(states).fill(-1);
  const relax = (to: number, c: number, p: number, from: number): void => {
    const cur = cost[to] ?? Number.POSITIVE_INFINITY;
    if (c < cur || (c === cur && p < (pen[to] ?? 0))) {
      cost[to] = c;
      pen[to] = p;
      prev[to] = from;
    }
  };
  const prefC = new Int32Array(n + 1);
  const prefT = new Int32Array(n + 1);
  const runC = all ? minimalRuns(s, false, prefC) : new Int32Array(0);
  const runT = all ? minimalRuns(s, true, prefT) : new Int32Array(0);

  cost[0] = 0;
  for (let i = 0; i <= n; i++) {
    const at = i * MODES;
    if (all) {
      for (let m = C40; m <= X12; m++) {
        const c = cost[at + m] ?? Number.POSITIVE_INFINITY;
        if (c < Number.POSITIVE_INFINITY) relax(at + A, c + 1, pen[at + m] ?? 0, at + m);
      }
      for (let k = 0; k < 4; k++) {
        const c = cost[at + E0 + k] ?? Number.POSITIVE_INFINITY;
        if (c < Number.POSITIVE_INFINITY)
          relax(at + A, c + (EDF_UNLATCH[k] ?? 3), pen[at + E0 + k] ?? 0, at + E0 + k);
      }
      const ca = cost[at + A] ?? Number.POSITIVE_INFINITY;
      if (ca < Number.POSITIVE_INFINITY)
        for (let m = C40; m <= E0; m++) relax(at + m, ca + 1, pen[at + A] ?? 0, at + A);
    }
    if (i === n) break;
    const ch = s[i];
    const next = at + MODES;
    const ca = cost[at + A] ?? Number.POSITIVE_INFINITY;
    const pa = pen[at + A] ?? 0;
    if (ca < Number.POSITIVE_INFINITY && asciiOk(ch)) {
      if (isDigit(ch) && isDigit(s[i + 1])) {
        relax(next + MODES + A, ca + 1, pa, at + A);
        relax(next + A, ca + 1, pa + 1, at + A);
      } else relax(next + A, ca + 1, pa, at + A);
    }
    if (!all) continue;
    for (const [m, run, pref] of [
      [C40, runC, prefC],
      [TEXT, runT, prefT],
    ] as const) {
      const c = cost[at + m] ?? Number.POSITIVE_INFINITY;
      const j = run[i] ?? -1;
      if (c < Number.POSITIVE_INFINITY && j > i)
        relax(
          j * MODES + m,
          c + (2 * ((pref[j] ?? 0) - (pref[i] ?? 0))) / 3,
          pen[at + m] ?? 0,
          at + m,
        );
    }
    const cx = cost[at + X12] ?? Number.POSITIVE_INFINITY;
    if (
      cx < Number.POSITIVE_INFINITY &&
      i + 3 <= n &&
      x12Value(ch) >= 0 &&
      x12Value(s[i + 1]) >= 0 &&
      x12Value(s[i + 2]) >= 0
    )
      relax((i + 3) * MODES + X12, cx + 2, pen[at + X12] ?? 0, at + X12);
    if (edifactOk(ch))
      for (let k = 0; k < 4; k++) {
        const c = cost[at + E0 + k] ?? Number.POSITIVE_INFINITY;
        if (c < Number.POSITIVE_INFINITY)
          relax(
            next + E0 + ((k + 1) % 4),
            c + (k === 3 ? 3 : 0),
            pen[at + E0 + k] ?? 0,
            at + E0 + k,
          );
      }
  }

  // End candidates in tie-break order (research 3.5, 3.6): plain ASCII first.
  const cands: Candidate[] = [];
  const BIG = Number.POSITIVE_INFINITY;
  const end = n * MODES;
  const add = (
    kind: DmEndingKind,
    node: number,
    extra: number,
    minLeft: number,
    maxLeft: number,
  ): void => {
    const c = cost[node] ?? BIG;
    if (c < BIG) cands.push({ kind, node, cost: c, extra, minLeft, maxLeft });
  };
  add('ascii', end + A, 0, 0, BIG);
  // Unlatch then pad is the ASCII state at n (zero-length unlatch transitions), so only the
  // endings without unlatch are listed here.
  for (let m = C40; m <= X12; m++) add('exact', end + m, 0, 0, 0);
  add('edifact-end', end + E0, 0, 0, 2);
  for (let i = Math.max(0, n - 4); i < n; i++) {
    const len = asciiLength(s, i);
    if (len <= 2) add('edifact-ascii-tail', i * MODES + E0, len, len, 2);
  }
  for (let m = C40; m <= X12; m++)
    for (let i = Math.max(0, n - 2); i < n; i++) {
      const one =
        (i === n - 1 && asciiOk(s[i])) || (i === n - 2 && isDigit(s[i]) && isDigit(s[i + 1]));
      if (one) add('ascii-last', i * MODES + m, 1, 1, 1);
    }

  const pick = (capacity: number): Candidate | undefined => {
    const cap = capacity - lead;
    let best: Candidate | undefined;
    for (const c of cands) {
      const left = cap - c.cost;
      if (left < c.minLeft || left > c.maxLeft || c.cost + c.extra > cap) continue;
      if (!best || c.cost + c.extra < best.cost + best.extra) best = c;
    }
    return best;
  };

  const build = (c: Candidate): number[] => {
    const chain: number[] = [];
    for (let v = c.node; v >= 0; v = prev[v] ?? -1) chain.push(v);
    chain.reverse();
    const out: number[] = lead ? [232] : [];
    let edf: number[] = [];
    for (let q = 1; q < chain.length; q++) {
      const from = chain[q - 1] ?? 0;
      const to = chain[q] ?? 0;
      const fi = Math.floor(from / MODES);
      const fm = from % MODES;
      const ti = Math.floor(to / MODES);
      const tm = to % MODES;
      if (fi === ti) {
        if (tm !== A) out.push(LATCH[tm] ?? 0);
        else if (fm >= E0) {
          packEdifact(edf, true, out);
          edf = [];
        } else out.push(254);
      } else if (fm === A) asciiRun(s, fi, ti, out);
      else if (fm === C40 || fm === TEXT)
        packTriplets(
          s.slice(fi, ti).flatMap((x) => ctValues(x, fm === TEXT)),
          out,
        );
      else if (fm === X12)
        packTriplets(
          s.slice(fi, ti).map((x) => x12Value(x)),
          out,
        );
      else {
        edf.push(s[fi] ?? 0);
        if (tm === E0) {
          packEdifact(edf, false, out);
          edf = [];
        }
      }
    }
    const i = Math.floor(c.node / MODES);
    switch (c.kind) {
      case 'edifact-ascii-tail':
      case 'ascii-last':
        asciiRun(s, i, n, out);
        break;
      case 'ascii':
      case 'exact':
      case 'edifact-end':
        break;
      default: {
        const never: never = c.kind;
        return never;
      }
    }
    return out;
  };

  let minimum = BIG;
  for (const c of cands) {
    const total = c.cost + c.extra;
    // Smallest capacity where the candidate applies: total, unless it needs room left over.
    const at = Math.max(total, c.cost + c.minLeft);
    if (at <= c.cost + c.maxLeft && at < minimum) minimum = at;
  }
  return {
    fit(capacity: number): readonly number[] | undefined {
      const c = pick(capacity);
      return c ? build(c) : undefined;
    },
    ending(capacity: number): DmEnding | undefined {
      const c = pick(capacity);
      if (!c) return undefined;
      const tail = c.kind === 'ascii-last' || c.kind === 'edifact-ascii-tail' ? c.extra : 0;
      return {
        kind: c.kind,
        mode: MODE_NAMES[c.node % MODES] ?? 'ascii',
        tail,
        total: c.cost + c.extra + lead,
      };
    },
    minimum: minimum + lead,
  };
}

/**
 * The symbols as an encoder input: each 0..127 or DM_FNC1. Byte values 128 to 255 cannot occur
 * in GS1 or Digital Link data and are NOT_REPRESENTABLE (`details.value`, `details.index`).
 */
export function checkSymbols(symbols: readonly number[]): Result<readonly number[]> {
  for (let i = 0; i < symbols.length; i++) {
    const v = symbols[i];
    if (!asciiOk(v)) {
      const e = notRepresentable('datamatrix', `value ${String(v)} at index ${i}`);
      return fail([
        new Gs1Error({
          code: e.code,
          message: e.message,
          details: { ...e.details, value: v, index: i },
        }),
      ]);
    }
  }
  return ok(symbols);
}

const SQUARES: readonly DmSize[] = /* @__PURE__ */ (() =>
  DM_SIZES.filter((s) => s.shape === 'square'))();
const RECTANGLES: readonly DmSize[] = /* @__PURE__ */ (() =>
  DM_SIZES.filter((s) => s.shape === 'rectangular'))();
/** All 30 sizes by area, squares first on equal areas (decision H10). */
const BY_AREA: readonly DmSize[] = /* @__PURE__ */ (() =>
  // oxlint-disable-next-line no-array-sort -- sorts a fresh copy
  [...DM_SIZES].sort(
    (a, b) =>
      a.rows * a.columns - b.rows * b.columns ||
      (a.shape === b.shape ? 0 : a.shape === 'square' ? -1 : 1),
  ))();

function invalidSize(): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_VALUE',
    message: "Option size must be 'square', 'rectangular', 'auto' or one of the 30 ECC 200 sizes",
    details: { option: 'size' },
  });
}

/** The candidate sizes of a size option, in the order to try, or undefined if it is invalid. */
function candidates(size: unknown): readonly DmSize[] | undefined {
  if (size === 'square') return SQUARES;
  if (size === 'rectangular') return RECTANGLES;
  if (size === 'auto') return BY_AREA;
  if (typeof size !== 'object' || size === null || Array.isArray(size)) return undefined;
  try {
    const rows: unknown = Reflect.get(size, 'rows');
    const columns: unknown = Reflect.get(size, 'columns');
    if (typeof rows !== 'number' || typeof columns !== 'number') return undefined;
    const found = dmSize(rows, columns);
    return found ? [found] : undefined;
  } catch {
    return undefined;
  }
}

/** What to do when the data does not fit: a size option with more room, or less data. */
function tooLongRemedy(size: DmSizeOption): string {
  if (size === 'square' || size === 'auto')
    return 'It does not fit the largest symbol (144x144); use less data';
  return "Use size 'square' (the default) or 'auto', which pick the smallest size that fits";
}

/**
 * The first size of the option's list (ascending capacity within the shape, or by area for
 * 'auto') that the encodation fits, with its codewords. INVALID_VALUE `size` for an invalid
 * option; DATA_TOO_LONG (`limit`, `actual`, `unit: 'codewords'`, plus `size` when explicit) when
 * nothing fits; NOT_REPRESENTABLE when the data has no encodation.
 */
export function chooseSize(
  enc: DmEncodation,
  size: DmSizeOption,
): Result<{ size: DmSize; codewords: readonly number[] }> {
  const list = candidates(size);
  if (!list) return fail([invalidSize()]);
  if (enc.minimum === Number.POSITIVE_INFINITY)
    return fail([notRepresentable('datamatrix', 'byte values above 127 are not supported')]);
  let limit = 0;
  for (const s of list) {
    limit = Math.max(limit, s.dataCodewords);
    const codewords = enc.fit(s.dataCodewords);
    if (codewords) return ok({ size: s, codewords });
  }
  const e = dataTooLong(limit, enc.minimum);
  const only = list.length === 1 ? list[0] : undefined;
  const explicit =
    typeof size === 'object' && only ? { rows: only.rows, columns: only.columns } : undefined;
  return fail([
    new Gs1Error({
      code: e.code,
      message: `Data needs ${enc.minimum} codewords, the limit is ${limit}. ${tooLongRemedy(size)}.`,
      details: explicit
        ? { ...e.details, unit: 'codewords', size: explicit }
        : { ...e.details, unit: 'codewords' },
    }),
  ]);
}
