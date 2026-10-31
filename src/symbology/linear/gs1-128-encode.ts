import { Gs1Error, fail, ok } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { ElementString, format, tryParse } from '../../ai/index.ts';
import type { AiValue } from '../../ai/index.ts';
import { dataTooLong, freezePattern, notRepresentable } from '../render/internal.ts';
import type { HriText, LinearPattern } from '../render/index.ts';
import { C128_STOP, C128_WIDTHS, FNC1, START_B, START_C } from './code128-tables.ts';

export interface Gs1128Options {
  /** Fixed-length AIs first, saving separators (default false). */
  readonly optimizeOrder?: boolean;
  /** Bar height in modules (default 64). */
  readonly height?: number;
  /** Human readable interpretation (default true). */
  readonly hri?: boolean;
}

const GS = 0x1d;
const MAX_DATA = 48;
const DEFAULT_HEIGHT = 64;
/** The tallest bars, in modules: far above any real symbol, it keeps rendered images sane. */
const MAX_HEIGHT = 1000;
const QUIET = 10;
const HRI_SIZE = 8;
const HRI_GAP = 3;
/** Cap height and line pitch of the HRI font: 0.8 and 1.2 times the size (plan decision G17). */
const HRI_CAP = 6.4;
const HRI_LINE = 9.6;
/** Estimated advance of one HRI character: 0.6 em. */
const HRI_ADVANCE = 4.8;
const CODE_C = 99;
const CODE_B = 100;

function invalidOption(option: string, message: string): Gs1Error {
  return new Gs1Error({ code: 'INVALID_VALUE', message, details: { option } });
}

interface Settings {
  readonly optimizeOrder: boolean;
  readonly height: number;
  readonly hri: boolean;
}

function readOptions(options: unknown): Result<Settings> {
  if (options !== undefined && (typeof options !== 'object' || options === null))
    return fail([invalidOption('options', 'Options must be an object')]);
  const o: object = options ?? {};
  const get = (name: string): unknown => Reflect.get(o, name);
  const errors: Gs1Error[] = [];
  let optimizeOrder = false;
  const oo = get('optimizeOrder');
  if (oo !== undefined) {
    if (typeof oo !== 'boolean')
      errors.push(invalidOption('optimizeOrder', 'optimizeOrder must be a boolean'));
    else optimizeOrder = oo;
  }
  let height = DEFAULT_HEIGHT;
  const h = get('height');
  if (h !== undefined) {
    if (typeof h !== 'number' || !Number.isFinite(h) || h <= 0 || h > MAX_HEIGHT)
      errors.push(invalidOption('height', `height must be above 0 and at most ${MAX_HEIGHT}`));
    else height = h;
  }
  let hri = true;
  const f = get('hri');
  if (f !== undefined) {
    if (typeof f !== 'boolean') errors.push(invalidOption('hri', 'hri must be a boolean'));
    else hri = f;
  }
  if (errors.length > 0) return fail(errors);
  return ok({ optimizeOrder, height, hri });
}

function isDigitAt(s: string, i: number): boolean {
  const c = s.charCodeAt(i);
  return c >= 48 && c <= 57;
}

/**
 * Minimal symbol values for raw data (GS is FNC1): `[start, FNC1, ...data, check]`, without the
 * stop. A dynamic programme over code sets B and C with the plan decision G13 tie-break: stay
 * before latch; the start set is the cheapest, C first on ties. Every character must be GS or
 * ASCII 32 to 127. Internal.
 */
export function encodeTokens(raw: string): number[] {
  const n = raw.length;
  // costB[i], costC[i]: fewest symbol characters for raw[i..] when in code set B or C.
  const costB: number[] = Array.from({ length: n + 1 }, () => 0);
  const costC: number[] = Array.from({ length: n + 1 }, () => 0);
  const stayB = (i: number): number => 1 + (costB[i + 1] ?? 0);
  const stayC = (i: number): number => {
    if (raw.charCodeAt(i) === GS) return 1 + (costC[i + 1] ?? 0);
    if (isDigitAt(raw, i) && isDigitAt(raw, i + 1)) return 1 + (costC[i + 2] ?? 0);
    return Infinity;
  };
  for (let i = n - 1; i >= 0; i--) {
    const b = stayB(i);
    const c = stayC(i);
    costB[i] = Math.min(b, 1 + c);
    costC[i] = Math.min(c, 1 + b);
  }
  let inC = (costC[0] ?? 0) <= (costB[0] ?? 0);
  const values: number[] = [inC ? START_C : START_B, FNC1];
  let i = 0;
  while (i < n) {
    const stay = inC ? stayC(i) : stayB(i);
    const latch = 1 + (inC ? stayB(i) : stayC(i));
    if (latch < stay) {
      values.push(inC ? CODE_B : CODE_C);
      inC = !inC;
    }
    const code = raw.charCodeAt(i);
    if (code === GS) {
      values.push(FNC1);
      i++;
    } else if (inC) {
      values.push(10 * (code - 48) + raw.charCodeAt(i + 1) - 48);
      i += 2;
    } else {
      values.push(code - 32);
      i++;
    }
  }
  let sum = values[0] ?? 0;
  for (let k = 1; k < values.length; k++) sum += k * (values[k] ?? 0);
  values.push(sum % 103);
  return values;
}

