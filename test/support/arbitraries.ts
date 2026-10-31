import * as fc from 'fast-check';
import vectorsFile from '../vectors/linters.json' with { type: 'json' };
import { checkCharacterPair, checkDigit, CSET39, CSET64, CSET82 } from '../../src/core/index.ts';
import type { AiComponent, AiEntry } from '../../src/ai/dictionary.ts';
import { LINTERS } from '../../src/ai/linters/index.ts';
import { aiPatternMatches, getAi } from '../../src/ai/lookup.ts';
import { AI_TABLE } from '../../src/ai/table.gen.ts';

export type Element = readonly [ai: string, value: string];
export type Message = readonly Element[];

const ALPHABET: Record<AiComponent['cset'], string> = {
  N: '0123456789',
  X: CSET82,
  Y: CSET39,
  Z: CSET64,
};

export function charArb(cset: AiComponent['cset']): fc.Arbitrary<string> {
  if (cset !== 'X') return fc.constantFrom(...ALPHABET[cset].split(''));
  return fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom(...'0123456789ABCabc'.split('')) },
    { weight: 1, arbitrary: fc.constantFrom(...ALPHABET.X.split('')) },
  );
}

export const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** Mostly-valid dates and times; days run to 31 so month-length and leap-year rules are hit. */
const yymmdd = (minDay: number): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.integer({ min: 0, max: 99 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: minDay, max: 31 }),
    )
    .map(([y, m, d]) => pad2(y) + pad2(m) + pad2(d));
const yyyymmdd = (minDay: number): fc.Arbitrary<string> =>
  fc
    .tuple(fc.integer({ min: 1890, max: 2110 }), yymmdd(minDay))
    .map(([y, md]) => y.toString() + md.slice(2));
const hh = fc.integer({ min: 0, max: 23 }).map(pad2);
const mi = fc.integer({ min: 0, max: 59 }).map(pad2);

const DATE_LINTERS: Record<string, fc.Arbitrary<string>> = {
  yymmd0: yymmdd(0),
  yymmdd: yymmdd(1),
  yyyymmd0: yyyymmdd(0),
  yyyymmdd: yyyymmdd(1),
  hhmi: fc.tuple(hh, mi).map(([h, m]) => h + m),
  hh,
  mi,
  ss: mi,
};

/** Linters whose valid values are drawn from the reference vectors rather than synthesised. */
export const POOLED: ReadonlySet<string> = new Set([
  'iso4217',
  'iso3166',
  'iso3166alpha2',
  'iso3166999',
  'iso5218',
  'pcenc',
  'latitude',
  'longitude',
  'yesno',
  'hyphen',
  'importeridx',
  'packagetype',
  'mediatype',
  'posinseqslash',
  'nonzero',
  'winding',
  'zero',
  'pieceoftotal',
  'iban',
  'nozeroprefix',
  'couponcode',
  'couponposoffer',
]);

const OK_VECTORS = new Map<string, string[]>();
/** Every reference vector (accepted and rejected) per linter, for probing linter edge cases. */
const ALL_VECTORS = new Map<string, string[]>();
for (const v of vectorsFile.vectors) {
  for (const [map, include] of [
    [OK_VECTORS, v.ok],
    [ALL_VECTORS, true],
  ] as const) {
    if (!include) continue;
    const list = map.get(v.linter) ?? [];
    list.push(v.data);
    map.set(v.linter, list);
  }
}

const CSET_LINTER = {
  N: LINTERS.csetnumeric,
  X: LINTERS.cset82,
  Y: LINTERS.cset39,
  Z: LINTERS.cset64,
} as const;

function passesComponent(c: AiComponent, s: string): boolean {
  return (
    s.length >= c.min &&
    s.length <= c.max &&
    CSET_LINTER[c.cset](s) === null &&
    c.linters.every((l) => LINTERS[l](s) === null)
  );
}

function poolFor(c: AiComponent): string[] {
  const pooled = c.linters.filter((l) => POOLED.has(l));
  if (pooled.length === 0) return [];
  const candidates = new Set(pooled.flatMap((l) => OK_VECTORS.get(l) ?? []));
  return [...candidates].filter((s) => passesComponent(c, s));
}

