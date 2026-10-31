import { Gs1Error, fail, ok, unwrap } from '../../core/index.ts';
import type { Result } from '../../core/index.ts';
import { format } from '../../ai/index.ts';
import type { AiValue, ElementString } from '../../ai/index.ts';
import { freezeDecoded, freezeMatrix } from '../render/internal.ts';
import type {
  DecodedSymbol,
  ModuleMatrix,
  Orientation,
  Symbology,
  SymbologyName,
} from '../render/index.ts';
import { EC_LEVELS } from './qr-tables.ts';
import type { QrEcLevel } from './qr-tables.ts';
import { chooseVersion } from './qr-encode.ts';
import { buildSymbol } from './qr-place.ts';
import { decodeBits, readQr } from './qr-decode.ts';
import type { QrRead, QrSegmentInfo, QrText } from './qr-decode.ts';
import { dlEncodeInput, dlFromText, readDigitalLinkOptions } from './dl-carrier.ts';
import type { DigitalLinkOptions } from './dl-carrier.ts';
import {
  decodeFailure,
  encodeFailure,
  encodedOrder,
  gs1ElementString,
  gs1FromData,
  hriLines,
  invalidOption,
  optionReader,
  readBoolean,
  readHriSize,
} from './common.ts';

export type { QrEcLevel } from './qr-tables.ts';

export interface QrOptions {
  /** Error correction level, used exactly, never raised (default 'M'). */
  readonly ecLevel?: QrEcLevel;
  /** 'auto' (default): the smallest version that fits; or one version 1..40. */
  readonly version?: 'auto' | number;
  /** 'auto' (default): the lowest BWIPP-compatible penalty; or one ISO mask 0..7. */
  readonly mask?: 'auto' | number;
  /** Fixed-length AIs first, saving separators, as gs1128 (GS1 mode; default false). */
  readonly optimizeOrder?: boolean;
  /** One human readable line per element string below the symbol (default false). */
  readonly hri?: boolean;
  /** HRI font size in modules (default 3). */
  readonly hriSize?: number;
}

export interface QrDlOptions extends QrOptions {
  /** How to build the URI from an element string, as `toScan(es, 'qr', { digitalLink })`. */
  readonly digitalLink?: DigitalLinkOptions;
}

export interface QrMetadata {
  readonly version: number;
  readonly ecLevel: QrEcLevel;
  /** Mask pattern reference, ISO 0..7. */
  readonly mask: number;
  /** Data codewords after correction, padding included. */
  readonly codewords: readonly number[];
  /** Bits before the terminator, the FNC1 indicator included. */
  readonly dataBits: number;
  /** EC codewords of the symbol, all blocks. */
  readonly ecCodewords: number;
  readonly blocks: number;
  /** Data segments in order, with their character counts. */
  readonly segments: readonly {
    readonly mode: 'numeric' | 'alphanumeric' | 'byte' | 'kanji';
    readonly count: number;
  }[];
  readonly orientation: Orientation;
  /** Whether the symbol had reversed reflectance (light modules on dark). */
  readonly inverted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Options

interface Settings {
  readonly ecLevel: QrEcLevel;
  readonly version: 'auto' | number;
  readonly mask: 'auto' | number;
  readonly optimizeOrder: boolean;
  readonly hri: boolean;
  readonly hriSize: number;
  /** The raw `digitalLink` option (read only for the Digital Link carrier). */
  readonly digitalLink: unknown;
}

const isEcLevel = (v: unknown): v is QrEcLevel =>
  typeof v === 'string' && (EC_LEVELS as readonly string[]).includes(v);

const isIntIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/**
 * Validates the options, collecting one INVALID_VALUE (`details.option`) per bad option. The
 * version is checked here, before any table lookup, so no RangeError can escape.
 */
function readOptions(options: unknown, carrier: boolean): Result<Settings> {
  const reader = optionReader(options);
  if (!reader.ok) return fail(reader.errors);
  const r = reader.value;
  let ecLevel: QrEcLevel = 'M';
  const e = r.get('ecLevel');
  if (e && e.value !== undefined) {
    if (isEcLevel(e.value)) ecLevel = e.value;
    else r.errors.push(invalidOption('ecLevel', "Option ecLevel must be 'L', 'M', 'Q' or 'H'"));
  }
  let version: 'auto' | number = 'auto';
  const v = r.get('version');
  if (v && v.value !== undefined) {
    if (v.value === 'auto' || isIntIn(v.value, 1, 40)) version = v.value;
    else
      r.errors.push(
        invalidOption('version', "Option version must be 'auto' or an integer from 1 to 40"),
      );
  }
  let mask: 'auto' | number = 'auto';
  const m = r.get('mask');
  if (m && m.value !== undefined) {
    if (m.value === 'auto' || isIntIn(m.value, 0, 7)) mask = m.value;
    else
      r.errors.push(invalidOption('mask', "Option mask must be 'auto' or an integer from 0 to 7"));
  }
  const optimizeOrder = readBoolean(r, 'optimizeOrder');
  const hri = readBoolean(r, 'hri');
  const hriSize = readHriSize(r);
  const dl = carrier ? r.get('digitalLink') : undefined;
  if (r.errors.length > 0) return fail(r.errors);
  return ok({ ecLevel, version, mask, optimizeOrder, hri, hriSize, digitalLink: dl?.value });
}

// ---------------------------------------------------------------------------------------------
// Encoding

/** The exported object names, for input errors that point to the other object. */
const NAMES = { gs1: 'gs1Qr', dl: 'qr' } as const;

/** The FNC1 unit of the QR encoder. */
const FNC1 = -1;
const GS = 0x1d;

/** Units to segments, version choice and the symbol (decisions Q3 to Q7, Q14). */
function symbolOf(
  units: readonly number[],
  s: Settings,
  name: SymbologyName,
  hri: readonly AiValue[],
): Result<ModuleMatrix> {
  const enc = chooseVersion(units, name === 'gs1-qr', s.ecLevel, s.version);
  if (!enc.ok) return fail(enc.errors);
  const built = buildSymbol(enc.value.version, s.ecLevel, enc.value.codewords, s.mask);
  return ok(
    freezeMatrix({
      kind: 'matrix',
      symbology: name,
      width: built.width,
      height: built.height,
      rows: built.rows,
      quietZone: built.quietZone,
      hri: s.hri ? hriLines(hri, built.height, s.hriSize) : [],
    }),
  );
}

function encodeGs1(data: unknown, options: unknown): Result<ModuleMatrix> {
  try {
    const opts = readOptions(options, false);
    if (!opts.ok) return fail(opts.errors);
    const s = opts.value;
    const es = gs1ElementString(data, NAMES);
    if (!es.ok) return fail(es.errors);
    const raw = format(es.value, 'raw', { optimizeOrder: s.optimizeOrder });
    const units: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      units.push(c === GS ? FNC1 : c);
    }
    return symbolOf(units, s, 'gs1-qr', encodedOrder(es.value, s.optimizeOrder));
  } catch {
    return fail([encodeFailure()]);
  }
}

