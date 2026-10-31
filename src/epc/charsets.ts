import { CSET82 } from '../core/cset.ts';

/** Table A-1 characters that EPC URIs write as escapes (TDS Annex A, "URI Form" column). */
const A1_ESCAPES: Readonly<Record<string, string>> = {
  '"': '%22',
  '%': '%25',
  '&': '%26',
  '/': '%2F',
  '<': '%3C',
  '>': '%3E',
  '?': '%3F',
};
/** GS3A3 characters allowed literally besides letters and digits (TDS 5, OtherChar). */
const OTHER_CHARS = "!'()*+,-.:;=_";
const HEX = '0123456789ABCDEF';

export type Unescaped = { readonly value: string } | { readonly badAt: number };

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isUpper(c: number): boolean {
  return c >= 65 && c <= 90;
}
function isLower(c: number): boolean {
  return c >= 97 && c <= 122;
}
function hexValue(c: number): number {
  if (isDigit(c)) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}
/** The character of the %HH escape at `i`, or undefined if malformed. */
function escapeAt(s: string, i: number): string | undefined {
  const hi = hexValue(s.charCodeAt(i + 1));
  const lo = hexValue(s.charCodeAt(i + 2));
  return hi < 0 || lo < 0 ? undefined : String.fromCharCode(hi * 16 + lo);
}

/** A Table A-1 value in EPC URI form: escape exactly " % & / < > ? (plan decision E5). */
export function escapeGs3a3(raw: string): string {
  let out = '';
  for (const ch of raw) out += A1_ESCAPES[ch] ?? ch;
  return out;
}

/**
 * A GS3A3Component (TDS 5) to its value. Letters, digits and OtherChar may appear literally;
 * anything else must be a %HH escape (either hex case) of a Table A-1 character.
 */
export function unescapeGs3a3(s: string): Unescaped {
  if (s.length === 0) return { badAt: 0 };
  let value = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 37) {
      const ch = escapeAt(s, i);
      if (ch === undefined || !CSET82.includes(ch)) return { badAt: i };
      value += ch;
      i += 2;
    } else if (isDigit(c) || isUpper(c) || isLower(c) || OTHER_CHARS.includes(s.charAt(i))) {
      value += s.charAt(i);
    } else return { badAt: i };
  }
  return { value };
}

/** Table G-1 value of a character (ASCII & 0x3F). Callers check the character first. */
export function encode6(ch: string): number {
  return ch.charCodeAt(0) & 0x3f;
}

/** Table G-1 character of a 6-bit value; '' for 0 (terminator) and unassigned values. */
export function decode6(v: number): string {
  if (v >= 1 && v <= 26) return String.fromCharCode(0x40 + v);
  if (v === 0x23 || v === 0x2d || v === 0x2f || (v >= 0x30 && v <= 0x39))
    return String.fromCharCode(v);
  return '';
}

/** A 6-bit field value in URI form: '/' and '#' escaped (TDS 5, CPRefChar and ADIChar). */
export function escape6(raw: string): string {
  let out = '';
  for (const ch of raw) out += ch === '/' ? '%2F' : ch === '#' ? '%23' : ch;
  return out;
}

/**
 * A CPRef or ADI component to its value: digits, upper-case letters and '-' literally, '/'
 * as %2F, and '#' as %23 where `hash` allows it ('any' for CPRef, 'first' for the ADI
 * serial, 'none' for the ADI part number).
 */
export function unescape6(s: string, hash: 'any' | 'first' | 'none'): Unescaped {
  let value = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 37) {
      const ch = escapeAt(s, i);
      const hashOk = hash === 'any' || (hash === 'first' && i === 0);
      if (ch !== '/' && !(ch === '#' && hashOk)) return { badAt: i };
      value += ch;
      i += 2;
    } else if (isDigit(c) || isUpper(c) || c === 45) value += s.charAt(i);
    else return { badAt: i };
  }
  return { value };
}

/** A CAGE code or DoDAAC: 5 or 6 of 0-9 and A-Z without I and O (TDS 6.3.17). */
export function isCage(s: string): boolean {
  if (s.length !== 5 && s.length !== 6) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!(isDigit(c) || (isUpper(c) && c !== 73 && c !== 79))) return false;
  }
  return true;
}

/** Two upper-case hex digits of a byte. */
export function hex2(v: number): string {
  return HEX.charAt((v >> 4) & 15) + HEX.charAt(v & 15);
}
