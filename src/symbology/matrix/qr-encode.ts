import { fail, Gs1Error, ok, type Result } from '../../core/index.ts';
import { dataTooLong, notRepresentable } from '../render/internal.ts';
import { type QrEcLevel, EC_LEVELS, countBits, qrVersion, versionGroup } from './qr-tables.ts';

export type QrMode = 'numeric' | 'alphanumeric' | 'byte';

/** Units: byte values 0x00..0x7E, or FNC1 as -1 (GS1 mode only). */
export interface QrSegment {
  readonly mode: QrMode;
  readonly units: readonly number[];
}

export interface QrEncoding {
  readonly version: number;
  readonly segments: readonly QrSegment[];
  /** Bits before the terminator, the FNC1 indicator included. */
  readonly bits: number;
  /** All data codewords of the version and level, padding included. */
  readonly codewords: readonly number[];
}

/** The FNC1 unit. */
const FNC1 = -1;
const PERCENT = 0x25;
const GS = 0x1d;

const MODES: readonly QrMode[] = ['numeric', 'alphanumeric', 'byte'];
const MODE_INDICATOR: Readonly<Record<QrMode, number>> = {
  numeric: 0b0001,
  alphanumeric: 0b0010,
  byte: 0b0100,
};
/** A version of each count-length group, for `countBits`. */
const GROUP_VERSIONS: readonly number[] = [1, 10, 27];
const GROUP_LAST: readonly number[] = [9, 26, 40];

/** Alphanumeric values of the bytes 0x00..0x7F, -1 where the byte is not alphanumeric. */
const ALNUM_VALUE: Int8Array = /* @__PURE__ */ (() => {
  const t = new Int8Array(128).fill(-1);
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  return t;
})();
const ALNUM_PERCENT = 38;

const isDigit = (u: number): boolean => u >= 0x30 && u <= 0x39;

/** Alphanumeric value of a unit (FNC1 is `%` in GS1 mode), or -1. */
function alnumValue(u: number, gs1: boolean): number {
  if (u === FNC1) return gs1 ? ALNUM_PERCENT : -1;
  return u >= 0 && u < 128 ? (ALNUM_VALUE[u] ?? -1) : -1;
}

/**
 * The character count of a segment: in an alphanumeric segment in GS1 mode a literal `%` counts
 * twice (it is written `%%`), FNC1 once (as `%`).
 */
export function characterCount(s: QrSegment, gs1: boolean): number {
  if (s.mode !== 'alphanumeric' || !gs1) return s.units.length;
  let n = s.units.length;
  for (const u of s.units) if (u === PERCENT) n++;
  return n;
}

/**
 * The exact minimal-bit segmentation (decision Q3, QR research 2.3) for the count lengths of
 * `group`: a dynamic programme over units in sixths of a bit, linear in units times modes. Ties
 * go to the previous mode in order numeric, alphanumeric, byte, then to the first final mode.
 * `bits` includes the `0101` FNC1 indicator in GS1 mode.
 */
