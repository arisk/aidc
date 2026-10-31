// Usage: node scripts/gen-epc-tdt-vectors.ts
// Dev only, never run in CI (plan decision E19). Runs GS1's TDT 2.3 draft JavaScript translator
// offline, from the pinned repository tarball, and freezes its output for the 22 legacy binary
// schemes into test/vectors/epc-tdt.json, and its encodings of the 24 "+" and "++" schemes into
// test/vectors/epc-tdt-plus.json. The tarball is untrusted data: it is extracted into a
// fresh temporary directory, none of its build tools run, and only TDTtranslator.js is loaded.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/ai/index.ts';
import { epc } from '../src/epc/index.ts';
import type { BinarySchemeName, PlusSchemeName } from '../src/epc/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TARBALL_REL = 'docs/specifications/data/repos/gs1-tdt-main-a655cc3-2026-09-19.tar.gz';
const TARBALL = join(ROOT, TARBALL_REL);
/** The tarball's SHA-256: its TDTtranslator.js runs in this process, so it must be this file. */
const TARBALL_SHA256 = '4776e0e37a4a2ce005c117094c5f6b6425c3b9cb12335d31e05a1b28a9cd8734';
const DEMO_REL = 'TDT-main/TDT_2_3_demo';
const OUT = join(ROOT, 'test/vectors/epc-tdt.json');
const PER_SCHEME = 25;
const SEED = 0x9e3779b9;

// ---------------------------------------------------------------------------------------------
// A tiny seeded PRNG (xorshift32), independent of src/.
// ---------------------------------------------------------------------------------------------

let state = SEED >>> 0;
function next(): number {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state;
}
/** An integer in [lo, hi]. */
function int(lo: number, hi: number): number {
  return lo + (next() % (hi - lo + 1));
}
function pick(s: string): string {
  return s.charAt(int(0, s.length - 1));
}
function digits(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += pick('0123456789');
  return out;
}
/**
 * A decimal integer below 2^bits with at most `maxDigits` digits and no leading zeros (TDS 5
 * NumericComponent). The digit count is drawn first so short and long values both appear.
 */
function integer(bits: number, maxDigits = 99): string {
  const bound = 1n << BigInt(bits);
  const most = Math.min(maxDigits, (bound - 1n).toString().length);
  if (int(0, 9) === 0) return '0';
  for (;;) {
    const n = int(1, most);
    const s = n === 1 ? pick('0123456789') : pick('123456789') + digits(n - 1);
    if (BigInt(s) < bound) return s;
  }
}

// GS3A3 characters (TDS Table A-1) and their URI escapes; upper-case hex only, because TDT
// rejects lower-case escapes (research C.3).
const CSET82 =
  '!"%&\'()*+,-./0123456789:;<=>?ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '%22',
  '%': '%25',
  '&': '%26',
  '/': '%2F',
  '<': '%3C',
  '>': '%3E',
  '?': '%3F',
};
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function gs3a3(maxChars: number): string {
  const n = int(1, maxChars);
  let out = '';
  for (let i = 0; i < n; i++) {
    // Mostly letters and digits, so values look like real serials; one in four from all of A-1.
    const ch = int(0, 3) === 0 ? pick(CSET82) : pick(ALNUM);
    out += ESCAPES[ch] ?? ch;
  }
  return out;
}
const UPPER_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** CPRefChar (TDS 6.3.11): digits, upper case, '-', '/' and '#' (the last two escaped). */
function cpref(maxChars: number): string {
  const n = int(1, maxChars);
  let out = '';
  for (let i = 0; i < n; i++) {
    const ch = int(0, 5) === 0 ? pick('-/#') : pick(UPPER_DIGITS);
    out += ch === '/' ? '%2F' : ch === '#' ? '%23' : ch;
  }
  return out;
}
/** ADIChar (TDS 6.3.18): digits, upper case, '-' and '/' (escaped). */
function adiChars(min: number, max: number): string {
  const n = int(min, max);
  let out = '';
  for (let i = 0; i < n; i++) {
    const ch = int(0, 5) === 0 ? pick('-/') : pick(UPPER_DIGITS);
    out += ch === '/' ? '%2F' : ch;
  }
  return out;
}
/** A CAGE code or DoDAAC: 5 or 6 of 0-9 and A-Z without I and O (TDS 6.3.17). */
function cage(): string {
  const set = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = int(5, 6); i > 0; i--) out += pick(set);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Inputs per scheme: pure identity components (URI form) and a filter.
