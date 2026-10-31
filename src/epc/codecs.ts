import { BitReader, BitWriter } from '../core/bits.ts';
import { Gs1Error } from '../core/errors.ts';
import {
  decode6,
  encode6,
  escape6,
  escapeGs3a3,
  isCage,
  unescape6,
  unescapeGs3a3,
} from './charsets.ts';
import type { FieldDef, FieldSpec, PartitionRow } from './descriptor.ts';
import { epcError, overflow } from './errors.ts';
import { CSET82 } from '../core/cset.ts';

/** URI components a field consumes: 2 for a partition, none for filter and fixed zeros. */
export function componentCount(spec: FieldSpec): number {
  if (spec.kind === 'partition') return 2;
  return spec.kind === 'filter' || spec.kind === 'zeros' ? 0 : 1;
}

function allDigits(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return true;
}

function pow2(bits: number): bigint {
  return 1n << BigInt(bits);
}
function pow10(digits: number): bigint {
  return 10n ** BigInt(digits);
}

/** A NumericComponent (TDS 5: digits, no leading zero unless "0") that fits `bits`. */
function encodeNumeric(
  name: string,
  s: string,
  bits: number,
  w: BitWriter,
  maxDigits?: number,
): Gs1Error | undefined {
  if (s.length === 0 || !allDigits(s))
    return overflow(name, 'not-numeric', `${name} must be a decimal number`);
  if (s.length > 1 && s.charCodeAt(0) === 48) {
    return overflow(
      name,
      'leading-zero',
      `${name} cannot have leading zeros in this scheme; use a scheme with an alphanumeric ${name}`,
    );
  }
  if (maxDigits !== undefined && s.length > maxDigits)
    return overflow(name, 'too-many-digits', `${name} has more than ${maxDigits} digits`);
  const v = BigInt(s);
  if (v >= pow2(bits)) return overflow(name, 'too-large', `${name} does not fit in ${bits} bits`);
  w.write(v, bits);
  return undefined;
}

/** 7-bit characters of a GS3A3 component, right-padded with zeros to `bits` (TDS 14.3.2). */
function encodeString7(
  name: string,
  s: string,
  bits: number,
  maxChars: number,
  w: BitWriter,
): Gs1Error | undefined {
  const u = unescapeGs3a3(s);
  if ('badAt' in u)
    return epcError('escape', `${name} has a character that must be escaped or is not allowed`, {
      details: { field: name, at: u.badAt },
    });
  if (u.value.length > maxChars)
    return overflow(name, 'too-many-chars', `${name} has more than ${maxChars} characters`);
  for (let i = 0; i < u.value.length; i++) w.write(u.value.charCodeAt(i), 7);
  const pad = bits - u.value.length * 7;
  if (pad > 0) w.write(0, pad);
  return undefined;
}

/** 6-bit characters plus a 000000 terminator (TDS 14.3.8, 14.3.9). */
function encodeString6(
  name: string,
  s: string,
  min: number,
  max: number,
  hash: 'any' | 'first' | 'none',
  w: BitWriter,
): Gs1Error | undefined {
  const u = unescape6(s, hash);
  if ('badAt' in u)
    return epcError('escape', `${name} has a character that is not allowed`, {
      details: { field: name, at: u.badAt },
    });
  if (u.value.length < min || u.value.length > max)
    return overflow(name, 'length', `${name} must have ${min} to ${max} characters`);
  // TDS 6.3.18: ADIExtendedComponent = 0*1"%23" 1*ADIChar, so a leading '#' needs a character after it.
  if (hash === 'first' && u.value === '#')
    return overflow(name, 'length', `${name} must have a character after '#'`);
  for (const ch of u.value) w.write(encode6(ch), 6);
  w.write(0, 6);
  return undefined;
}

function encodePartition(
  def: FieldDef,
  spec: Extract<FieldSpec, { kind: 'partition' }>,
  c: string,
  d: string,
  w: BitWriter,
): Gs1Error | undefined {
  if (!allDigits(c))
    return epcError('component', 'The company prefix must be digits', {
      details: { field: 'companyPrefix' },
    });
  const p = spec.table.findIndex((row) => row[1] === c.length);
  const row: PartitionRow | undefined = spec.table[p];
  if (!row)
    return epcError('gcp-length', `A company prefix must have 6 to 12 digits, not ${c.length}`, {
      details: { field: 'companyPrefix' },
    });
  const [m, , n, k] = row;
  w.write(p, 3);
  w.write(BigInt(c), m);
  const name = def.name;
  switch (spec.other) {
    case 'padded':
      if (d.length !== k || !allDigits(d))
        return overflow(
          name,
          'length',
          `${name} must have exactly ${k} digits with a ${c.length}-digit company prefix`,
        );
      w.write(k === 0 ? 0n : BigInt(d), n);
      return undefined;
    case 'unpadded':
      return encodeNumeric(name, d, n, w, k);
    case 'string7':
      return encodeString7(name, d, n, k, w);
    case 'cpref6':
      return encodeString6(name, d, 1, k, 'any', w);
  }
  return spec.other satisfies never;
}

