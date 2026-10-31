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
import { checkSymbols, chooseSize, DM_FNC1, encodeCodewords } from './dm-encode.ts';
import type { DmSizeOption } from './dm-encode.ts';
import { decodeCodewords, readDataMatrix, specialError } from './dm-decode.ts';
import type { DmMode, DmRead, DmText } from './dm-decode.ts';
import { placeCodewords } from './dm-place.ts';
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
  renamed,
} from './common.ts';

export type { DmMode } from './dm-decode.ts';
export type { DmSizeOption } from './dm-encode.ts';

export interface DataMatrixOptions {
  /**
   * 'square' (default: the smallest square that fits), 'rectangular' (the 6 rectangular sizes),
   * 'auto' (smallest area of all 30, square on ties) or one exact ECC 200 size.
   */
  readonly size?: DmSizeOption;
  /** 'auto' (default): the minimal-codeword encodation; 'ascii': ASCII mode only. */
  readonly encodation?: 'auto' | 'ascii';
  /** Fixed-length AIs first, saving separators, as gs1128 (GS1 mode; default false). */
  readonly optimizeOrder?: boolean;
  /** One human readable line per element string below the symbol (default false). */
  readonly hri?: boolean;
  /** HRI font size in modules (default 3). */
  readonly hriSize?: number;
}

export interface DataMatrixDlOptions extends DataMatrixOptions {
  /** How to build the URI from an element string, as `toScan(es, 'datamatrix', { digitalLink })`. */
  readonly digitalLink?: DigitalLinkOptions;
}

export interface DataMatrixMetadata {
  readonly rows: number;
  readonly columns: number;
  readonly shape: 'square' | 'rectangular';
  /** Data codewords after correction, pads excluded. */
  readonly codewords: readonly number[];
  /** EC codewords of the symbol, all blocks. */
  readonly ecCodewords: number;
  readonly blocks: number;
  /** Encodation modes in order of use. */
  readonly encodation: readonly DmMode[];
  readonly orientation: Orientation;
  /** Whether the symbol had reversed reflectance (light modules on dark). */
  readonly inverted: boolean;
}

// ---------------------------------------------------------------------------------------------
// Options

interface Settings {
  readonly size: DmSizeOption;
  readonly encodation: 'auto' | 'ascii';
  readonly optimizeOrder: boolean;
  readonly hri: boolean;
  readonly hriSize: number;
  /** The raw `digitalLink` option (read only for the Digital Link carrier). */
  readonly digitalLink: unknown;
}

/**
 * A plain copy of the size option, read once; undefined when it is not one of the accepted forms
 * (an unknown explicit size is left to `chooseSize`).
 */
function readSize(v: unknown): DmSizeOption | undefined {
  if (v === undefined) return 'square';
  if (v === 'square' || v === 'rectangular' || v === 'auto') return v;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const rows: unknown = Reflect.get(v, 'rows');
  const columns: unknown = Reflect.get(v, 'columns');
  return typeof rows === 'number' && typeof columns === 'number' ? { rows, columns } : undefined;
}

/** Validates the options, collecting one INVALID_VALUE (`details.option`) per bad option. */
function readOptions(options: unknown, carrier: boolean): Result<Settings> {
  const reader = optionReader(options);
  if (!reader.ok) return fail(reader.errors);
  const r = reader.value;
  let size: DmSizeOption = 'square';
  const s = r.get('size');
  if (s) {
    let read: DmSizeOption | undefined;
    try {
      read = readSize(s.value);
    } catch {
      read = undefined;
    }
    if (read === undefined)
      r.errors.push(
        invalidOption(
          'size',
          "Option size must be 'square', 'rectangular', 'auto' or { rows, columns }",
        ),
      );
    else size = read;
  }
  let encodation: 'auto' | 'ascii' = 'auto';
  const e = r.get('encodation');
  if (e && e.value !== undefined) {
    if (e.value !== 'auto' && e.value !== 'ascii')
      r.errors.push(invalidOption('encodation', "Option encodation must be 'auto' or 'ascii'"));
    else encodation = e.value;
  }
  const optimizeOrder = readBoolean(r, 'optimizeOrder');
  const hri = readBoolean(r, 'hri');
  const hriSize = readHriSize(r);
  const dl = carrier ? r.get('digitalLink') : undefined;
  if (r.errors.length > 0) return fail(r.errors);
  return ok({ size, encodation, optimizeOrder, hri, hriSize, digitalLink: dl?.value });
}

// ---------------------------------------------------------------------------------------------
// Encoding

/** The exported object names, for input errors that point to the other object. */
const NAMES = { gs1: 'gs1DataMatrix', dl: 'dataMatrix' } as const;

