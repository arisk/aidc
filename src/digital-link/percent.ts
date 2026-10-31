import { UNRESERVED } from './syntax.ts';

const HEX = '0123456789ABCDEF';
const PERCENT = 0x25;
const PLUS = 0x2b;
const SPACE = 0x20;

/**
 * Percent-encodes a value for a Digital Link path or query (dl.c URIescape): unreserved
 * characters stay, everything else becomes %XX with uppercase hex; a space is "+" in the
 * query. GS1 values are ASCII, so a character above U+00FF is a programming error.
 */
export function percentEncode(s: string, query: boolean): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128 && UNRESERVED[c] === 1) out += s[i];
    else if (c === SPACE && query) out += '+';
    else if (c <= 0xff) out += `%${HEX.charAt(c >> 4)}${HEX.charAt(c & 15)}`;
    else throw new RangeError(`Cannot percent-encode U+${c.toString(16).toUpperCase()}`);
  }
  return out;
}

export type Decoded =
  | { readonly value: string; readonly shifts: number[] }
  | { readonly badPercentAt: number };

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

/**
 * Decodes %XX escapes (either hex case) and, in the query, "+" as a space (dl.c URIunescape).
 * Each %XX decodes to one byte as one character (no UTF-8). A "%" that does not start a
 * %XX escape is rejected (plan decision D2(b)). `shifts` holds two entries per escape, as
 * SourceElement.shifts expects.
 */
export function percentDecode(raw: string, query: boolean): Decoded {
  let value = '';
  const shifts: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === PERCENT) {
      const hi = hexValue(raw.charCodeAt(i + 1));
      const lo = hexValue(raw.charCodeAt(i + 2));
      if (hi < 0 || lo < 0) return { badPercentAt: i };
      shifts.push(value.length, value.length);
      value += String.fromCharCode(hi * 16 + lo);
      i += 2;
    } else if (c === PLUS && query) value += ' ';
    else value += raw[i];
  }
  return { value, shifts };
}
