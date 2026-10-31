import { readFileSync, writeFileSync } from 'node:fs';
import { parseSyntaxDictionary, renderAiTable } from './lib/syntax-dictionary.ts';

const SOURCE = 'docs/specifications/data/gs1-syntax-dictionary-2026-01-27.txt';
const { release, entries } = parseSyntaxDictionary(readFileSync(SOURCE, 'utf8'));
writeFileSync('src/ai/table.gen.ts', renderAiTable(release, entries, SOURCE));
console.log(`wrote ${entries.length} AI entries (release ${release})`);