/** Rewrites a random string so that the structural linters (GCP, check characters) pass. */
function fixUp(c: AiComponent, s: string): string {
  let out = s;
  const setDigits = (from: number, count: number): void => {
    if (out.length < from + count) return;
    let digits = '';
    for (let i = from; i < from + count; i++) {
      const ch = out.charCodeAt(i);
      digits += ch >= 48 && ch <= 57 ? out[i] : String((ch * 7) % 10);
    }
    out = out.slice(0, from) + digits + out.slice(from + count);
  };
  if (c.linters.includes('gcppos1')) setDigits(0, 4);
  if (c.linters.includes('gcppos2')) setDigits(1, 4);
  if (c.linters.includes('hasnondigit') && /^\d+$/.test(out) && out.length > 2) {
    out = `${out.slice(0, -3)}A${out.slice(-2)}`;
  }
  if (c.linters.includes('csum') && /^\d{2,}$/.test(out)) {
    out = out.slice(0, -1) + checkDigit(out.slice(0, -1));
  }
  if (c.linters.includes('csumalpha') && out.length > 2 && /^[0-9A-Za-z]+$/.test(out)) {
    out = out.slice(0, -2) + checkCharacterPair(out.slice(0, -2));
  }
  return out;
}

function randomComponentArb(c: AiComponent, boundary: boolean): fc.Arbitrary<string> {
  const inRange = [
    { weight: 6, arbitrary: fc.integer({ min: c.min, max: Math.min(c.max, c.min + 6) }) },
    { weight: 2, arbitrary: fc.integer({ min: c.min, max: c.max }) },
  ];
  const lengths = boundary
    ? fc.oneof(...inRange, {
        weight: 2,
        arbitrary: fc.constantFrom(Math.max(0, c.min - 1), c.max + 1),
      })
    : fc.oneof(...inRange);
  return lengths.chain((n) =>
    fc.array(charArb(c.cset), { minLength: n, maxLength: n }).map((a) => a.join('')),
  );
}

/** A component value built to pass its cset and linters (most of the time). */
function wellFormedComponentArb(c: AiComponent): fc.Arbitrary<string> {
  const date = c.linters.map((l) => DATE_LINTERS[l]).find((a) => a !== undefined);
  if (date && c.min === c.max) return date;
  const pool = poolFor(c);
  if (pool.length > 0) return fc.constantFrom(...pool);
  // GCP linters need four leading digits, so do not draw shorter values for them.
  const gcp = c.linters.includes('gcppos1') || c.linters.includes('gcppos2') ? 5 : 0;
  const min = Math.min(c.max, Math.max(c.min, gcp));
  return randomComponentArb({ ...c, min }, false).map((s) => fixUp(c, s));
}

function valueFrom(
  e: AiEntry,
  componentArb: (c: AiComponent) => fc.Arbitrary<string>,
): fc.Arbitrary<string> {
  const mandatory = e.components.filter((c) => !c.optional);
  const optional = e.components.filter((c) => c.optional);
  return fc
    .tuple(fc.tuple(...mandatory.map(componentArb)), fc.integer({ min: 0, max: optional.length }))
    .chain(([parts, nOpt]) =>
      fc
        .tuple(...optional.slice(0, nOpt).map(componentArb))
        .map((opts) => [...parts, ...opts].join('')),
    );
}

/**
 * Reference linter vectors (accepted or not) that fit the component's length range. Vectors
 * containing "|" are skipped: the engine reads it as its composite-symbol separator.
 */
function edgeCaseComponentArb(c: AiComponent): fc.Arbitrary<string> {
  const random = randomComponentArb(c, true);
  const vectors = [...new Set(c.linters.flatMap((l) => ALL_VECTORS.get(l) ?? []))].filter(
    (v) => v.length >= c.min && v.length <= c.max && !v.includes('|'),
  );
  return vectors.length === 0 ? random : fc.oneof(fc.constantFrom(...vectors), random);
}

/**
 * Mostly well-formed values; one in eight is noisy (unfixed random characters, lengths one past
 * either bound) and one in sixteen draws linter reference vectors, so every run keeps a share
 * of malformed elements and of linter edge cases.
 */
function valueArb(e: AiEntry): fc.Arbitrary<string> {
  return fc.oneof(
    { weight: 13, arbitrary: valueFrom(e, wellFormedComponentArb) },
    { weight: 2, arbitrary: valueFrom(e, (c) => randomComponentArb(c, true)) },
    { weight: 1, arbitrary: valueFrom(e, edgeCaseComponentArb) },
  );
}