function encodeDl(data: unknown, options: unknown): Result<ModuleMatrix> {
  try {
    const opts = readOptions(options, true);
    if (!opts.ok) return fail(opts.errors);
    const s = opts.value;
    const dl = readDigitalLinkOptions(s.digitalLink);
    if (!dl.ok) return fail(dl.errors);
    const input = dlEncodeInput(data, dl.value, NAMES);
    if (!input.ok) return fail(input.errors);
    const { uri, elementString } = input.value;
    const units: number[] = [];
    for (let i = 0; i < uri.length; i++) units.push(uri.charCodeAt(i));
    return symbolOf(units, s, 'qr', elementString.entries());
  } catch {
    return fail([encodeFailure()]);
  }
}

// ---------------------------------------------------------------------------------------------
// Decoding

function metadataOf(read: QrRead, t: QrText): QrMetadata {
  return {
    version: read.version,
    ecLevel: read.level,
    mask: read.mask,
    codewords: read.codewords.slice(),
    dataBits: t.dataBits,
    ecCodewords: read.ecCodewords,
    blocks: read.blocks,
    segments: t.segments.map((g: QrSegmentInfo) => ({ mode: g.mode, count: g.count })),
    orientation: read.orientation,
    inverted: read.inverted,
  };
}

const SPECIAL_MESSAGES = {
  eci: 'an ECI designator',
  'structured-append': 'structured append',
  'fnc1-second': 'FNC1 in second position',
  kanji: 'Kanji mode',
} as const;

/** UNSUPPORTED for ECI, structured append, FNC1 second and Kanji (decisions Q11, Q13). */
function specialError(t: QrText): Gs1Error | undefined {
  const sp = t.special;
  if (sp === undefined) return undefined;
  const base = { reason: sp.reason, aimId: t.aimId, rawData: t.data };
  let details: Record<string, unknown>;
  switch (sp.reason) {
    case 'eci':
      details = { ...base, eci: sp.eci };
      break;
    case 'structured-append':
      details = { ...base, position: sp.position, total: sp.total, parity: sp.parity };
      break;
    case 'fnc1-second':
      details = { ...base, applicationIndicator: sp.applicationIndicator };
      break;
    case 'kanji':
      details = base;
      break;
    default: {
      const unreachable: never = sp;
      return unreachable;
    }
  }
  return new Gs1Error({
    code: 'UNSUPPORTED',
    message: `QR Code with ${SPECIAL_MESSAGES[sp.reason]} is not supported`,
    details,
  });
}

function notGs1(t: QrText, message: string): Gs1Error {
  return new Gs1Error({
    code: 'UNSUPPORTED',
    message,
    details: { reason: 'not-gs1', aimId: t.aimId, text: t.data, rawData: t.data },
  });
}

