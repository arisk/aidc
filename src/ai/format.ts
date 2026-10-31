import type { ElementString } from './element-string.ts';
import { resolveAi } from './lookup.ts';

export type ElementStringFormat = 'bracketed' | 'raw' | 'hri';

export interface FormatOptions {
  readonly optimizeOrder?: boolean;
}

const GS = '\u001d';

/** Unknown AIs (present only via allowUnknownAIs) use their pseudo entry's FNC1 rule. */
function needsSeparator(ai: string): boolean {
  // Invariant: every AI in an ElementString resolves; `?? true` (separate) is only a safe default.
  return resolveAi(ai, true)?.fnc1 ?? true;
}

/**
 * `es` as text. `'bracketed'` (the default) and `'raw'` parse back to the same AIs; `'hri'` is
 * for display only and leaves a `(` inside a value unescaped, as the GS1 Syntax Engine does.
 */
export function format(
  es: ElementString,
  style: ElementStringFormat = 'bracketed',
  opts: FormatOptions = {},
): string {
  const entries = es.entries();
  if (style === 'bracketed') return es.toString();
  if (style === 'hri') return entries.map(([a, v]) => `(${a})${v}`).join('');
  const ordered = opts.optimizeOrder
    ? [
        ...entries.filter(([a]) => !needsSeparator(a)),
        ...entries.filter(([a]) => needsSeparator(a)),
      ]
    : entries;
  let out = '';
  ordered.forEach(([a, v], i) => {
    out += a + v;
    if (i < ordered.length - 1 && needsSeparator(a)) out += GS;
  });
  return out;
}

/**
 * The HRI lines of `es`, as the GS1 Syntax Engine prints them. For display only: a `(` inside a
 * value is not escaped, so the text does not always parse back to the same AIs. Use `format(es)`.
 */
export function hri(es: ElementString, opts: { readonly titles?: boolean } = {}): string[] {
  return es.entries().map(([a, v]) => {
    // Unknown AIs (present only via allowUnknownAIs) are titled UNKNOWN, as by the Syntax Engine.
    const title = opts.titles ? resolveAi(a, true)?.title : undefined;
    return `${title ? `${title} ` : ''}(${a}) ${v}`;
  });
}
