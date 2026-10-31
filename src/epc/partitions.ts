import type { PartitionTable } from './descriptor.ts';

const M = [40, 37, 34, 30, 27, 24, 20] as const;
const L = [12, 11, 10, 9, 8, 7, 6] as const;

function table(n: readonly number[], k: readonly number[]): PartitionTable {
  return Object.freeze(
    M.map((m, p) => Object.freeze([m, L[p] ?? 0, n[p] ?? 0, k[p] ?? 0] as const)),
  );
}

/** TDS 14.6.1 (SGTIN, ITIP): indicator + item reference digits. */
export const SGTIN_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [4, 7, 10, 14, 17, 20, 24],
  [1, 2, 3, 4, 5, 6, 7],
);
/** TDS 14.6.2, 14.6.6, 14.6.7 (SSCC, GSRN, GSRNP): extension + serial reference digits. */
export const SSCC_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [18, 21, 24, 28, 31, 34, 38],
  [5, 6, 7, 8, 9, 10, 11],
);
/** TDS 14.6.3, 14.6.8, 14.6.10 (SGLN, GDTI, SGCN): location / document type / coupon reference. */
export const SGLN_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [1, 4, 7, 11, 14, 17, 21],
  [0, 1, 2, 3, 4, 5, 6],
);
/** TDS 14.6.4 (GRAI): asset type digits. */
export const GRAI_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [4, 7, 10, 14, 17, 20, 24],
  [0, 1, 2, 3, 4, 5, 6],
);
/** TDS 14.6.5.1 (GIAI-96, unpadded): maximum asset reference digits. */
export const GIAI96_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [42, 45, 48, 52, 55, 58, 62],
  [13, 14, 15, 16, 17, 18, 19],
);
/** TDS 14.6.5.2 (GIAI-202, string): maximum asset reference characters. */
export const GIAI202_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [148, 151, 154, 158, 161, 164, 168],
  [18, 19, 20, 21, 22, 23, 24],
);
/** TDS 14.6.9.1 (CPI-96, unpadded): maximum part reference digits. */
export const CPI96_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [11, 14, 17, 21, 24, 27, 31],
  [3, 4, 5, 6, 7, 8, 9],
);
/** TDS 14.6.9.2 (CPI-var, 6-bit variable): maximum bits (6K + 6) and characters. */
export const CPIVAR_PARTITION: PartitionTable = /* @__PURE__ */ table(
  [114, 120, 126, 132, 138, 144, 150],
  [18, 19, 20, 21, 22, 23, 24],
);