export function segment(
  units: readonly number[],
  gs1: boolean,
  group: 0 | 1 | 2,
): { readonly segments: readonly QrSegment[]; readonly bits: number } {
  const n = units.length;
  const header = gs1 ? 4 : 0;
  if (n === 0) return { segments: [], bits: header };
  const v = GROUP_VERSIONS[group] ?? 1;
  const head = [
    (4 + countBits('numeric', v)) * 6,
    (4 + countBits('alphanumeric', v)) * 6,
    (4 + countBits('byte', v)) * 6,
  ];
  const inf = Number.POSITIVE_INFINITY;
  const from = new Int8Array(n * 3);
  let c0 = head[0]!;
  let c1 = head[1]!;
  let c2 = head[2]!;
  for (let i = 0; i < n; i++) {
    const u = units[i]!;
    // Costs if the previous segment closes here (rounded up to whole bits).
    const r0 = Math.ceil(c0 / 6) * 6;
    const r1 = Math.ceil(c1 / 6) * 6;
    const r2 = Math.ceil(c2 / 6) * 6;
    const at = i * 3;
    let n0 = inf;
    let n1 = inf;
    if (isDigit(u)) {
      const h = head[0]!;
      let best = c0;
      let j = 0;
      if (r1 + h < best) {
        best = r1 + h;
        j = 1;
      }
      if (r2 + h < best) {
        best = r2 + h;
        j = 2;
      }
      n0 = best + 20;
      from[at] = j;
    }
    if (alnumValue(u, gs1) >= 0) {
      const h = head[1]!;
      let best = r0 + h;
      let j = 0;
      if (c1 < best) {
        best = c1;
        j = 1;
      }
      if (r2 + h < best) {
        best = r2 + h;
        j = 2;
      }
      n1 = best + (gs1 && u === PERCENT ? 66 : 33);
      from[at + 1] = j;
    }
    {
      const h = head[2]!;
      let best = r0 + h;
      let j = 0;
      if (r1 + h < best) {
        best = r1 + h;
        j = 1;
      }
      if (c2 < best) {
        best = c2;
        j = 2;
      }
      c2 = best + 48;
      from[at + 2] = j;
    }
    c0 = n0;
    c1 = n1;
  }
  const finals = [Math.ceil(c0 / 6), Math.ceil(c1 / 6), Math.ceil(c2 / 6)];
  let m = 0;
  for (let k = 1; k < 3; k++) if (finals[k]! < finals[m]!) m = k;
  const bits = finals[m]! + header;

  // Back-track one mode per unit, then merge equal neighbours.
  const modes = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    modes[i] = m;
    m = from[i * 3 + m]!;
  }
  const segments: QrSegment[] = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || modes[i] !== modes[start]) {
      segments.push({ mode: MODES[modes[start]!]!, units: units.slice(start, i) });
      start = i;
    }
  }
  return { segments, bits };
}

/** A big-endian bit writer over a fixed number of codewords; `over` records any overflow. */
class BitWriter {
  readonly bytes: Uint8Array;
  pos = 0;
  over = false;
  readonly #limit: number;
  constructor(codewords: number) {
    this.bytes = new Uint8Array(codewords);
    this.#limit = codewords * 8;
  }
  write(value: number, n: number): void {
    if (this.pos + n > this.#limit) {
      this.over = true;
      return;
    }
    for (let i = n - 1; i >= 0; i--) {
      if ((value >> i) & 1) this.bytes[this.pos >> 3]! |= 0x80 >> (this.pos & 7);
      this.pos++;
    }
  }
}

function writeSegment(w: BitWriter, s: QrSegment, gs1: boolean, version: number): boolean {
  const count = characterCount(s, gs1);
  const width = countBits(s.mode, version);
  if (count >= 1 << width) return false;
  w.write(MODE_INDICATOR[s.mode], 4);
  w.write(count, width);
  const u = s.units;
  switch (s.mode) {
    case 'numeric': {
      let i = 0;
      for (; i + 3 <= u.length; i += 3) w.write(digits(u, i, 3), 10);
      const rest = u.length - i;
      if (rest > 0) w.write(digits(u, i, rest), rest === 2 ? 7 : 4);
      return true;
    }
    case 'alphanumeric': {
      let pending = -1;
      const put = (value: number): void => {
        if (pending < 0) pending = value;
        else {
          w.write(pending * 45 + value, 11);
          pending = -1;
        }
      };
      for (const x of u) {
        const value = alnumValue(x, gs1);
        if (value < 0) throw new RangeError(`not alphanumeric: ${x}`);
        put(value);
        if (gs1 && x === PERCENT) put(ALNUM_PERCENT);
      }
      if (pending >= 0) w.write(pending, 6);
      return true;
    }
    case 'byte':
      for (const x of u) w.write(x === FNC1 ? GS : x, 8);
      return true;
    default: {
      const never: never = s.mode;
      throw new RangeError(`unknown mode ${String(never)}`);
    }
  }
}

/** The value of `n` digit units from `at`. */
function digits(u: readonly number[], at: number, n: number): number {
  let v = 0;
  for (let k = at; k < at + n; k++) {
    const d = u[k]!;
    if (!isDigit(d)) throw new RangeError(`not a digit: ${d}`);
    v = v * 10 + d - 0x30;
  }
  return v;
}

/**
 * The bit stream (decision Q4) of `segments` padded to the data capacity of `version`-`level`:
 * `0101` first in GS1 mode, the segments, a terminator of up to 4 zero bits, zero bits to the
 * codeword boundary, then 0xEC and 0x11 alternately. Undefined when it does not fit. Units must
 * suit their segment's mode (a RangeError otherwise).
 */
