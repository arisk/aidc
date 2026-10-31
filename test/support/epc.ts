import type { Epc, IdentityEpc } from '../../src/epc/index.ts';

/** `e` narrowed to an identity EPC (plan decision F1); a test failure for a plus EPC. */
export function identity(e: Epc): IdentityEpc {
  if (e.kind === 'plus') throw new Error(`expected an identity EPC, got ${e.binaryScheme}`);
  return e;
}
