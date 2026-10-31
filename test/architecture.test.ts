import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Modules a module may import (spec section 3, plan decisions D8 and E16). */
const MODULE_DEPS: Record<string, readonly string[]> = {
  core: [],
  ai: ['core'],
  epc: ['core', 'ai'],
  'digital-link': ['core', 'ai', 'epc'],
  scan: ['core', 'ai', 'digital-link'],
  'symbology/render': ['core', 'ai'],
  'symbology/linear': ['core', 'ai', 'symbology/render'],
  'symbology/matrix': ['core', 'ai', 'digital-link', 'symbology/render'],
};
/** Files of another module that may be imported. `core` files are all importable. */
const ENTRY_POINTS: Record<string, readonly string[]> = {
  ai: ['index.ts', 'internal.ts'],
  epc: ['index.ts'],
  'digital-link': ['index.ts'],
  scan: ['index.ts'],
  'symbology/render': ['index.ts', 'internal.ts'],
  'symbology/linear': ['index.ts'],
  'symbology/matrix': ['index.ts'],
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [],
  );
}

const importRe =
  /(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const SRC = resolve('src');

function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(importRe)].map((m) =>
    relative(SRC, resolve(dirname(file), m[1] ?? m[2] ?? '')),
  );
}

/** Splits a src-relative path into its module key and the path inside it. */
function split(rel: string): [string, string] {
  const parts = rel.split('/');
  const n = parts[0] === 'symbology' ? 2 : 1;
  return [parts.slice(0, n).join('/'), parts.slice(n).join('/')];
}

describe('module boundaries', () => {
  for (const file of walk('src')) {
    const from = relative(SRC, resolve(file));
    const [mod] = split(from);
    it(`${from} imports only what its module may`, () => {
      const violations: string[] = [];
      for (const target of importsOf(file)) {
        const [targetMod, inner] = split(target);
        const edge = `${from} -> ${target}`;
        if (from === 'index.ts') {
          if (inner !== 'index.ts') violations.push(edge);
        } else if (targetMod !== mod) {
          if (!(MODULE_DEPS[mod] ?? []).includes(targetMod)) violations.push(edge);
          else if (targetMod !== 'core' && !(ENTRY_POINTS[targetMod] ?? []).includes(inner))
            violations.push(edge);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

describe('render layer', () => {
  for (const file of walk('src/symbology/render')) {
    it(`${relative(SRC, resolve(file))} imports ai only as a type`, () => {
      const bad = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => /from\s*['"](\.\.\/)+ai\//.test(l) && !l.startsWith('import type'));
      expect(bad).toEqual([]);
    });
  }
});

describe('digital-link and render internals', () => {
  it('only symbology/matrix/dl-carrier.ts imports digital-link', () => {
    const offenders = walk('src/symbology')
      .filter((f) => relative(SRC, resolve(f)) !== 'symbology/matrix/dl-carrier.ts')
      .filter((f) => importsOf(f).some((t) => split(t)[0] === 'digital-link'))
      .map((f) => relative(SRC, resolve(f)));
    expect(offenders).toEqual([]);
  });
  it('the render index does not re-export internal.ts', () => {
    const text = readFileSync('src/symbology/render/index.ts', 'utf8');
    expect(text).not.toContain('internal.ts');
    expect(importsOf('src/symbology/render/index.ts').map((t) => split(t)[1])).not.toContain(
      'internal.ts',
    );
  });
});
