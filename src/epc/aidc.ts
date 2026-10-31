/**
 * The TDS Table F value codec: one AI value per its Table F row, with the encoding methods of
 * TDS 2.3 section 14.5. Used by the "+" and "++" scheme bodies and by the +AIDC trailer (15.3).
 * The AI header (Table K) is not written or read here.
 */
import { BASE64URL, base64urlIndex } from '../core/base64url.ts';
import type { BitReader, BitWriter } from '../core/bits.ts';
import { CSET82 } from '../core/cset.ts';
import type { Gs1Error } from '../core/errors.ts';
import { epcError, overflow } from './errors.ts';
import { TABLE_F, type TableFComponent } from './tables.gen.ts';
import { isUrn40, readUrn40, urn40Bits, writeUrn40 } from './urn40.ts';

// ---------------------------------------------------------------------------------------------
// Integer bit counts (TDS Table B column b): ceil(L * log2 10) = bitLength(10^L - 1) for L >= 1.

const POW10: bigint[] = [1n];
function pow10(n: number): bigint {
  for (let i = POW10.length; i <= n; i++) POW10.push((POW10[i - 1] ?? 1n) * 10n);
  return POW10[n] ?? 1n;
}

const INT_BITS: number[] = [0];
/** Bits of an L-digit unsigned integer: ceil(L * log2 10), exact (TDS Table B column b). */
export function integerBits(digits: number): number {
  for (let i = INT_BITS.length; i <= digits; i++) INT_BITS.push((pow10(i) - 1n).toString(2).length);
  return INT_BITS[digits] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Character sets.

const HEX_UPPER = '0123456789ABCDEF';
const HEX_LOWER = '0123456789abcdef';

function indexTable(chars: string): Int8Array {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = i;
  return t;
}
const UPPER_INDEX: Int8Array = /* @__PURE__ */ indexTable(HEX_UPPER);
const LOWER_INDEX: Int8Array = /* @__PURE__ */ indexTable(HEX_LOWER);
/** Table 14-9: the ASCII codes of CSET 82 plus '#'. */
const ASCII7_INDEX: Int8Array = /* @__PURE__ */ indexTable(`${CSET82}#`);

const lookup = (t: Int8Array, c: number): number => (c < 128 ? (t[c] ?? -1) : -1);
const isDigit = (c: number): boolean => c >= 48 && c <= 57;

function allIn(s: string, test: (c: number) => boolean): boolean {
  for (let i = 0; i < s.length; i++) if (!test(s.charCodeAt(i))) return false;
  return true;
}
const allDigits = (s: string): boolean => allIn(s, isDigit);

// ---------------------------------------------------------------------------------------------
// Failures. Inner helpers throw these; encodeMethod and decodeMethod turn them into Gs1Errors.
// RangeError from the BitReader (bits ran out) passes through to the caller.

class EncodeFail {
  readonly kind: 'component' | 'too-long';
  readonly message: string;
  constructor(kind: 'component' | 'too-long', message: string) {
    this.kind = kind;
    this.message = message;
  }
}
class DecodeFail {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

const decodeFail = (message: string): never => {
  throw new DecodeFail(message);
};
const badPart = (message: string): EncodeFail => new EncodeFail('component', message);

function put(w: BitWriter, value: number | bigint, width: number): void {
  if (width > 0) w.write(value, width);
}

/** Reads two decimal digits at `at`; the caller has checked that `s` is all digits. */
const two = (s: string, at: number): number =>
  (s.charCodeAt(at) - 48) * 10 + (s.charCodeAt(at + 1) - 48);
const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

// ---------------------------------------------------------------------------------------------
// 14.5.6 Variable-length alphanumeric.

const IND_NUMERIC = 0;
const IND_UPPER = 1;
const IND_LOWER = 2;
const IND_BASE64 = 3;
const IND_ASCII7 = 4;
const IND_URN40 = 5;

/** Data bits for each indicator 000 to 101, or -1 where `s` has a character it cannot hold. */
function alnBits(s: string): number[] {
  const L = s.length;
  return [
    allDigits(s) ? integerBits(L) : -1,
    allIn(s, (c) => lookup(UPPER_INDEX, c) >= 0) ? 4 * L : -1,
    allIn(s, (c) => lookup(LOWER_INDEX, c) >= 0) ? 4 * L : -1,
    allIn(s, (c) => base64urlIndex(c) >= 0) ? 6 * L : -1,
    allIn(s, (c) => lookup(ASCII7_INDEX, c) >= 0) ? 7 * L : -1,
    isUrn40(s) ? urn40Bits(L) : -1,
  ];
}

/** F3: the indicator with the fewest data bits; on a tie, the lowest indicator. */
function chooseIndicator(s: string): number {
  const bits = alnBits(s);
  let best = -1;
  for (let i = 0; i < bits.length; i++) {
    const b = bits[i] ?? -1;
    if (b >= 0 && (best < 0 || b < (bits[best] ?? 0))) best = i;
  }
  return best;
}

function encodeAln(c: TableFComponent, s: string, w: BitWriter): void {
  if (s.length > c.maxChars)
    throw new EncodeFail('too-long', `holds at most ${c.maxChars} characters`);
  if (c.maxChars === 1 && s.length !== 1) throw badPart('must be one character');
  const ind = chooseIndicator(s);
  if (ind < 0) throw badPart('has a character no alphanumeric encoding can hold');
  put(w, ind, c.indicatorBits);
  if (c.maxChars !== 1) put(w, s.length, c.lengthBits);
  const L = s.length;
  switch (ind) {
    case IND_NUMERIC:
      put(w, L === 0 ? 0n : BigInt(s), integerBits(L));
      return;
    case IND_UPPER:
    case IND_LOWER: {
      const t = ind === IND_UPPER ? UPPER_INDEX : LOWER_INDEX;
      for (let i = 0; i < L; i++) w.write(lookup(t, s.charCodeAt(i)), 4);
      return;
    }
    case IND_BASE64:
      for (let i = 0; i < L; i++) w.write(base64urlIndex(s.charCodeAt(i)), 6);
      return;
    case IND_ASCII7:
      for (let i = 0; i < L; i++) w.write(s.charCodeAt(i), 7);
      return;
    default:
      writeUrn40(s, w);
  }
}

/** Decodes an ALN field whose length may be at most `max` (the remainder limit for DTN). */
function decodeAln(c: TableFComponent, r: BitReader, max: number): string {
  const ind = r.read(c.indicatorBits);
  const L = c.maxChars === 1 ? 1 : r.read(c.lengthBits);
  if (L > max) throw new DecodeFail(`Length ${L} is over the maximum of ${max}`);
  let out = '';
  switch (ind) {
    case IND_NUMERIC: {
      const v = r.readBig(integerBits(L));
      if (v >= pow10(L)) throw new DecodeFail(`Integer ${v} has more than ${L} digits`);
      return L === 0 ? '' : v.toString().padStart(L, '0');
    }
    case IND_UPPER:
    case IND_LOWER: {
      const alphabet = ind === IND_UPPER ? HEX_UPPER : HEX_LOWER;
      for (let i = 0; i < L; i++) out += alphabet.charAt(r.read(4));
      return out;
    }
    case IND_BASE64:
      for (let i = 0; i < L; i++) out += BASE64URL.charAt(r.read(6));
      return out;
    case IND_ASCII7:
      for (let i = 0; i < L; i++) {
        const code = r.read(7);
        if (lookup(ASCII7_INDEX, code) < 0)
          throw new DecodeFail(`7-bit code ${code} is not in Table 14-9`);
        out += String.fromCharCode(code);
      }
      return out;
    case IND_URN40:
      return readUrn40(r, L, decodeFail);
    default:
      throw new DecodeFail(`Encoding indicator ${ind.toString(2).padStart(3, '0')} is reserved`);
  }
}

// ---------------------------------------------------------------------------------------------
// Dates (14.5.8 to 14.5.11).

function checkDate(s: string, at: number): void {
  const mm = two(s, at + 2);
  const dd = two(s, at + 4);
  if (mm < 1 || mm > 12 || dd > 31) throw badPart('is not a YYMMDD date');
}
function checkTime(s: string, at: number, parts: number): void {
  if (two(s, at) > 24) throw badPart('has an hour over 24');
  for (let p = 1; p < parts; p++)
    if (two(s, at + 2 * p) > 59) throw badPart('has a minute or second over 59');
}

function writeDate(s: string, at: number, w: BitWriter): void {
  w.write(two(s, at), 7);
  w.write(two(s, at + 2), 4);
  w.write(two(s, at + 4), 5);
}
/** Writes hh, then mm and ss as `parts` asks (1 to 3), from `at`. */
function writeTime(s: string, at: number, parts: number, w: BitWriter): void {
  w.write(two(s, at), 5);
  for (let p = 1; p < parts; p++) w.write(two(s, at + 2 * p), 6);
}

function readDate(r: BitReader): string {
  const yy = r.read(7);
  const mm = r.read(4);
  const dd = r.read(5);
  if (yy > 99) throw new DecodeFail(`Year ${yy} is over 99`);
  if (mm < 1 || mm > 12) throw new DecodeFail(`Month ${mm} is not 1 to 12`);
  return pad2(yy) + pad2(mm) + pad2(dd);
}
function readTime(r: BitReader, parts: number): string {
  const hh = r.read(5);
  if (hh > 24) throw new DecodeFail(`Hour ${hh} is over 24`);
  let out = pad2(hh);
  for (let p = 1; p < parts; p++) {
    const v = r.read(6);
    if (v > 59) throw new DecodeFail(`Minute or second ${v} is over 59`);
    out += pad2(v);
  }
  return out;
}

/** 14.5.11 format code by value length: 00 YYMMDDhh, 01 +mm, 10 +ss, 11 YYMMDD. */
const DATETIME_FORMAT: Readonly<Record<number, number>> = { 8: 0, 10: 1, 12: 2, 6: 3 };

// ---------------------------------------------------------------------------------------------
// Methods.

function encodeComponent(c: TableFComponent, s: string, w: BitWriter): void {
  switch (c.method) {
    case 'FLN':
      if (s.length !== c.fixedChars || !allDigits(s))
        throw badPart(`must be ${c.fixedChars} digits`);
      for (let i = 0; i < s.length; i++) w.write(s.charCodeAt(i) - 48, 4);
      return;
    case 'FBL':
      if (s.length !== c.fixedChars || !allDigits(s))
        throw badPart(`must be ${c.fixedChars} digits`);
      w.write(BigInt(s), c.fixedBits);
      return;
    case 'ALN':
      encodeAln(c, s, w);
      return;
    case 'DTN': {
      if (s.length > c.maxChars)
        throw new EncodeFail('too-long', `holds at most ${c.maxChars} characters`);
      let k = 0;
      while (k < s.length && isDigit(s.charCodeAt(k))) k++;
      for (let i = 0; i < k; i++) w.write(s.charCodeAt(i) - 48, 4);
      if (k === s.length) {
        w.write(0b1111, 4);
        return;
      }
      w.write(0b1110, 4);
      encodeAln(c, s.slice(k), w);
      return;
    }
    case 'VN':
      if (s.length > c.maxChars)
        throw new EncodeFail('too-long', `holds at most ${c.maxChars} digits`);
      if (!allDigits(s)) throw badPart('must be digits');
      put(w, s.length, c.lengthBits);
      put(w, s.length === 0 ? 0n : BigInt(s), integerBits(s.length));
      return;
    case 'DATE6':
      if (s.length !== 6 || !allDigits(s)) throw badPart('must be YYMMDD');
      checkDate(s, 0);
      writeDate(s, 0, w);
      return;
    case 'DATE10':
      if (s.length !== 10 || !allDigits(s)) throw badPart('must be YYMMDDhhmm');
      checkDate(s, 0);
      checkTime(s, 6, 2);
      writeDate(s, 0, w);
      writeTime(s, 6, 2, w);
      return;
    case 'DATERANGE':
      if ((s.length !== 6 && s.length !== 12) || !allDigits(s))
        throw badPart('must be YYMMDD or YYMMDDYYMMDD');
      checkDate(s, 0);
      if (s.length === 12) checkDate(s, 6);
      w.write(s.length === 12 ? 1 : 0, 1);
      writeDate(s, 0, w);
      if (s.length === 12) writeDate(s, 6, w);
      return;
    case 'DATETIME': {
      const format = DATETIME_FORMAT[s.length];
      if (format === undefined || !allDigits(s)) throw badPart('must be YYMMDD[hh[mm[ss]]]');
      const parts = (s.length - 6) / 2;
      checkDate(s, 0);
      if (parts > 0) checkTime(s, 6, parts);
      w.write(format, 2);
      writeDate(s, 0, w);
      if (parts > 0) writeTime(s, 6, parts, w);
      return;
    }
    case 'COUNTRY':
      if (s.length !== 2 || !allIn(s, (x) => x >= 65 && x <= 90))
        throw badPart('must be two letters A to Z');
      w.write(s.charCodeAt(0) - 65, 6);
      w.write(s.charCodeAt(1) - 65, 6);
      return;
    case 'BIT':
      if (s !== '0' && s !== '1') throw badPart("must be '0' or '1'");
      w.write(s === '1' ? 1 : 0, 1);
      return;
    case 'MINUS':
      if (s !== '' && s !== '-') throw badPart("must be '' or '-'");
      w.write(s === '-' ? 1 : 0, 1);
      return;
    case 'SEQ': {
      const n = s.charCodeAt(0) - 48;
      const m = s.charCodeAt(2) - 48;
      if (s.length !== 3 || s.charCodeAt(1) !== 47 || !(n >= 1 && n <= 9) || !(m >= 1 && m <= 9))
        throw badPart('must be n/m with n and m 1 to 9');
      w.write(n, 4);
      w.write(m, 4);
      return;
    }
    default: {
      const never: never = c.method;
      throw new Error(`Unknown Table F method ${String(never)}`);
    }
  }
}

function decodeComponent(c: TableFComponent, r: BitReader): string {
  switch (c.method) {
    case 'FLN': {
      let out = '';
      for (let i = 0; i < c.fixedChars; i++) {
        const n = r.read(4);
        if (n > 9) throw new DecodeFail(`Nibble ${n.toString(2)} is not a digit`);
        out += String(n);
      }
      return out;
    }
    case 'FBL': {
      const v = r.readBig(c.fixedBits);
      if (v >= pow10(c.fixedChars))
        throw new DecodeFail(`${v} has more than ${c.fixedChars} digits`);
      return v.toString().padStart(c.fixedChars, '0');
    }
    case 'ALN':
      return decodeAln(c, r, c.maxChars);
    case 'DTN': {
      let out = '';
      for (;;) {
        const n = r.read(4);
        if (n === 0b1111) return out;
        if (n === 0b1110) return out + decodeAln(c, r, c.maxChars - out.length);
        if (n > 9) throw new DecodeFail(`Nibble ${n.toString(2)} is not a digit or terminator`);
        if (out.length === c.maxChars) throw new DecodeFail(`More than ${c.maxChars} characters`);
        out += String(n);
      }
    }
    case 'VN': {
      const L = r.read(c.lengthBits);
      if (L > c.maxChars) throw new DecodeFail(`Length ${L} is over the maximum of ${c.maxChars}`);
      const v = r.readBig(integerBits(L));
      if (v >= pow10(L)) throw new DecodeFail(`Integer ${v} has more than ${L} digits`);
      return L === 0 ? '' : v.toString().padStart(L, '0');
    }
    case 'DATE6':
      return readDate(r);
    case 'DATE10':
      return readDate(r) + readTime(r, 2);
    case 'DATERANGE':
      return r.read(1) === 1 ? readDate(r) + readDate(r) : readDate(r);
    case 'DATETIME': {
      const format = r.read(2);
      const date = readDate(r);
      return format === 3 ? date : date + readTime(r, format + 1);
    }
    case 'COUNTRY': {
      let out = '';
      for (let i = 0; i < 2; i++) {
        const n = r.read(6);
        if (n > 25) throw new DecodeFail(`Country letter code ${n} is over 25`);
        out += String.fromCharCode(65 + n);
      }
      return out;
    }
    case 'BIT':
      return r.read(1) === 1 ? '1' : '0';
    case 'MINUS':
      return r.read(1) === 1 ? '-' : '';
    case 'SEQ': {
      const n = r.read(4);
      const m = r.read(4);
      if (n < 1 || n > 9 || m < 1 || m > 9)
        throw new DecodeFail(`Sequence ${n}/${m} is not 1 to 9`);
      return `${n}/${m}`;
    }
    default: {
      const never: never = c.method;
      throw new Error(`Unknown Table F method ${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Public (internal API) entry points.

const aiPlace = (ai: string | undefined): { ai?: string; details?: { ai: string } } =>
  ai === undefined ? {} : { ai, details: { ai } };

/**
 * Encodes one Table F component. On failure returns the error; the writer may then hold a
 * partial field and is to be discarded.
 */
export function encodeMethod(
  component: TableFComponent,
  part: string,
  w: BitWriter,
  ai?: string,
): Gs1Error | undefined {
  try {
    encodeComponent(component, part, w);
    return undefined;
  } catch (e) {
    if (!(e instanceof EncodeFail)) throw e;
    const label = ai === undefined ? component.method : `(${ai})`;
    return e.kind === 'too-long'
      ? overflow(
          ai ?? component.method,
          'too-long',
          `${label} ${e.message} in an EPC (TDS Table F)`,
        )
      : epcError(
          'component',
          `${label} ${e.message} for ${component.method} encoding`,
          aiPlace(ai),
        );
  }
}

/** Decodes one Table F component; throws RangeError when the bits run out. */
export function decodeMethod(
  component: TableFComponent,
  r: BitReader,
  ai?: string,
): string | Gs1Error {
  const bit = r.position;
  try {
    return decodeComponent(component, r);
  } catch (e) {
    if (!(e instanceof DecodeFail)) throw e;
    return epcError(
      'binary',
      `${ai === undefined ? '' : `(${ai}) `}${component.method}: ${e.message}`,
      {
        ...(ai === undefined ? {} : { ai }),
        details: { ...(ai === undefined ? {} : { ai }), bit },
      },
    );
  }
}

/**
 * Encodes an AI value per its Table F row, without the AI header. Returns an error for an AI
 * without a Table F row, a value over a Table F maximum, or characters no method can hold; the
 * writer is then to be discarded.
 */
export function encodeAiValue(ai: string, value: string, w: BitWriter): Gs1Error | undefined {
  const comps = TABLE_F.get(ai);
  if (comps === undefined)
    return overflow(
      ai,
      'not-encodable',
      `(${ai}) has no TDS Table F row, so an EPC cannot carry it`,
    );
  let at = 0;
  for (const [i, c] of comps.entries()) {
    const last = i === comps.length - 1;
    if (!last && value.length - at < c.fixedChars)
      return epcError('component', `(${ai}) is too short for its Table F components`, aiPlace(ai));
    const end = last ? value.length : at + c.fixedChars;
    const e = encodeMethod(c, value.slice(at, end), w, ai);
    if (e !== undefined) return e;
    at = end;
  }
  return undefined;
}

/** Decodes an AI value per its Table F row; throws RangeError when the bits run out. */
export function decodeAiValue(ai: string, r: BitReader): string | Gs1Error {
  const comps = TABLE_F.get(ai);
  if (comps === undefined)
    return epcError('binary', `(${ai}) has no TDS Table F row`, {
      ai,
      details: { ai, bit: r.position },
    });
  let out = '';
  for (const c of comps) {
    const v = decodeMethod(c, r, ai);
    if (typeof v !== 'string') return v;
    out += v;
  }
  return out;
}