export function encodeSegments(
  segments: readonly QrSegment[],
  gs1: boolean,
  version: number,
  level: QrEcLevel,
): readonly number[] | undefined {
  const capacity = qrVersion(version).levels[level].dataCodewords;
  const w = new BitWriter(capacity);
  if (gs1) w.write(0b0101, 4);
  for (const s of segments) if (!writeSegment(w, s, gs1, version)) return undefined;
  if (w.over) return undefined;
  const bytes = Math.ceil(Math.min(w.pos + 4, capacity * 8) / 8);
  for (let i = bytes; i < capacity; i++) w.bytes[i] = (i - bytes) % 2 === 0 ? 0xec : 0x11;
  return Array.from(w.bytes);
}

function invalidVersion(): Gs1Error {
  return new Gs1Error({
    code: 'INVALID_VALUE',
    message: "Option version must be 'auto' or an integer from 1 to 40",
    details: { option: 'version' },
  });
}

/** DATA_TOO_LONG with the levers that help: `version` 'auto' and a lower `ecLevel`. */
function tooLong(
  limit: number,
  actual: number,
  level: QrEcLevel,
  version: number | undefined,
): Gs1Error {
  const e = dataTooLong(limit, actual);
  const lower = level === 'L' ? '' : ' or a lower ecLevel';
  const remedy =
    version === undefined || version === 40
      ? `Use${lower ? ' a lower ecLevel or' : ''} less data`
      : `Use version 'auto' (or a larger version)${lower}`;
  return new Gs1Error({
    code: e.code,
    message: `Data needs ${actual} bits; version ${version ?? 40}-${level} holds ${limit}. ${remedy}.`,
    details:
      version === undefined
        ? { ...e.details, unit: 'bits' }
        : { ...e.details, unit: 'bits', version },
  });
}

/**
 * The encoding at `version`, or for `'auto'` the smallest version over the three count-length
 * groups whose data capacity holds that group's minimal segmentation (decision Q5).
 * INVALID_VALUE `version` for any other version; NOT_REPRESENTABLE (`position`, `value`) for a
 * unit outside 0x00..0x7E (FNC1 allowed in GS1 mode); DATA_TOO_LONG (`limit`, `actual` in bits,
 * `unit: 'bits'`, plus `version` when explicit) when nothing fits.
 */
export function chooseVersion(
  units: readonly number[],
  gs1: boolean,
  level: QrEcLevel,
  version: 'auto' | number,
): Result<QrEncoding> {
  if (
    version !== 'auto' &&
    (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 40)
  ) {
    return fail([invalidVersion()]);
  }
  if (!EC_LEVELS.includes(level)) {
    return fail([
      new Gs1Error({
        code: 'INVALID_VALUE',
        message: "Option ecLevel must be 'L', 'M', 'Q' or 'H'",
        details: { option: 'ecLevel' },
      }),
    ]);
  }
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const valid =
      typeof u === 'number' &&
      ((Number.isInteger(u) && u >= 0 && u <= 0x7e) || (gs1 && u === FNC1));
    if (!valid) {
      const e = notRepresentable(gs1 ? 'gs1-qr' : 'qr', `value ${String(u)} at position ${i}`);
      return fail([
        new Gs1Error({
          code: e.code,
          message: e.message,
          details: { ...e.details, position: i, value: u },
        }),
      ]);
    }
  }
  const capacity = (v: number): number => qrVersion(v).levels[level].dataCodewords * 8;
  const encoded = (
    v: number,
    s: { readonly segments: readonly QrSegment[]; readonly bits: number },
  ): Result<QrEncoding> | undefined => {
    const codewords = encodeSegments(s.segments, gs1, v, level);
    return codewords && ok({ version: v, segments: s.segments, bits: s.bits, codewords });
  };

  if (version !== 'auto') {
    const s = segment(units, gs1, versionGroup(version));
    const r = s.bits <= capacity(version) ? encoded(version, s) : undefined;
    return r ?? fail([tooLong(capacity(version), s.bits, level, version)]);
  }
  let bits = 0;
  let first = 1;
  for (const group of [0, 1, 2] as const) {
    const s = segment(units, gs1, group);
    bits = s.bits;
    const last = GROUP_LAST[group] ?? 40;
    for (let v = first; v <= last; v++) {
      if (s.bits <= capacity(v)) {
        const r = encoded(v, s);
        if (r) return r;
      }
    }
    first = last + 1;
  }
  return fail([tooLong(capacity(40), bits, level, undefined)]);
}
