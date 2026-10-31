import { getAi } from '../ai/index.ts';

/** Whether `ai` is a Digital Link primary key (has `dlpkey` in the Syntax Dictionary). */
export function isPrimaryKey(ai: string): boolean {
  return getAi(ai)?.dlpkey !== undefined;
}

function alternatives(key: string): readonly (readonly string[])[] {
  return getAi(key)?.dlpkey ?? [];
}

function isSubsequence(qs: readonly string[], alt: readonly string[]): boolean {
  let j = 0;
  for (const q of qs) {
    while (j < alt.length && alt[j] !== q) j++;
    if (j === alt.length) return false;
    j++;
  }
  return true;
}

/**
 * Whether `path` (a primary key, then qualifiers) is valid: the qualifiers keep the order of
 * one of the key's qualifier sequences, any of which may be skipped (dl.c; DL 4.9).
 */
export function isValidKeyPath(path: readonly string[]): boolean {
  const [key, ...qs] = path;
  if (key === undefined || !isPrimaryKey(key)) return false;
  return qs.length === 0 || alternatives(key).some((alt) => isSubsequence(qs, alt));
}

/**
 * Whether `ai` may accompany primary key `key` in a Digital Link: a qualifier in one of the
 * key's qualifier sequences, or a data attribute. Unknown AIs (allowUnknownAIs) count as
 * attributes, as in the query.
 */
export function mayAccompany(key: string, ai: string): boolean {
  const info = getAi(ai);
  if (info === undefined || info.dlAttr) return true;
  return alternatives(key).some((alt) => alt.includes(ai));
}

/** Whether `ai` could be inserted after the key of `path` and keep it valid (dl.c AI_SHOULD_BE_IN_PATH_INFO). */
export function shouldBeInPath(path: readonly string[], ai: string): boolean {
  for (let i = 1; i <= path.length; i++) {
    if (isValidKeyPath([...path.slice(0, i), ai, ...path.slice(i)])) return true;
  }
  return false;
}

/**
 * Qualifiers to put in the path after `key` (plan decision D5): the present qualifiers of
 * each alternative sequence, in sequence order; the longest wins, ties go to the one whose
 * leftover AIs are all data attributes, then to the lexically first "key q1 q2" (dl.c).
 */
export function choosePathQualifiers(key: string, present: ReadonlySet<string>): readonly string[] {
  let best: readonly string[] = [];
  let bestRank: readonly [number, number, string] | undefined;
  for (const alt of alternatives(key)) {
    const qs = alt.filter((q) => present.has(q));
    let clean = 1;
    for (const ai of present) {
      if (ai !== key && !qs.includes(ai) && getAi(ai)?.dlAttr !== true) clean = 0;
    }
    const rank = [qs.length, clean, [key, ...qs].join(' ')] as const;
    if (
      !bestRank ||
      rank[0] > bestRank[0] ||
      (rank[0] === bestRank[0] && rank[1] > bestRank[1]) ||
      (rank[0] === bestRank[0] && rank[1] === bestRank[1] && rank[2] < bestRank[2])
    ) {
      best = qs;
      bestRank = rank;
    }
  }
  return best;
}
