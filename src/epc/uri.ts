import { Gs1Error } from '../core/errors.ts';
import { bitsToHex, hexToBits } from './binary.ts';
import { escape6, escapeGs3a3, isCage, unescape6, unescapeGs3a3 } from './charsets.ts';
import type { BinaryScheme, PureSchemeName } from './descriptor.ts';
import { epcError } from './errors.ts';
import { type EpcFields, FIELD_NAMES, type Gs1SchemeName } from './fields.ts';
import { schemeByName } from './schemes.ts';

const ID_PREFIX = 'urn:epc:id:';
const CLASS_PREFIX = 'urn:epc:class:';
const TAG_PREFIX = 'urn:epc:tag:';
const RAW_PREFIX = 'urn:epc:raw:';
const HEX = '0123456789ABCDEF';
/** The largest raw URI bit count: a 5-bit length of 16-bit words (TDS 15.2.1). */
const MAX_RAW_BITS = 31 * 16;
/** The most decimal digits of a value below 2^496 (2^496 is about 1.02e149). */
const MAX_RAW_DIGITS = 150;
/** The hex digits of a 496-bit value: longer hex is refused before it is read. */
const MAX_RAW_HEX = MAX_RAW_BITS / 4;

const COLON = 0x3a;
const OPEN = 0x5b;

type Comp =
  | 'padded'
  | 'paddedOrEmpty'
  | 'numeric'
  | 'gs3a3'
  | 'cpref'
  | 'cage'
  | 'adiPart'
  | 'adiSerial'
  | 'two'
  | 'bic'
  | 'imovn';

/** Component kinds per pure scheme, and the digit total of the first two (TDS 6.3). */
const PURE: Readonly<
  Record<
    PureSchemeName,
    { readonly comps: readonly Comp[]; readonly total?: number; readonly maxLast?: number }
  >
> = {
  sgtin: { comps: ['padded', 'padded', 'gs3a3'], total: 13 },
  sscc: { comps: ['padded', 'padded'], total: 17 },
  sgln: { comps: ['padded', 'paddedOrEmpty', 'gs3a3'], total: 12 },
  grai: { comps: ['padded', 'paddedOrEmpty', 'gs3a3'], total: 12 },
  giai: { comps: ['padded', 'gs3a3'] },
  gsrn: { comps: ['padded', 'padded'], total: 17 },
  gsrnp: { comps: ['padded', 'padded'], total: 17 },
  gdti: { comps: ['padded', 'paddedOrEmpty', 'gs3a3'], total: 12 },
  cpi: { comps: ['padded', 'cpref', 'numeric'] },
  sgcn: { comps: ['padded', 'paddedOrEmpty', 'padded'], total: 12, maxLast: 12 },
  ginc: { comps: ['padded', 'gs3a3'] },
  gsin: { comps: ['padded', 'padded'], total: 16 },
  itip: { comps: ['padded', 'padded', 'two', 'two', 'gs3a3'], total: 13 },
  upui: { comps: ['padded', 'padded', 'gs3a3'], total: 13 },
  pgln: { comps: ['padded', 'paddedOrEmpty'], total: 12 },
  gid: { comps: ['numeric', 'numeric', 'numeric'] },
  usdod: { comps: ['cage', 'numeric'] },
  adi: { comps: ['cage', 'adiPart', 'adiSerial'] },
  bic: { comps: ['bic'] },
  imovn: { comps: ['imovn'] },
  lgtin: { comps: ['padded', 'padded', 'gs3a3'], total: 13 },
};

export interface PureId {
  readonly kind: 'id' | 'class';
  readonly scheme: PureSchemeName;
  /** Components in URI form (escapes as given). */
  readonly components: readonly string[];
}

/** Gen2 control fields of a tag or raw URI (TDS 12.2.2). */
export interface EpcControl {
  readonly att?: number;
  readonly umi?: boolean;
  readonly xpc?: number;
}

export interface TagParts {
  readonly control: EpcControl;
  readonly scheme: BinaryScheme;
  readonly filter: number | undefined;
  readonly components: readonly string[];
}

export interface RawParts {
  readonly control: EpcControl;
  /** The value as N bits. */
  readonly bits: string;
  /** The AFI of a toggle 1 body (`N.xAFI.xHEX`); not an EPC (plan decision E14). */
  readonly afi?: number;
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function allDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isDigit(s.charCodeAt(i))) return false;
  return true;
}
/** NumericComponent: "0" or digits without a leading zero. */
function isNumeric(s: string): boolean {
  return s.length > 0 && allDigits(s) && (s === '0' || s.charCodeAt(0) !== 48);
}
function hexValue(c: number): number {
  if (isDigit(c)) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}
