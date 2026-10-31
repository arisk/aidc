/**
 * The TDS 2.x "+" and "++" EPC binary schemes (TDS 2.3 sections 14.5 and 14.6, Table 14-1):
 * descriptors, and the engine that writes and reads the header, +AIDC toggle, filter, DSGTIN
 * prioritised date, body AIs (Table F), "++" hostname and the +AIDC trailer (15.3).
 * Research plus 1.1 to 1.3, 2.1 and 3.
 */
import type { AiValue } from '../ai/index.ts';
import { BitReader, BitWriter } from '../core/bits.ts';
import { Gs1Error } from '../core/errors.ts';
import { decodeAiValue, decodeMethod, encodeAiValue, encodeMethod } from './aidc.ts';
import { hex2 } from './charsets.ts';
import type { PlusSchemeName } from './descriptor.ts';
import { epcError, overflow } from './errors.ts';
import { decodeHostname, encodeHostname } from './hostname.ts';
import { aiKeyLength } from './table-k.ts';
import { TABLE_F, type TableFComponent } from './tables.gen.ts';

export interface PlusScheme {
  readonly name: PlusSchemeName;
  /** The 8-bit header (TDS Table 14-1; research plus 3 rows 1 and 2 for SSCC++ and ITIP++). */
  readonly header: number;
  /** The legacy family: 'sgtin' for sgtin+ and dsgtin+, 'sscc', ... */
  readonly family: PlusFamily;
  /** AIs of the body in encoding order (research plus 1.2). */
  readonly ais: readonly string[];
  /** DSGTIN: a prioritised date follows the filter (14.5.3). */
  readonly date: boolean;
  /** "++": a hostname follows the body (14.5.16). */
  readonly hostname: boolean;
}

/** The legacy schemes with plus forms: dsgtin+ and dsgtin++ are 'sgtin'. */
export type PlusFamily = Exclude<PlusBase, 'dsgtin'>;

type PlusBase =
  | 'sgtin'
  | 'dsgtin'
  | 'sscc'
  | 'sgln'
  | 'grai'
  | 'giai'
  | 'gsrn'
  | 'gsrnp'
  | 'gdti'
  | 'sgcn'
  | 'itip'
  | 'cpi';

type Row = readonly [
  base: PlusBase,
  plus: number,
  plusPlus: number,
  family: PlusFamily,
  ais: readonly string[],
];

const ROWS: readonly Row[] = [
  ['sgtin', 0xf7, 0xfd, 'sgtin', ['01', '21']],
  ['dsgtin', 0xfb, 0xfc, 'sgtin', ['01', '21']],
  ['sscc', 0xf9, 0xef, 'sscc', ['00']],
  ['sgln', 0xf2, 0xe9, 'sgln', ['414', '254']],
  ['grai', 0xf1, 0xeb, 'grai', ['8003']],
  ['giai', 0xfa, 0xee, 'giai', ['8004']],
  ['gsrn', 0xf4, 0xe7, 'gsrn', ['8018']],
  ['gsrnp', 0xf5, 0xe8, 'gsrnp', ['8017']],
  ['gdti', 0xf6, 0xea, 'gdti', ['253']],
  ['sgcn', 0xf8, 0xec, 'sgcn', ['255']],
  ['itip', 0xf3, 0xed, 'itip', ['8006', '21']],
  ['cpi', 0xf0, 0xe6, 'cpi', ['8010', '8011']],
];

function build(plusPlus: boolean): PlusScheme[] {
  return ROWS.map(([base, plus, pp, family, ais]) =>
    Object.freeze({
      name: plusPlus ? (`${base}++` as const) : (`${base}+` as const),
      header: plusPlus ? pp : plus,
      family,
      ais: Object.freeze([...ais]),
      date: base === 'dsgtin',
      hostname: plusPlus,
    }),
  );
}

/** The 24 "+" and "++" schemes: the 12 "+" schemes first, then the 12 "++" schemes. */
export const PLUS_SCHEMES: readonly PlusScheme[] = Object.freeze([...build(false), ...build(true)]);

const BY_NAME: ReadonlyMap<string, PlusScheme> = new Map(PLUS_SCHEMES.map((s) => [s.name, s]));
const BY_HEADER: ReadonlyMap<number, PlusScheme> = new Map(PLUS_SCHEMES.map((s) => [s.header, s]));