// ---------------------------------------------------------------------------------------------

/** Partition table index p for a GCP length L (TDS 14.6: L = 12 - p). */
const pOf = (L: number): number => 12 - L;
const GIAI96_BITS = [42, 45, 48, 52, 55, 58, 62] as const;
const CPI96_BITS = [11, 14, 17, 21, 24, 27, 31] as const;

interface Input {
  readonly pure: string;
  readonly components: readonly string[];
  /** Absent for GID-96, which has no filter field. */
  readonly filter?: number;
  /** The GS1 Company Prefix length, for the GS1-keyed schemes. */
  readonly gcpLength?: number;
}

type Gen = () => Input;

/** C.ref.(serial) inputs for the partitioned GS1 schemes: `ref` gets the GCP length. */
function gs1(pure: string, ref: (L: number) => string, ...rest: (() => string)[]): Gen {
  return () => {
    const L = int(6, 12);
    return {
      pure,
      components: [digits(L), ref(L), ...rest.map((f) => f())],
      filter: int(0, 7),
      gcpLength: L,
    };
  };
}

const two = (n: number): string => String(n).padStart(2, '0');

function itip(serial: () => string): Gen {
  return () => {
    const L = int(6, 12);
    // The (8006) pieceoftotal linter needs 1 <= piece <= total.
    const total = int(1, 99);
    const piece = int(1, total);
    return {
      pure: 'itip',
      components: [digits(L), digits(13 - L), two(piece), two(total), serial()],
      filter: int(0, 7),
      gcpLength: L,
    };
  };
}

const GENERATORS: Readonly<Record<BinarySchemeName, Gen>> = {
  'sgtin-96': gs1(
    'sgtin',
    (L) => digits(13 - L),
    () => integer(38),
  ),
  'sgtin-198': gs1(
    'sgtin',
    (L) => digits(13 - L),
    () => gs3a3(20),
  ),
  'sscc-96': gs1('sscc', (L) => digits(17 - L)),
  'sgln-96': gs1(
    'sgln',
    (L) => digits(12 - L),
    () => integer(41),
  ),
  'sgln-195': gs1(
    'sgln',
    (L) => digits(12 - L),
    () => gs3a3(20),
  ),
  'grai-96': gs1(
    'grai',
    (L) => digits(12 - L),
    () => integer(38),
  ),
  'grai-170': gs1(
    'grai',
    (L) => digits(12 - L),
    () => gs3a3(16),
  ),
  'giai-96': gs1('giai', (L) => integer(GIAI96_BITS[pOf(L)] ?? 0)),
  'giai-202': gs1('giai', (L) => gs3a3(30 - L)),
  'gsrn-96': gs1('gsrn', (L) => digits(17 - L)),
  'gsrnp-96': gs1('gsrnp', (L) => digits(17 - L)),
  'gdti-96': gs1(
    'gdti',
    (L) => digits(12 - L),
    () => integer(41),
  ),
  'gdti-113': gs1(
    'gdti',
    (L) => digits(12 - L),
    () => digits(int(1, 17)),
  ),
  'gdti-174': gs1(
    'gdti',
    (L) => digits(12 - L),
    () => gs3a3(17),
  ),
  'sgcn-96': gs1(
    'sgcn',
    (L) => digits(12 - L),
    () => digits(int(1, 12)),
  ),
  'itip-110': itip(() => integer(38)),
  'itip-212': itip(() => gs3a3(20)),
  'gid-96': () => ({
    pure: 'gid',
    components: [integer(28), integer(24), integer(36)],
  }),
  'cpi-96': gs1(
    'cpi',
    (L) => integer(CPI96_BITS[pOf(L)] ?? 0, 15 - L),
    () => integer(31),
  ),
  'cpi-var': gs1(
    'cpi',
    (L) => cpref(30 - L),
    () => integer(40, 12),
  ),
  // TDT's USDOD-96 tag pattern takes a one-digit filter (research legacy section 3), so 0..9.
  'usdod-96': () => ({ pure: 'usdod', components: [cage(), integer(36)], filter: int(0, 9) }),
  'adi-var': () => {
    const hash = int(0, 3) === 0 ? '%23' : '';
    return {
      pure: 'adi',
      components: [cage(), adiChars(0, 32), hash + adiChars(1, hash === '' ? 30 : 29)],
      filter: int(0, 63),
    };
  },
};