/** Encodes one field's components (URI form) into `w`. The filter field is the engine's. */
export function encodeField(
  def: FieldDef,
  components: readonly string[],
  w: BitWriter,
): Gs1Error | undefined {
  const spec = def.spec;
  const s = components[0] ?? '';
  switch (spec.kind) {
    case 'filter':
      return epcError('filter', 'The filter is written by the engine');
    case 'zeros':
      w.write(0, spec.bits);
      return undefined;
    case 'integer':
      return encodeNumeric(def.name, s, spec.bits, w, spec.maxDigits);
    case 'fixedWidthInteger':
      if (s.length !== spec.digits || !allDigits(s))
        return overflow(def.name, 'length', `${def.name} must have exactly ${spec.digits} digits`);
      w.write(BigInt(s), spec.bits);
      return undefined;
    case 'string7':
      return encodeString7(def.name, s, spec.bits, spec.maxChars, w);
    case 'numericString':
      if (s.length === 0 || !allDigits(s))
        return overflow(def.name, 'not-numeric', `${def.name} must be digits`);
      if (s.length > spec.maxDigits)
        return overflow(
          def.name,
          'too-many-digits',
          `${def.name} has more than ${spec.maxDigits} digits`,
        );
      w.write(BigInt(`1${s}`), spec.bits);
      return undefined;
    case 'cage6':
      if (!isCage(s))
        return epcError(
          'component',
          'A CAGE code or DoDAAC has 5 or 6 characters 0-9 and A-Z without I and O',
          { details: { field: def.name } },
        );
      if (s.length === 5) w.write(0b100000, 6);
      for (const ch of s) w.write(encode6(ch), 6);
      return undefined;
    case 'string6Var':
      return encodeString6(def.name, s, spec.min, spec.max, spec.hash, w);
    case 'ascii8':
      if (!isCage(s))
        return epcError(
          'component',
          'A CAGE code or DoDAAC has 5 or 6 characters 0-9 and A-Z without I and O',
          { details: { field: def.name } },
        );
      for (const ch of s.padStart(spec.chars, ' ')) w.write(ch.charCodeAt(0), 8);
      return undefined;
    case 'partition':
      return encodePartition(def, spec, s, components[1] ?? '', w);
  }
  return spec satisfies never;
}

function bad(def: FieldDef, bit: number, message: string): Gs1Error {
  return epcError('binary', message, { details: { field: def.name, bit } });
}

/** Reads 7-bit characters from `bits` bits: one or more non-zero, then only zeros (TDS 14.4.2). */
function decodeString7(
  def: FieldDef,
  r: BitReader,
  bits: number,
  maxChars: number,
): string | Gs1Error {
  const start = r.position;
  let value = '';
  let ended = false;
  let left = bits;
  while (left >= 7) {
    const v = r.read(7);
    left -= 7;
    if (v === 0) ended = true;
    else if (ended)
      return epcError('binary', `${def.name} has a character after the end of the string`, {
        details: { field: def.name, bit: r.position - 7 },
      });
    else {
      const ch = String.fromCharCode(v);
      if (!CSET82.includes(ch))
        return epcError('binary', `${def.name} has a character outside Table A-1`, {
          details: { field: def.name, bit: r.position - 7 },
        });
      value += ch;
    }
  }
  if (left > 0 && r.read(left) !== 0)
    return bad(def, start, `${def.name} has non-zero padding bits`);
  if (value.length === 0)
    return epcError('binary', `${def.name} is empty`, { details: { field: def.name, bit: start } });
  if (value.length > maxChars)
    return epcError('binary', `${def.name} has more than ${maxChars} characters`, {
      details: { field: def.name, bit: start },
    });
  return escapeGs3a3(value);
}

/** Reads 6-bit characters up to the 000000 terminator (TDS 14.4.8, 14.4.9). */
function decodeString6(
  def: FieldDef,
  r: BitReader,
  min: number,
  max: number,
  hash: 'any' | 'first' | 'none',
): string | Gs1Error {
  const start = r.position;
  let value = '';
  for (;;) {
    const v = r.read(6);
    if (v === 0) break;
    const ch = decode6(v);
    const hashOk = hash === 'any' || (hash === 'first' && value.length === 0);
    if (ch === '' || (ch === '#' && !hashOk))
      return epcError('binary', `${def.name} has a character outside Table G-1`, {
        details: { field: def.name, bit: r.position - 6 },
      });
    value += ch;
    if (value.length > max)
      return epcError('binary', `${def.name} must have ${min} to ${max} characters`, {
        details: { field: def.name, bit: start },
      });
  }
  if (value.length < min)
    return epcError('binary', `${def.name} must have ${min} to ${max} characters`, {
      details: { field: def.name, bit: start },
    });
  if (hash === 'first' && value === '#')
    return epcError('binary', `${def.name} must have a character after '#'`, {
      details: { field: def.name, bit: start },
    });
  return escape6(value);
}