export function plusSchemeByName(name: string): PlusScheme | undefined {
  return BY_NAME.get(name);
}

export function plusSchemeByHeader(header: number): PlusScheme | undefined {
  return BY_HEADER.get(header);
}

// ---------------------------------------------------------------------------------------------
// DSGTIN prioritised date (14.5.3).

/** The date AIs a prioritised date can carry, in date type indicator order (14.5.3 table). */
export const PRIORITISED_DATE_AIS: readonly string[] = Object.freeze([
  '11',
  '13',
  '15',
  '16',
  '17',
  '7006',
  '7007',
]);

const DATE6: TableFComponent = Object.freeze({
  method: 'DATE6',
  fixedChars: 6,
  fixedBits: 16,
  indicatorBits: 0,
  lengthBits: 0,
  maxChars: 0,
});

/**
 * Whether an AI value can be the prioritised date. TDS 14.5.3: "The prioritised date format only
 * supports 6-digit date values (YYMMDD)", and its encoding input is "a 6-digit numeric string".
 * So a (7007) harvest date range (12 digits, 14.5.10) is not eligible: it goes to +AIDC.
 */
export function isPrioritisedDate(ai: string, value: string): boolean {
  return PRIORITISED_DATE_AIS.includes(ai) && value.length === 6;
}

// ---------------------------------------------------------------------------------------------
// Content.

export interface PlusContent {
  readonly filter: number;
  /** Body AIs, in body order (values as in an element string). */
  readonly body: readonly AiValue[];
  /** DSGTIN only. */
  readonly date?: AiValue;
  readonly hostname?: string;
  readonly aidc: readonly AiValue[];
}

export interface DecodedPlus extends PlusContent {
  readonly scheme: PlusScheme;
  /** Bits up to the end of the last +AIDC entry (or of the EPC), without zero fill. */
  readonly bitLength: number;
}

/** The Gen2 maximum EPC length (TDS 9.3 Table 9-3; plan decision F11). */
const MAX_BITS = 496;

/** SGLN without (254) encodes extension "0" (plan decision F7). */
const SGLN_EXTENSION = '254';

function encodeBody(
  scheme: PlusScheme,
  body: readonly AiValue[],
  w: BitWriter,
): Gs1Error | undefined {
  if (body.length > scheme.ais.length)
    return epcError('component', `${scheme.name} takes the AIs ${aiList(scheme.ais)}`);
  for (const [i, ai] of scheme.ais.entries()) {
    const entry = body[i] ?? (ai === SGLN_EXTENSION ? ([ai, '0'] as const) : undefined);
    if (entry?.[0] !== ai)
      return epcError('component', `${scheme.name} takes the AIs ${aiList(scheme.ais)}`, {
        ai,
        details: { ai },
      });
    const e = encodeAiValue(ai, entry[1], w);
    if (e !== undefined) return e;
  }
  return undefined;
}

const aiList = (ais: readonly string[]): string => ais.map((a) => `(${a})`).join('');

function encodeDate(date: AiValue, w: BitWriter): Gs1Error | undefined {
  const [ai, value] = date;
  const indicator = PRIORITISED_DATE_AIS.indexOf(ai);
  if (indicator < 0)
    return epcError(
      'component',
      `(${ai}) cannot be a prioritised date; use one of ${aiList(PRIORITISED_DATE_AIS)} (TDS 14.5.3)`,
      { ai, details: { ai } },
    );
  // TDS 14.5.3: 6-digit dates only, so a 12-digit (7007) range cannot be the prioritised date.
  if (!isPrioritisedDate(ai, value))
    return epcError(
      'component',
      `(${ai}) must be a 6-digit YYMMDD date to be the prioritised date (TDS 14.5.3)`,
      {
        ai,
        details: { ai },
      },
    );
  w.write(indicator, 4);
  return encodeMethod(DATE6, value, w, ai);
}