/** TDT scheme names (TDT spells the variable-length ones with a lower-case "var"). */
function tdtName(s: BinarySchemeName): string {
  return s.endsWith('-var') ? `${s.slice(0, -4).toUpperCase()}-var` : s.toUpperCase();
}
/** Schemes TDT cannot encode (encode throws "Input is not binary", research C.3). */
const DECODE_ONLY: ReadonlySet<BinarySchemeName> = new Set(['cpi-var', 'usdod-96']);
/** Schemes without a GS1 key, so without a GS1_AI_JSON level. */
const NO_GS1_KEY: ReadonlySet<BinarySchemeName> = new Set(['gid-96', 'usdod-96', 'adi-var']);

// ---------------------------------------------------------------------------------------------
// Plus pass inputs: element strings for the 24 "+" and "++" schemes (research plus 1.2, 2.3).
// ---------------------------------------------------------------------------------------------

/** GS1 mod 10 check digit of `body` (GS1 General Specifications 7.9.1). */
function checkDigit(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body.charAt(body.length - 1 - i));
    sum += i % 2 === 0 ? 3 * d : d;
  }
  return String((10 - (sum % 10)) % 10);
}
const withCheck = (body: string): string => body + checkDigit(body);

/** A raw (unescaped) CSET 82 value of min..max characters, mostly letters and digits. */
function cset82(min: number, max: number): string {
  const n = int(min, max);
  let out = '';
  for (let i = 0; i < n; i++) out += int(0, 3) === 0 ? pick(CSET82) : pick(ALNUM);
  return out;
}
/** CSET 39 (#, -, / and upper-case alphanumerics), as (8010) needs after its GCP. */
function cset39(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += int(0, 5) === 0 ? pick('#-/') : pick(UPPER_DIGITS);
  return out;
}
/** An optional AI component: empty one time in ten, else `f()`. */
const optional = (f: () => string): string => (int(0, 9) === 0 ? '' : f());

/** YYMMDD with DD 01 to 28; DD 00 one time in ten when `dd00` (the yymmd0 linter allows it). */
function yymmdd(dd00 = false): string {
  const dd = dd00 && int(0, 9) === 0 ? 0 : int(1, 28);
  return two(int(0, 99)) + two(int(1, 12)) + two(dd);
}

type Entry = readonly [ai: string, value: string];
type PlusBase =
  | 'sgtin'
  | 'dsgtin'
  | 'sscc'
  | 'sgln'
  | 'grai'
  | 'giai'
  | 'gsrn'
  | 'gsrnp'
  | 'gdti'
  | 'sgcn'
  | 'itip'
  | 'cpi';

