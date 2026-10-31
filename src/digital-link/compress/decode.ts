import { BASE64URL, base64urlIndex, base64urlToBits } from '../../core/base64url.ts';
import { BitReader } from '../../core/bits.ts';
import type { AiValue } from '../../ai/index.ts';
import { type FComponent, OPT_BY_CODE, TABLE_F, TABLE_P, lengthBits, valueBits } from './tables.ts';

export type CompressedCause =
  | 'base64url'
  | 'truncated'
  | 'table-p'
  | 'ai-digit'
  | 'table-f'
  | 'reserved-code'
  | 'version'
  | 'encoding'
  | 'length'
  | 'overflow'
  | 'padding'
  | 'non-gs1-key';

export interface DecompressFailure {
  readonly cause: CompressedCause;
  /** Bit offset of the field that failed. */
  readonly at: number;
}

export interface Decompressed {
  readonly ais: AiValue[];
  /** Non-GS1 key/value pairs (flowchart C13), decoded. */
  readonly other: (readonly [string, string])[];
  /** True when an Ex handover code ended decoding (C15); the rest is proprietary. */
  readonly handover: boolean;
}

const LOWER_HEX = '0123456789abcdef';
const UPPER_HEX = '0123456789ABCDEF';

function readNumber(r: BitReader, len: number, at: number): string | DecompressFailure {
  const n = r.readBig(valueBits(len));
  if (len === 0) return n === 0n ? '' : { cause: 'overflow', at };
  const digits = n.toString();
  return digits.length > len ? { cause: 'overflow', at } : digits.padStart(len, '0');
}

/** An alphanumeric component (D11/D12). `fixed` is its length when `lengthWidth` is 0. */
function readAlnum(
  r: BitReader,
  lengthWidth: number,
  fixed: number,
  max: number,
): string | DecompressFailure {
  const at = r.position;
  const e = r.read(3);
  const len = lengthWidth > 0 ? r.read(lengthWidth) : fixed;
  if (len > max) return { cause: 'length', at };
  if (e === 0) return readNumber(r, len, at);
  if (e > 4) return { cause: 'encoding', at };
  let s = '';
  for (let i = 0; i < len; i++) {
    if (e === 1) s += LOWER_HEX.charAt(r.read(4));
    else if (e === 2) s += UPPER_HEX.charAt(r.read(4));
    else if (e === 3) s += BASE64URL.charAt(r.read(6));
    else s += String.fromCharCode(r.read(7));
  }
  return s;
}

function readValue(r: BitReader, comps: readonly FComponent[]): string | DecompressFailure {
  let v = '';
  for (const c of comps) {
    const at = r.position;
    let part: string | DecompressFailure;
    if (c.enc === 'N') {
      const len = c.variable ? r.read(lengthBits(c.length)) : c.length;
      part = len > c.length ? { cause: 'length', at } : readNumber(r, len, at);
    } else {
      part = readAlnum(r, c.variable ? lengthBits(c.length) : 0, c.length, c.length);
    }
    if (typeof part !== 'string') return part;
    v += part;
  }
  return v;
}

function firstNonBase64url(s: string): number {
  for (let i = 0; i < s.length; i++) if (base64urlIndex(s.charCodeAt(i)) < 0) return i;
  return s.length === 0 ? 0 : -1;
}

/**
 * Decodes a compressed path segment (flowcharts D5-D13). Unlike the GS1 prototype it pads
 * numbers with their leading zeros, checks lengths against Table F, rejects reserved codes
 * and encodings, and rejects non-zero padding bits.
 */
export function decompressSegment(segment: string): Decompressed | DecompressFailure {
  const bad = firstNonBase64url(segment);
  if (bad >= 0) return { cause: 'base64url', at: bad * 6 };
  const r = new BitReader(base64urlToBits(segment));
  const ais: AiValue[] = [];
  const other: (readonly [string, string])[] = [];
  let handover = false;
  try {
    while (r.remaining >= 8) {
      const at = r.position;
      const h1 = r.read(4);
      const h2 = r.read(4);
      if (h1 <= 9 && h2 <= 9) {
        let ai = `${h1}${h2}`;
        const n = TABLE_P.get(ai);
        if (n === undefined) return { cause: 'table-p', at };
        for (let i = 2; i < n; i++) {
          const d = r.read(4);
          if (d > 9) return { cause: 'ai-digit', at };
          ai += String(d);
        }
        const comps = TABLE_F.get(ai);
        if (!comps) return { cause: 'table-f', at };
        const v = readValue(r, comps);
        if (typeof v !== 'string') return v;
        ais.push([ai, v]);
      } else if (h1 === 0xd) {
        if (h2 !== 0) return { cause: 'version', at };
      } else if (h1 === 0xe) {
        handover = true;
        break;
      } else if (h1 === 0xf) {
        const len = (h2 << 3) | r.read(3);
        if (len === 0) return { cause: 'non-gs1-key', at };
        let key = '';
        for (let i = 0; i < len; i++) key += BASE64URL.charAt(r.read(6));
        const v = readAlnum(r, 7, 0, 127);
        if (typeof v !== 'string') return v;
        other.push([key, v]);
      } else {
        const seq = OPT_BY_CODE.get((h1 << 4) | h2);
        if (!seq) return { cause: 'reserved-code', at };
        for (const ai of seq) {
          const v = readValue(r, TABLE_F.get(ai) ?? []);
          if (typeof v !== 'string') return v;
          ais.push([ai, v]);
        }
      }
    }
  } catch (e) {
    if (e instanceof RangeError) return { cause: 'truncated', at: r.position };
    throw e;
  }
  if (!handover && r.rest().includes('1')) return { cause: 'padding', at: r.position };
  return { ais, other, handover };
}