function encodeAidc(
  aidc: readonly AiValue[],
  taken: readonly string[],
  w: BitWriter,
): Gs1Error | undefined {
  for (const [ai, value] of aidc) {
    if (taken.includes(ai))
      return epcError(
        'aidc',
        `(${ai}) is already carried by the EPC; it cannot repeat in +AIDC data`,
        {
          ai,
          details: { ai },
        },
      );
    // An AI without a Table F row: encodeAiValue gives the error (not-encodable).
    if (!TABLE_F.has(ai)) return encodeAiValue(ai, value, new BitWriter());
    for (let i = 0; i < ai.length; i++) w.write(ai.charCodeAt(i) - 48, 4);
    const e = encodeAiValue(ai, value, w);
    if (e !== undefined) return e;
  }
  return undefined;
}

/**
 * The bits (unpadded) of a "+" or "++" EPC (research plus 1.1). Errors: INVALID_EPC `filter`,
 * `component` (body or date), `no-date`, `hostname`, `aidc` (an +AIDC AI the EPC already carries),
 * and the Table F errors of the values; EPC_FIELD_OVERFLOW `too-long` over 496 bits.
 */
export function encodePlus(scheme: PlusScheme, c: PlusContent): string | Gs1Error {
  if (!Number.isInteger(c.filter) || c.filter < 0 || c.filter > 7)
    return epcError('filter', 'The filter must be an integer from 0 to 7', {
      details: { filter: c.filter },
    });
  if (scheme.date && c.date === undefined)
    return epcError('no-date', `${scheme.name} needs a prioritised date AI (TDS 14.5.3)`);
  if (!scheme.date && c.date !== undefined)
    return epcError('component', `${scheme.name} has no prioritised date`);
  if (scheme.hostname && c.hostname === undefined)
    return epcError('hostname', `${scheme.name} needs a hostname (TDS 14.5.16)`);
  if (!scheme.hostname && c.hostname !== undefined)
    return epcError('hostname', `${scheme.name} carries no hostname`);

  const w = new BitWriter();
  w.write(scheme.header, 8);
  w.write(c.aidc.length > 0 ? 1 : 0, 1);
  w.write(c.filter, 3);
  if (c.date !== undefined) {
    const e = encodeDate(c.date, w);
    if (e !== undefined) return e;
  }
  const body = encodeBody(scheme, c.body, w);
  if (body !== undefined) return body;
  if (c.hostname !== undefined) {
    const e = encodeHostname(c.hostname, w);
    if (e !== undefined) return e;
  }
  const taken = c.date === undefined ? scheme.ais : [...scheme.ais, c.date[0]];
  const aidc = encodeAidc(c.aidc, taken, w);
  if (aidc !== undefined) return aidc;
  if (w.length > MAX_BITS)
    return overflow(
      'epc',
      'too-long',
      `The EPC needs ${w.length} bits; the most is ${MAX_BITS} (TDS 9.3 Table 9-3)`,
    );
  return w.toString();
}

// ---------------------------------------------------------------------------------------------
// Decode.

const binary = (message: string, bit: number, ai?: string): Gs1Error =>
  epcError('binary', message, {
    ...(ai === undefined ? {} : { ai }),
    details: { ...(ai === undefined ? {} : { ai }), bit },
  });

/** Thrown inside decodePlus to return an error from a nested step. */
class Stop {
  readonly error: Gs1Error;
  constructor(error: Gs1Error) {
    this.error = error;
  }
}
const check = <T>(v: T | Gs1Error): T => {
  if (v instanceof Gs1Error) throw new Stop(v);
  return v;
};

function readDate(r: BitReader): AiValue {
  const at = r.position;
  const indicator = r.read(4);
  const ai = PRIORITISED_DATE_AIS[indicator];
  if (ai === undefined)
    throw new Stop(
      binary(
        `Date type indicator ${indicator.toString(2).padStart(4, '0')} is reserved (TDS 14.5.3)`,
        at,
      ),
    );
  return [ai, check(decodeMethod(DATE6, r, ai))];
}

function readBody(scheme: PlusScheme, r: BitReader): AiValue[] {
  const body: AiValue[] = [];
  for (const ai of scheme.ais) {
    const value = check(decodeAiValue(ai, r));
    // SGLN without (254): extension "0" is dropped (plan decision F7).
    if (!(ai === SGLN_EXTENSION && value === '0')) body.push([ai, value]);
  }
  return body;
}

