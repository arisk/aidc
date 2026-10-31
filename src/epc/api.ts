import { type AiValue, ElementString, tryParse, validate } from '../ai/index.ts';
import { Gs1Error, type Result, fail, guard, ok, unwrap } from '../core/errors.ts';
import {
  bitsToBytes,
  bitsToHex,
  bytesToBits,
  decodeBinary,
  encodeBinary,
  firstNonHex,
  hexToBits,
  isDecodedPlus,
} from './binary.ts';
import type {
  BinaryScheme,
  BinarySchemeName,
  EpcBinarySchemeName,
  PlusSchemeName,
  PureSchemeName,
} from './descriptor.ts';
import { epcError } from './errors.ts';
import { type EpcFields, gs1Fields, isGs1Scheme } from './fields.ts';
import {
  type GcpLengthSource,
  aisFromPure,
  companyPrefixOf,
  elementStringFromPure,
  pureFromElementString,
} from './gs1.ts';
import {
  type DecodedPlus,
  PRIORITISED_DATE_AIS,
  type PlusContent,
  type PlusFamily,
  type PlusScheme,
  encodePlus,
  isPrioritisedDate,
  plusSchemeByName,
} from './plus.ts';
import { schemeByName } from './schemes.ts';
import {
  type EpcControl,
  type PureId,
  canonicalComponents,
  fieldsOf,
  formatPure,
  formatRaw,
  formatTag,
  parsePure,
  parseRaw,
  parseTag,
} from './uri.ts';

/** Fields every EPC value may carry. `bytes` is a fresh copy on each read. */
export interface EpcCommon {
  /** The filter value of a binary encoding that has one. */
  readonly filter?: number;
  readonly rawUri?: string;
  /** EPC bits zero-padded to 16-bit words, upper-case hex. */
  readonly hex?: string;
  /** The bytes of `hex`; a new copy on each read. */
  readonly bytes?: Uint8Array;
  /** The EPC bit count, without padding. */
  readonly bitLength?: number;
  /** Gen2 control fields of the tag and raw URIs. */
  readonly control?: EpcControl;
}

/** What every identity EPC has, whatever its scheme. */
interface IdentityEpcBase extends EpcCommon {
  readonly kind: 'id' | 'class';
  /** Pure identity components in URI form. */
  readonly components: readonly string[];
  readonly pureIdentityUri: string;
  readonly binaryScheme?: BinarySchemeName;
  readonly tagUri?: string;
}

/** An identity EPC of scheme `S`. */
type IdentityEpcOf<S extends PureSchemeName> = IdentityEpcBase & {
  readonly scheme: S;
  /** Its data by name, URI escapes removed (see EpcFieldsByScheme). */
  readonly fields: EpcFields<S>;
};

/**
 * An EPC with a pure identity (or class) URI: its pure identity, and, when it has a legacy
 * binary encoding, the tag URI, raw URI and bits. Narrow on `scheme` to type `fields`. Immutable.
 */
export type IdentityEpc = { [S in PureSchemeName]: IdentityEpcOf<S> }[PureSchemeName];

/** What every plus EPC has, whatever its family. */
interface PlusEpcBase extends EpcCommon {
  readonly kind: 'plus';
  readonly binaryScheme: PlusSchemeName;
  readonly filter: number;
  /** The body AIs, then the DSGTIN prioritised date, then the +AIDC AIs, in encoded order. */
  readonly elementString: ElementString;
  /** The +AIDC AIs alone (TDS 15.3). */
  readonly aidc: readonly AiValue[];
  /** "++" schemes: the Digital Link hostname (TDS 14.5.16). */
  readonly hostname?: string;
  readonly rawUri: string;
  readonly hex: string;
  readonly bytes: Uint8Array;
  readonly bitLength: number;
}

/** A plus EPC of the legacy family `F`. */
type PlusEpcOf<F extends PlusFamily> = PlusEpcBase & {
  /** The legacy family: 'sgtin' for sgtin+, dsgtin+, sgtin++ and dsgtin++. */
  readonly scheme: F;
  /** Its key data by name, as on a legacy EPC of the family; no GS1 Company Prefix. */
  readonly fields: EpcFields<F>;
};