/** BIC owner code character: A-Z without I and O. */
function isOwnerChar(c: number): boolean {
  return c >= 65 && c <= 90 && c !== 73 && c !== 79;
}
function isBic(s: string): boolean {
  if (s.length !== 11) return false;
  for (let i = 0; i < 3; i++) if (!isOwnerChar(s.charCodeAt(i))) return false;
  const cat = s.charAt(3);
  return (cat === 'J' || cat === 'U' || cat === 'Z') && allDigits(s.slice(4));
}

function isPureScheme(name: string): name is PureSchemeName {
  return Object.prototype.hasOwnProperty.call(PURE, name);
}

/** Number of URI components of a pure scheme's body. */
export function pureComponentCount(scheme: PureSchemeName): number {
  return PURE[scheme].comps.length;
}

/** Splits `body` into `n` components on the first n - 1 dots; undefined when there are fewer. */
function splitComponents(body: string, n: number): string[] | undefined {
  const out: string[] = [];
  let start = 0;
  for (let k = 0; k < n - 1; k++) {
    const dot = body.indexOf('.', start);
    if (dot < 0) return undefined;
    out.push(body.slice(start, dot));
    start = dot + 1;
  }
  out.push(body.slice(start));
  return out;
}

function badComponent(kind: Comp, at: number): Gs1Error {
  return epcError('component', `Component is not a valid ${kind} component`, { position: at });
}

/** Checks one component; `at` is its index in the URI. */
function checkComponent(kind: Comp, s: string, at: number): Gs1Error | undefined {
  switch (kind) {
    case 'padded':
      return s.length > 0 && allDigits(s) ? undefined : badComponent(kind, at);
    case 'paddedOrEmpty':
      return allDigits(s) ? undefined : badComponent(kind, at);
    case 'numeric':
      return isNumeric(s) ? undefined : badComponent(kind, at);
    case 'two':
      return s.length === 2 && allDigits(s) ? undefined : badComponent(kind, at);
    case 'imovn':
      return s.length === 7 && allDigits(s) ? undefined : badComponent(kind, at);
    case 'bic':
      return isBic(s) ? undefined : badComponent(kind, at);
    case 'cage':
      return isCage(s) ? undefined : badComponent(kind, at);
    case 'gs3a3': {
      if (s.length === 0) return badComponent(kind, at);
      const u = unescapeGs3a3(s);
      return 'badAt' in u ? badEscape(at + u.badAt) : undefined;
    }
    case 'cpref':
    case 'adiPart':
    case 'adiSerial': {
      const u = unescape6(s, kind === 'cpref' ? 'any' : kind === 'adiSerial' ? 'first' : 'none');
      if ('badAt' in u) return badEscape(at + u.badAt);
      if (u.value.length === 0 && kind !== 'adiPart') return badComponent(kind, at);
      // TDS 6.3.18: ADIExtendedComponent = 0*1"%23" 1*ADIChar, so '%23' alone is not a serial.
      return kind === 'adiSerial' && u.value === '#' ? badComponent(kind, at) : undefined;
    }
    default: {
      const never: never = kind;
      return never;
    }
  }
}

function badEscape(at: number): Gs1Error {
  return epcError('escape', 'A character must be escaped, or an escape is not allowed here', {
    position: at,
    length: 1,
  });
}

/** Parses the pure body of `scheme` starting at `start` in `uri`. */
function parseBody(uri: string, start: number, scheme: PureSchemeName): string[] | Gs1Error {
  const def = PURE[scheme];
  const comps = splitComponents(uri.slice(start), def.comps.length);
  if (!comps) {
    return epcError('syntax', `${scheme} takes ${def.comps.length} components`, {
      position: uri.length,
    });
  }
  let at = start;
  for (let k = 0; k < comps.length; k++) {
    const s = comps[k] ?? '';
    const e = checkComponent(def.comps[k] ?? 'gs3a3', s, at);
    if (e) return e;
    if (def.maxLast !== undefined && k === comps.length - 1 && s.length > def.maxLast) {
      return epcError('component', `The last component has at most ${def.maxLast} digits`, {
        position: at,
      });
    }
    at += s.length + 1;
  }
  if (def.total !== undefined && (comps[0] ?? '').length + (comps[1] ?? '').length !== def.total) {
    return epcError('component', `The first two components must total ${def.total} digits`, {
      position: start,
      details: { total: def.total },
    });
  }
  return comps;
}

