/**
 * The "++" Digital Link hostname (TDS 2.3 section 14.5.16): a 1-bit encoding indicator, a 6-bit
 * length L, then either URN Code 40 (indicator 0, L characters) or 7-bit units with the
 * optimisation Tables A and B1 to B4 (indicator 1, L units; a 14-bit B code counts 2).
 */
import type { BitReader, BitWriter } from '../core/bits.ts';
import type { Gs1Error } from '../core/errors.ts';
import { epcError } from './errors.ts';
import { HOSTNAME_TABLE_A, HOSTNAME_TABLE_B } from './tables.gen.ts';
import { isUrn40, readUrn40, urn40Bits, writeUrn40 } from './urn40.ts';

const MAX_LENGTH = 63;

/**
 * Hostname characters: letters, digits, '-', '.' and '_'. TDS allows any CSET 82 character, but
 * '/', '?', '#', '@', '%', quotes, '<' and the like would change a URL built from the hostname,
 * or break HTML it is shown in (security review). Decoding also allows ':' for a port.
 */
const HOST_CHAR: Uint8Array = /* @__PURE__ */ (() => {
  const t = new Uint8Array(128);
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._';
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = 1;
  return t;
})();
const COLON = 58;

/** Index of the first character not allowed in a hostname, or -1. */
function firstBadChar(host: string, port: boolean): number {
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    if (!(c < 128 && HOST_CHAR[c] === 1) && !(port && c === COLON)) return i;
  }
  return -1;
}

/**
 * Checks a "++" hostname to encode: 1 to 63 letters, digits, '-', '.' and '_'.
 * The error is INVALID_EPC (`hostname`) with `details.at`, the index of the offending character.
 */
export function checkHostname(host: string): Gs1Error | undefined {
  if (host.length === 0)
    return epcError('hostname', 'The hostname is empty', { details: { at: 0 } });
  if (host.length > MAX_LENGTH)
    return epcError('hostname', `The hostname is over ${MAX_LENGTH} characters`, {
      details: { at: MAX_LENGTH },
    });
  const at = firstBadChar(host, false);
  return at < 0
    ? undefined
    : epcError('hostname', `Hostname character ${JSON.stringify(host.charAt(at))} is not allowed`, {
        details: { at },
      });
}

// ---------------------------------------------------------------------------------------------
// Optimisation tables.

interface Entry {
  readonly text: string;
  /** The 7-bit or 14-bit code as a "0"/"1" string. */
  readonly code: string;
}

/** The Table B entries whose 14-bit code starts with `prefix`. */
const tableB = (prefix: string): Entry[] =>
  [...HOSTNAME_TABLE_B]
    .filter(([code]) => code.startsWith(prefix))
    .map(([code, text]) => ({ text, code }));

/** Every table entry in the reference order B4, B3, A, B1, B2. */
const ENTRIES: readonly Entry[] = /* @__PURE__ */ (() => [
  ...tableB('0000011'),
  ...tableB('0000010'),
  ...[...HOSTNAME_TABLE_A].map(([code, text]) => ({ text, code })),
  ...tableB('0000000'),
  ...tableB('0000001'),
])();

/**
 * The reference greedy optimiser (research plus 1.4; gs1-tdt a655cc3 TDT_2_3_demo/TDTtranslator.js
 * `internalHostname2Binary`): the entries it may use for `host`. The single-character ASCII rows
 * of TDT Table A, which the reference also collects, are left out: they sort last and emit the
 * same bits as the ASCII fallback, so they cannot change the output.
 */
function pickEntries(host: string): Entry[] {
  // Sort is stable, so equal keys keep the B4, B3, A, B1, B2 order.
  // oxlint-disable-next-line no-array-sort -- sorting a fresh array; toSorted is not in ES2022
  const found = ENTRIES.filter((e) => host.includes(e.text)).sort(
    (x, y) => y.text.length - x.text.length || x.code.length - y.code.length,
  );
  // As the reference does: remove only the first occurrence, joining the text around it.
  const kept: Entry[] = [];
  let rest = host;
  for (const e of found) {
    const at = rest.indexOf(e.text);
    if (at < 0) continue;
    kept.push(e);
    rest = rest.slice(0, at) + rest.slice(at + e.text.length);
  }
  return kept;
}