/**
 * A TDS 2.x "+" or "++" EPC. TDS defines no pure identity or tag URI
 * for these schemes (TDS 12.3.1, 14.3): the value is equivalent to its element string.
 * Narrow on `scheme` to type `fields`. Immutable.
 */
export type PlusEpc = { [F in PlusFamily]: PlusEpcOf<F> }[PlusFamily];

/** An EPC: an identity EPC (`kind` 'id' or 'class') or a "+"/"++" EPC (`kind` 'plus'). */
export type Epc = IdentityEpc | PlusEpc;

export interface EpcEncodeOptions {
  /**
   * Encode into this binary scheme. A legacy scheme must belong to the EPC's pure scheme; a
   * plus EPC re-encodes only into a "+"/"++" scheme of its family.
   */
  readonly scheme?: EpcBinarySchemeName;
  /** The filter value; defaults to the input's filter, else 0. */
  readonly filter?: number;
  /** Control fields for the tag and raw URIs; defaults to the input's. */
  readonly control?: EpcControl;
  /** "++" schemes only: the Digital Link hostname; defaults to the input's. */
  readonly hostname?: string;
  /**
   * The GS1 Company Prefix length, or a lookup (see `GcpLengthSource`). Encoding a legacy
   * scheme from an element string needs it. A plus EPC does not encode one: with this option
   * its `fields.companyPrefix` is set, and left out when the lookup returns undefined. A legacy
   * EPC has its own, so decoding one ignores it.
   */
  readonly companyPrefixLength?: GcpLengthSource;
}

export interface EpcFromElementStringOptions extends EpcEncodeOptions {
  /** The EPC scheme; inferred from the AIs present when absent. */
  readonly epcScheme?: PureSchemeName;
  /**
   * DSGTIN: the prioritized date AI. Defaults to the first present of
   * (11), (13), (15), (16), (17), (7006), (7007) with a 6-digit value.
   */
  readonly dateAi?: '11' | '13' | '15' | '16' | '17' | '7006' | '7007';
  /** Plus schemes: carry the AIs the scheme does not as +AIDC data (default true). */
  readonly aidc?: boolean;
}

export interface EpcApi {
  decode(input: string | Uint8Array, opts?: EpcEncodeOptions): Epc;
  tryDecode(input: string | Uint8Array, opts?: EpcEncodeOptions): Result<Epc>;
  fromElementString(input: ElementString | string, opts?: EpcFromElementStringOptions): Epc;
  tryFromElementString(
    input: ElementString | string,
    opts?: EpcFromElementStringOptions,
  ): Result<Epc>;
  toElementString(e: Epc): ElementString;
  tryToElementString(e: Epc): Result<ElementString>;
}

const TAG_PREFIX = 'urn:epc:tag:';
const RAW_PREFIX = 'urn:epc:raw:';
const ID_PREFIX = 'urn:epc:id:';
const CLASS_PREFIX = 'urn:epc:class:';

interface Binary {
  readonly scheme: BinaryScheme;
  readonly filter: number | undefined;
  /** Unpadded EPC bits. */
  readonly bits: string;
}

/** What an identity input decodes to, before options apply. */
interface IdentitySource {
  readonly plus?: undefined;
  readonly pure: PureId;
  readonly binary?: Binary;
  readonly control: EpcControl;
}

/** What a "+" or "++" input decodes to, before options apply. */
interface PlusSource {
  readonly plus: DecodedPlus;
  /** The validated element string of the content (plan decision F12). */
  readonly elementString: ElementString;
  /** Unpadded EPC bits, +AIDC data included. */
  readonly bits: string;
  readonly control: EpcControl;
}

type Source = IdentitySource | PlusSource;

/** Where an input came from, to place errors in it. */
interface Place {
  /** Hex input: bit errors point at their hex digit. */
  readonly hex: boolean;
  /** The length of a string input; undefined for bytes. */
  readonly length: number | undefined;
}

const hasFilter = (s: BinaryScheme): boolean => s.fields[0]?.spec.kind === 'filter';

