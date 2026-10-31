import { BitReader, BitWriter } from '../core/bits.ts';
import { Gs1Error } from '../core/errors.ts';
import { componentCount, decodeField, encodeField } from './codecs.ts';
import type { BinaryScheme } from './descriptor.ts';
import { epcError } from './errors.ts';
import { hex2 } from './charsets.ts';
import { type DecodedPlus, decodePlus } from './plus.ts';
import { isPlusHeader, schemeByHeader } from './schemes.ts';

export interface DecodedBinary {
  readonly scheme: BinaryScheme;
  readonly filter: number | undefined;
  readonly components: readonly string[];
  readonly bitLength: number;
}

/** The EPC bit string (unpadded) of `components` (URI form) in `scheme`. */
export function encodeBinary(
  scheme: BinaryScheme,
  filter: number | undefined,
  components: readonly string[],
): string | Gs1Error {
  const w = new BitWriter();
  w.write(scheme.header, 8);
  let i = 0;
  for (const def of scheme.fields) {
    if (def.spec.kind === 'filter') {
      const f = filter ?? 0;
      if (!Number.isInteger(f) || f < 0 || f >= 2 ** def.spec.bits) {
        return epcError(
          'filter',
          `The filter must be an integer from 0 to ${2 ** def.spec.bits - 1}`,
          { details: { filter: f } },
        );
      }
      w.write(f, def.spec.bits);
      continue;
    }
    const n = componentCount(def.spec);
    const e = encodeField(def, components.slice(i, i + n), w);
    if (e) return e;
    i += n;
  }
  if (i !== components.length)
    return epcError('component', `${scheme.name} takes ${i} components, not ${components.length}`);
  return w.toString();
}

function truncated(bit: number): Gs1Error {
  return epcError('binary', 'The EPC binary ends inside a field', { details: { bit } });
}

/** Whether a decoded binary is a "+" or "++" EPC. */
export const isDecodedPlus = (d: DecodedBinary | DecodedPlus): d is DecodedPlus => 'aidc' in d;

/**
 * Decodes an EPC bit string (with any trailing zero padding, plan decision E4). A "+" or "++"
 * header goes to the plus engine (TDS 14.5, 14.6), which leaves AI rules to element string
 * validation (plan decision F12).
 */
export function decodeBinary(bits: string): DecodedBinary | DecodedPlus | Gs1Error {
  if (bits.length < 8) return truncated(bits.length);
  const header = Number.parseInt(bits.slice(0, 8), 2);
  if (isPlusHeader(header)) return decodePlus(bits);
  const scheme = schemeByHeader(header);
  if (!scheme) {
    return new Gs1Error({
      code: 'EPC_UNKNOWN_HEADER',
      message: `Unknown EPC header ${hex2(header)}`,
      details: { header, bit: 0 },
    });
  }
  if (scheme.bits !== undefined && bits.length < scheme.bits) return truncated(bits.length);
  const r = new BitReader(scheme.bits === undefined ? bits : bits.slice(0, scheme.bits));
  r.read(8);
  let filter: number | undefined;
  const components: string[] = [];
  try {
    for (const def of scheme.fields) {
      const c = decodeField(def, r);
      if (c instanceof Gs1Error) return c;
      if (def.spec.kind === 'filter') filter = Number(c[0]);
      else components.push(...c);
    }
  } catch (e) {
    if (e instanceof RangeError) return truncated(r.position);
    throw e;
  }
  const bitLength = scheme.bits ?? r.position;
  const pad = bits.indexOf('1', bitLength);
  if (pad >= 0)
    return epcError('binary', 'The bits after the EPC must be zero', { details: { bit: pad } });
  return { scheme, filter, components, bitLength };
}

const HEX = '0123456789ABCDEF';

/** Upper-case hex of `bits`, zero-padded to 16-bit words (plan decision E4). */
export function bitsToHex(bits: string): string {
  const padded = bits.padEnd(Math.ceil(bits.length / 16) * 16, '0');
  let out = '';
  for (let i = 0; i < padded.length; i += 4)
    out += HEX.charAt(Number.parseInt(padded.slice(i, i + 4), 2));
  return out;
}

function hexDigit(c: number): number {
  return c >= 48 && c <= 57
    ? c - 48
    : c >= 65 && c <= 70
      ? c - 55
      : c >= 97 && c <= 102
        ? c - 87
        : -1;
}

/** The index of the first character of `hex` that is not a hex digit, or -1. */
export function firstNonHex(hex: string): number {
  for (let i = 0; i < hex.length; i++) if (hexDigit(hex.charCodeAt(i)) < 0) return i;
  return -1;
}

/** The bits of a hex string (either case), or the index of the first invalid character. */
export function hexToBits(hex: string): string | number {
  let out = '';
  for (let i = 0; i < hex.length; i++) {
    const v = hexDigit(hex.charCodeAt(i));
    if (v < 0) return i;
    out += v.toString(2).padStart(4, '0');
  }
  return out;
}

/** Bytes of `bits`, zero-padded to 16-bit words. */
export function bitsToBytes(bits: string): Uint8Array {
  const padded = bits.padEnd(Math.ceil(bits.length / 16) * 16, '0');
  const out = new Uint8Array(padded.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return out;
}

export function bytesToBits(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(2).padStart(8, '0');
  return out;
}
