import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'tsdown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Bundle guard (decisions H20 and Q18): a consumer that imports only `gs1DataMatrix` or `gs1Qr`
 * must not pay for the Digital Link builder and parser or the epc code they pull in. Fixtures
 * import the source files and are bundled in a temporary directory with tsdown's programmatic
 * build; the repository's `dist` is never read.
 */
const ENTRY = fileURLToPath(new URL('../../src/symbology/matrix/datamatrix.ts', import.meta.url));
const QR_ENTRY = fileURLToPath(new URL('../../src/symbology/matrix/qr.ts', import.meta.url));

/**
 * Markers that occur only in epc and digital-link code. Identifiers survive only without
 * minification; the string literals survive both builds.
 */
const NAME_MARKERS = ['tryParseDigitalLink', 'sgtin'] as const;
const LITERAL_MARKERS = ['sgtin', 'INVALID_DIGITAL_LINK', 'https://id.gs1.org'] as const;

const FIXTURES = {
  gs1: `import { gs1DataMatrix } from ${JSON.stringify(ENTRY)};
const m = gs1DataMatrix.encode('(01)09501101020917(10)ABC');
console.log(gs1DataMatrix.decode(m).rawData);
`,
  dl: `import { dataMatrix } from ${JSON.stringify(ENTRY)};
const m = dataMatrix.encode('(01)09501101020917(10)ABC');
console.log(dataMatrix.decode(m).digitalLink);
`,
  gs1Qr: `import { gs1Qr } from ${JSON.stringify(QR_ENTRY)};
const m = gs1Qr.encode('(01)09501101020917(10)ABC');
console.log(gs1Qr.decode(m).rawData);
`,
  qr: `import { qr } from ${JSON.stringify(QR_ENTRY)};
const m = qr.encode('(01)09501101020917(10)ABC');
console.log(qr.decode(m).digitalLink);
`,
} as const;
type Fixture = keyof typeof FIXTURES;
const NAMES: readonly Fixture[] = ['gs1', 'dl', 'gs1Qr', 'qr'];

let dir = '';
const out = new Map<string, string>();

async function bundle(name: Fixture, minify: boolean): Promise<string> {
  const outDir = join(dir, `${name}-${minify ? 'min' : 'plain'}`);
  await build({
    config: false,
    cwd: dir,
    entry: { [name]: join(dir, `${name}.ts`) },
    outDir,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify,
    treeshake: true,
    dts: false,
    sourcemap: false,
    clean: false,
    tsconfig: false,
    logLevel: 'silent',
  });
  const file = readdirSync(outDir).find((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  if (file === undefined) throw new Error(`no output for ${name}`);
  return readFileSync(join(outDir, file), 'utf8');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aidc-bundle-'));
  for (const [name, text] of Object.entries(FIXTURES)) writeFileSync(join(dir, `${name}.ts`), text);
  const jobs = NAMES.flatMap((name) =>
    [true, false].map(async (minify) => out.set(`${name}-${minify}`, await bundle(name, minify))),
  );
  await Promise.all(jobs);
  // Eight tsdown builds take several seconds: well past the default 10 s hook timeout on a busy host.
}, 120_000);

afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

const code = (name: Fixture, minify: boolean): string => out.get(`${name}-${minify}`) ?? '';

describe('bundle guard (H20, Q18)', () => {
  it.each(['dl', 'qr'] as const)(
    'the %s carrier fixture contains every marker, so the guard is not vacuous',
    (name) => {
      for (const m of NAME_MARKERS) expect(code(name, false)).toContain(m);
      for (const m of LITERAL_MARKERS) expect(code(name, true)).toContain(m);
    },
  );

  it.each(['gs1', 'gs1Qr'] as const)(
    'the %s GS1-mode fixture has no Digital Link and no epc code',
    (name) => {
      for (const m of NAME_MARKERS) expect(code(name, false)).not.toContain(m);
      for (const m of LITERAL_MARKERS) {
        expect(code(name, true)).not.toContain(m);
        expect(code(name, false)).not.toContain(m);
      }
    },
  );

  it('the QR fixtures carry no Data Matrix code and the reverse', () => {
    expect(code('gs1Qr', false)).toContain('readQr');
    expect(code('gs1Qr', false)).not.toContain('readDataMatrix');
    expect(code('gs1', false)).toContain('readDataMatrix');
    expect(code('gs1', false)).not.toContain('readQr');
  });

  it('logs the minified gzip sizes', () => {
    const sizes = new Map(
      NAMES.map((name) => {
        const text = code(name, true);
        return [name, { bytes: text.length, gzip: gzipSync(text, { level: 9 }).length }] as const;
      }),
    );
    for (const [name, s] of sizes)
      console.log(`bundle ${name}: ${s.bytes} bytes minified, ${s.gzip} bytes gzip -9`);
    const gzip = (name: Fixture): number => sizes.get(name)?.gzip ?? 0;
    expect(gzip('gs1')).toBeLessThan(gzip('dl'));
    expect(gzip('gs1Qr')).toBeLessThan(gzip('qr'));
  });
});
