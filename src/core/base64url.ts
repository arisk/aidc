import { CSET64 } from './cset.ts';

/** RFC 4648 section 5 base64url alphabet; the same characters as CSET 64. */
export const BASE64URL: string = CSET64;

function buildIndex(): Int8Array {
  const t = new Int8Array(128).fill(-1);
  for (let i = 0; i < BASE64URL.length; i++) t[BASE64URL.charCodeAt(i)] = i;
  return t;
}
const INDEX: Int8Array = /* @__PURE__ */ buildIndex();

/** The 6-bit value of character code `c`, or -1. */
export function base64urlIndex(c: number): number {
  return c < 128 ? (INDEX[c] ?? -1) : -1;
}

export function isBase64url(s: string): boolean {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) if (base64urlIndex(s.charCodeAt(i)) < 0) return false;
  return true;
}

/** Maps each 6 bits to a character, right-padding the last group with zeros; no "=". */
export function bitsToBase64url(bits: string): string {
  let out = '';
  for (let i = 0; i < bits.length; i += 6) {
    out += BASE64URL.charAt(Number.parseInt(bits.slice(i, i + 6).padEnd(6, '0'), 2));
  }
  return out;
}

/** The bits of a base64url string; callers check isBase64url first. */
export function base64urlToBits(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++)
    out += base64urlIndex(s.charCodeAt(i)).toString(2).padStart(6, '0');
  return out;
}