function decodePartition(
  def: FieldDef,
  spec: Extract<FieldSpec, { kind: 'partition' }>,
  r: BitReader,
): string[] | Gs1Error {
  const start = r.position;
  const p = r.read(3);
  const row = spec.table[p];
  if (!row)
    return epcError('partition', `Partition value ${p} is not defined`, {
      details: { field: 'partition', bit: r.position - 3 },
    });
  const [m, l, n, k] = row;
  const c = r.readBig(m);
  if (c >= pow10(l))
    return bad(def, start, 'The company prefix has more digits than its partition allows');
  const company = c.toString().padStart(l, '0');
  switch (spec.other) {
    case 'padded': {
      const d = r.readBig(n);
      if (d >= pow10(k))
        return bad(def, start, `${def.name} has more digits than its partition allows`);
      return [company, k === 0 ? '' : d.toString().padStart(k, '0')];
    }
    case 'unpadded': {
      // TDS Tables 14-23, 14-25: the reference has at most K digits, as when encoding.
      const d = r.readBig(n);
      return d < pow10(k)
        ? [company, d.toString()]
        : bad(def, start, `${def.name} has more than ${k} digits`);
    }
    case 'string7': {
      const d = decodeString7(def, r, n, k);
      return typeof d === 'string' ? [company, d] : d;
    }
    case 'cpref6': {
      const d = decodeString6(def, r, 1, k, 'any');
      return typeof d === 'string' ? [company, d] : d;
    }
  }
  return spec.other satisfies never;
}

/** Decodes one field into URI-form components. Throws RangeError if the bits run out. */
export function decodeField(def: FieldDef, r: BitReader): string[] | Gs1Error {
  const start = r.position;
  const spec = def.spec;
  switch (spec.kind) {
    case 'filter':
      return [String(r.read(spec.bits))];
    case 'zeros':
      return r.readBig(spec.bits) === 0n ? [] : bad(def, start, 'Reserved bits must be zero');
    case 'integer': {
      const v = r.readBig(spec.bits);
      // TDS Table 14-26: the CPI-var serial has at most 12 digits, as when encoding.
      return spec.maxDigits !== undefined && v >= pow10(spec.maxDigits)
        ? bad(def, start, `${def.name} has more than ${spec.maxDigits} digits`)
        : [v.toString()];
    }
    case 'fixedWidthInteger': {
      const v = r.readBig(spec.bits);
      return v >= pow10(spec.digits)
        ? bad(def, start, `${def.name} has more than ${spec.digits} digits`)
        : [v.toString().padStart(spec.digits, '0')];
    }
    case 'string7': {
      const s = decodeString7(def, r, spec.bits, spec.maxChars);
      return typeof s === 'string' ? [s] : s;
    }
    case 'numericString': {
      const v = r.readBig(spec.bits).toString();
      return v.length >= 2 && v.charCodeAt(0) === 49
        ? [v.slice(1)]
        : bad(def, start, `${def.name} is not a valid Numeric String`);
    }
    case 'cage6': {
      let value = '';
      let prefixed = false;
      for (let i = 0; i < 6; i++) {
        const v = r.read(6);
        if (i === 0 && v === 0b100000) {
          prefixed = true;
          continue;
        }
        const ch = decode6(v);
        if (ch === '') return bad(def, start, 'Invalid CAGE code or DoDAAC');
        value += ch;
      }
      return value.length === (prefixed ? 5 : 6) && isCage(value)
        ? [value]
        : bad(def, start, 'Invalid CAGE code or DoDAAC');
    }
    case 'string6Var': {
      const s = decodeString6(def, r, spec.min, spec.max, spec.hash);
      return typeof s === 'string' ? [s] : s;
    }
    case 'ascii8': {
      let value = '';
      for (let i = 0; i < spec.chars; i++) value += String.fromCharCode(r.read(8));
      let from = 0;
      while (from < value.length && value.charCodeAt(from) === 32) from++;
      const trimmed = value.slice(from);
      return isCage(trimmed) ? [trimmed] : bad(def, start, 'Invalid CAGE code or DoDAAC');
    }
    case 'partition':
      return decodePartition(def, spec, r);
  }
  return spec satisfies never;
}
