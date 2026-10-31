// Checks the hand-written binary scheme descriptors (plan decision E3) against GS1's TDT 2.3
// draft definition files: structure (header, length, partition bits, field bit lengths and
// maxima) and a property test that our encodings fully match the TDT regular expressions.
// TDS 2.3 wins over TDT where they disagree; the known cases are in ALLOW below.
import { readdirSync, readFileSync } from 'node:fs';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BinaryScheme, PartitionTable } from '../../src/epc/descriptor.ts';
import { epc } from '../../src/epc/index.ts';
import { BINARY_SCHEMES } from '../../src/epc/schemes.ts';
import { identity } from '../support/epc.ts';

const TDT_DIR = new URL(
  '../../docs/specifications/data/tdt-2.3-draft-2026-09-15a/',
  import.meta.url,
);
const RUNS = 200;

// ---------------------------------------------------------------------------------------------
// Allow-list of known TDT discrepancies (research legacy section 3). TDS wins in each case.
// ---------------------------------------------------------------------------------------------

type AllowId =
  | 'gdti-113-serial'
  | 'giai-96-pure-maximum'
  | 'cpi-var-pure-serial'
  | 'usdod-96-tag-filter'
  | 'adi-var-garbage-alternative'
  | 'integer-leading-zeros';

const ALLOW: Readonly<Record<AllowId, { readonly tds: string; readonly why: string }>> = {
  'gdti-113-serial': {
    tds: 'TDS 14.6.8.2 (Table 14-31), 14.3.6',
    why: 'TDT encodes the GDTI-113 serial as a plain integer (decimalMaximum 17 nines); TDS uses Numeric String ("1" prepended). Skips the BINARY decimalMaximum check of its serial bits.',
  },
  'giai-96-pure-maximum': {
    tds: 'TDS 14.6.5.1 (Table 14-23), 14.3.4',
    why: 'TDT PURE_IDENTITY decimalMaximum of the GIAI-96 asset reference is 10^K-1; the binary bound is 2^N-1, as TDT BINARY and TAG_ENCODING say.',
  },
  'cpi-var-pure-serial': {
    tds: 'TDS 14.6.9.2 (CPI-var coding table: serial "Up to 12 digits")',
    why: 'TDT CPI-var PURE_IDENTITY serial is [0-9]{1,10} while TAG_ENCODING allows {1,12}. Skips pure URI matching for serials over 10 digits.',
  },
  'usdod-96-tag-filter': {
    tds: 'TDS 14.6.13 defers to the DoD guide; TDT itself gives the 4-bit filter decimalMaximum 15',
    why: 'TDT USDOD-96 TAG_ENCODING filter pattern is [0-9]. Filters 10..15 are skipped for the tag URI match.',
  },
  'adi-var-garbage-alternative': {
    tds: 'TDS 14.6.14, Table G-1',
    why: 'TDT ADI-var BINARY patterns contain the alternative (?:111--[01]), which can never match a bit string. Harmless; removed before the BINARY pattern alphabet check.',
  },
  'integer-leading-zeros': {
    tds: 'TDS 5 (NumericComponent), 12.3.1',
    why: 'TDT URI patterns such as [0-9]{1,12} accept leading zeros that TDS forbids for integer fields. Harmless here: we only check that our output matches TDT, never the reverse.',
  },
};

/** Marks a check that an allow-list entry exempts; the id is type-checked against ALLOW. */
function allows(id: AllowId): boolean {
  return id in ALLOW;
}

// ---------------------------------------------------------------------------------------------
// TDT loader: JSON.parse output narrowed with type guards into small local interfaces.
// ---------------------------------------------------------------------------------------------

