export const PACKAGE_NAME: string = 'aidc';
export * from './core/index.ts';
export * from './ai/index.ts';
export * from './digital-link/index.ts';
export * from './scan/index.ts';
export * from './epc/index.ts';
export {
  SYMBOL_SPECS,
  linearPattern,
  matrixFromRows,
  moduleAt,
  toSvg,
  tryToSvg,
} from './symbology/render/index.ts';
export type {
  Bearer,
  DecodedSymbol,
  HriText,
  LinearPattern,
  ModuleMatrix,
  Orientation,
  PatternRow,
  QuietZone,
  RowRole,
  SvgOptions,
  SymbolSpec,
  Symbology,
  SymbologyName,
} from './symbology/render/index.ts';
export * from './symbology/linear/index.ts';
export * from './symbology/matrix/index.ts';
