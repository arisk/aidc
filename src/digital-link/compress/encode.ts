import { base64urlIndex, bitsToBase64url } from '../../core/base64url.ts';
import { BitWriter } from '../../core/bits.ts';
import type { AiValue } from '../../ai/index.ts';
import { type FComponent, TABLE_F, TABLE_OPT, lengthBits, valueBits } from './tables.ts';

export type CompressFailure = {
  readonly ai: string;
  readonly why: 'not-in-table' | 'length' | 'not-numeric';
};

/** Encoding indicator for a value (C10): the first matching test wins; "" is 7-bit ASCII. */
function encodingOf(v: string): number {
  if (v.length === 0) return 4;
  let digits = true;
  let lowerHex = true;
  let upperHex = true;
  let b64 = true;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    const digit = c >= 48 && c <= 57;
    if (!digit) digits = false;
    if (!digit && !(c >= 97 && c <= 102)) lowerHex = false;
    if (!digit && !(c >= 65 && c <= 70)) upperHex = false;
    if (base64urlIndex(c) < 0) b64 = false;
  }
  return digits ? 0 : lowerHex ? 1 : upperHex ? 2 : b64 ? 3 : 4;
}

/** An alphanumeric component (C8/C9): 3-bit indicator, optional length, value bits. */
export function writeAlnum(w: BitWriter, v: string, lengthWidth: number): void {
  const e = encodingOf(v);
  w.write(e, 3);
  if (lengthWidth > 0) w.write(v.length, lengthWidth);
  if (e === 0) {
    w.write(BigInt(v), valueBits(v.length));
    return;
  }
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (e === 1 || e === 2) w.write(Number.parseInt(v.charAt(i), 16), 4);
    else if (e === 3) w.write(base64urlIndex(c), 6);
    else w.write(c, 7); // values are ASCII after validation; write() rejects anything wider
  }
}

function isDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function writeValue(
  w: BitWriter,
  ai: string,
  v: string,
  comps: readonly FComponent[],
): CompressFailure | undefined {
  let at = 0;
  for (const c of comps) {
    const part = c.variable ? v.slice(at) : v.slice(at, at + c.length);
    if (c.variable ? part.length > c.length : part.length !== c.length)
      return { ai, why: 'length' };
    at += part.length;
    if (c.enc === 'N') {
      if (!isDigits(part)) return { ai, why: 'not-numeric' };
      if (c.variable) w.write(part.length, lengthBits(c.length));
      w.write(part === '' ? 0n : BigInt(part), valueBits(part.length));
    } else writeAlnum(w, part, c.variable ? lengthBits(c.length) : 0);
  }
  return at === v.length ? undefined : { ai, why: 'length' };
}

/**
 * The compressed bit string of AI data (flowcharts C3-C12): Table Opt sequences first, chosen
 * greedily as the GS1 prototype does (most AI digits, ties by table order), then the other
 * AIs sorted lexically, each as 4-bit digits and its value. Repeated AIs (identical values,
 * as ElementString guarantees) are written once.
 */
export function compressBits(entries: readonly AiValue[]): string | CompressFailure {
  const values = new Map<string, string>();
  for (const [ai, v] of entries) if (!values.has(ai)) values.set(ai, v);
  for (const ai of values.keys()) if (!TABLE_F.has(ai)) return { ai, why: 'not-in-table' };
  const remaining = new Set(values.keys());
  const w = new BitWriter();
  for (;;) {
    let best: readonly [number, readonly string[]] | undefined;
    let bestLen = 0;
    for (const opt of TABLE_OPT) {
      if (!opt[1].every((a) => remaining.has(a))) continue;
      const len = opt[1].join('').length;
      if (len > bestLen) {
        best = opt;
        bestLen = len;
      }
    }
    if (!best) break;
    w.write(best[0], 8);
    for (const ai of best[1]) {
      const f = writeValue(w, ai, values.get(ai) ?? '', TABLE_F.get(ai) ?? []);
      if (f) return f;
      remaining.delete(ai);
    }
  }
  // oxlint-disable-next-line unicorn/no-array-sort -- toSorted is not in the ES2022 lib; the copy is local
  for (const ai of [...remaining].sort()) {
    for (let i = 0; i < ai.length; i++) w.write(ai.charCodeAt(i) - 48, 4);
    const f = writeValue(w, ai, values.get(ai) ?? '', TABLE_F.get(ai) ?? []);
    if (f) return f;
  }
  return w.toString();
}

/** The compressed path segment: the bit string as base64url (C16). */
export function compressSegment(entries: readonly AiValue[]): string | CompressFailure {
  const bits = compressBits(entries);
  return typeof bits === 'string' ? bitsToBase64url(bits) : bits;
}
