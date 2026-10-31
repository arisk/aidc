/**
 * Internals shared with aidc's own modules (digital-link, scan). Not part of the package
 * API: neither src/ai/index.ts nor src/index.ts re-exports this file.
 */
export { withAssociations } from './analyze.ts';
export { AI_TABLE } from './table.gen.ts';
export { createElementString } from './element-string.ts';
export { resolveAi } from './lookup.ts';
export { checkElement } from './parse.ts';
export type { ParsedElement, SourceElement, Tokens } from './parse.ts';