/** Symbols to codewords, size choice and placement (decisions H9, H10, H11). */
function symbolOf(
  symbols: readonly number[],
  s: Settings,
  name: SymbologyName,
  hri: readonly AiValue[],
): Result<ModuleMatrix> {
  const checked = checkSymbols(symbols);
  if (!checked.ok) return fail(renamed(checked.errors, 'datamatrix', name));
  const chosen = chooseSize(encodeCodewords(checked.value, s.encodation), s.size);
  if (!chosen.ok) return fail(renamed(chosen.errors, 'datamatrix', name));
  const placed = placeCodewords(chosen.value.size, chosen.value.codewords);
  return ok(
    freezeMatrix({
      kind: 'matrix',
      symbology: name,
      width: placed.width,
      height: placed.height,
      rows: placed.rows,
      quietZone: { left: 1, right: 1, top: 1, bottom: 1 },
      hri: s.hri ? hriLines(hri, placed.height, s.hriSize) : [],
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
    const symbols = [DM_FNC1];
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      symbols.push(c === 29 ? DM_FNC1 : c);
    }
    return symbolOf(symbols, s, 'gs1-datamatrix', encodedOrder(es.value, s.optimizeOrder));
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
    const symbols: number[] = [];
    for (let i = 0; i < uri.length; i++) symbols.push(uri.charCodeAt(i));
    return symbolOf(symbols, s, 'datamatrix', elementString.entries());
  } catch {
    return fail([encodeFailure()]);
  }
}

// ---------------------------------------------------------------------------------------------
// Decoding

function metadataOf(read: DmRead, t: DmText): DataMatrixMetadata {
  return {
    rows: read.size.rows,
    columns: read.size.columns,
    shape: read.size.shape,
    codewords: read.codewords.slice(0, t.length),
    ecCodewords: read.size.ecCodewords,
    blocks: read.size.blocks,
    encodation: t.encodation,
    orientation: read.orientation,
    inverted: read.inverted,
  };
}

function notGs1(t: DmText, message: string): Gs1Error {
  return new Gs1Error({
    code: 'UNSUPPORTED',
    message,
    details: { reason: 'not-gs1', aimId: t.aimId, text: t.data },
  });
}

/** Reads and decodes a symbol: the codeword stream and its transmitted data. */
function readText(symbol: unknown): Result<{ read: DmRead; text: DmText }> {
  const read = readDataMatrix(symbol);
  if (!read.ok) return fail(read.errors);
  const text = decodeCodewords(read.value.codewords);
  if (!text.ok) return fail(text.errors);
  const special = specialError(text.value);
  if (special) return fail([special]);
  return ok({ read: read.value, text: text.value });
}

/** A `]d2` result (decision H8 data rules); positions of data errors index `rawData`. */
function gs1Result(read: DmRead, t: DmText): Result<DecodedSymbol<DataMatrixMetadata>> {
  const es = gs1FromData(t.data);
  if (!es.ok) return fail(es.errors);
  return ok(
    freezeDecoded({
      symbology: 'gs1-datamatrix',
      aimId: ']d2',
      elementString: es.value,
      rawData: t.data,
      errorsCorrected: read.errorsCorrected,
      metadata: metadataOf(read, t),
    }),
  );
}

function decodeGs1(symbol: unknown): Result<DecodedSymbol<DataMatrixMetadata>> {
  try {
    const r = readText(symbol);
    if (!r.ok) return fail(r.errors);
    const { read, text } = r.value;
    if (text.aimId !== ']d2')
      return fail([
        notGs1(text, 'Data Matrix without FNC1 in first position is not GS1 DataMatrix'),
      ]);
    return gs1Result(read, text);
  } catch {
    /* v8 ignore next */
    return fail([decodeFailure()]);
  }
}

function decodeDl(symbol: unknown): Result<DecodedSymbol<DataMatrixMetadata>> {
  try {
    const r = readText(symbol);
    if (!r.ok) return fail(r.errors);
    const { read, text } = r.value;
    if (text.aimId === ']d2') return gs1Result(read, text);
    const dl = dlFromText(text.data);
    if (!dl) return fail([notGs1(text, 'The Data Matrix text is not a GS1 Digital Link URI')]);
    return ok(
      freezeDecoded({
        symbology: 'datamatrix',
        aimId: ']d1',
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

function gs1TryEncode(
  data: ElementString | string,
  options?: DataMatrixOptions,
): Result<ModuleMatrix> {
  return encodeGs1(data, options);
}

function gs1TryDecode(symbol: ModuleMatrix): Result<DecodedSymbol<DataMatrixMetadata>> {
  return decodeGs1(symbol);
}

/**
 * GS1 DataMatrix: encodes an element string with FNC1 first (`]d2`), choosing the
 * minimal-codeword encodation and the size per the `size` option; decodes only `]d2` symbols.
 * A bundle that uses only this object contains no Digital Link or EPC code.
 */
export const gs1DataMatrix: Symbology<DataMatrixOptions, DataMatrixMetadata, ModuleMatrix> =
  /* @__PURE__ */ Object.freeze({
    name: 'gs1-datamatrix',
    encode: (data: ElementString | string, options?: DataMatrixOptions): ModuleMatrix =>
      unwrap(gs1TryEncode(data, options)),
    tryEncode: gs1TryEncode,
    decode: (symbol: ModuleMatrix): DecodedSymbol<DataMatrixMetadata> =>
      unwrap(gs1TryDecode(symbol)),
    tryDecode: gs1TryDecode,
  } as const);

function dlTryEncode(
  data: ElementString | string,
  options?: DataMatrixDlOptions,
): Result<ModuleMatrix> {
  return encodeDl(data, options);
}

function dlTryDecode(symbol: ModuleMatrix): Result<DecodedSymbol<DataMatrixMetadata>> {
  return decodeDl(symbol);
}

/**
 * Data Matrix as a GS1 Digital Link carrier: encodes a URI (verbatim) or an
 * element string (built into a URI as `toScan(es, 'datamatrix', { digitalLink })`) without FNC1
 * (`]d1`); decodes `]d1` symbols holding a GS1 Digital Link URI and `]d2` symbols (reported as
 * 'gs1-datamatrix').
 */
export const dataMatrix: Symbology<DataMatrixDlOptions, DataMatrixMetadata, ModuleMatrix> =
  /* @__PURE__ */ Object.freeze({
    name: 'datamatrix',
    encode: (data: ElementString | string, options?: DataMatrixDlOptions): ModuleMatrix =>
      unwrap(dlTryEncode(data, options)),
    tryEncode: dlTryEncode,
    decode: (symbol: ModuleMatrix): DecodedSymbol<DataMatrixMetadata> =>
      unwrap(dlTryDecode(symbol)),
    tryDecode: dlTryDecode,
  } as const);
