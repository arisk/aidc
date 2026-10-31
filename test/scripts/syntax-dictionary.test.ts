import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSyntaxDictionary, renderAiTable } from '../../scripts/lib/syntax-dictionary.ts';

const SOURCE = 'docs/specifications/data/gs1-syntax-dictionary-2026-01-27.txt';
const text = readFileSync(SOURCE, 'utf8');
const { release, entries } = parseSyntaxDictionary(text);
const byAi = new Map(entries.map((e) => [e.ai, e]));

describe('parseSyntaxDictionary', () => {
  it('reads the release and expands ranges', () => {
    expect(release).toBe('2026-01-27');
    expect(byAi.has('3100')).toBe(true);
    expect(byAi.has('3105')).toBe(true);
    expect(byAi.has('3106')).toBe(false);
    expect(byAi.get('3103')?.title).toBe('NET WEIGHT (kg)');
    expect(byAi.has('91')).toBe(true);
    expect(byAi.has('99')).toBe(true);
  });

  it('parses (01) GTIN', () => {
    expect(byAi.get('01')).toEqual({
      ai: '01',
      title: 'GTIN',
      fnc1: false,
      dlAttr: true,
      components: [{ cset: 'N', min: 14, max: 14, optional: false, linters: ['csum', 'gcppos2'] }],
      req: [],
      ex: ['255', '37'],
      dlpkey: [['22', '10', '21'], ['235']],
    });
  });

  it('parses optional components, AND groups and repeated req', () => {
    const e423 = byAi.get('423');
    expect(e423?.components).toHaveLength(5);
    expect(e423?.components[1]).toEqual({
      cset: 'N',
      min: 3,
      max: 3,
      optional: true,
      linters: ['iso3166'],
    });
    expect(byAi.get('7004')?.req).toEqual([[['01', '10']]]);
    expect(byAi.get('37')?.req).toEqual([[['00']], [['02'], ['8026']]]);
    expect(byAi.get('253')?.components[1]).toEqual({
      cset: 'X',
      min: 1,
      max: 17,
      optional: true,
      linters: [],
    });
    expect(byAi.get('00')?.dlpkey).toEqual([[]]);
    expect(byAi.get('10')?.dlpkey).toBeUndefined();
    expect(byAi.get('8110')?.title).toBe('');
  });

  it('no AI is a prefix of another (parser relies on this)', () => {
    const ais = entries.map((e) => e.ai);
    const clashes: string[] = [];
    for (const a of ais)
      for (const b of ais) if (a !== b && b.startsWith(a)) clashes.push(`${a} prefixes ${b}`);
    expect(clashes).toEqual([]);
  });
});

describe('generated table', () => {
  it('src/ai/table.gen.ts is up to date (run `pnpm gen`)', () => {
    expect(readFileSync('src/ai/table.gen.ts', 'utf8')).toBe(
      renderAiTable(release, entries, SOURCE),
    );
  });
});