/** The 7-bit units of `host` as code strings. */
function sevenBitUnits(host: string): string[] {
  const kept = pickEntries(host);
  const units: string[] = [];
  let i = 0;
  while (i < host.length) {
    const e = kept.find((k) => host.startsWith(k.text, i));
    if (e === undefined) {
      units.push(host.charCodeAt(i).toString(2).padStart(7, '0'));
      i++;
    } else {
      units.push(e.code);
      i += e.text.length;
    }
  }
  return units;
}

/**
 * Encodes a hostname, choosing as the TDT reference does (F3): URN Code 40 when every character
 * allows it and it is not longer than the optimised 7-bit form, else 7-bit.
 */
export function encodeHostname(host: string, w: BitWriter): Gs1Error | undefined {
  const bad = checkHostname(host);
  if (bad !== undefined) return bad;
  const units = sevenBitUnits(host);
  let sevenBits = 0;
  for (const u of units) sevenBits += u.length;
  if (isUrn40(host) && urn40Bits(host.length) <= sevenBits) {
    w.write(0, 1);
    w.write(host.length, 6);
    writeUrn40(host, w);
  } else {
    w.write(1, 1);
    w.write(sevenBits / 7, 6);
    for (const u of units) w.write(Number.parseInt(u, 2), u.length);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Decode (14.5.16.2).

class DecodeFail {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}
const fail = (message: string): never => {
  throw new DecodeFail(message);
};

/** Reserved 7-bit codes: 0000100 to 0011101, 0100100 ('$') and 1000000 ('@'). */
const isReserved = (code: number): boolean =>
  (code >= 4 && code <= 29) || code === 36 || code === 64;

function readSevenBit(r: BitReader, L: number): string {
  let out = '';
  let n = 0;
  while (n < L) {
    const code = r.read(7);
    const bits = code.toString(2).padStart(7, '0');
    if (code < 4) {
      if (n + 2 > L) fail(`A 14-bit code starts at unit ${n + 1} of ${L}`);
      const full = bits + r.read(7).toString(2).padStart(7, '0');
      const text = HOSTNAME_TABLE_B.get(full);
      if (text === undefined) fail(`14-bit hostname code ${full} is not assigned`);
      out += text;
      n += 2;
    } else {
      if (isReserved(code)) fail(`7-bit hostname code ${bits} is reserved`);
      out += HOSTNAME_TABLE_A.get(bits) ?? String.fromCharCode(code);
      n++;
    }
  }
  return out;
}

/**
 * Decodes a hostname, reading exactly L characters or units (research plus 3, row 13).
 * A reserved or unassigned code, a bad URN Code 40 group, or a result that is not 1 to 63
 * hostname characters (letters, digits, '-', '.', '_' and ':'; TDS 14.5.16 allows all of
 * CSET 82) is INVALID_EPC (`binary`, `details.bit`). Throws RangeError when the bits run out.
 */
export function decodeHostname(r: BitReader): string | Gs1Error {
  const bit = r.position;
  try {
    const ind = r.read(1);
    const L = r.read(6);
    const host = ind === 0 ? readUrn40(r, L, fail) : readSevenBit(r, L);
    if (host.length === 0) fail('The hostname is empty');
    if (host.length > MAX_LENGTH) fail(`The hostname is over ${MAX_LENGTH} characters`);
    const at = firstBadChar(host, true);
    if (at >= 0) fail(`Character ${JSON.stringify(host.charAt(at))} is not allowed in a hostname`);
    return host;
  } catch (e) {
    if (!(e instanceof DecodeFail)) throw e;
    return epcError('binary', `Hostname: ${e.message}`, { details: { bit } });
  }
}
