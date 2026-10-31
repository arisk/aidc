import { analyzeEntries, toEntries, withAssociations } from './analyze.ts';
import type { ParseOptions } from './parse.ts';

export type AiValue = readonly [ai: string, value: string];

/**
 * Creates an ElementString without validation, for callers that have already validated the
 * entries (tryParse, validate). Module-internal: not re-exported from the package.
 */
export let createElementString: (entries: readonly AiValue[]) => ElementString;

export class ElementString {
  readonly #entries: readonly AiValue[];
  readonly size: number;

  private constructor(entries: readonly AiValue[]) {
    this.#entries = Object.freeze(entries.map(([a, v]) => Object.freeze([a, v] as const)));
    this.size = entries.length;
    Object.freeze(this);
  }

  /**
   * Validates and creates. Throws the first Gs1Error.
   * Object input follows JavaScript property order (integer-like keys such as "10" come first);
   * pass an array of [ai, value] pairs to control order.
   * An ElementString is re-validated with `opts`.
   */
  static from(
    input: ElementString | Readonly<Record<string, string>> | Iterable<readonly [string, string]>,
    opts: ParseOptions = {},
  ): ElementString {
    const r = toEntries(input instanceof ElementString ? input.entries() : input);
    if (!r.ok) throw r.error;
    const { elements, errors } = analyzeEntries(r.entries, opts);
    const all = withAssociations(elements, errors, opts);
    if (all.length > 0) throw all[0];
    // Without errors every entry became one element, in order.
    return new ElementString(elements.map((e) => [e.ai, e.value] as const));
  }

  static {
    createElementString = (entries) => new ElementString(entries);
  }

  get(ai: string): string | undefined {
    return this.#entries.find(([a]) => a === ai)?.[1];
  }

  getAll(ai: string): string[] {
    return this.#entries.filter(([a]) => a === ai).map(([, v]) => v);
  }

  has(ai: string): boolean {
    return this.#entries.some(([a]) => a === ai);
  }

  entries(): AiValue[] {
    return [...this.#entries];
  }

  toObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [a, v] of this.#entries) if (!Object.hasOwn(out, a)) out[a] = v;
    return out;
  }

  equals(other: ElementString): boolean {
    const o = other.entries();
    return (
      o.length === this.size &&
      this.#entries.every(([a, v], i) => o[i]?.[0] === a && o[i]?.[1] === v)
    );
  }

  /**
   * True when both hold the same AI values in any order, counting repeats: Digital Link and
   * other carriers reorder AIs, so use this rather than `equals` to compare across them.
   */
  equivalent(other: ElementString): boolean {
    if (other.size !== this.size) return false;
    const counts = new Map<string, number>();
    // An AI is digits only, so the first "=" separates it from the value.
    for (const [a, v] of this.#entries) counts.set(`${a}=${v}`, (counts.get(`${a}=${v}`) ?? 0) + 1);
    for (const [a, v] of other.entries()) {
      const n = counts.get(`${a}=${v}`) ?? 0;
      if (n === 0) return false;
      counts.set(`${a}=${v}`, n - 1);
    }
    return true;
  }

  toString(): string {
    return this.#entries.map(([a, v]) => `(${a})${v.replaceAll('(', '\\(')}`).join('');
  }

  get gtin(): string | undefined {
    return this.get('01');
  }
  get sscc(): string | undefined {
    return this.get('00');
  }
  get gln(): string | undefined {
    return this.get('414');
  }
  get batch(): string | undefined {
    return this.get('10');
  }
  get serial(): string | undefined {
    return this.get('21');
  }
  get expiry(): string | undefined {
    return this.get('17');
  }
  get bestBefore(): string | undefined {
    return this.get('15');
  }
}