/**
 * The longest EPC URI accepted. The longest valid one (an ADI with every character escaped and
 * all control fields) is about 250 characters; this bounds the work on hostile input.
 */
const MAX_URI_LENGTH = 1024;

/** The largest EPC in Gen2 EPC memory, as for raw URIs: 31 words of 16 bits (TDS 15.2.1). */
const MAX_EPC_BITS = 31 * 16;

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null;

/** Control fields as the URIs carry them: non-zero values only (plan decision E13). */
function canonicalControl(c: EpcControl): EpcControl {
  return {
    ...(c.att ? { att: c.att } : {}),
    ...(c.umi ? { umi: true } : {}),
    ...(c.xpc ? { xpc: c.xpc } : {}),
  };
}

const badControl = (field: string, message: string): Gs1Error =>
  epcError('control', message, { details: { field } });
const inRange = (v: unknown, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/** Checks `opts.control` from a caller: att 0..255, xpc 0..0xFFFFFFFF, umi a boolean. */
function checkControl(control: unknown): Gs1Error | undefined {
  if (!isObject(control)) return badControl('control', 'control must be an object');
  const { att, umi, xpc } = control;
  if (att !== undefined && !inRange(att, 0xff))
    return badControl('att', 'att must be an integer from 0 to 255');
  if (xpc !== undefined && !inRange(xpc, 0xffffffff))
    return badControl('xpc', 'xpc must be an integer from 0 to 0xFFFFFFFF');
  if (umi !== undefined && typeof umi !== 'boolean')
    return badControl('umi', 'umi must be a boolean');
  return undefined;
}

const padWords = (bits: string): string => bits.padEnd(Math.ceil(bits.length / 16) * 16, '0');

/** TypeScript cannot pair a `scheme` variable with its `fields`; fieldsOf does by construction. */
function asIdentity(
  e: IdentityEpcBase & { readonly scheme: PureSchemeName; readonly fields: EpcFields },
): IdentityEpc {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fields comes from fieldsOf(scheme)
  return e as IdentityEpc;
}

/** The fields of a canonical pure identity: GS1 data and company prefix, or TDS names. */
function identityFields(pure: PureId): EpcFields {
  if (!isGs1Scheme(pure.scheme)) return fieldsOf(pure.scheme, pure.components);
  const ais = aisFromPure(pure);
  // Canonical components of a decoded EPC always map; this guards a bug.
  if (ais instanceof Gs1Error) throw ais;
  return gs1Fields(pure.scheme, ais, pure.components[0] ?? '');
}

function makeEpc(pure: PureId, binary?: Binary, control: EpcControl = {}): IdentityEpc {
  const components = canonicalComponents(pure.scheme, pure.components);
  const base = asIdentity({
    scheme: pure.scheme,
    kind: pure.kind,
    components: Object.freeze(components),
    fields: identityFields({ kind: pure.kind, scheme: pure.scheme, components }),
    pureIdentityUri: formatPure(pure),
  });
  if (!binary) return Object.freeze(base);
  const { scheme, bits } = binary;
  const filter = hasFilter(scheme) ? (binary.filter ?? 0) : undefined;
  const ctl = Object.freeze(canonicalControl(control));
  const out = {
    ...base,
    binaryScheme: scheme.name,
    ...(filter === undefined ? {} : { filter }),
    tagUri: formatTag(scheme, filter, pure.components, ctl),
    rawUri: formatRaw(padWords(bits), ctl),
    hex: bitsToHex(bits),
    bitLength: bits.length,
    control: ctl,
  };
  // A Uint8Array cannot be frozen: hand out a fresh copy on each read.
  Object.defineProperty(out, 'bytes', { enumerable: true, get: () => bitsToBytes(bits) });
  return Object.freeze(out);
}

/** The element string entries of plus content: body, date, +AIDC (plan decision F2). */
function plusEntries(c: PlusContent): AiValue[] {
  return [...c.body, ...(c.date === undefined ? [] : [c.date]), ...c.aidc];
}

function makePlusEpc(
  scheme: PlusScheme,
  c: PlusContent,
  elementString: ElementString,
  bits: string,
  control: EpcControl,
  companyPrefix: string | undefined,
): PlusEpc {
  const ctl = Object.freeze(canonicalControl(control));
  const out = Object.freeze({
    kind: 'plus' as const,
    scheme: scheme.family,
    fields: gs1Fields(scheme.family, c.body, companyPrefix),
    binaryScheme: scheme.name,
    filter: c.filter,
    elementString,
    aidc: Object.freeze(c.aidc.map(([a, v]) => Object.freeze([a, v] as const))),
    ...(c.hostname === undefined ? {} : { hostname: c.hostname }),
    rawUri: formatRaw(padWords(bits), ctl),
    hex: bitsToHex(bits),
    // A Uint8Array cannot be frozen: hand out a fresh copy on each read.
    get bytes(): Uint8Array {
      return bitsToBytes(bits);
    },
    bitLength: bits.length,
    control: ctl,
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fields comes from gs1Fields(scheme.family)
  return out as PlusEpc;
}

/** A plus EPC, with `fields.companyPrefix` when `gcp` gives its length. */
function plusEpc(
  scheme: PlusScheme,
  c: PlusContent,
  elementString: ElementString,
  bits: string,
  control: EpcControl,
  gcp: GcpLengthSource | undefined,
): Result<Epc> {
  const prefix = gcp === undefined ? undefined : companyPrefixOf(scheme.family, c.body, gcp);
  if (prefix instanceof Gs1Error) return failed(prefix);
  return ok(makePlusEpc(scheme, c, elementString, bits, control, prefix));
}

/** A copy of `e` at `position` and `length`, or without a place when `position` is undefined. */
function placed(e: Gs1Error, position: number | undefined, length: number | undefined): Gs1Error {
  return new Gs1Error({
    code: e.code,
    message: e.message,
    ...(e.ai === undefined ? {} : { ai: e.ai }),
    ...(position === undefined ? {} : { position }),
    ...(length === undefined ? {} : { length }),
    ...(e.details === undefined ? {} : { details: e.details }),
  });
}

/** A copy of `e` at its hex digit, for errors found in the bits of a hex string. */
function atHex(e: Gs1Error): Gs1Error {
  const bit = e.details?.['bit'];
  return typeof bit === 'number' ? placed(e, Math.floor(bit / 4), 1) : e;
}

function fromBits(bits: string, control: EpcControl, place: Place): Result<Source> {
  const d = decodeBinary(bits);
  if (d instanceof Gs1Error) return fail([place.hex ? atHex(d) : d]);
  if (isDecodedPlus(d)) {
    // An AI rule the content breaks is not tied to one place in the bits: the error spans the
    // whole string input, and has no place for bytes (plan decision F12).
    const v = validate(plusEntries(d));
    const at = place.length === undefined ? undefined : 0;
    if (!v.ok) return fail(v.errors.map((e) => placed(e, at, place.length)));
    return ok({ plus: d, elementString: v.value, bits: bits.slice(0, d.bitLength), control });
  }
  return ok({
    pure: { kind: 'id', scheme: d.scheme.epcScheme, components: d.components },
    binary: { scheme: d.scheme, filter: d.filter, bits: bits.slice(0, d.bitLength) },
    control,
  });
}

const failed = <T>(e: Gs1Error): Result<T> => fail([e]);

function sourceOf(input: string | Uint8Array): Result<Source> {
  if (input instanceof Uint8Array) {
    if (input.length * 8 > MAX_EPC_BITS) {
      return failed(
        epcError('binary', `An EPC has at most ${MAX_EPC_BITS} bits`, {
          details: { bit: MAX_EPC_BITS },
        }),
      );
    }
    return fromBits(bytesToBits(input), {}, { hex: false, length: undefined });
  }
  if (input.startsWith(TAG_PREFIX)) {
    const t = parseTag(input);
    if (t instanceof Gs1Error) return failed(t);
    // The filter range and the fit of each component are checked by encoding (TDS 12.3).
    const bits = encodeBinary(t.scheme, t.filter, t.components);
    if (bits instanceof Gs1Error) return failed(bits);
    return ok({
      pure: { kind: 'id', scheme: t.scheme.epcScheme, components: t.components },
      binary: { scheme: t.scheme, filter: t.filter, bits },
      control: t.control,
    });
  }
  if (input.startsWith(RAW_PREFIX)) {
    const r = parseRaw(input);
    if (r instanceof Gs1Error) return failed(r);
    if (r.afi !== undefined) {
      return failed(
        new Gs1Error({
          code: 'UNSUPPORTED',
          message: 'A raw URI with an AFI (toggle 1) does not hold an EPC',
          details: { reason: 'raw-afi', afi: r.afi },
        }),
      );
    }
    return fromBits(r.bits, r.control, { hex: false, length: input.length });
  }
  if (input.startsWith(ID_PREFIX) || input.startsWith(CLASS_PREFIX)) {
    const p = parsePure(input);
    return p instanceof Gs1Error ? failed(p) : ok({ pure: p, control: {} });
  }
  // Over 496 bits, only look for a bad character: do not build the bits.
  const bits = input.length * 4 > MAX_EPC_BITS ? firstNonHex(input) : hexToBits(input);
  if (typeof bits === 'number' && bits >= 0) {
    return failed(
      epcError('syntax', 'An EPC is hex, bytes, or a urn:epc: URI', {
        position: bits,
        length: 1,
      }),
    );
  }
  if (typeof bits === 'number') {
    return failed(
      epcError('binary', `An EPC has at most ${MAX_EPC_BITS} bits`, {
        position: MAX_EPC_BITS / 4,
        length: input.length - MAX_EPC_BITS / 4,
        details: { bit: MAX_EPC_BITS },
      }),
    );
  }
  return fromBits(bits, {}, { hex: true, length: input.length });
}

/** Checks the options shared by every path: control, hostname, dateAi and aidc types. */
function checkOptions(opts: Partial<EpcFromElementStringOptions>): Gs1Error | undefined {
  // Before any message interpolates them: a Symbol or a null-prototype object would throw.
  if (opts.scheme !== undefined && typeof opts.scheme !== 'string')
    return epcError('scheme', 'scheme must be a string');
  if (opts.epcScheme !== undefined && typeof opts.epcScheme !== 'string')
    return epcError('scheme', 'epcScheme must be a string');
  if (opts.dateAi !== undefined && typeof opts.dateAi !== 'string')
    return epcError('component', 'dateAi must be a string');
  if (opts.control !== undefined) {
    const e = checkControl(opts.control);
    if (e) return e;
  }
  if (opts.hostname !== undefined && typeof opts.hostname !== 'string')
    return epcError('hostname', 'hostname must be a string');
  if (opts.aidc !== undefined && typeof opts.aidc !== 'boolean')
    return epcError('aidc', 'aidc must be a boolean');
  const gcp = opts.companyPrefixLength;
  if (gcp !== undefined && typeof gcp !== 'number' && typeof gcp !== 'function')
    return epcError('gcp-length', 'companyPrefixLength must be a number or a function');
  return undefined;
}

const noHostname = (scheme: string | undefined): Gs1Error =>
  epcError('hostname', 'Only "++" schemes carry a hostname (TDS 14.5.16)', {
    details: { scheme: scheme ?? null },
  });

/** Applies encode options to a decoded identity source. */
function encode(src: IdentitySource, opts: EpcEncodeOptions): Result<Epc> {
  if (opts.hostname !== undefined)
    return failed(noHostname(opts.scheme ?? src.binary?.scheme.name ?? src.pure.scheme));
  let scheme = src.binary?.scheme;
  if (opts.scheme !== undefined) {
    scheme = schemeByName(opts.scheme);
    if (!scheme || scheme.epcScheme !== src.pure.scheme || src.pure.kind !== 'id') {
      return failed(
        epcError(
          'scheme',
          `${opts.scheme} cannot encode urn:epc:${src.pure.kind}:${src.pure.scheme}${plusSchemeByName(opts.scheme) === undefined ? '' : '; use toElementString, then fromElementString with the plus scheme'}`,
          {
            details: { scheme: opts.scheme },
          },
        ),
      );
    }
  }
  const control = opts.control ?? src.control;
  if (!scheme) {
    if (opts.filter !== undefined || opts.control !== undefined) {
      return failed(
        epcError(
          opts.filter === undefined ? 'control' : 'filter',
          'A filter or control fields need a binary scheme; pass scheme',
        ),
      );
    }
    return ok(makeEpc(src.pure));
  }
  if (opts.filter !== undefined && !hasFilter(scheme)) {
    return failed(
      epcError('filter', `${scheme.name} has no filter`, { details: { filter: opts.filter } }),
    );
  }
  const filter = opts.filter ?? src.binary?.filter ?? 0;
  const same =
    src.binary !== undefined && src.binary.scheme === scheme && src.binary.filter === filter;
  const bits =
    same && src.binary ? src.binary.bits : encodeBinary(scheme, filter, src.pure.components);
  if (bits instanceof Gs1Error) return failed(bits);
  return ok(makeEpc(src.pure, { scheme, filter, bits }, control));
}

interface PlusOptions {
  readonly filter: number;
  readonly hostname: string | undefined;
  readonly dateAi: string | undefined;
  readonly aidc: boolean;
  readonly gcp: GcpLengthSource | undefined;
}

/** SGLN without (254) encodes extension "0", which decoding drops (plan decision F7). */
const isDefaultExtension = ([ai, v]: AiValue): boolean => ai === '254' && v === '0';

/**
 * The content of `scheme` from a validated element string (plan decisions F5, F6, F7): the
 * body AIs, the DSGTIN date, and the other AIs as +AIDC data in element string order, with
 * identical repeats once.
 */
function plusContent(
  scheme: PlusScheme,
  es: ElementString,
  opts: PlusOptions,
): PlusContent | Gs1Error {
  const body: AiValue[] = [];
  for (const ai of scheme.ais) {
    const value = es.get(ai);
    if (value === undefined) {
      // SGLN: the extension (254) is optional (plan decision F7).
      if (ai === '254') continue;
      return epcError('no-epc-key', `${scheme.name} needs AI (${ai})`, {
        ai,
        details: { ai, scheme: scheme.name },
      });
    }
    body.push([ai, value]);
  }
  let date: AiValue | undefined;
  if (scheme.date) {
    const ai =
      opts.dateAi ??
      PRIORITISED_DATE_AIS.find((a) => {
        const v = es.get(a);
        return v !== undefined && isPrioritisedDate(a, v);
      });
    const value = ai === undefined ? undefined : es.get(ai);
    if (ai === undefined || value === undefined) {
      return epcError(
        'no-date',
        opts.dateAi === undefined
          ? `${scheme.name} needs a 6-digit date in one of ${PRIORITISED_DATE_AIS.map((a) => `(${a})`).join('')} (TDS 14.5.3)`
          : `The element string has no (${opts.dateAi}) for the prioritised date`,
        { details: { scheme: scheme.name } },
      );
    }
    date = [ai, value];
  } else if (opts.dateAi !== undefined) {
    return epcError('component', `${scheme.name} has no prioritised date; dateAi is for DSGTIN`, {
      details: { dateAi: opts.dateAi },
    });
  }
  const aidc: AiValue[] = [];
  if (opts.aidc) {
    const seen = new Set<string>();
    for (const [ai, value] of es.entries()) {
      if (scheme.ais.includes(ai) || ai === date?.[0]) continue;
      // Conflicting repeats fail validation, so one value per AI remains.
      if (seen.has(ai)) continue;
      seen.add(ai);
      aidc.push([ai, value]);
    }
  }
  return {
    filter: opts.filter,
    body,
    ...(date === undefined ? {} : { date }),
    ...(opts.hostname === undefined ? {} : { hostname: opts.hostname }),
    aidc,
  };
}

/** Encodes a validated element string into a plus scheme. */
function encodePlusEpc(
  scheme: PlusScheme,
  es: ElementString,
  opts: PlusOptions,
  control: EpcControl,
): Result<Epc> {
  if (opts.dateAi !== undefined && !PRIORITISED_DATE_AIS.includes(opts.dateAi)) {
    return failed(
      epcError('component', `dateAi must be one of ${PRIORITISED_DATE_AIS.join(', ')}`, {
        details: { dateAi: opts.dateAi },
      }),
    );
  }
  const content = plusContent(scheme, es, opts);
  if (content instanceof Gs1Error) return failed(content);
  const bits = encodePlus(scheme, content);
  if (bits instanceof Gs1Error) return failed(bits);
  // The EPC holds what decoding gives back: (254)0 is dropped (F7).
  const stored = { ...content, body: content.body.filter((e) => !isDefaultExtension(e)) };
  const v = validate(plusEntries(stored));
  if (!v.ok) return v;
  return plusEpc(scheme, stored, v.value, bits, control, opts.gcp);
}

const schemeError = (name: string, message: string): Gs1Error =>
  epcError('scheme', message, { details: { scheme: name } });

/** Applies encode options to a decoded plus source (plan decision F13). */
function encodePlusSource(src: PlusSource, opts: EpcEncodeOptions): Result<Epc> {
  const from = src.plus.scheme;
  let scheme = from;
  if (opts.scheme !== undefined) {
    const s = plusSchemeByName(opts.scheme);
    if (s?.family !== from.family) {
      return failed(
        schemeError(
          opts.scheme,
          `A ${from.name} EPC re-encodes only into a "+" or "++" ${from.family} scheme, not ${opts.scheme} (no GCP length in the binary)`,
        ),
      );
    }
    scheme = s;
  }
  if (opts.hostname !== undefined && !scheme.hostname) {
    return failed(noHostname(scheme.name));
  }
  const control = opts.control ?? src.control;
  const filter = opts.filter ?? src.plus.filter;
  const hostname = scheme.hostname ? (opts.hostname ?? src.plus.hostname) : undefined;
  if (scheme === from && filter === src.plus.filter && hostname === src.plus.hostname)
    return plusEpc(
      scheme,
      src.plus,
      src.elementString,
      src.bits,
      control,
      opts.companyPrefixLength,
    );
  return encodePlusEpc(
    scheme,
    src.elementString,
    // Keep the date's role; into SGTIN it moves to +AIDC data.
    {
      filter,
      hostname,
      dateAi: scheme.date ? src.plus.date?.[0] : undefined,
      aidc: true,
      gcp: opts.companyPrefixLength,
    },
    control,
  );
}

/** Options from a caller: undefined and null mean none; anything else must be an object. */
function optionsOf<T extends object>(
  opts: T | null | undefined,
  fn: string,
): Partial<T> | Gs1Error {
  if (opts === undefined || opts === null) return {};
  if (!isObject(opts))
    return new Gs1Error({ code: 'SYNTAX', message: `The options of ${fn} must be an object` });
  return opts;
}

function tryDecode(input: string | Uint8Array, options?: EpcEncodeOptions): Result<Epc> {
  return guard(() => tryDecodeUnguarded(input, options));
}

function tryDecodeUnguarded(input: string | Uint8Array, options?: EpcEncodeOptions): Result<Epc> {
  const opts = optionsOf(options, 'epc.decode');
  if (opts instanceof Gs1Error) return failed(opts);
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) {
    return failed(
      new Gs1Error({ code: 'SYNTAX', message: 'epc.decode takes a string or a Uint8Array' }),
    );
  }
  if (input === '') {
    return failed(
      new Gs1Error({ code: 'EMPTY_INPUT', message: 'The input is empty', position: 0 }),
    );
  }
  if (typeof input === 'string' && input.startsWith('urn:') && input.length > MAX_URI_LENGTH) {
    return failed(
      epcError('syntax', `An EPC URI has at most ${MAX_URI_LENGTH} characters`, {
        position: MAX_URI_LENGTH,
      }),
    );
  }
  const bad = checkOptions(opts);
  if (bad) return failed(bad);
  const src = sourceOf(input);
  if (!src.ok) return src;
  return src.value.plus === undefined ? encode(src.value, opts) : encodePlusSource(src.value, opts);
}

function tryFromElementString(
  input: ElementString | string,
  options?: EpcFromElementStringOptions,
): Result<Epc> {
  return guard(() => tryFromElementStringUnguarded(input, options));
}

function tryFromElementStringUnguarded(
  input: ElementString | string,
  options?: EpcFromElementStringOptions,
): Result<Epc> {
  const opts = optionsOf(options, 'epc.fromElementString');
  if (opts instanceof Gs1Error) return failed(opts);
  let es: ElementString;
  if (typeof input === 'string') {
    const r = tryParse(input);
    if (!r.ok) return r;
    es = r.value;
  } else if (input instanceof ElementString) {
    es = input;
  } else {
    return failed(
      new Gs1Error({
        code: 'SYNTAX',
        message: 'epc.fromElementString takes a string or an ElementString',
      }),
    );
  }
  const bad = checkOptions(opts);
  if (bad) return failed(bad);
  const plus = opts.scheme === undefined ? undefined : plusSchemeByName(opts.scheme);
  if (plus !== undefined) {
    if (opts.epcScheme !== undefined && opts.epcScheme !== plus.family) {
      return failed(
        schemeError(plus.name, `${plus.name} does not encode urn:epc:id:${opts.epcScheme}`),
      );
    }
    // An ElementString may come from elsewhere: validate it like a decoded one (F12).
    const v = validate(es);
    if (!v.ok) return v;
    return encodePlusEpc(
      plus,
      v.value,
      {
        filter: opts.filter ?? 0,
        hostname: opts.hostname,
        dateAi: opts.dateAi,
        aidc: opts.aidc ?? true,
        gcp: opts.companyPrefixLength,
      },
      opts.control ?? {},
    );
  }
  if (opts.dateAi !== undefined) {
    return failed(
      epcError('component', 'dateAi is for the DSGTIN "+" and "++" schemes', {
        details: { dateAi: opts.dateAi },
      }),
    );
  }
  if (opts.hostname !== undefined) return failed(noHostname(opts.scheme));
  const binary = opts.scheme === undefined ? undefined : schemeByName(opts.scheme);
  if (opts.scheme !== undefined && binary === undefined) {
    return failed(schemeError(opts.scheme, `Unknown EPC encoding name ${opts.scheme}`));
  }
  const epcScheme = opts.epcScheme ?? binary?.epcScheme;
  const pure = pureFromElementString(es, {
    ...(epcScheme === undefined ? {} : { epcScheme }),
    ...(opts.companyPrefixLength === undefined
      ? {}
      : { companyPrefixLength: opts.companyPrefixLength }),
  });
  if (pure instanceof Gs1Error) return failed(pure);
  return encode({ pure, control: {} }, opts);
}

function tryToElementString(e: Epc): Result<ElementString> {
  return guard(() => tryToElementStringUnguarded(e));
}

function tryToElementStringUnguarded(e: Epc): Result<ElementString> {
  if (isObject(e) && e.kind === 'plus' && e.elementString instanceof ElementString)
    return ok(e.elementString);
  if (!isObject(e) || e.kind === 'plus' || !Array.isArray(e.components)) {
    return failed(
      new Gs1Error({ code: 'SYNTAX', message: 'epc.toElementString takes an Epc value' }),
    );
  }
  return elementStringFromPure({ kind: e.kind, scheme: e.scheme, components: e.components });
}

/** EPC Tag Data Standard 2.3: decode, encode and map EPCs to and from element strings. */
export const epc: EpcApi = Object.freeze({
  decode: (input: string | Uint8Array, opts?: EpcEncodeOptions): Epc =>
    unwrap(tryDecode(input, opts)),
  tryDecode,
  fromElementString: (input: ElementString | string, opts?: EpcFromElementStringOptions): Epc =>
    unwrap(tryFromElementString(input, opts)),
  tryFromElementString,
  toElementString: (e: Epc): ElementString => unwrap(tryToElementString(e)),
  tryToElementString,
});
