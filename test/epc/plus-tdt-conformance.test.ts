// Checks the hand-written "+" and "++" scheme descriptors (src/epc/plus.ts) against GS1's TDT 2.3
// draft definition files: the BINARY header, the toggle and filter that follow it, the body AI
// order (encodedAI), the hostname (binaryHostname) and, for DSGTIN, the date type indicators.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLUS_SCHEMES, PRIORITISED_DATE_AIS, type PlusScheme } from '../../src/epc/plus.ts';

const TDT_DIR = new URL(
  '../../docs/specifications/data/tdt-2.3-draft-2026-09-15a/',
  import.meta.url,
);

// ---------------------------------------------------------------------------------------------
// TDT loader: JSON.parse output narrowed with type guards into small local interfaces.
// ---------------------------------------------------------------------------------------------

interface TdtOption {
  readonly optionKey: string;
  readonly grammar: string | undefined;
  readonly encodedAI: readonly string[];
  readonly aiSequence: readonly string[];
}
interface TdtLevel {
  readonly type: string;
  readonly prefixMatch: string | undefined;
  readonly options: readonly TdtOption[];
}
interface TdtScheme {
  readonly file: string;
  readonly name: string;
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
function strings(v: unknown, what: string): string[] {
  return list(v).map((x) => {
    if (typeof x !== 'string') throw new TypeError(`${what} holds a non-string`);
    return x;
  });
}

function parseOption(v: unknown): TdtOption {
  const o = record(v, 'option');
  return {
    optionKey: str(o, 'optionKey'),
    grammar: optStr(o, 'grammar'),
    encodedAI: list(o.encodedAI).map((x) => str(record(x, 'encodedAI'), 'ai')),
    aiSequence: strings(o.aiSequence, 'aiSequence'),
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

/** The TDT definition files of the "+" and "++" schemes. */
const PLUS_FILES: readonly string[] = readdirSync(TDT_DIR).filter((f) => f.endsWith('+.json'));

function loadTdt(file: string): TdtScheme {
  const root: unknown = JSON.parse(readFileSync(new URL(file, TDT_DIR), 'utf8'));
  const s = record(record(root, 'root')['tdt:epcTagDataTranslation'], 'translation').scheme;
  const o = record(s, 'scheme');
  return { file, name: str(o, 'name'), levels: list(o.level).map(parseLevel) };
}

function level(t: TdtScheme, type: string): TdtLevel {
  const l = t.levels.find((x) => x.type === type);
  if (!l) throw new Error(`${t.name} has no ${type} level`);
  return l;
}

/** Grammar tokens: quoted literals (quotes removed) and field names. */
function tokens(grammar: string | undefined): string[] {
  return (grammar ?? '').split(' ').map((t) => t.replaceAll("'", ''));
}

const ours = (t: TdtScheme): PlusScheme => {
  const s = PLUS_SCHEMES.find((x) => x.name === t.name.toLowerCase());
  if (s === undefined) throw new Error(`no plus scheme for TDT ${t.name}`);
  return s;
};

const TDT: readonly TdtScheme[] = PLUS_FILES.map(loadTdt);
const PAIRS = TDT.map((t) => [t.name, t, ours(t)] as const);
const BINARY_OPTIONS = PAIRS.flatMap(([name, t, s]) =>
  level(t, 'BINARY').options.map((o) => [`${name} option ${o.optionKey}`, o, s] as const),
);
const header = (s: PlusScheme): string => s.header.toString(2).padStart(8, '0');

describe('"+" and "++" descriptors against the TDT 2.3 draft definitions', () => {
  it('has one TDT file for each of the 24 plus schemes, named as the scheme', () => {
    expect(PLUS_FILES.length).toBe(24);
    expect(TDT.map((t) => `${t.name}.json`)).toEqual(PLUS_FILES);
    expect(new Set(PAIRS.map(([, , s]) => s.name)).size).toBe(PLUS_SCHEMES.length);
  });

  it.each(PAIRS)('%s: BINARY prefixMatch is our header', (_name, t, s) => {
    expect(level(t, 'BINARY').prefixMatch).toBe(header(s));
  });

  it.each(BINARY_OPTIONS)(
    '%s: header, then the +AIDC toggle and the filter (TDS 14.5.1, 14.5.2)',
    (_name, o, s) => {
      expect(tokens(o.grammar).slice(0, 3)).toEqual([header(s), 'dataToggle', 'filter']);
    },
  );

  it.each(BINARY_OPTIONS)('%s: encodedAI order is our body AI order', (_name, o, s) => {
    expect(o.encodedAI).toEqual(s.ais);
  });

  it.each(BINARY_OPTIONS)('%s: binaryHostname if and only if "++"', (_name, o, s) => {
    expect(tokens(o.grammar).includes('binaryHostname')).toBe(s.hostname);
  });

  it.each(BINARY_OPTIONS)('%s: a date type indicator if and only if DSGTIN', (_name, o, s) => {
    // DSGTIN grammars carry a 4-bit literal (the indicator) right after the filter.
    expect(/^[01]{4}$/.test(tokens(o.grammar)[3] ?? '')).toBe(s.date);
  });

  describe.each(PAIRS.filter(([, , s]) => s.date))('%s date type indicators', (_name, t) => {
    const binary = level(t, 'BINARY').options;
    const json = level(t, 'GS1_AI_JSON').options;
    // Indicator (from the BINARY grammar) to date AI (third AI of the same option's JSON form).
    const tdtMap = binary.map((o) => {
      const ai = json.find((j) => j.optionKey === o.optionKey)?.aiSequence[2];
      return [Number.parseInt(tokens(o.grammar)[3] ?? '', 2), ai] as const;
    });

    it('defines the 7 indicators 0000 to 0110', () => {
      expect(tdtMap.map(([i]) => i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    it('maps each indicator to the same date AI as ours (TDS 14.5.3)', () => {
      expect(tdtMap.map(([, ai]) => ai)).toEqual(PRIORITISED_DATE_AIS);
    });
  });
});