export const VALUE_ARBS: ReadonlyMap<string, fc.Arbitrary<string>> = new Map<
  string,
  fc.Arbitrary<string>
>(AI_TABLE.map((e) => [e.ai, valueArb(e)]));
export const elementFor = (ai: string): fc.Arbitrary<Element> =>
  (VALUE_ARBS.get(ai) ?? fc.constant('')).map((v) => [ai, v] as const);

// AIs that start most real messages (keys), weighted so associations are often satisfiable.
const KEYS = [
  '00',
  '01',
  '02',
  '253',
  '255',
  '401',
  '402',
  '414',
  '8003',
  '8004',
  '8006',
  '8017',
  '8018',
];
const anyElement = fc.constantFrom(...AI_TABLE.map((e) => e.ai)).chain(elementFor);
const elementArb = fc.oneof(
  { weight: 4, arbitrary: anyElement },
  { weight: 1, arbitrary: fc.constantFrom(...KEYS).chain(elementFor) },
);

const BY_PATTERN = new Map<string, string[]>();
function aisMatching(pattern: string): string[] {
  let list = BY_PATTERN.get(pattern);
  if (!list) {
    list = AI_TABLE.filter((e) => aiPatternMatches(pattern, e.ai)).map((e) => e.ai);
    BY_PATTERN.set(pattern, list);
  }
  return list;
}

/** The req rules of `m` that no group satisfies (self-matches excluded, as in the engine). */
function unsatisfied(m: Message): string[][][] {
  const present = m.map(([ai]) => ai);
  const out: string[][][] = [];
  for (const ai of new Set(present)) {
    for (const rule of getAi(ai)?.req ?? []) {
      const ok = rule.some((g) =>
        g.every((p) => present.some((o) => o !== ai && aiPatternMatches(p, o))),
      );
      if (!ok) out.push(rule.map((g) => [...g]));
    }
  }
  return out;
}

/** Appends AIs that satisfy each missing requirement (one random group per rule), recursively. */
export function satisfyArb(m: Message, depth: number): fc.Arbitrary<Message> {
  const missing = unsatisfied(m);
  if (missing.length === 0 || depth === 0) return fc.constant(m);
  const additions = fc.tuple(
    ...missing.map((rule) =>
      fc
        .constantFrom(...rule)
        .chain((group) =>
          fc.tuple(...group.map((p) => fc.constantFrom(...aisMatching(p)).chain(elementFor))),
        ),
    ),
  );
  return additions.chain((adds) => {
    const next = [...m];
    for (const group of adds) {
      for (const el of group) if (!next.some(([a]) => a === el[0])) next.push(el);
    }
    return satisfyArb(next, depth - 1);
  });
}

/** Optionally repeats an element, either verbatim (allowed) or with a fresh value (rejected). */
function withRepeat(m: Message): fc.Arbitrary<Message> {
  return fc
    .tuple(fc.nat({ max: m.length - 1 }), fc.nat({ max: m.length }), fc.boolean())
    .chain(([from, to, same]) => {
      const el = m[from];
      if (!el) return fc.constant(m);
      const repeated: fc.Arbitrary<Element> = same ? fc.constant(el) : elementFor(el[0]);
      return repeated.map((r) => [...m.slice(0, to), r, ...m.slice(to)]);
    });
}

/** Shuffles element order (a full-length shuffled subarray is a permutation). */
export const shuffled = (m: Message): fc.Arbitrary<Message> =>
  fc.shuffledSubarray([...m], { minLength: m.length, maxLength: m.length });

export const messageArb: fc.Arbitrary<Message> = fc
  .tuple(
    fc.array(elementArb, { minLength: 1, maxLength: 4 }),
    fc.integer({ min: 0, max: 9 }),
    fc.integer({ min: 0, max: 9 }),
  )
  .chain(([base, satisfyRoll, repeatRoll]) => {
    // 80% of messages get their requisites filled in, so association-valid messages are common.
    const satisfied = satisfyRoll < 8 ? satisfyArb(base, 3).chain(shuffled) : fc.constant(base);
    return satisfied.chain((m) => (repeatRoll === 0 ? withRepeat(m) : fc.constant(m)));
  });