/**
 * HRI lines (plan decision G17): pieces joined in order, wrapped only between pieces so that a
 * line's estimated width fits `width`; a piece wider than `width` alone takes its own line.
 * Internal.
 */
export function hriLines(pieces: readonly string[], width: number, height: number): HriText[] {
  const lines: string[] = [];
  let line = '';
  for (const p of pieces) {
    if (line !== '' && (line.length + p.length) * HRI_ADVANCE > width) {
      lines.push(line);
      line = '';
    }
    line += p;
  }
  if (line !== '') lines.push(line);
  return lines.map((text, k) => ({
    text,
    x: width / 2,
    y: height + HRI_GAP + HRI_CAP + HRI_LINE * k,
    size: HRI_SIZE,
    anchor: 'middle',
    role: 'hri',
  }));
}

/** Raw data of `entries` in this order, with GS after the elements flagged in `sep`. */
function rawOf(entries: readonly AiValue[], sep: ReadonlyMap<AiValue, boolean>): string {
  let out = '';
  entries.forEach((e, k) => {
    out += e[0] + e[1];
    if (k < entries.length - 1 && sep.get(e) === true) out += '\u001d';
  });
  return out;
}

/**
 * The elements in the order `format(es, 'raw', { optimizeOrder })` encodes them. The separator
 * rule of each element is read off the caller-order raw data (every element but the last shows
 * it); the last element's rule is the one that reproduces the optimized raw data.
 */
function encodedOrder(es: ElementString, optimizeOrder: boolean): readonly AiValue[] {
  const entries = es.entries();
  if (!optimizeOrder) return entries;
  const plain = format(es, 'raw');
  const target = format(es, 'raw', { optimizeOrder: true });
  const sep = new Map<AiValue, boolean>();
  let at = 0;
  for (const e of entries) {
    at += e[0].length + e[1].length;
    const gs = plain.charCodeAt(at) === GS;
    sep.set(e, gs);
    if (gs) at++;
  }
  const last = entries.at(-1);
  for (const lastSep of [true, false]) {
    if (last !== undefined) sep.set(last, lastSep);
    const ordered = [
      ...entries.filter((e) => sep.get(e) !== true),
      ...entries.filter((e) => sep.get(e) === true),
    ];
    if (rawOf(ordered, sep) === target) return ordered;
  }
  return entries;
}

/**
 * String data is parsed without the association rules: a label may split its element strings
 * across several GS1-128 symbols (for example (00) in one, (02)(37)(10) in another), so one
 * symbol need not hold every required AI. An ElementString is used as given.
 */
function elementStringOf(data: unknown): Result<ElementString> {
  if (data instanceof ElementString) return ok(data);
  if (typeof data === 'string') return tryParse(data, { validateAssociations: false });
  return fail([
    new Gs1Error({
      code: 'INVALID_VALUE',
      message: 'Data must be a string or an ElementString',
      details: { option: 'data' },
    }),
  ]);
}

/** GS1-128 encoder (plan decisions G13, G14, G16, G17). Never throws. Internal. */
export function encodeGs1128(data: unknown, options: unknown): Result<LinearPattern> {
  try {
    const opts = readOptions(options);
    if (!opts.ok) return fail(opts.errors);
    const s = opts.value;
    const es = elementStringOf(data);
    if (!es.ok) return fail(es.errors);
    const raw = format(es.value, 'raw', { optimizeOrder: s.optimizeOrder });
    if (raw.length > MAX_DATA) return fail([dataTooLong(MAX_DATA, raw.length)]);
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c !== GS && (c < 32 || c > 127))
        return fail([notRepresentable('gs1-128', 'a character is outside code set B')]);
    }
    const values = encodeTokens(raw);
    const widths: number[] = [];
    for (const v of values) for (let k = 0; k < 6; k++) widths.push(C128_WIDTHS[6 * v + k] ?? 0);
    widths.push(...C128_STOP);
    const width = 11 * values.length + 13;
    const pieces = encodedOrder(es.value, s.optimizeOrder).map(([a, v]) => `(${a})${v}`);
    return ok(
      freezePattern({
        kind: 'linear',
        symbology: 'gs1-128',
        width,
        height: s.height,
        rows: [{ role: 'symbol', x: 0, y: 0, height: s.height, widths }],
        hri: s.hri ? hriLines(pieces, width, s.height) : [],
        quietZone: { left: QUIET, right: QUIET, top: 0, bottom: 0 },
      }),
    );
  } catch {
    return fail([new Gs1Error({ code: 'INVALID_VALUE', message: 'Input could not be encoded' })]);
  }
}
