/**
 * Code 128 element widths (GenSpecs Table 5-25): value v (0 to 106) is `W.slice(6v, 6v + 6)`,
 * bar first; entry 106 is the first six elements of the stop. Research ITF/GS1-128 1.1.
 */
const W =
  '212222222122222221121223121322131222122213122312132212221213221312231212112232122132122231113222' +
  '123122123221223211221132221231213212223112312131311222321122321221312212322112322211212123212321' +
  '232121111323131123131321112313132113132311211313231113231311112133112331132131113123113321133121' +
  '313121211331231131213113213311213131311123311321331121312113312311332111314111221411431111111224' +
  '111422121124121421141122141221112214112412122114122411142112142211241211221114413111241112134111' +
  '111242121142121241114212124112124211411212421112421211212141214121412121111143111341131141114113' +
  '114311411113411311113141114131311141411131211412211214211232233111';

export const C128_COUNT = 107;
export const START_A = 103;
export const START_B = 104;
export const START_C = 105;
export const STOP = 106;
export const FNC1 = 102;

/** 107 x 6 element widths. */
export const C128_WIDTHS: Uint8Array = /* @__PURE__ */ (() => {
  const out = new Uint8Array(C128_COUNT * 6);
  for (let i = 0; i < out.length; i++) out[i] = W.charCodeAt(i) - 48;
  return out;
})();

/** The stop pattern, 7 elements. */
export const C128_STOP: readonly number[] = [2, 3, 3, 1, 1, 1, 2];

/** Lookup key of six widths 1 to 4, two bits each. */
export function c128Key(w: readonly number[], from: number): number {
  let key = 0;
  for (let k = 0; k < 6; k++) key = key * 4 + ((w[from + k] ?? 1) - 1);
  return key;
}

/** Symbol value by `c128Key`, -1 for unknown. */
export const C128_LOOKUP: Int16Array = /* @__PURE__ */ (() => {
  const out = new Int16Array(4096).fill(-1);
  for (let v = 0; v < C128_COUNT; v++) {
    let key = 0;
    for (let k = 0; k < 6; k++) key = key * 4 + ((C128_WIDTHS[6 * v + k] ?? 1) - 1);
    out[key] = v;
  }
  return out;
})();
