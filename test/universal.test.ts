import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : [],
  );
}

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const importRe = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

describe('src is universal', () => {
  const files = walk('src');

  it('has no Node built-in imports', () => {
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(importRe)) {
        const spec = m[1] ?? m[2] ?? '';
        expect(builtins.has(spec), `${file} imports ${spec}`).toBe(false);
      }
    }
  });

  it('has no runtime dependencies', () => {
    const pkg: Record<string, unknown> = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg['dependencies']).toBeUndefined();
  });
});