/** Components in canonical escape form (plan decision E5). */
export function canonicalComponents(
  scheme: PureSchemeName,
  components: readonly string[],
): string[] {
  const kinds = PURE[scheme].comps;
  return components.map((s, k) => {
    const kind = kinds[k];
    if (kind === 'gs3a3') {
      const u = unescapeGs3a3(s);
      return 'value' in u ? escapeGs3a3(u.value) : s;
    }
    if (kind === 'cpref' || kind === 'adiPart' || kind === 'adiSerial') {
      const u = unescape6(s, 'any');
      return 'value' in u ? escape6(u.value) : s;
    }
    return s;
  });
}

/** `kind`'s component without its URI escapes; `s` is canonical, so it always unescapes. */
function unescapedComponent(kind: Comp | undefined, s: string): string {
  if (!s.includes('%')) return s;
  const u =
    kind === 'gs3a3'
      ? unescapeGs3a3(s)
      : kind === 'cpref' || kind === 'adiPart' || kind === 'adiSerial'
        ? unescape6(s, kind === 'cpref' ? 'any' : kind === 'adiSerial' ? 'first' : 'none')
        : undefined;
  if (u === undefined) return s;
  if ('badAt' in u) throw new Error(`Invalid canonical EPC component: ${s}`);
  return u.value;
}

/** The named fields of canonical, validated `components` of a scheme without a GS1 key. Frozen. */
export function fieldsOf<S extends Exclude<PureSchemeName, Gs1SchemeName>>(
  scheme: S,
  components: readonly string[],
): EpcFields<S> {
  const kinds = PURE[scheme].comps;
  const names: readonly string[] = FIELD_NAMES[scheme];
  const out: Record<string, string> = {};
  for (const [k, name] of names.entries()) {
    out[name] = unescapedComponent(kinds[k], components[k] ?? '');
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- FIELD_NAMES[scheme] gives exactly EpcFields<S>'s keys
  return Object.freeze(out) as EpcFields<S>;
}

function canonical(scheme: PureSchemeName, components: readonly string[]): string {
  return canonicalComponents(scheme, components).join('.');
}

/** Parses a pure identity URI (`urn:epc:id:`) or the LGTIN class URI (`urn:epc:class:lgtin:`). */
export function parsePure(uri: string): PureId | Gs1Error {
  const kind = uri.startsWith(ID_PREFIX) ? 'id' : uri.startsWith(CLASS_PREFIX) ? 'class' : '';
  if (kind === '') {
    return epcError('syntax', 'An EPC URI starts with urn:epc:id: or urn:epc:class:', {
      position: 0,
    });
  }
  const nameAt = kind === 'id' ? ID_PREFIX.length : CLASS_PREFIX.length;
  const colon = uri.indexOf(':', nameAt);
  const name = uri.slice(nameAt, colon < 0 ? uri.length : colon);
  if (!isPureScheme(name) || (name === 'lgtin') !== (kind === 'class')) {
    return epcError('scheme', `Unknown EPC ${kind === 'id' ? 'identity' : 'class'} scheme`, {
      position: nameAt,
      length: name.length,
    });
  }
  if (colon < 0) {
    return epcError('syntax', 'The scheme name must be followed by a colon', {
      position: uri.length,
    });
  }
  const components = parseBody(uri, colon + 1, name);
  if (!Array.isArray(components)) return components;
  return { kind, scheme: name, components };
}

export function formatPure(p: PureId): string {
  const prefix = p.kind === 'class' ? CLASS_PREFIX : ID_PREFIX;
  return `${prefix}${p.scheme}:${canonical(p.scheme, p.components)}`;
}

function hexDigits(v: number, width: number): string {
  let out = '';
  let n = v;
  for (let i = 0; i < width; i++) {
    out = HEX.charAt(n % 16) + out;
    n = Math.floor(n / 16);
  }
  return out;
}

/** Control fields in canonical form (plan decision E13): non-zero only, then a colon. */
export function controlPrefix(control: EpcControl): string {
  let out = '';
  if (control.att) out += `[att=x${hexDigits(control.att, 2)}]`;
  if (control.umi) out += '[umi=1]';
  if (control.xpc) out += `[xpc=x${hexDigits(control.xpc, control.xpc > 0xffff ? 8 : 4)}]`;
  return out === '' ? '' : `${out}:`;
}

/** The value of `s` as hex digits (either case), or -1 when it is not exactly `n` of them. */
function hexOf(s: string, n: number): number {
  if (s.length !== n) return -1;
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const h = hexValue(s.charCodeAt(i));
    if (h < 0) return -1;
    v = v * 16 + h;
  }
  return v;
}

