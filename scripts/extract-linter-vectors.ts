// Usage: node scripts/extract-linter-vectors.ts <syntax-dictionary-src-dir>
// Reads GS1's reference linter C sources and writes:
//   test/vectors/linters.json            (UNIT_TEST_PASS / UNIT_TEST_FAIL cases)
//   src/ai/linters/lint-codes.gen.ts     (gs1_lint_err_t names + English messages)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Vector =
  | { linter: string; data: string; ok: true }
  | { linter: string; data: string; ok: false; code: string; pos: number; len: number };

export function decodeCString(lit: string): string {
  let out = '';
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i] ?? '';
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = lit[++i] ?? '';
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'x') {
      let hex = '';
      while (/[0-9a-fA-F]/.test(lit[i + 1] ?? '')) hex += lit[++i];
      out += String.fromCharCode(Number.parseInt(hex, 16));
    } else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(lit[i + 1] ?? '')) oct += lit[++i];
      out += String.fromCharCode(Number.parseInt(oct, 8));
    } else out += n;
  }
  return out;
}

/**
 * The C harness marks the error span as data[0,pos) + '*' + data[pos,pos+len) + '*' + rest.
 * When the data itself contains '*' several spans can produce the same marking (for example
 * data "*" and highlight "***"). A real lint error always covers at least one character in
 * those cases, so an ambiguous marking resolves to the single candidate with len > 0, and
 * is otherwise rejected (null) rather than guessed.
 */
export function highlightToSpan(
  data: string,
  highlight: string,
): { pos: number; len: number } | null {
  const found: Array<{ pos: number; len: number }> = [];
  for (let pos = 0; pos <= data.length; pos++) {
    for (let len = 0; pos + len <= data.length; len++) {
      const marked = `${data.slice(0, pos)}*${data.slice(pos, pos + len)}*${data.slice(pos + len)}`;
      if (marked === highlight) found.push({ pos, len });
    }
  }
  if (found.length === 1) return found[0] ?? null;
  const nonEmpty = found.filter((s) => s.len > 0);
  return nonEmpty.length === 1 ? (nonEmpty[0] ?? null) : null;
}

// One C string argument: one or more adjacent literals (concatenated by the compiler),
// possibly split across lines.
const LIT = String.raw`"(?:[^"\\]|\\.)*"`;
const STRS = String.raw`((?:${LIT}\s*)+)`;
const CASE_RE = new RegExp(
  String.raw`UNIT_TEST_(PASS|FAIL)\(gs1_lint_([a-z0-9]+),\s*${STRS}(?:,\s*GS1_LINTER_([A-Z0-9_]+),\s*${STRS})?\)`,
  'y',
);

function joinLiterals(args: string): string {
  let out = '';
  for (const m of args.matchAll(new RegExp(LIT, 'g'))) out += decodeCString(m[0].slice(1, -1));
  return out;
}

export function extractVectors(srcDir: string): { vectors: Vector[]; skipped: number } {
  const vectors: Vector[] = [];
  let skipped = 0;
  const files = readdirSync(srcDir).filter((f) => /^lint_[a-z0-9]+\.c$/.test(f));
  files.sort(); // oxlint: no-array-sort is moot here, the array is a local copy
  for (const file of files) {
    const text = readFileSync(join(srcDir, file), 'utf8');
    for (const start of text.matchAll(/UNIT_TEST_(?:PASS|FAIL)\(/g)) {
      const at = start.index;
      const lineStart = text.lastIndexOf('\n', at) + 1;
      if (text.slice(lineStart, at).includes('#define')) continue;
      CASE_RE.lastIndex = at;
      const m = CASE_RE.exec(text);
      if (!m) {
        skipped++;
        continue;
      }
      const [, kind, linter = '', rawData = '', code, rawHighlight] = m;
      const data = joinLiterals(rawData);
      if (kind === 'PASS') {
        vectors.push({ linter, data, ok: true });
        continue;
      }
      const span = highlightToSpan(data, joinLiterals(rawHighlight ?? ''));
      if (!span || !code) {
        skipped++;
        continue;
      }
      vectors.push({ linter, data, ok: false, code, ...span });
    }
  }
  return { vectors, skipped };
}

export function extractLintCodes(headerText: string): Array<{ code: string; message: string }> {
  const out: Array<{ code: string; message: string }> = [];
  const re = /^\s*GS1_LINTER_([A-Z0-9_]+)(?:\s*=\s*\d+)?\s*,\s*\/\/\/<\s*(.*?)\s*$/;
  for (const line of headerText.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    const [, code = '', message = ''] = m;
    if (code === 'OK' || code.startsWith('UNUSED_')) continue;
    out.push({ code, message });
  }
  return out;
}

function main(): void {
  const srcDir = process.argv[2];
  if (!srcDir) throw new Error('usage: node scripts/extract-linter-vectors.ts <src-dir>');
  const { vectors, skipped } = extractVectors(srcDir);
  writeFileSync(
    'test/vectors/linters.json',
    `${JSON.stringify({ source: 'gs1-syntax-dictionary main c63d8a1 (2026-08-29), src/lint_*.c', skipped, vectors }, null, 1)}\n`,
  );
  const codes = extractLintCodes(readFileSync(join(srcDir, 'gs1syntaxdictionary.h'), 'utf8'));
  const ts = [
    '// Generated by scripts/extract-linter-vectors.ts from gs1syntaxdictionary.h. Do not edit.',
    '// Source: gs1-syntax-dictionary main @ c63d8a1, Apache-2.0, Copyright (c) 2022-2026 GS1 AISBL. See THIRD_PARTY_NOTICES.md.',
    `export type LintCode =\n${codes.map((c) => `  | '${c.code}'`).join('\n')};`,
    '',
    'export const LINT_MESSAGES: Readonly<Record<LintCode, string>> = {',
    ...codes.map((c) => `  ${c.code}: ${JSON.stringify(c.message)},`),
    '};',
    '',
  ].join('\n');
  writeFileSync('src/ai/linters/lint-codes.gen.ts', ts);
  console.log(`vectors: ${vectors.length}, skipped: ${skipped}, codes: ${codes.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