interface TdtField {
  readonly seq: number;
  readonly name: string;
  readonly bitLength: number | undefined;
  readonly length: number | undefined;
  readonly compaction: string | undefined;
  readonly decimalMaximum: string | undefined;
}
interface TdtOption {
  readonly optionKey: string;
  readonly pattern: string;
  readonly grammar: string;
  readonly fields: readonly TdtField[];
}
interface TdtLevel {
  readonly type: string;
  readonly prefixMatch: string | undefined;
  readonly options: readonly TdtOption[];
}
interface TdtScheme {
  readonly name: string;
  readonly tagLength: number | undefined;
  readonly levels: readonly TdtLevel[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function record(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new TypeError(`${what} is not an object`);
  return v;
}
function list(v: unknown): readonly unknown[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new TypeError(`${key} is not a string`);
  return v;
}
function optStr(o: Record<string, unknown>, key: string): string | undefined {
  return o[key] === undefined ? undefined : str(o, key);
}
function optNum(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') throw new TypeError(`${key} is not a number`);
  return v;
}

function parseField(v: unknown): TdtField {
  const o = record(v, 'field');
  const seq = optNum(o, 'seq');
  if (seq === undefined) throw new TypeError('field without seq');
  return {
    seq,
    name: str(o, 'name'),
    bitLength: optNum(o, 'bitLength'),
    length: optNum(o, 'length'),
    compaction: optStr(o, 'compaction'),
    decimalMaximum: optStr(o, 'decimalMaximum'),
  };
}
function parseOption(v: unknown): TdtOption {
  const o = record(v, 'option');
  const fields = list(o.field).map(parseField);
  // oxlint-disable-next-line no-array-sort -- sorting a fresh local copy by capture group index
  fields.sort((a, b) => a.seq - b.seq);
  return {
    optionKey: str(o, 'optionKey'),
    pattern: str(o, 'pattern'),
    grammar: str(o, 'grammar'),
    fields,
  };
}
function parseLevel(v: unknown): TdtLevel {
  const o = record(v, 'level');
  return {
    type: str(o, 'type'),
    prefixMatch: optStr(o, 'prefixMatch'),
    options: list(o.option).map(parseOption),
  };
}

const FILES: readonly string[] = readdirSync(TDT_DIR).filter((f) => f.endsWith('.json'));

function loadTdt(scheme: BinaryScheme): TdtScheme {
  const file = FILES.find((f) => f.toLowerCase() === `${scheme.name}.json`);
  if (file === undefined) throw new Error(`No TDT file for ${scheme.name}`);
  const root: unknown = JSON.parse(readFileSync(new URL(file, TDT_DIR), 'utf8'));
  const s = record(record(root, 'root')['tdt:epcTagDataTranslation'], 'translation').scheme;
  const o = record(s, 'scheme');
  return {
    name: str(o, 'name'),
    tagLength: optNum(o, 'tagLength'),
    levels: list(o.level).map(parseLevel),
  };
}

function level(t: TdtScheme, type: string): TdtLevel {
  const l = t.levels.find((x) => x.type === type);
  if (!l) throw new Error(`${t.name} has no ${type} level`);
  return l;
}
function option(l: TdtLevel, key: string): TdtOption {
  const o = l.options.find((x) => x.optionKey === key);
  if (!o) throw new Error(`${l.type} has no option ${key}`);
  return o;
}
function fieldNamed(o: TdtOption, name: string): TdtField {
  const f = o.fields.find((x) => x.name === name);
  if (!f) throw new Error(`option ${o.optionKey} has no field ${name}`);
  return f;
}
const fullMatch = (pattern: string): RegExp => new RegExp(`^(?:${pattern})$`);

// ---------------------------------------------------------------------------------------------
// Options: one per GCP length for partitioned schemes, 8 layouts for ADI-var, else "1".
// ---------------------------------------------------------------------------------------------

interface Variant {
  readonly gcpLength?: number;
  /** ADI-var: a 5-character CAGE code (else a 6-character DoDAAC). */
  readonly cage5?: boolean;
  /** ADI-var: an original part number is present. */
  readonly part?: boolean;
  /** ADI-var: the serial starts with '#'. */
  readonly hash?: boolean;
}

function partitionOf(s: BinaryScheme): PartitionTable | undefined {
  for (const f of s.fields) if (f.spec.kind === 'partition') return f.spec.table;
  return undefined;
}

/** TDT ADI-var option keys 1..8: CAGE (1-4) or DoDAAC (5-8) x '#' serial (3,4,7,8) x part (even). */
function adiOptionKey(v: Variant): string {
  return String(
    1 + (v.cage5 === true ? 0 : 4) + (v.hash === true ? 2 : 0) + (v.part === true ? 1 : 0),
  );
}
function variantOf(s: BinaryScheme, key: string): Variant {
  if (partitionOf(s)) return { gcpLength: Number(key) };
  if (s.name === 'adi-var') {
    const k = Number(key) - 1;
    return { cage5: k < 4, hash: (k & 2) !== 0, part: (k & 1) !== 0 };
  }
  return {};
}
function optionKeyOf(s: BinaryScheme, v: Variant): string {
  if (v.gcpLength !== undefined) return String(v.gcpLength);
  return s.name === 'adi-var' ? adiOptionKey(v) : '1';
}

// ---------------------------------------------------------------------------------------------
// Expected BINARY grammar per descriptor and option.
// ---------------------------------------------------------------------------------------------

type Expected =
  | { readonly kind: 'lit'; readonly value: string }
  | {
      readonly kind: 'field';
      readonly bits: number | undefined;
      readonly compaction: string | undefined;
      /** A number to compare, null for "absent", undefined for "not compared". */
      readonly length?: number | null;
      /** Largest value of the binary field and of its URI component (integer fields only). */
      readonly binaryMax?: bigint;
      readonly uriMax?: bigint;
    };

const pow2 = (n: number): bigint => 1n << BigInt(n);
const pow10 = (n: number): bigint => 10n ** BigInt(n);
const minBig = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const bin = (v: number, bits: number): string => v.toString(2).padStart(bits, '0');
const lit = (value: string): Expected => ({ kind: 'lit', value });
const int = (bits: number, max: bigint, length?: number | null): Expected =>
  length === undefined
    ? { kind: 'field', bits, compaction: undefined, binaryMax: max, uriMax: max }
    : { kind: 'field', bits, compaction: undefined, length, binaryMax: max, uriMax: max };
const chars = (bits: number | undefined, compaction: string): Expected => ({
  kind: 'field',
  bits,
  compaction,
});

function expectedGrammar(s: BinaryScheme, v: Variant): Expected[] {
  const out: Expected[] = [lit(bin(s.header, 8))];
  for (const { spec } of s.fields) {
    switch (spec.kind) {
      case 'filter':
        out.push(int(spec.bits, pow2(spec.bits) - 1n));
        break;
      case 'zeros':
        out.push(lit('0'.repeat(spec.bits)));
        break;
      case 'integer':
        out.push(
          int(
            spec.bits,
            minBig(
              pow2(spec.bits),
              spec.maxDigits === undefined ? pow2(spec.bits) : pow10(spec.maxDigits),
            ) - 1n,
          ),
        );
        break;
      case 'fixedWidthInteger':
        out.push(int(spec.bits, pow10(spec.digits) - 1n, spec.digits));
        break;
      case 'string7':
        out.push(chars(spec.bits, '7-bit'));
        break;
      case 'numericString':
        out.push({
          kind: 'field',
          bits: spec.bits,
          compaction: undefined,
          binaryMax: BigInt(`1${'9'.repeat(spec.maxDigits)}`),
          uriMax: pow10(spec.maxDigits) - 1n,
        });
        break;
      case 'cage6':
        if (v.cage5 === true) out.push(lit('100000'), chars(30, '6-bit'));
        else out.push(chars(36, '6-bit'));
        break;
      case 'string6Var':
        if (spec.min > 0 || v.part === true) out.push(chars(undefined, '6-bit'));
        out.push(lit('000000'));
        break;
      case 'ascii8':
        out.push(chars(spec.chars * 8, '8-bit'));
        break;
      case 'partition': {
        const p = spec.table.findIndex((row) => row[1] === v.gcpLength);
        const row = spec.table[p];
        if (!row) throw new Error(`${s.name}: no partition row for ${v.gcpLength}`);
        const [m, l, n, k] = row;
        out.push(lit(bin(p, 3)), int(m, pow10(l) - 1n, l));
        switch (spec.other) {
          case 'padded':
            out.push(int(n, pow10(k) - 1n, k));
            break;
          case 'unpadded':
            out.push(int(n, minBig(pow2(n), pow10(k)) - 1n, null));
            break;
          case 'string7':
            out.push(chars(n, '7-bit'));
            break;
          case 'cpref6':
            out.push(chars(undefined, '6-bit'), lit('000000'));
            break;
          default: {
            const never: never = spec.other;
            throw new Error(String(never));
          }
        }
        break;
      }
      default: {
        const never: never = spec;
        throw new Error(String(never));
      }
    }
  }
  return out;
}

type GrammarToken = { readonly lit: string } | { readonly name: string };
function grammarTokens(grammar: string): GrammarToken[] {
  return [...grammar.matchAll(/'([^']*)'|(\S+)/g)].map((m) =>
    m[2] === undefined ? { lit: m[1] ?? '' } : { name: m[2] },
  );
}

function showExpected(e: Expected): string {
  if (e.kind === 'lit') return `'${e.value}'`;
  const len = e.length === undefined ? '' : ` length=${e.length ?? 'none'}`;
  return `field bits=${e.bits ?? 'none'} ${e.compaction ?? 'integer'}${len}`;
}
function showActual(o: TdtOption, t: GrammarToken, e: Expected | undefined): string {
  if ('lit' in t) return `'${t.lit}'`;
  const f = fieldNamed(o, t.name);
  const len = e?.kind === 'field' && e.length !== undefined ? ` length=${f.length ?? 'none'}` : '';
  return `field bits=${f.bitLength ?? 'none'} ${f.compaction ?? 'integer'}${len}`;
}

/** TDT field names of `o` aligned with the expected grammar, for the decimalMaximum checks. */
function alignedFields(o: TdtOption, expected: readonly Expected[]): [TdtField, Expected][] {
  const out: [TdtField, Expected][] = [];
  grammarTokens(o.grammar).forEach((t, i) => {
    const e = expected[i];
    if ('name' in t && e?.kind === 'field') out.push([fieldNamed(o, t.name), e]);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Arbitraries for each component kind.
// ---------------------------------------------------------------------------------------------

const DIGITS = '0123456789';
/** TDS Table A-1 (GS1 AI encodable character set 82). */
const CSET82 =
  '!"%&\'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
/** TDS Table G-1 (6-bit characters), without '#'. */
const G1 = '-/0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** CAGE and DoDAAC characters: 0-9 and A-Z without I and O (TDS 6.3.17). */
const CAGE = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const A1_ESCAPES: Readonly<Record<string, string>> = {
  '"': '%22',
  '%': '%25',
  '&': '%26',
  '/': '%2F',
  '<': '%3C',
  '>': '%3E',
  '?': '%3F',
};

/** Strings of `min` to `max` characters; a third of them exactly `max` long, to hit the limit. */
const charsOf = (alphabet: string, min: number, max: number): fc.Arbitrary<string> => {
  const unit = fc.constantFrom(...alphabet.split(''));
  return fc.oneof(
    { weight: 2, arbitrary: fc.string({ unit, minLength: min, maxLength: max }) },
    { weight: 1, arbitrary: fc.string({ unit, minLength: max, maxLength: max }) },
  );
};
const escapeA1 = (s: string): string =>
  s
    .split('')
    .map((c) => A1_ESCAPES[c] ?? c)
    .join('');
const escapeG1 = (s: string): string =>
  s
    .split('')
    .map((c) => (c === '/' ? '%2F' : c === '#' ? '%23' : c))
    .join('');
const string7 = (max: number): fc.Arbitrary<string> => charsOf(CSET82, 1, max).map(escapeA1);
/** Integers without leading zeros up to `max`; a sixth of them exactly `max`. */
const integer = (max: bigint): fc.Arbitrary<string> =>
  fc
    .oneof({ weight: 5, arbitrary: fc.bigInt({ min: 0n, max }) }, fc.constant(max))
    .map((n) => n.toString());

/**
 * Components one step past a field's limit (or, for the ADI serial, a lone '#'). `tdt` says whether the TDT URI patterns must reject
 * them too: true for lengths, false for integer values (TDT patterns do not encode maxima).
 */
interface Over {
  readonly components: readonly string[];
  readonly tdt: boolean;
}
interface Sample {
  readonly filter: number;
  readonly components: readonly string[];
  readonly variant: Variant;
  readonly overs: readonly Over[];
}
interface Part {
  readonly components: readonly string[];
  readonly variant: Variant;
  readonly overs: readonly Over[];
}
const A = (n: number): string => 'A'.repeat(n);

function partitionArb(
  spec: Extract<BinaryScheme['fields'][number]['spec'], { kind: 'partition' }>,
): fc.Arbitrary<Part> {
  return fc.constantFrom(...spec.table).chain(([, l, n, k]) => {
    const max = minBig(pow2(n), pow10(k)) - 1n;
    const [other, over]: [fc.Arbitrary<string>, (d: string) => Over] =
      spec.other === 'padded'
        ? [charsOf(DIGITS, k, k), (d) => ({ components: [`${d}0`], tdt: true })]
        : spec.other === 'unpadded'
          ? [integer(max), () => ({ components: [(max + 1n).toString()], tdt: false })]
          : spec.other === 'string7'
            ? [string7(k), () => ({ components: [A(k + 1)], tdt: true })]
            : [
                charsOf(`${G1}#`, 1, k).map(escapeG1),
                () => ({ components: [A(k + 1)], tdt: true }),
              ];
    return fc.tuple(charsOf(DIGITS, l, l), other).map(([c, d]) => {
      const o = over(d);
      return {
        components: [c, d],
        variant: { gcpLength: l },
        overs: [{ components: [c, ...o.components], tdt: o.tdt }],
      };
    });
  });
}

const one = (a: fc.Arbitrary<string>, over: string, tdt: boolean): fc.Arbitrary<Part> =>
  a.map((c) => ({ components: [c], variant: {}, overs: [{ components: [over], tdt }] }));

function fieldArb(spec: BinaryScheme['fields'][number]['spec']): fc.Arbitrary<Part> {
  switch (spec.kind) {
    case 'filter':
    case 'zeros':
      return fc.constant({ components: [], variant: {}, overs: [] });
    case 'integer': {
      const max =
        minBig(
          pow2(spec.bits),
          spec.maxDigits === undefined ? pow2(spec.bits) : pow10(spec.maxDigits),
        ) - 1n;
      return one(integer(max), (max + 1n).toString(), false);
    }
    case 'fixedWidthInteger':
      return one(charsOf(DIGITS, spec.digits, spec.digits), `1${'0'.repeat(spec.digits)}`, true);
    case 'string7':
      return one(string7(spec.maxChars), A(spec.maxChars + 1), true);
    case 'numericString':
      return one(charsOf(DIGITS, 1, spec.maxDigits), '1'.repeat(spec.maxDigits + 1), true);
    case 'cage6':
      return charsOf(CAGE, 5, 6).map((c) => ({
        components: [c],
        variant: { cage5: c.length === 5 },
        overs: [{ components: [A(7)], tdt: true }],
      }));
    case 'ascii8':
      return one(charsOf(CAGE, 5, 6), A(spec.chars + 1), true);
    case 'string6Var': {
      const overs = [{ components: [A(spec.max + 1)], tdt: true }];
      if (spec.hash === 'none') {
        return charsOf(G1, spec.min, spec.max).map((c) => ({
          components: [escapeG1(c)],
          variant: { part: c.length > 0 },
          overs,
        }));
      }
      // TDS 6.3.18: ADIExtendedComponent = 0*1"%23" 1*ADIChar, so '#' needs a character after it;
      // a lone '#' is checked as an invalid value, like the over-long one.
      const serialOvers = [...overs, { components: ['%23'], tdt: true }];
      return fc
        .oneof(
          charsOf(G1, Math.max(spec.min, 1), spec.max),
          charsOf(G1, 1, spec.max - 1).map((c) => `#${c}`),
        )
        .map((c) => ({
          components: [escapeG1(c)],
          variant: { hash: c.startsWith('#') },
          overs: serialOvers,
        }));
    }
    case 'partition':
      return partitionArb(spec);
    default: {
      const never: never = spec;
      throw new Error(String(never));
    }
  }
}

function sampleArb(s: BinaryScheme): fc.Arbitrary<Sample> {
  const filterBits = s.fields.find((f) => f.spec.kind === 'filter')?.spec;
  const maxFilter = filterBits?.kind === 'filter' ? 2 ** filterBits.bits - 1 : 0;
  return fc
    .tuple(fc.integer({ min: 0, max: maxFilter }), ...s.fields.map((f) => fieldArb(f.spec)))
    .map(([filter, ...parts]) => ({
      filter,
      components: parts.flatMap((p) => p.components),
      variant: parts.reduce<Variant>((acc, p) => ({ ...acc, ...p.variant }), {}),
      // Each over replaces one part's components and keeps the others valid.
      overs: parts.flatMap((p, i) =>
        p.overs.map((o) => ({
          components: parts.flatMap((q, j) => (i === j ? o.components : q.components)),
          tdt: o.tdt,
        })),
      ),
    }));
}

function hexToBits(hex: string): string {
  return hex
    .split('')
    .map((c) => Number.parseInt(c, 16).toString(2).padStart(4, '0'))
    .join('');
}

// ---------------------------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------------------------

function byName(name: string): BinaryScheme {
  const s = BINARY_SCHEMES.find((x) => x.name === name);
  if (!s) throw new Error(name);
  return s;
}

describe('TDT conformance: allow-list', () => {
  it('has exactly the six known TDT discrepancies, each with a TDS citation', () => {
    expect(Object.keys(ALLOW)).toHaveLength(6);
    expect(Object.values(ALLOW).every((a) => a.tds.startsWith('TDS ') && a.why.length > 0)).toBe(
      true,
    );
  });

  it('gdti-113-serial: TDT still gives the serial a plain integer maximum', () => {
    const b = level(loadTdt(byName('gdti-113')), 'BINARY');
    expect(b.options.map((o) => fieldNamed(o, 'serial').decimalMaximum)).toEqual(
      Array.from({ length: 7 }, () => '99999999999999999'),
    );
  });

  it('giai-96-pure-maximum: TDT PURE_IDENTITY still uses 10^K-1, BINARY 2^N-1', () => {
    const t = loadTdt(byName('giai-96'));
    const pure = level(t, 'PURE_IDENTITY').options.map(
      (o) => fieldNamed(o, 'indassetref').decimalMaximum,
    );
    const binary = level(t, 'BINARY').options.map(
      (o) => fieldNamed(o, 'indassetref').decimalMaximum,
    );
    expect(pure).toEqual([13, 14, 15, 16, 17, 18, 19].map((k) => (pow10(k) - 1n).toString()));
    expect(binary).toEqual([42, 45, 48, 52, 55, 58, 62].map((n) => (pow2(n) - 1n).toString()));
  });

  it('cpi-var-pure-serial: TDT PURE_IDENTITY rejects a 12-digit serial that TAG_ENCODING and TDS allow', () => {
    const t = loadTdt(byName('cpi-var'));
    const e = epc.decode('urn:epc:id:cpi:0614141.A.123456789012', { scheme: 'cpi-var', filter: 1 });
    expect(
      fullMatch(option(level(t, 'PURE_IDENTITY'), '7').pattern).test(identity(e).pureIdentityUri),
    ).toBe(false);
    expect(
      fullMatch(option(level(t, 'TAG_ENCODING'), '7').pattern).test(identity(e).tagUri ?? ''),
    ).toBe(true);
  });

  it('usdod-96-tag-filter: TDT TAG_ENCODING rejects filter 10 although its maximum is 15', () => {
    const t = loadTdt(byName('usdod-96'));
    const tag = option(level(t, 'TAG_ENCODING'), '1');
    const e = epc.decode('urn:epc:id:usdod:2S194.12', { scheme: 'usdod-96', filter: 10 });
    expect(identity(e).tagUri).toBe('urn:epc:tag:usdod-96:10.2S194.12');
    expect(fullMatch(tag.pattern).test(identity(e).tagUri ?? '')).toBe(false);
    expect(fieldNamed(tag, 'filter').decimalMaximum).toBe('15');
  });

  it('adi-var-garbage-alternative: TDT ADI-var BINARY patterns still contain (?:111--[01])', () => {
    const b = level(loadTdt(byName('adi-var')), 'BINARY');
    expect(b.options.map((o) => o.pattern.includes('|(?:111--[01])'))).toEqual(
      Array.from({ length: 8 }, () => true),
    );
  });

  it('integer-leading-zeros: TDT accepts a leading-zero serial that TDS and our decoder reject', () => {
    const t = loadTdt(byName('sgtin-96'));
    const uri = 'urn:epc:id:sgtin:0614141.812345.0123';
    expect(fullMatch(option(level(t, 'PURE_IDENTITY'), '7').pattern).test(uri)).toBe(true);
    expect(epc.tryDecode(uri, { scheme: 'sgtin-96' })).toMatchObject({
      ok: false,
      errors: [{ code: 'EPC_FIELD_OVERFLOW', details: { why: 'leading-zero' } }],
    });
  });
});

describe.each(BINARY_SCHEMES.map((s) => [s.name, s] as const))('TDT conformance: %s', (_, s) => {
  const tdt = loadTdt(s);
  const binary = level(tdt, 'BINARY');
  const tag = level(tdt, 'TAG_ENCODING');
  const pure = level(tdt, 'PURE_IDENTITY');
  const table = partitionOf(s);
  const expectedKeys = table
    ? ['12', '11', '10', '9', '8', '7', '6']
    : s.name === 'adi-var'
      ? ['1', '2', '3', '4', '5', '6', '7', '8']
      : ['1'];

  it('is the TDT scheme of the same name, with one option per GCP length or layout', () => {
    expect(tdt.name.toLowerCase()).toBe(s.name);
    expect(binary.options.map((o) => o.optionKey)).toEqual(expectedKeys);
    expect(tag.options.map((o) => o.optionKey)).toEqual(expectedKeys);
    expect(pure.options.map((o) => o.optionKey)).toEqual(expectedKeys);
  });

  it('has the TDT header (BINARY prefixMatch)', () => {
    expect(binary.prefixMatch).toBe(bin(s.header, 8));
  });

  it('has the TDT tagLength (absent for the variable-length schemes)', () => {
    expect(tdt.tagLength).toBe(s.bits);
  });

  it.runIf(table !== undefined)('has the TDT partition bits, M, L, N and K per GCP length', () => {
    const rows = binary.options.map((o) => {
      const t = grammarTokens(o.grammar);
      const gcp = fieldNamed(o, 'gs1companyprefix');
      const at = t.findIndex((x) => 'name' in x && x.name === 'gs1companyprefix');
      const next = t[at + 1];
      const other = next && 'name' in next ? fieldNamed(o, next.name) : undefined;
      const bits = o.pattern.slice(`^${binary.prefixMatch ?? ''}([01]{3})`.length).slice(0, 3);
      return [Number.parseInt(bits, 2), gcp.bitLength, gcp.length, other?.bitLength, other?.length];
    });
    const spec = s.fields.find((f) => f.spec.kind === 'partition')?.spec;
    const other = spec?.kind === 'partition' ? spec.other : undefined;
    const ours = expectedKeys.map((key) => {
      const p = (table ?? []).findIndex((row) => row[1] === Number(key));
      const [m, l, n, k] = table?.[p] ?? [];
      return [p, m, l, other === 'cpref6' ? undefined : n, other === 'padded' ? k : undefined];
    });
    expect(binary.options.every((o) => o.pattern.startsWith(`^${bin(s.header, 8)}([01]{3})`))).toBe(
      true,
    );
    expect(rows).toEqual(ours);
  });

  it('has the TDT BINARY field sequence: literals, bit lengths, compaction and lengths', () => {
    const actual = binary.options.map((o) => {
      const exp = expectedGrammar(s, variantOf(s, o.optionKey));
      return [o.optionKey, ...grammarTokens(o.grammar).map((t, i) => showActual(o, t, exp[i]))];
    });
    const expected = binary.options.map((o) => [
      o.optionKey,
      ...expectedGrammar(s, variantOf(s, o.optionKey)).map(showExpected),
    ]);
    expect(actual).toEqual(expected);
  });

  it('has the TDT decimalMaximum of every integer field, at every level', () => {
    const mismatches: string[] = [];
    for (const o of binary.options) {
      const uriMax = new Map<string, bigint>();
      for (const [f, e] of alignedFields(o, expectedGrammar(s, variantOf(s, o.optionKey)))) {
        if (e.kind !== 'field' || e.binaryMax === undefined || e.uriMax === undefined) continue;
        uriMax.set(f.name, e.uriMax);
        const allowed = s.name === 'gdti-113' && f.name === 'serial' && allows('gdti-113-serial');
        if (!allowed && f.decimalMaximum !== e.binaryMax.toString())
          mismatches.push(`BINARY ${o.optionKey} ${f.name}: ${f.decimalMaximum} != ${e.binaryMax}`);
      }
      for (const l of [tag, pure]) {
        for (const f of option(l, o.optionKey).fields) {
          if (f.decimalMaximum === undefined) continue;
          const max = uriMax.get(f.name);
          const allowed = s.name === 'giai-96' && l === pure && allows('giai-96-pure-maximum');
          if (!allowed && f.decimalMaximum !== max?.toString())
            mismatches.push(`${l.type} ${o.optionKey} ${f.name}: ${f.decimalMaximum} != ${max}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('has BINARY patterns made only of 0, 1 and regular expression syntax', () => {
    const garbage = '|(?:111--[01])';
    const skipGarbage = s.name === 'adi-var' && allows('adi-var-garbage-alternative');
    const odd = binary.options
      .map((o) => (skipGarbage ? o.pattern.split(garbage).join('') : o.pattern))
      .filter((p) => !/^[01^()[\]{}?:!|+*,0-9]*$/.test(p));
    expect(odd).toEqual([]);
  });

  it(`encodes random pure identities into bits and URIs the TDT patterns fully match (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(sampleArb(s), (sample) => {
        const pureIn = `urn:epc:id:${s.epcScheme}:${sample.components.join('.')}`;
        const hasFilter = s.fields.some((f) => f.spec.kind === 'filter');
        const e = epc.decode(
          pureIn,
          hasFilter ? { scheme: s.name, filter: sample.filter } : { scheme: s.name },
        );
        const bits = hexToBits(e.hex ?? '').slice(0, e.bitLength);
        const key = optionKeyOf(s, sample.variant);
        const b = option(binary, key);
        const problems: string[] = [];
        if (identity(e).pureIdentityUri !== pureIn)
          problems.push(`pure URI changed: ${identity(e).pureIdentityUri}`);
        if (s.bits !== undefined && e.bitLength !== s.bits)
          problems.push(`bitLength ${e.bitLength}`);
        const m = fullMatch(b.pattern).exec(bits);
        if (!m) problems.push(`BINARY option ${key} does not match ${bits}`);
        for (const f of b.fields) {
          const g = m?.[f.seq];
          const allowed = s.name === 'gdti-113' && f.name === 'serial' && allows('gdti-113-serial');
          if (g === undefined || f.compaction !== undefined || f.decimalMaximum === undefined)
            continue;
          if (!allowed && BigInt(`0b${g}`) > BigInt(f.decimalMaximum))
            problems.push(`BINARY ${f.name} ${BigInt(`0b${g}`)} > ${f.decimalMaximum}`);
        }
        // TDT's USDOD-96 tag pattern takes one filter digit.
        const skipTag = s.name === 'usdod-96' && sample.filter > 9 && allows('usdod-96-tag-filter');
        if (!skipTag && !fullMatch(option(tag, key).pattern).test(identity(e).tagUri ?? ''))
          problems.push(`TAG_ENCODING option ${key} does not match ${identity(e).tagUri}`);
        // TDT's CPI-var pure pattern takes at most 10 serial digits.
        const skipPure =
          s.name === 'cpi-var' &&
          (sample.components[2] ?? '').length > 10 &&
          allows('cpi-var-pure-serial');
        if (!skipPure && !fullMatch(option(pure, key).pattern).test(identity(e).pureIdentityUri))
          problems.push(
            `PURE_IDENTITY option ${key} does not match ${identity(e).pureIdentityUri}`,
          );
        for (const over of sample.overs) {
          const body = over.components.join('.');
          const overPure = `urn:epc:id:${s.epcScheme}:${body}`;
          const overTag = `urn:epc:tag:${s.name}:${hasFilter ? `${sample.filter}.` : ''}${body}`;
          if (epc.tryDecode(overPure, { scheme: s.name }).ok)
            problems.push(`accepted past a limit: ${overPure}`);
          const tdtAccepts = [
            ...pure.options.map((o) => fullMatch(o.pattern).test(overPure)),
            ...tag.options.map((o) => fullMatch(o.pattern).test(overTag)),
          ].some(Boolean);
          if (over.tdt && tdtAccepts) problems.push(`TDT accepts past our limit: ${overPure}`);
        }
        expect(problems).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