const CONTROL_ORDER = ['att', 'umi', 'xpc'];

function badControl(at: number): Gs1Error {
  return epcError(
    'control',
    'Control fields are [att=xHH], [umi=0|1], [xpc=xHHHH], in that order',
    {
      position: at,
    },
  );
}

/**
 * Parses optional control fields at `start`. Returns the controls and the index after the
 * colon that ends them (or `start` when there are none).
 */
function parseControls(
  uri: string,
  start: number,
): { readonly control: EpcControl; readonly next: number } | Gs1Error {
  if (uri.charCodeAt(start) !== OPEN) return { control: {}, next: start };
  const control: { att?: number; umi?: boolean; xpc?: number } = {};
  let last = -1;
  let i = start;
  while (uri.charCodeAt(i) === OPEN) {
    const close = uri.indexOf(']', i);
    const eq = uri.indexOf('=', i);
    if (close < 0 || eq < 0 || eq > close) return badControl(i);
    const name = uri.slice(i + 1, eq);
    const value = uri.slice(eq + 1, close);
    const order = CONTROL_ORDER.indexOf(name);
    if (order <= last) return badControl(i);
    last = order;
    if (name === 'umi') {
      if (value !== '0' && value !== '1') return badControl(i);
      control.umi = value === '1';
    } else {
      const hex = value.slice(1);
      const v =
        value.charAt(0) !== 'x'
          ? -1
          : name === 'att'
            ? hexOf(hex, 2)
            : hexOf(hex, hex.length === 8 ? 8 : 4);
      if (v < 0) return badControl(i);
      if (name === 'att') control.att = v;
      else control.xpc = v;
    }
    i = close + 1;
  }
  if (uri.charCodeAt(i) !== COLON) {
    return epcError('control', 'Control fields must be followed by a colon', { position: i });
  }
  return { control, next: i + 1 };
}

/** Parses a tag URI (`urn:epc:tag:`, TDS 12). The filter range is checked when encoding. */
export function parseTag(uri: string): TagParts | Gs1Error {
  if (!uri.startsWith(TAG_PREFIX)) {
    return epcError('syntax', 'A tag URI starts with urn:epc:tag:', { position: 0 });
  }
  const c = parseControls(uri, TAG_PREFIX.length);
  if (!('next' in c)) return c;
  const nameAt = c.next;
  const colon = uri.indexOf(':', nameAt);
  const name = uri.slice(nameAt, colon < 0 ? uri.length : colon);
  const scheme = schemeByName(name);
  if (!scheme) {
    return epcError('scheme', 'Unknown EPC encoding name', {
      position: nameAt,
      length: name.length,
    });
  }
  if (colon < 0) {
    return epcError('syntax', 'The encoding name must be followed by a colon', {
      position: uri.length,
    });
  }
  let bodyAt = colon + 1;
  let filter: number | undefined;
  if (scheme.fields[0]?.spec.kind === 'filter') {
    const dot = uri.indexOf('.', bodyAt);
    if (dot < 0) {
      return epcError('syntax', 'The filter must be followed by a dot', { position: uri.length });
    }
    const f = uri.slice(bodyAt, dot);
    if (!isNumeric(f)) {
      return epcError('filter', 'The filter must be a number', {
        position: bodyAt,
        length: f.length,
      });
    }
    filter = Number(f);
    bodyAt = dot + 1;
  }
  const components = parseBody(uri, bodyAt, scheme.epcScheme);
  if (!Array.isArray(components)) return components;
  return { control: c.control, scheme, filter, components };
}

export function formatTag(
  scheme: BinaryScheme,
  filter: number | undefined,
  components: readonly string[],
  control: EpcControl,
): string {
  const f = scheme.fields[0]?.spec.kind === 'filter' ? `${filter ?? 0}.` : '';
  return `${TAG_PREFIX}${controlPrefix(control)}${scheme.name}:${f}${canonical(scheme.epcScheme, components)}`;
}

