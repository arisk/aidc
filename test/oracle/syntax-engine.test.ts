import { fileURLToPath } from 'node:url';
import * as fc from 'fast-check';
import { GS1encoder } from 'gs1encoder';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ElementString, format, hri, tryParse } from '../../src/ai/index.ts';
import { isLinterName } from '../../src/ai/linters/index.ts';
import { getAi } from '../../src/ai/lookup.ts';
import { tokenize } from '../../src/ai/parse.ts';
import { AI_TABLE } from '../../src/ai/table.gen.ts';
import {
  type Element,
  type Message,
  charArb,
  elementFor,
  messageArb,
  pad2,
  POOLED,
  shuffled,
} from '../support/arbitraries.ts';

const DICT = fileURLToPath(
  new URL('../../docs/specifications/data/gs1-syntax-dictionary-2026-01-27.txt', import.meta.url),
);
const RUNS = Number(process.env['ORACLE_RUNS'] ?? 5000);

const UINT32 = 2 ** 32;
/** True when a 10-digit coordinate exceeds `max` but wraps into range modulo 2^32. */
const wrapsIntoRange = (digits: string, max: number): boolean => {
  const v = Number(digits);
  return v > max && v % UINT32 <= max;
};

/**
 * Confirmed Syntax Engine bugs where our behaviour follows the GS1 General Specifications.
 * Each entry names the GenSpecs section that justifies the difference and a predicate on the
 * generated message that filters exactly that case out of the properties.
 */
const KNOWN_ENGINE_DIFFERENCES: ReadonlyArray<{
  readonly genspecs: string;
  readonly why: string;
  readonly matches: (m: Message) => boolean;
}> = [
  {
    genspecs:
      '7.13 (and 3.7.30): X = 10,000,000 * (latitude + 90), Y = 10,000,000 * ((longitude + 360) mod 360)',
    why:
      'lint_latitude.c and lint_longitude.c accumulate the 10 digits in an `unsigned long`, which is ' +
      '32 bits in the WASM build, so values of 2^32 and above wrap (e.g. longitude 5000000000 becomes ' +
      '705032704) and are accepted. GenSpecs bounds X to 0..1800000000 and Y to 0..3600000000; we reject.',
    matches: (m) =>
      m.some(
        ([ai, v]) =>
          ai === '4309' &&
          (wrapsIntoRange(v.slice(0, 10), 1_800_000_000) ||
            wrapsIntoRange(v.slice(10, 20), 3_600_000_000)),
      ),
  },
];

const isKnownDifference = (m: Message): boolean =>
  KNOWN_ENGINE_DIFFERENCES.some((d) => d.matches(m));

/** For free-form inputs: whether the elements the engine accepted hit a known difference. */
const engineAcceptedKnownDifference = (theirs: Verdict): boolean =>
  theirs.ok &&
  isKnownDifference(
    tokenize(theirs.bracketed, { allowUnknownAIs: true }).elements.map((e) => [e.ai, e.value]),
  );

let engine: GS1encoder;
beforeAll(async () => {
  engine = await GS1encoder.create({ syntaxDictionary: DICT });
});

type Verdict = { ok: true; raw: string; bracketed: string } | { ok: false; message: string };