/** Reads the 4-bit digits of an +AIDC AI key after its first two (Table K). */
function readKey(first: string, at: number, r: BitReader): string {
  const len = aiKeyLength(first);
  if (len === undefined) throw new Stop(binary(`No GS1 AI starts with ${first} (TDS Table K)`, at));
  let ai = first;
  while (ai.length < len) {
    const d = r.read(4);
    if (d > 9) throw new Stop(binary(`+AIDC AI key nibble ${d.toString(2)} is not a digit`, at));
    ai += String(d);
  }
  return ai;
}

/**
 * The +AIDC loop (TDS 15.3; research plus 2.1; plan decision F10). Returns the entries and the
 * bit where the zero fill starts.
 */
function readAidc(
  bits: string,
  r: BitReader,
  taken: readonly string[],
): { aidc: AiValue[]; end: number } {
  const start = r.position;
  const aidc: AiValue[] = [];
  let end = -1;
  while (r.remaining >= 8) {
    // Only zeros left: zero fill, whatever its length (E4), not AI (00) data.
    if (bits.indexOf('1', r.position) < 0) break;
    const at = r.position;
    const hi = r.read(4);
    const lo = r.read(4);
    if (hi > 9 || lo > 9)
      throw new Stop(
        binary(
          `+AIDC header ${hi.toString(2).padStart(4, '0')}${lo.toString(2).padStart(4, '0')} is reserved (TDS 15.3)`,
          at,
        ),
      );
    // 00000000 with fewer than 72 bits after it is zero fill, not AI (00).
    if (hi === 0 && lo === 0 && r.remaining < 72) {
      end = at;
      break;
    }
    const ai = readKey(`${hi}${lo}`, at, r);
    if (!TABLE_F.has(ai)) throw new Stop(binary(`(${ai}) has no TDS Table F row`, at, ai));
    if (taken.includes(ai))
      throw new Stop(
        epcError('aidc', `(${ai}) is already carried by the EPC; it cannot repeat in +AIDC data`, {
          ai,
          details: { ai, bit: at },
        }),
      );
    aidc.push([ai, check(decodeAiValue(ai, r))]);
  }
  if (end < 0) end = r.position;
  const one = bits.indexOf('1', end);
  if (one >= 0) throw new Stop(binary('The bits after the +AIDC data must be zero', one));
  if (aidc.length === 0)
    throw new Stop(binary('The +AIDC toggle is 1 but no +AIDC data follows (TDS 14.5.1)', start));
  return { aidc, end };
}

/**
 * Decodes a "+" or "++" EPC from its bits (with any trailing zero fill). Only decodes: check
 * digits and AI rules are left to element string validation (plan decision F12). Errors:
 * EPC_UNKNOWN_HEADER for a header that is not a plus scheme; INVALID_EPC `binary` (with
 * `details.bit`) for bad or missing bits, and `aidc` for an +AIDC AI the EPC already carries.
 */
export function decodePlus(bits: string): DecodedPlus | Gs1Error {
  if (bits.length < 8) return binary('The EPC binary ends inside the header', bits.length);
  const header = Number.parseInt(bits.slice(0, 8), 2);
  const scheme = plusSchemeByHeader(header);
  if (scheme === undefined)
    return new Gs1Error({
      code: 'EPC_UNKNOWN_HEADER',
      message: `EPC header ${hex2(header)} is not a "+" or "++" scheme`,
      details: { header, bit: 0 },
    });
  const r = new BitReader(bits);
  r.read(8);
  try {
    const toggle = r.read(1);
    const filter = r.read(3);
    const date = scheme.date ? readDate(r) : undefined;
    const body = readBody(scheme, r);
    const hostname = scheme.hostname ? check(decodeHostname(r)) : undefined;
    let aidc: AiValue[] = [];
    let bitLength = r.position;
    if (toggle === 1) {
      const taken = date === undefined ? scheme.ais : [...scheme.ais, date[0]];
      ({ aidc, end: bitLength } = readAidc(bits, r, taken));
    } else {
      const one = bits.indexOf('1', bitLength);
      if (one >= 0) return binary('The bits after the EPC must be zero', one);
    }
    return {
      scheme,
      filter,
      body,
      ...(date === undefined ? {} : { date }),
      ...(hostname === undefined ? {} : { hostname }),
      aidc,
      bitLength,
    };
  } catch (e) {
    if (e instanceof Stop) return e.error;
    if (e instanceof RangeError) return binary('The EPC binary ends inside a field', r.position);
    throw e;
  }
}