/** `bits` (a binary string) as exactly `n` bits, or undefined when its value needs more. */
function fitBits(bits: string, n: number): string | undefined {
  const one = bits.indexOf('1');
  const significant = one < 0 ? '' : bits.slice(one);
  return significant.length > n ? undefined : significant.padStart(n, '0');
}

/** Hex digits from `start` to `end` as bits, or the URI index of the first bad character. */
function hexBits(uri: string, start: number, end: number): string | number | Gs1Error {
  if (end - start > MAX_RAW_HEX) {
    return epcError('syntax', `A raw URI hex value has at most ${MAX_RAW_HEX} digits`, {
      position: start,
    });
  }
  const b = hexToBits(uri.slice(start, end));
  return typeof b === 'number' ? start + b : b;
}

/** Parses a raw URI (`urn:epc:raw:`, TDS 12, 15.2): hex, AFI and deprecated decimal bodies. */
export function parseRaw(uri: string): RawParts | Gs1Error {
  if (!uri.startsWith(RAW_PREFIX)) {
    return epcError('syntax', 'A raw URI starts with urn:epc:raw:', { position: 0 });
  }
  const c = parseControls(uri, RAW_PREFIX.length);
  if (!('next' in c)) return c;
  const nAt = c.next;
  const dot = uri.indexOf('.', nAt);
  const nText = uri.slice(nAt, dot < 0 ? uri.length : dot);
  if (dot < 0 || !isNumeric(nText) || nText === '0') {
    return epcError('syntax', 'A raw URI body starts with a bit count and a dot', {
      position: nAt,
    });
  }
  const n = Number(nText);
  if (n > MAX_RAW_BITS) {
    return epcError('syntax', `A raw URI holds at most ${MAX_RAW_BITS} bits`, { position: nAt });
  }
  const tooLarge = (): Gs1Error =>
    epcError('syntax', `The value does not fit in ${n} bits`, { position: nAt });
  const valueAt = dot + 1;
  if (uri.charAt(valueAt) !== 'x') {
    const digits = uri.slice(valueAt);
    if (!isNumeric(digits)) {
      return epcError('syntax', 'A raw URI value is x and hex digits, or a decimal number', {
        position: valueAt,
      });
    }
    // A value of at most 496 bits has at most 150 digits: stop longer input before BigInt.
    if (digits.length > MAX_RAW_DIGITS) {
      return epcError('syntax', `A raw URI decimal value has at most ${MAX_RAW_DIGITS} digits`, {
        position: nAt,
      });
    }
    const bits = fitBits(BigInt(digits).toString(2), n);
    return bits === undefined ? tooLarge() : { control: c.control, bits };
  }
  const second = uri.indexOf('.', valueAt);
  if (second < 0) {
    const b = hexBits(uri, valueAt + 1, uri.length);
    if (b instanceof Gs1Error) return b;
    if (typeof b === 'number') return epcError('syntax', 'Not a hex digit', { position: b });
    const bits = fitBits(b, n);
    return bits === undefined ? tooLarge() : { control: c.control, bits };
  }
  // AFI body (toggle 1): N.xAFI.xHEX
  const a = hexBits(uri, valueAt + 1, second);
  if (a instanceof Gs1Error) return a;
  if (typeof a === 'number') return epcError('syntax', 'Not a hex digit', { position: a });
  const afiBits = fitBits(a, 8);
  if (a.length === 0 || afiBits === undefined) {
    return epcError('syntax', 'The AFI is hex digits with a value less than 256', {
      position: valueAt,
    });
  }
  if (uri.charAt(second + 1) !== 'x') {
    return epcError('syntax', 'The AFI must be followed by .x and hex digits', {
      position: second + 1,
    });
  }
  const b = hexBits(uri, second + 2, uri.length);
  if (b instanceof Gs1Error) return b;
  if (typeof b === 'number') return epcError('syntax', 'Not a hex digit', { position: b });
  const bits = fitBits(b, n);
  if (bits === undefined) return tooLarge();
  return { control: c.control, bits, afi: Number.parseInt(afiBits, 2) };
}

/** A raw URI of word-padded `bits` (TDS 15.2.1). */
export function formatRaw(bits: string, control: EpcControl): string {
  return `${RAW_PREFIX}${controlPrefix(control)}${bits.length}.x${bitsToHex(bits)}`;
}