function oracleBracketed(bracketed: string): Verdict {
  try {
    engine.aiDataStr = bracketed;
    return { ok: true, raw: engine.dataStr, bracketed: engine.aiDataStr };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function oracleWithoutRequisites(bracketed: string): Verdict {
  engine.validateAIassociations = false;
  try {
    return oracleBracketed(bracketed);
  } finally {
    engine.validateAIassociations = true;
  }
}

function oraclePermittingUnknown(input: string): Verdict {
  engine.permitUnknownAIs = true;
  try {
    return input.startsWith('^') ? oracleRaw(input) : oracleBracketed(input);
  } finally {
    engine.permitUnknownAIs = false;
  }
}

/** The engine's HRI lines for accepted bracketed input, or null when it rejects the input. */
function oracleHri(bracketed: string, titles: boolean): string[] | null {
  engine.permitUnknownAIs = true;
  engine.includeDataTitlesInHRI = titles;
  try {
    engine.aiDataStr = bracketed;
    return engine.hri;
  } catch {
    return null;
  } finally {
    engine.permitUnknownAIs = false;
    engine.includeDataTitlesInHRI = false;
  }
}

function oracleRaw(raw: string): Verdict {
  try {
    engine.dataStr = raw;
    return { ok: true, raw: engine.dataStr, bracketed: engine.aiDataStr };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

// ---------------------------------------------------------------------------------------------
// Statistics, printed once at the end (with ORACLE_STATS=1) to show how much of the space a
// run explored.

interface Stats {
  valid: number;
  invalid: number;
  reasons: Map<string, number>;
}
const STATS: Record<string, Stats> = {};

function record(property: string, v: Verdict): void {
  const s = (STATS[property] ??= { valid: 0, invalid: 0, reasons: new Map() });
  if (v.ok) {
    s.valid++;
    return;
  }
  s.invalid++;
  const reason = v.message
    .replaceAll(/\(\d+\)/g, '(AI)')
    .replaceAll(/"[^"]*"/g, '"..."')
    .replace(/(not satisfied|No known AI is a prefix of): .*$/, '$1: ...');
  s.reasons.set(reason, (s.reasons.get(reason) ?? 0) + 1);
}

afterAll(() => {
  engine.free();
  if (process.env['ORACLE_STATS'] !== '1') return;
  for (const [name, s] of Object.entries(STATS)) {
    const total = s.valid + s.invalid;
    const pct = total === 0 ? 0 : (100 * s.valid) / total;
    const ranked = [...s.reasons.entries()];
    // Sorts a fresh copy; Array#toSorted is outside the ES2022 lib this repo targets.
    // oxlint-disable-next-line unicorn/no-array-sort
    ranked.sort((a, b) => b[1] - a[1]);
    const top = ranked
      .slice(0, 12)
      .map(([r, n]) => `    ${n.toString().padStart(6)}  ${r}`)
      .join('\n');
    // Written to stdout directly: vitest only replays console output of failing tests.
    process.stdout.write(
      `[oracle] ${name}: ${total} inputs, ${s.valid} valid (${pct.toFixed(1)}%), ${s.invalid} invalid\n  top engine rejections:\n${top}\n`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// Arbitraries

const AI_LENGTH_BY_PREFIX = new Map(AI_TABLE.map((e) => [e.ai.slice(0, 2), e.ai.length]));

// Prefixes of 3- and 4-digit AIs: the only ones where an unknown AI can be delimited in raw data.
const KNOWN_PREFIXES = [...AI_LENGTH_BY_PREFIX.entries()]
  .filter(([, n]) => n > 2)
  .map(([p]) => Number(p));
const UNKNOWN_LENGTHS = fc.oneof(
  { weight: 4, arbitrary: fc.integer({ min: 1, max: 20 }) },
  { weight: 2, arbitrary: fc.constantFrom(5, 6, 7, 12, 13, 14) },
  { weight: 1, arbitrary: fc.integer({ min: 84, max: 91 }) },
);

/** The predefined value length the engine applies to an unknown AI, if any. */
const unknownFixedLength = (ai: string): number | undefined => {
  const p = Number(ai.slice(0, 2));
  if (ai.length === 3 && p === 41) return 13;
  return ai.length === 4 && p >= 31 && p <= 36 ? 6 : undefined;
};

/**
 * Elements with arbitrary 2 to 4 digit AIs, mostly unassigned. Value lengths cluster on the
 * predefined lengths (6, 13) and on the 90-character ceiling.
 */
const unknownElementArb: fc.Arbitrary<Element> = fc
  .tuple(
    fc.oneof(
      { weight: 2, arbitrary: fc.constantFrom(...KNOWN_PREFIXES) },
      { weight: 1, arbitrary: fc.integer({ min: 0, max: 99 }) },
    ),
    fc.integer({ min: 0, max: 3 }).map((r) => r > 0),
    fc.integer({ min: 2, max: 4 }),
    fc.array(fc.constantFrom(...'0123456789'.split('')), { minLength: 2, maxLength: 2 }),
    fc.boolean(),
    UNKNOWN_LENGTHS,
  )
  .chain(([prefix, followPrefix, anyLength, digits, natural, randomLength]) => {
    // Mostly use the AI length implied by the prefix (which the engine requires) and the
    // predefined value length where one applies.
    const implied = AI_LENGTH_BY_PREFIX.get(pad2(prefix)) ?? anyLength;
    const ai = (pad2(prefix) + digits.join('')).slice(0, followPrefix ? implied : anyLength);
    if (getAi(ai)) return elementFor(ai);
    const n = (natural ? unknownFixedLength(ai) : undefined) ?? randomLength;
    return fc
      .array(charArb('X'), { minLength: n, maxLength: n })
      .map((v) => [ai, v.join('')] as const);
  });

const withUnknownArb: fc.Arbitrary<Message> = fc
  .tuple(messageArb, fc.array(unknownElementArb, { minLength: 1, maxLength: 3 }))
  .chain(([m, unknown]) => shuffled([...m, ...unknown]));

/**
 * Free-form token soup for parser robustness: brackets, escapes, separators, AIs and value
 * fragments in any order. "|" is left out on purpose: it is the engine's composite-symbol
 * separator, a symbology input convention rather than element string syntax.
 */
const SYNTAX_TOKENS = [
  '(',
  ')',
  '\\',
  '\\(',
  '^',
  '((',
  '()',
  '0',
  '1',
  '9',
  'A',
  'a',
  ' ',
  '~',
  '(01)',
  '(10)',
  '(21)',
  '(17)',
  '(00)',
  '(8030)',
  '(253)',
  '(3103)',
  '(99)',
  '(0)',
  '(01',
  '01',
  '10',
  '21',
  '17',
  '09506000134352',
  '006141411234567890',
  '201225',
  'ABC123',
];
const tokenSoup = (start: string): fc.Arbitrary<string> =>
  fc
    .array(fc.constantFrom(...SYNTAX_TOKENS), { minLength: 0, maxLength: 8 })
    .map((t) => start + t.join(''));

/** Applies one small edit (insert, delete or replace at a drawn position) to a string. */
const mutate = (input: string): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.nat({ max: input.length }),
      fc.integer({ min: 0, max: 2 }),
      fc.constantFrom(...SYNTAX_TOKENS, '^', '^^', '\u001d'),
    )
    .map(([at, op, token]) => {
      if (op === 0) return input.slice(0, at) + token + input.slice(at);
      if (op === 1) return input.slice(0, at) + input.slice(at + 1);
      return input.slice(0, at) + token + input.slice(at + 1);
    });

/**
 * Ruling R14: our bracketed parser accepts HRI-style spaces directly after an AI's ")" and
 * directly before a "(" or the end of input; the Syntax Engine rejects them. Free-form and
 * mutated inputs with such spaces are skipped rather than compared (spaces elsewhere, e.g.
 * inside a value, are still compared: both sides reject them).
 */
const hasHriSpaces = (input: string): boolean =>
  input.startsWith('(') && (input.includes(') ') || input.includes(' (') || input.endsWith(' '));

const toBracketed = (m: Message): string =>
  m.map(([ai, v]) => `(${ai})${v.replaceAll('(', '\\(')}`).join('');

/**
 * Raw form with `^` separators. Policy 0: only where required; 1: after every element but the
 * last. `drop` 1 omits the first required separator (values run together); 2 with policy 1 adds
 * a trailing separator; other values change nothing.
 */
function toRaw(m: Message, policy: number, drop: number): string {
  let out = '^';
  m.forEach(([ai, v], i) => {
    out += ai + v;
    const last = i === m.length - 1;
    const required = getAi(ai)?.fnc1 ?? true;
    const sep = policy === 1 ? !last || drop === 2 : required && !last;
    // drop 1: omit the first required separator so values run together.
    if (sep && !(drop === 1 && required && i === 0)) out += '^';
  });
  return out;
}

/** Verdict plus, for accepted input, the elements in bracketed form: ours vs the engine's. */
const agreement = (ours: ReturnType<typeof tryParse>, theirs: Verdict) => ({
  ours: { ok: ours.ok, elements: ours.ok ? format(ours.value, 'bracketed') : null },
  theirs: { ok: theirs.ok, elements: theirs.ok ? theirs.bracketed : null },
});

/** ElementString.from over the message entries: its bracketed form, or null when it throws. */
function fromEntries(m: Message, allowUnknownAIs: boolean): string | null {
  try {
    return ElementString.from(m, { allowUnknownAIs }).toString();
  } catch {
    return null;
  }
}

const describeVerdict = (v: Verdict): string => (v.ok ? `ok ${v.bracketed}` : v.message);
const describeOurs = (r: ReturnType<typeof tryParse>): string =>
  r.ok ? `ok ${format(r.value, 'bracketed')}` : r.errors.map((e) => e.message).join('; ');

// ---------------------------------------------------------------------------------------------

describe('agreement with the GS1 Syntax Engine 1.4.1', () => {
  it('worked examples agree', () => {
    const cases = [
      '(01)09506000134352(17)201225(10)ABC123',
      '(00)006141411234567890',
      '(10)ABC',
      '(01)09506000134353',
    ];
    const mismatches = cases.filter((s) => tryParse(s).ok !== oracleBracketed(s).ok);
    expect(mismatches).toEqual([]);
  });

  it(`random bracketed messages agree (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(messageArb, (m) => {
        const bracketed = toBracketed(m);
        fc.pre(!isKnownDifference(m));
        const ours = tryParse(bracketed);
        const theirs = oracleBracketed(bracketed);
        record('bracketed', theirs);
        const ourRaw = ours.ok ? `^${format(ours.value, 'raw').replaceAll('\u001d', '^')}` : null;
        const theirRaw = theirs.ok ? theirs.raw : null;
        expect(
          { ok: ours.ok, raw: ourRaw },
          `${bracketed}\nours: ${describeOurs(ours)}\ntheirs: ${describeVerdict(theirs)}`,
        ).toEqual({ ok: theirs.ok, raw: theirRaw });
      }),
      { numRuns: RUNS },
    );
  });

  it(`validateAssociations: false matches validateAIassociations = false (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(messageArb, (m) => {
        fc.pre(!isKnownDifference(m));
        const bracketed = toBracketed(m);
        const ours = tryParse(bracketed, { validateAssociations: false });
        const theirs = oracleWithoutRequisites(bracketed);
        record('bracketed, associations off', theirs);
        const a = agreement(ours, theirs);
        expect(
          a.ours,
          `${bracketed}\nours: ${describeOurs(ours)}\ntheirs: ${describeVerdict(theirs)}`,
        ).toEqual(a.theirs);
      }),
      { numRuns: RUNS },
    );
  });

  it(`allowUnknownAIs matches permitUnknownAIs, bracketed and raw (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(withUnknownArb, fc.integer({ min: 0, max: 1 }), (m, policy) => {
        fc.pre(!isKnownDifference(m));
        const inputs = [toBracketed(m), toRaw(m, policy, 0)];
        const mismatches = inputs.flatMap((input) => {
          const ours = tryParse(input, { allowUnknownAIs: true });
          const theirs = oraclePermittingUnknown(input);
          if (engineAcceptedKnownDifference(theirs)) return [];
          record(input.startsWith('^') ? 'raw, unknown AIs' : 'bracketed, unknown AIs', theirs);
          // Bracketed input is compared on the engine's raw output; raw input on its bracketed form
          // (the engine echoes raw input verbatim, including optional separators).
          const isRaw = input.startsWith('^');
          const ourOut = ours.ok
            ? isRaw
              ? format(ours.value, 'bracketed')
              : `^${format(ours.value, 'raw').replaceAll('\u001d', '^')}`
            : null;
          const theirOut = theirs.ok ? (isRaw ? theirs.bracketed : theirs.raw) : null;
          const agree = ours.ok === theirs.ok && ourOut === theirOut;
          return agree
            ? []
            : [
                `${input}\nours: ${describeOurs(ours)} ${ourOut ?? ''}\ntheirs: ${describeVerdict(theirs)}`,
              ];
        });
        expect(mismatches).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it(`free-form bracketed and raw strings agree (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(fc.oneof(tokenSoup('('), tokenSoup('^')), (input) => {
        fc.pre(!hasHriSpaces(input));
        const ours = tryParse(input);
        const theirs = input.startsWith('^') ? oracleRaw(input) : oracleBracketed(input);
        fc.pre(!engineAcceptedKnownDifference(theirs));
        record('free-form', theirs);
        const a = agreement(ours, theirs);
        expect(
          a.ours,
          `${JSON.stringify(input)}\nours: ${describeOurs(ours)}\ntheirs: ${describeVerdict(theirs)}`,
        ).toEqual(a.theirs);
      }),
      { numRuns: RUNS },
    );
  });

  it(`single-edit mutations of messages agree (${RUNS} runs)`, () => {
    const mutated = fc
      .tuple(messageArb, fc.integer({ min: 0, max: 2 }))
      .chain(([m, form]) => mutate(form === 0 ? toBracketed(m) : toRaw(m, form - 1, 0)));
    fc.assert(
      fc.property(mutated, (input) => {
        // The engine reads non-"^" data as plain (non-GS1) data and bracketed data needs "(".
        fc.pre(input.startsWith('(') || input.startsWith('^'));
        fc.pre(!hasHriSpaces(input));
        const ours = tryParse(input);
        const theirs = input.startsWith('^') ? oracleRaw(input) : oracleBracketed(input);
        fc.pre(!engineAcceptedKnownDifference(theirs));
        record('mutated', theirs);
        const a = agreement(ours, theirs);
        expect(
          a.ours,
          `${JSON.stringify(input)}\nours: ${describeOurs(ours)}\ntheirs: ${describeVerdict(theirs)}`,
        ).toEqual(a.theirs);
      }),
      { numRuns: RUNS },
    );
  });

  it(`object input (ElementString.from) agrees with the engine (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(fc.oneof(messageArb, withUnknownArb), fc.boolean(), (m, allowUnknown) => {
        fc.pre(!isKnownDifference(m));
        const bracketed = toBracketed(m);
        const theirs = allowUnknown
          ? oraclePermittingUnknown(bracketed)
          : oracleBracketed(bracketed);
        record('object input', theirs);
        expect(
          fromEntries(m, allowUnknown),
          `${bracketed}\ntheirs: ${describeVerdict(theirs)}`,
        ).toEqual(theirs.ok ? theirs.bracketed : null);
      }),
      { numRuns: RUNS },
    );
  });

  it(`engine raw output of valid messages parses back to the same elements (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(messageArb, (m) => {
        const bracketed = toBracketed(m);
        fc.pre(!isKnownDifference(m));
        const theirs = oracleBracketed(bracketed);
        fc.pre(theirs.ok);
        record('raw round trip', theirs);
        const raw = theirs.ok ? theirs.raw : '';
        const back = tryParse(raw);
        expect(
          back.ok ? back.value.entries() : describeOurs(back),
          `${bracketed}\nraw: ${raw}`,
        ).toEqual(m.map(([a, v]) => [a, v]));
      }),
      { numRuns: RUNS },
    );
  });

  it(`HRI lines of valid messages match the engine, with and without titles (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(fc.oneof(messageArb, withUnknownArb), fc.boolean(), (m, titles) => {
        fc.pre(!isKnownDifference(m));
        const bracketed = toBracketed(m);
        const theirs = oracleHri(bracketed, titles);
        fc.pre(theirs !== null);
        const ours = tryParse(bracketed, { allowUnknownAIs: true });
        expect(
          ours.ok ? hri(ours.value, { titles }) : describeOurs(ours),
          `HRI of ${bracketed}`,
        ).toEqual(theirs);
      }),
      { numRuns: RUNS },
    );
  });

  it(`random raw messages agree (${RUNS} runs)`, () => {
    fc.assert(
      fc.property(
        messageArb,
        fc.integer({ min: 0, max: 1 }),
        fc.integer({ min: 0, max: 5 }),
        (m, policy, drop) => {
          fc.pre(!isKnownDifference(m));
          const raw = toRaw(m, policy, drop);
          const ours = tryParse(raw);
          const theirs = oracleRaw(raw);
          fc.pre(!engineAcceptedKnownDifference(theirs));
          record('raw', theirs);
          expect(
            { ok: ours.ok, bracketed: ours.ok ? format(ours.value, 'bracketed') : null },
            `${raw}\nours: ${describeOurs(ours)}\ntheirs: ${describeVerdict(theirs)}`,
          ).toEqual({ ok: theirs.ok, bracketed: theirs.ok ? theirs.bracketed : null });
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// Keep the linter-name guard honest: every pooled name must be a real linter.
it('pooled linter names exist', () => {
  expect([...POOLED].filter((l) => !isLinterName(l))).toEqual([]);
});