/** Body AIs of each plus scheme, in encoding order (TDT encodedAI, research plus 1.2). */
const PLUS_BODIES: Readonly<Record<PlusBase, () => Entry[]>> = {
  sgtin: () => [
    ['01', withCheck(digits(13))],
    ['21', cset82(1, 20)],
  ],
  dsgtin: () => [
    ['01', withCheck(digits(13))],
    ['21', cset82(1, 20)],
  ],
  sscc: () => [['00', withCheck(digits(17))]],
  sgln: () => {
    // (254) "0" means no extension (plan decision F7); keep the extension meaningful here.
    let ext = cset82(1, 20);
    while (ext === '0') ext = cset82(1, 20);
    return [
      ['414', withCheck(digits(12))],
      ['254', ext],
    ];
  },
  grai: () => [['8003', `0${withCheck(digits(12))}${optional(() => cset82(1, 16))}`]],
  giai: () => {
    const gcp = digits(int(4, 12));
    return [['8004', gcp + (int(0, 3) === 0 ? '' : cset82(1, 30 - gcp.length))]];
  },
  gsrn: () => [['8018', withCheck(digits(17))]],
  gsrnp: () => [['8017', withCheck(digits(17))]],
  gdti: () => [['253', withCheck(digits(12)) + optional(() => cset82(1, 17))]],
  sgcn: () => [['255', withCheck(digits(12)) + optional(() => digits(int(1, 12)))]],
  itip: () => {
    const total = int(1, 99);
    return [
      ['8006', withCheck(digits(13)) + two(int(1, total)) + two(total)],
      ['21', cset82(1, 20)],
    ];
  },
  cpi: () => {
    const gcp = digits(int(4, 12));
    const n = int(1, 12);
    return [
      ['8010', gcp + cset39(int(0, 30 - gcp.length))],
      // (8011) has no leading zero, so not "0" either (Syntax Dictionary nozeroprefix).
      ['8011', pick('123456789') + digits(n - 1)],
    ];
  },
};

/** The +AIDC pool (Table F AIs with simple valid values); values drawn per input. */
const AIDC_POOL: Readonly<Record<string, () => string>> = {
  '17': () => yymmdd(true),
  '10': () => cset82(1, 20),
  '3103': () => digits(6),
  '7003': () => yymmdd() + two(int(0, 23)) + two(int(0, 59)),
  '8008': () => {
    const n = int(0, 2);
    return (
      yymmdd() + two(int(0, 23)) + (n > 0 ? two(int(0, 59)) : '') + (n > 1 ? two(int(0, 59)) : '')
    );
  },
  '4330': () => digits(6) + (int(0, 1) === 0 ? '-' : ''),
  '7007': () => yymmdd() + (int(0, 1) === 0 ? yymmdd() : ''),
  '422': () => ['036', '124', '250', '276', '380', '392', '826', '840'][int(0, 7)] ?? '276',
  '91': () => cset82(1, 20),
};
/** Fixed sample values, used only to ask the AI validator which pool AIs a body may carry. */
const AIDC_SAMPLE: Readonly<Record<string, string>> = {
  '17': '250101',
  '10': 'A',
  '3103': '000123',
  '7003': '2501011200',
  '8008': '25010112',
  '4330': '000100',
  '7007': '250101',
  '422': '276',
  '91': 'A',
};
/** The DSGTIN prioritised date AIs, in date type indicator order (TDS 14.5.3). */
const DATE_AIS = ['11', '13', '15', '16', '17', '7006', '7007'] as const;
const PLUS_HOSTNAMES = [
  'id.example.com',
  'ID.EXAMPLE.COM',
  'www.host.co.uk',
  'data.example.org',
  'qr.acme.tech',
] as const;
const PLUS_PER_SCHEME = 20;
const PLUS_OUT = join(ROOT, 'test/vectors/epc-tdt-plus.json');

interface PlusInput {
  readonly scheme: PlusSchemeName;
  readonly entries: readonly Entry[];
  readonly filter: number;
  readonly hostname?: string;
}

