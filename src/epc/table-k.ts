import { AI_TABLE } from '../ai/internal.ts';

let keyLengths: Map<string, number> | undefined;

function build(): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of AI_TABLE) {
    const prefix = entry.ai.slice(0, 2);
    if (!map.has(prefix)) map.set(prefix, entry.ai.length);
  }
  return map;
}

/**
 * GS1 AI key length (2, 3 or 4) from the first two digits of an AI (TDS Table K), derived from
 * the library's AI table. `undefined` when no AI has that prefix.
 */
export function aiKeyLength(firstTwo: string): number | undefined {
  keyLengths ??= build();
  return keyLengths.get(firstTwo);
}