/** Reads and decodes a symbol: the codewords and their transmitted data. */
function readText(symbol: unknown): Result<{ read: QrRead; text: QrText }> {
  const read = readQr(symbol);
  if (!read.ok) return fail(read.errors);
  const text = decodeBits(read.value.codewords, read.value.version);
  if (!text.ok) return fail(text.errors);
  const special = specialError(text.value);
  if (special) return fail([special]);
  return ok({ read: read.value, text: text.value });
}

/** A `]Q3` result (decision Q2 data rules); positions of data errors index `rawData`. */
function gs1Result(read: QrRead, t: QrText): Result<DecodedSymbol<QrMetadata>> {
  const es = gs1FromData(t.data);
  if (!es.ok) return fail(es.errors);
  return ok(
    freezeDecoded({
      symbology: 'gs1-qr',
      aimId: ']Q3',
      elementString: es.value,
      rawData: t.data,
      errorsCorrected: read.errorsCorrected,
      metadata: metadataOf(read, t),
    }),
  );
}

function decodeGs1(symbol: unknown): Result<DecodedSymbol<QrMetadata>> {
  try {
    const r = readText(symbol);
    if (!r.ok) return fail(r.errors);
    const { read, text } = r.value;
    if (text.aimId !== ']Q3')
      return fail([notGs1(text, 'QR Code without FNC1 in first position is not GS1 QR Code')]);
    return gs1Result(read, text);
  } catch {
    /* v8 ignore next */
    return fail([decodeFailure()]);
  }
}

function decodeDl(symbol: unknown): Result<DecodedSymbol<QrMetadata>> {
  try {
    const r = readText(symbol);
    if (!r.ok) return fail(r.errors);
    const { read, text } = r.value;
    if (text.aimId === ']Q3') return gs1Result(read, text);
    const dl = text.aimId === ']Q1' ? dlFromText(text.data) : undefined;
    if (!dl) return fail([notGs1(text, 'The QR Code text is not a GS1 Digital Link URI')]);
    return ok(
      freezeDecoded({
        symbology: 'qr',
        aimId: ']Q1',
        elementString: dl.elementString,
        rawData: dl.uri,
        digitalLink: dl.uri,
        errorsCorrected: read.errorsCorrected,
        metadata: metadataOf(read, text),
      }),
    );
  } catch {
    /* v8 ignore next */
    return fail([decodeFailure()]);
  }
}

// ---------------------------------------------------------------------------------------------
// Public objects

function gs1TryEncode(data: ElementString | string, options?: QrOptions): Result<ModuleMatrix> {
  return encodeGs1(data, options);
}

function gs1TryDecode(symbol: ModuleMatrix): Result<DecodedSymbol<QrMetadata>> {
  return decodeGs1(symbol);
}

/**
 * GS1 QR Code: encodes an element string with FNC1 first (`]Q3`) using the exact
 * minimal segmentation, the smallest version at the `ecLevel` and the BWIPP-compatible mask;
 * decodes only `]Q3` symbols. A bundle that uses only this object contains no Digital Link or EPC
 * code.
 */
export const gs1Qr: Symbology<QrOptions, QrMetadata, ModuleMatrix> = /* @__PURE__ */ Object.freeze({
  name: 'gs1-qr',
  encode: (data: ElementString | string, options?: QrOptions): ModuleMatrix =>
    unwrap(gs1TryEncode(data, options)),
  tryEncode: gs1TryEncode,
  decode: (symbol: ModuleMatrix): DecodedSymbol<QrMetadata> => unwrap(gs1TryDecode(symbol)),
  tryDecode: gs1TryDecode,
} as const);

function dlTryEncode(data: ElementString | string, options?: QrDlOptions): Result<ModuleMatrix> {
  return encodeDl(data, options);
}

function dlTryDecode(symbol: ModuleMatrix): Result<DecodedSymbol<QrMetadata>> {
  return decodeDl(symbol);
}

/**
 * QR Code as a GS1 Digital Link carrier: encodes a URI (verbatim) or an
 * element string (built into a URI as `toScan(es, 'qr', { digitalLink })`) without FNC1
 * (`]Q1`); decodes `]Q1` symbols holding a GS1 Digital Link URI and `]Q3` symbols (reported as
 * 'gs1-qr').
 */
export const qr: Symbology<QrDlOptions, QrMetadata, ModuleMatrix> = /* @__PURE__ */ Object.freeze({
  name: 'qr',
  encode: (data: ElementString | string, options?: QrDlOptions): ModuleMatrix =>
    unwrap(dlTryEncode(data, options)),
  tryEncode: dlTryEncode,
  decode: (symbol: ModuleMatrix): DecodedSymbol<QrMetadata> => unwrap(dlTryDecode(symbol)),
  tryDecode: dlTryDecode,
} as const);