/** One plus input: body, DSGTIN date, 0 to 3 +AIDC AIs the body may carry, filter, hostname. */
function plusInput(base: PlusBase, plusPlus: boolean): PlusInput {
  const body = PLUS_BODIES[base]();
  const head: Entry[] = [...body];
  let dateIndex = -1;
  if (base === 'dsgtin') {
    dateIndex = int(0, DATE_AIS.length - 1);
    const ai = DATE_AIS[dateIndex] ?? '11';
    head.push([ai, yymmdd(ai !== '7006' && ai !== '7007')]);
  }
  // Pool AIs the AI validator accepts with this body (associations, plan decision F12); for
  // DSGTIN, none that our default prioritised date choice (F6) would pick instead of the date.
  const allowed = Object.keys(AIDC_POOL).filter((ai) => {
    const at = DATE_AIS.findIndex((d) => d === ai);
    if (dateIndex >= 0 && at >= 0 && at <= dateIndex) return false;
    return validate([...head, [ai, AIDC_SAMPLE[ai] ?? '']]).ok;
  });
  const aidc: Entry[] = [];
  for (let k = Math.min(int(0, 3), allowed.length); k > 0; k--) {
    const [ai = ''] = allowed.splice(int(0, allowed.length - 1), 1);
    aidc.push([ai, AIDC_POOL[ai]?.() ?? '']);
  }
  // TDT reads GS1_AI_JSON with JSON.parse, which puts integer-like keys first, ascending; every
  // pool AI is one, so the +AIDC AIs go in ascending order (our encoder keeps input order).
  aidc.sort((a, b) => Number(a[0]) - Number(b[0]));
  const filter = int(0, 7);
  const scheme = `${base}${plusPlus ? '++' : '+'}` as PlusSchemeName;
  return {
    scheme,
    entries: [...head, ...aidc],
    filter,
    ...(plusPlus ? { hostname: PLUS_HOSTNAMES[int(0, PLUS_HOSTNAMES.length - 1)] } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// TDT harness (research C.3, docs/superpowers/research/m3-epc-oracle-ref/tdt-harness.cjs).
// ---------------------------------------------------------------------------------------------

interface TdtTranslator {
  readonly initialized: Promise<unknown>;
  processData(): void;
  translate(input: string, scheme: string, level: string, opts: Record<string, unknown>): string;
}

const quiet = (): void => {};

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

if (sha256(TARBALL) !== TARBALL_SHA256)
  throw new Error(`${TARBALL_REL} does not match its pinned SHA-256; refusing to run its code`);

const work = mkdtempSync(join(tmpdir(), 'gs1-tdt-'));
const log = console.log;
try {
  execFileSync('tar', ['-xzf', TARBALL, '-C', work]);
  const runDir = join(work, DEMO_REL);
  for (const need of ['TDTtranslator.js', 'schemas', 'gcpprefixformatlist.json']) {
    if (!existsSync(join(runDir, need))) throw new Error(`${need} is missing from the tarball`);
  }
  const translatorJs = join(runDir, 'TDTtranslator.js');
  copyFileSync(translatorJs, join(runDir, 'TDTtranslator.cjs'));
  process.chdir(runDir);
  // TDT logs its tables and every unsupported scheme; keep the script output readable.
  console.debug = quiet;
  console.info = quiet;
  console.log = quiet;
  const req = createRequire(join(runDir, 'TDTtranslator.cjs'));
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- CommonJS class of known shape
  const Translator = req(join(runDir, 'TDTtranslator.cjs')) as new () => TdtTranslator;
  const t = new Translator();
  await t.initialized;
  t.processData();

  const notes: string[] = [
    'Inputs come from a seeded xorshift32 PRNG; each is a valid TDS 2.3 pure identity URI plus a filter.',
    'Escapes are upper-case only: TDT rejects lower-case escapes such as %2f (research C.3).',
    'cpi-var and usdod-96: TDT encoding throws "Input is not binary" (research C.3), so these vectors run in the decode direction: inputHex is our encoding of pureIdentityUri, and expect holds what TDT decodes it to.',
    'usdod-96 filters are 0 to 9: the TDT tag URI pattern for its 4-bit filter is [0-9].',
    'itip piece and total satisfy 1 <= piece <= total, as the (8006) pieceoftotal linter requires.',
    'gid-96, usdod-96 and adi-var have no GS1 key, so no aiJson.',
  ];
  const tryTranslate = (
    input: string,
    scheme: BinarySchemeName,
    level: string,
    opts: Record<string, unknown>,
  ): string | undefined => {
    try {
      return t.translate(input, tdtName(scheme), level, opts);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      notes.push(`skipped ${scheme} ${level} of ${input}: TDT threw "${why.slice(0, 120)}"`);
      return undefined;
    }
  };

  /** TDT's GS1_AI_JSON output, parsed; TDT does not escape '"' or '\\' inside values. */
  const aiJson = (text: string | undefined, scheme: BinarySchemeName, input: string): unknown => {
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      notes.push(`skipped ${scheme} GS1_AI_JSON of ${input}: TDT output is not JSON: ${text}`);
      return undefined;
    }
  };

  const vectors: unknown[] = [];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- GENERATORS keys are scheme names
  for (const [scheme, gen] of Object.entries(GENERATORS) as [BinarySchemeName, Gen][]) {
    for (let i = 0; i < PER_SCHEME; i++) {
      const v = gen();
      const pureIdentityUri = `urn:epc:id:${v.pure}:${v.components.join('.')}`;
      const opts: Record<string, unknown> = {};
      if (v.filter !== undefined) opts['filter'] = v.filter;
      if (v.gcpLength !== undefined) opts['gs1companyprefixlength'] = v.gcpLength;
      const expect: Record<string, unknown> = {};
      let inputHex: string | undefined;
      if (DECODE_ONLY.has(scheme)) {
        const filter = v.filter === undefined ? {} : { filter: v.filter };
        inputHex = epc.decode(pureIdentityUri, { scheme, ...filter }).hex;
        if (inputHex === undefined) throw new Error(`no hex for ${pureIdentityUri}`);
        const tagUri = tryTranslate(inputHex, scheme, 'TAG_ENCODING', {});
        const pure = tryTranslate(inputHex, scheme, 'PURE_IDENTITY', {});
        if (tagUri !== undefined) expect['tagUri'] = tagUri;
        if (pure !== undefined) expect['pureIdentityUri'] = pure;
        if (!NO_GS1_KEY.has(scheme)) {
          const ai = aiJson(tryTranslate(inputHex, scheme, 'GS1_AI_JSON', {}), scheme, inputHex);
          if (ai !== undefined) expect['aiJson'] = ai;
        }
      } else {
        const hex = tryTranslate(pureIdentityUri, scheme, 'HEX', opts);
        const tagUri = tryTranslate(pureIdentityUri, scheme, 'TAG_ENCODING', opts);
        if (hex !== undefined) expect['hex'] = hex;
        if (tagUri !== undefined) expect['tagUri'] = tagUri;
        if (!NO_GS1_KEY.has(scheme)) {
          const ai = aiJson(
            tryTranslate(pureIdentityUri, scheme, 'GS1_AI_JSON', opts),
            scheme,
            pureIdentityUri,
          );
          if (ai !== undefined) expect['aiJson'] = ai;
        }
      }
      if (Object.keys(expect).length === 0) {
        notes.push(`dropped ${scheme} ${pureIdentityUri}: TDT gave no output at all`);
        continue;
      }
      vectors.push({
        scheme,
        pureIdentityUri,
        ...(v.filter === undefined ? {} : { filter: v.filter }),
        ...(inputHex === undefined ? {} : { inputHex }),
        expect,
      });
    }
  }

  const provenance = {
    generator: 'scripts/gen-epc-tdt-vectors.ts',
    source: `${TARBALL_REL} (gs1/TDT main @ a655cc3)`,
    sourceSha256: sha256(TARBALL),
    translator: `${DEMO_REL}/TDTtranslator.js`,
    translatorSha256: sha256(translatorJs),
    license: 'Apache-2.0 (GS1 TDT); the vectors are test data only and are not shipped',
    normative: 'No: TDT 2.3 is a draft. TDS 2.3 wins on conflict (plan decisions E3, E19).',
    seed: SEED,
    perScheme: PER_SCHEME,
    notes,
  };
  writeFileSync(OUT, `${JSON.stringify({ provenance, vectors }, null, 2)}\n`);
  console.log = log;
  console.log(`wrote ${vectors.length} vectors, ${notes.length} notes, to ${OUT}`);

  // -------------------------------------------------------------------------------------------
  // Plus pass: the 24 "+" and "++" schemes, encode direction only. TDT's decoder drops the
  // +AIDC data after a "++" hostname and misreads the hostname length (research plus 3, rows 13
  // to 15), so only its encoder serves as an oracle. The PRNG restarts from the same seed, so
  // this pass does not depend on the legacy one.
  // -------------------------------------------------------------------------------------------
  console.log = quiet;
  state = SEED >>> 0;
  const plusNotes: string[] = [
    'Inputs come from a seeded xorshift32 PRNG (restarted from the seed for this pass); each is a valid element string: the body AIs, the DSGTIN prioritised date, then 0 to 3 +AIDC AIs from (17), (10), (3103), (7003), (8008), (4330), (7007), (422), (91).',
    'Encode direction only: TDT input is GS1_AI_JSON (body AIs, then the date, then the +AIDC AIs), output is HEX, with options filter and, for "++", hostname. TDT HEX is nibble padded; ours is padded to a 16-bit word.',
    '+AIDC AIs are those the AI validator accepts with the body (requirements such as (4330) needing (00)), in ascending AI order: TDT parses the JSON with JSON.parse, which orders integer-like keys first.',
    'DSGTIN: the date AI is drawn from (11), (13), (15), (16), (17), (7006), (7007); no +AIDC AI is a prioritised date AI at or before it, so the default dateAi (plan decision F6) picks it. DD is 00 one time in ten where the AI linter allows it (research plus 3, row 11).',
    'SGLN: (254) is never "0", which means no extension (plan decision F7). GRAI, GDTI and SGCN serials are empty one time in ten, as the AIs allow.',
  ];
  const plusVectors: unknown[] = [];
  for (const plusPlus of [false, true]) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PLUS_BODIES keys are bases
    for (const base of Object.keys(PLUS_BODIES) as PlusBase[]) {
      for (let i = 0; i < PLUS_PER_SCHEME; i++) {
        const v = plusInput(base, plusPlus);
        const es = validate(v.entries);
        if (!es.ok) throw new Error(`generated an invalid element string: ${v.entries.join(' ')}`);
        const elementString = es.value.toString();
        const json = `{${v.entries.map(([a, x]) => `${JSON.stringify(a)}:${JSON.stringify(x)}`).join(',')}}`;
        const opts: Record<string, unknown> = { filter: v.filter };
        if (v.hostname !== undefined) opts['hostname'] = v.hostname;
        const where = `${v.scheme} ${elementString}${v.hostname === undefined ? '' : ` @${v.hostname}`}`;
        let expectHex: string;
        try {
          expectHex = t.translate(json, v.scheme.toUpperCase(), 'HEX', opts);
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e);
          plusNotes.push(`skipped ${where}: TDT threw "${why.slice(0, 120)}"`);
          continue;
        }
        if (!/^[0-9A-F]+$/.test(expectHex)) {
          plusNotes.push(`skipped ${where}: TDT HEX output is not hex: ${expectHex}`);
          continue;
        }
        plusVectors.push({
          scheme: v.scheme,
          elementString,
          filter: v.filter,
          ...(v.hostname === undefined ? {} : { hostname: v.hostname }),
          expectHex,
        });
      }
    }
  }
  const plusProvenance = {
    ...provenance,
    normative:
      'No: TDT 2.3 is a draft, and its "+"/"++" support is new. TDS 2.3 wins on conflict, with the errata resolutions of research plus section 3 (plan decisions E3, E19).',
    perScheme: PLUS_PER_SCHEME,
    notes: plusNotes,
  };
  writeFileSync(
    PLUS_OUT,
    `${JSON.stringify({ provenance: plusProvenance, vectors: plusVectors }, null, 2)}\n`,
  );
  console.log = log;
  console.log(`wrote ${plusVectors.length} vectors, ${plusNotes.length} notes, to ${PLUS_OUT}`);
} finally {
  console.log = log;
  process.chdir(ROOT);
  rmSync(work, { recursive: true, force: true });
}
