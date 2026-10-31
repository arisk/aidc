import type { Cset } from '../core/cset.ts';
import type { LinterName } from './linters/index.ts';

export interface AiComponent {
  readonly cset: Cset;
  readonly min: number;
  readonly max: number;
  readonly optional: boolean;
  readonly linters: readonly LinterName[];
}

/** AND of AI patterns; a pattern may use "n" as a wildcard digit, e.g. "31nn". */
export type ReqGroup = readonly string[];
/** OR of groups; every ReqRule of an AI must be satisfied. */
export type ReqRule = readonly ReqGroup[];

export interface AiEntry {
  readonly ai: string;
  readonly title: string;
  /** True when an FNC1/GS separator is required after this AI unless it is last ("*" flag absent). */
  readonly fnc1: boolean;
  /** "?" flag: permitted as a GS1 Digital Link data attribute. */
  readonly dlAttr: boolean;
  readonly components: readonly AiComponent[];
  readonly req: readonly ReqRule[];
  readonly ex: readonly string[];
  /** Present when the AI is a Digital Link primary key: alternative ordered qualifier sequences. */
  readonly dlpkey?: readonly (readonly string[])[];
}
