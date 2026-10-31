import type { ElementString } from '../../ai/index.ts';
import type { Result } from '../../core/index.ts';

export type SymbologyName =
  | 'ean-13'
  | 'upc-a'
  | 'ean-8'
  | 'upc-e'
  | 'itf-14'
  | 'gs1-128'
  | 'gs1-datamatrix'
  | 'datamatrix'
  | 'gs1-qr'
  | 'qr';
export type RowRole = 'symbol' | 'guard-extension' | 'add-on';

export interface PatternRow {
  readonly role: RowRole;
  /** Modules from the content box's left edge. */
  readonly x: number;
  /** Modules from the top. */
  readonly y: number;
  readonly height: number;
  /** Even index dark; `widths[0]` may be 0. */
  readonly widths: readonly number[];
}

export interface HriText {
  readonly text: string;
  readonly x: number;
  /**
   * Baseline in modules. A `y` up to `pattern.height` is in content coordinates (measured from the
   * top of the bars). A `y` above `pattern.height` is text below the bars: `toSvg` places it relative
   * to the bottom of the rendered body, i.e. below the bottom quiet zone and the bottom bearer, so
   * `y - pattern.height` is the distance from the body's bottom edge to the baseline.
   */
  readonly y: number;
  /** Font size in modules. */
  readonly size: number;
  readonly anchor: 'start' | 'middle' | 'end';
  readonly role: 'hri' | 'quiet-zone-marker';
}

export interface QuietZone {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface Bearer {
  readonly sides: 'frame' | 'top-bottom';
  readonly width: number;
}

export interface LinearPattern {
  readonly kind: 'linear';
  /** Undefined for patterns built with `linearPattern(widths)`. */
  readonly symbology: SymbologyName | undefined;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly PatternRow[];
  readonly hri: readonly HriText[];
  readonly quietZone: QuietZone;
  readonly bearer?: Bearer;
}

/** A two-dimensional symbol as frozen plain data. */
export interface ModuleMatrix {
  readonly kind: 'matrix';
  /** Undefined for matrices built with `matrixFromRows`. */
  readonly symbology: SymbologyName | undefined;
  /** Columns and rows in modules, quiet zone excluded. */
  readonly width: number;
  readonly height: number;
  /** `height` strings of `width` characters, row 0 at the top: '1' dark, '0' light. */
  readonly rows: readonly string[];
  /** Minimum quiet zone in modules. */
  readonly quietZone: QuietZone;
  /** Optional HRI lines; empty unless the encoder was asked for them. */
  readonly hri: readonly HriText[];
}

/** How a decoded matrix was turned relative to the canonical orientation. */
export interface Orientation {
  readonly rotation: 0 | 90 | 180 | 270;
  readonly mirrored: boolean;
}

export interface DecodedSymbol<M extends object = Readonly<Record<string, unknown>>> {
  readonly symbology: SymbologyName;
  readonly aimId: string;
  readonly elementString: ElementString;
  readonly rawData: string;
  readonly errorsCorrected: number;
  readonly addOn?: string;
  /** The GS1 Digital Link URI carried by the symbol, if any. */
  readonly digitalLink?: string;
  readonly metadata: M;
}

export interface Symbology<
  Opts extends object,
  M extends object = Readonly<Record<string, unknown>>,
  S extends LinearPattern | ModuleMatrix = LinearPattern,
> {
  readonly name: SymbologyName;
  encode(data: ElementString | string, options?: Opts): S;
  tryEncode(data: ElementString | string, options?: Opts): Result<S>;
  decode(symbol: S): DecodedSymbol<M>;
  tryDecode(symbol: S): Result<DecodedSymbol<M>>;
}
