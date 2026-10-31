// Checks our "+" and "++" EPC encoder against encodings frozen from GS1's TDT 2.3 draft
// translator by scripts/gen-epc-tdt-vectors.ts (plan decision E19), and decodes each TDT
// encoding back. Only TDT's encoder is used: its decoder misreads "++" hostnames and drops
// +AIDC data (research plus 3, rows 13 to 15). TDS 2.3 wins over TDT where they disagree; each
// known case is in KNOWN_TDT_PLUS_DIFFERENCES, and ours must still differ from TDT there.
import { describe, expect, it } from 'vitest';
import vectorsFile from '../vectors/epc-tdt-plus.json' with { type: 'json' };
import { type ElementString, parse } from '../../src/ai/index.ts';
import type { Gs1Error } from '../../src/core/errors.ts';
import { type Epc, type PlusSchemeName, epc } from '../../src/epc/index.ts';

interface PlusTdtVector {
  readonly scheme: PlusSchemeName;
  readonly elementString: string;
  readonly filter: number;
  /** "++" schemes only. */
  readonly hostname?: string;
  /** TDT's HEX output: nibble padded, where ours is padded to a 16-bit word. */
  readonly expectHex: string;
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON file of known shape
const VECTORS = vectorsFile.vectors as readonly PlusTdtVector[];
const NOTES: readonly string[] = vectorsFile.provenance.notes;

type Field = 'hex' | 'decode';

/** One comparison: what we produce and what TDT gives, for one field of one vector. */
interface Case {
  readonly name: string;
  readonly vector: PlusTdtVector;
  readonly field: Field;
  readonly ours: unknown;
  readonly theirs: unknown;
}

interface Difference {
  readonly fields: readonly Field[];
  /** The TDS 2.3 text (or research row) that shows TDT is wrong. */
  readonly tds: string;
  readonly why: string;
  readonly applies: (v: PlusTdtVector) => boolean;
  /** What TDS gives; ours must equal it. */
  readonly expected: (c: Case) => unknown;
}

const KNOWN_TDT_PLUS_DIFFERENCES: ReadonlyMap<string, Difference> = new Map<string, Difference>([
  [
    'over-496-bits',
    {
      fields: ['hex', 'decode'],
      tds: 'TDS 9.3 Table 9-3 (the EPC bank holds at most 496 bits of EPC), plan decision F11',
      why: 'TDT encodes EPCs of any length; a long "++" EPC with three +AIDC AIs can exceed 496 bits. Ours refuses to encode it (EPC_FIELD_OVERFLOW, too-long) and to decode it (INVALID_EPC, binary).',
      // TDT hex is nibble padded, so more than 124 digits means more than 496 bits.
      applies: (v) => v.expectHex.length > 124,
      expected: (c) =>
        c.field === 'hex' ? ['EPC_FIELD_OVERFLOW too-long'] : ['INVALID_EPC binary'],
    },
  ],
]);

const codes = (errors: readonly Gs1Error[]): string[] =>
  errors.map((e) => {
    const d = e.details?.['why'] ?? e.details?.['reason'];
    return typeof d === 'string' ? `${e.code} ${d}` : e.code;
  });

/** The AI values of an element string in a canonical order: equal iff equivalent. */
function aiSet(es: ElementString): string {
  const parts = es.entries().map(([ai, value]) => `(${ai})${value}`);
  // oxlint-disable-next-line no-array-sort -- sorting a fresh local array; toSorted is not ES2022
  parts.sort();
  return parts.join('');
}

/** The decoded fields compared with the vector's input. */
function decoded(e: Epc): unknown {
  if (e.kind !== 'plus') return `not a plus EPC: ${e.kind}`;
  return {
    binaryScheme: e.binaryScheme,
    filter: e.filter,
    hostname: e.hostname ?? null,
    elementString: aiSet(e.elementString),
  };
}

function casesOf(v: PlusTdtVector): Case[] {
  const name = `${v.scheme} ${v.elementString}${v.hostname === undefined ? '' : ` @${v.hostname}`} f${v.filter}`;
  const out: Case[] = [];
  const add = (field: Field, ours: unknown, theirs: unknown): void => {
    out.push({ name: `${name}: ${field}`, vector: v, field, ours, theirs });
  };
  const r = epc.tryFromElementString(v.elementString, {
    scheme: v.scheme,
    filter: v.filter,
    ...(v.hostname === undefined ? {} : { hostname: v.hostname }),
  });
  if (r.ok) {
    // Modulo trailing zero padding: TDT pads to a nibble, we pad to a 16-bit word.
    const hex = r.value.hex ?? '';
    const n = Math.max(hex.length, v.expectHex.length);
    add('hex', hex.padEnd(n, '0'), v.expectHex.padEnd(n, '0'));
  } else add('hex', codes(r.errors), v.expectHex);
  const d = epc.tryDecode(v.expectHex);
  add('decode', d.ok ? decoded(d.value) : codes(d.errors), {
    binaryScheme: v.scheme,
    filter: v.filter,
    hostname: v.hostname ?? null,
    elementString: aiSet(parse(v.elementString)),
  });
  return out;
}

const CASES = VECTORS.flatMap(casesOf);
const known = (c: Case): string | undefined => {
  for (const [id, d] of KNOWN_TDT_PLUS_DIFFERENCES)
    if (d.fields.includes(c.field) && d.applies(c.vector)) return id;
  return undefined;
};
const AGREE = CASES.filter((c) => known(c) === undefined);
const DIFFER = CASES.flatMap((c) => {
  const id = known(c);
  const d = id === undefined ? undefined : KNOWN_TDT_PLUS_DIFFERENCES.get(id);
  return id === undefined || d === undefined ? [] : [{ id, d, c }];
});

describe('GS1 TDT 2.3 frozen "+" and "++" encodings', () => {
  it('cover all 24 plus schemes, and every input TDT refused is noted', () => {
    expect(VECTORS.length).toBe(417);
    expect(new Set(VECTORS.map((v) => v.scheme)).size).toBe(24);
    // 20 inputs per scheme: each became a vector or a "skipped" note.
    expect(VECTORS.length + NOTES.filter((n) => n.startsWith('skipped ')).length).toBe(480);
    expect(CASES.length).toBe(2 * VECTORS.length);
    // At least 90% of the vectors agree outright in both directions.
    const agreeing = VECTORS.filter((v) => CASES.every((c) => c.vector !== v || !known(c)));
    expect(agreeing.length).toBeGreaterThanOrEqual(VECTORS.length * 0.9);
  });

  it.each(AGREE.map((c) => [c.name, c] as const))('%s agrees with TDT', (_name, c) => {
    expect(c.ours).toEqual(c.theirs);
  });

  it.each(DIFFER.map((x) => [`${x.c.name} (${x.id})`, x] as const))(
    '%s differs from TDT and matches TDS',
    (_name, { d, c }) => {
      expect(c.ours).not.toEqual(c.theirs);
      expect(c.ours).toEqual(d.expected(c));
    },
  );

  it('lists each known difference once, and each still applies', () => {
    expect(KNOWN_TDT_PLUS_DIFFERENCES.size).toBe(1);
    const used = new Set(DIFFER.map((x) => x.id));
    expect([...KNOWN_TDT_PLUS_DIFFERENCES.keys()].filter((id) => !used.has(id))).toEqual([]);
  });
});
