/** True where mask `mask` (ISO 0..7) flips the module at column `x`, row `y` (QR research 3.1). */
export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (((y >> 1) + Math.floor(x / 3)) & 1) === 0;
    case 5:
      return ((x * y) & 1) + ((x * y) % 3) === 0;
    case 6:
      return ((((x * y) & 1) + ((x * y) % 3)) & 1) === 0;
    case 7:
      return ((((x + y) & 1) + ((x * y) % 3)) & 1) === 0;
    default:
      throw new RangeError(`QR mask out of range: ${mask}`);
  }
}

/**
 * N1 + N3 of one row or column: `size` modules from `start`, `step` apart. `runs` is scratch space
 * of at least `size + 1` entries.
 */
function lineScore(
  bits: Uint8Array,
  start: number,
  step: number,
  size: number,
  runs: Int32Array,
): number {
  let score = 0;
  // Run lengths as [light, dark, light, ...]; the first entry is 0 when the line starts dark.
  let len = 0;
  let colour = 0;
  let run = 0;
  for (let i = 0, p = start; i < size; i++, p += step) {
    const b = bits[p]!;
    if (b === colour) {
      run++;
    } else {
      if (run >= 5) score += run - 2;
      runs[len++] = run;
      colour = b;
      run = 1;
    }
  }
  if (run >= 5) score += run - 2;
  runs[len++] = run;
  // N3: a dark run of 3k with k-module neighbours, light margin of 4 or the edge on either side.
  for (let i = 3; i <= len - 3; i += 2) {
    const r = runs[i]!;
    if (r % 3 !== 0) continue;
    const k = r / 3;
    if (runs[i - 2] !== k || runs[i - 1] !== k || runs[i + 1] !== k || runs[i + 2] !== k) continue;
    if (i === 3 || i + 4 >= len || (runs[i - 3] ?? 0) >= 4 || (runs[i + 3] ?? 0) >= 4) score += 40;
  }
  return score;
}

/**
 * The BWIPP-compatible penalty (QR research 3.2, decision Q6) of a full `size` x `size` matrix
 * given row-major (0 light, 1 dark): N1 + N2 + N3 + N4. Linear in the number of modules.
 */
export function penalty(bits: Uint8Array, size: number): number {
  const runs = new Int32Array(size + 1);
  let score = 0;
  for (let y = 0; y < size; y++) score += lineScore(bits, y * size, 1, size, runs);
  for (let x = 0; x < size; x++) score += lineScore(bits, x, size, size, runs);
  // N2: every one-coloured 2x2 block (branch-free: random data mispredicts); N4 counts dark modules.
  let blocks = 0;
  let dark = 0;
  for (let y = 0; y + 1 < size; y++) {
    let p = y * size;
    let left = bits[p]! | (bits[p + size]! << 1);
    dark += bits[p]!;
    for (let x = 1; x < size; x++) {
      p++;
      const right = bits[p]! | (bits[p + size]! << 1);
      dark += bits[p]!;
      // The 2x2 block as 4 bits: 15 all dark, 0 all light.
      const quad = left | (right << 2);
      blocks += ((quad + 1) >> 4) | (quad === 0 ? 1 : 0);
      left = right;
    }
  }
  for (let p = (size - 1) * size; p < size * size; p++) dark += bits[p]!;
  score += 3 * blocks;
  const total = size * size;
  return score + 10 * Math.floor(Math.abs(20 * dark - 10 * total) / total);
}

/** Bit `mask` set where that mask flips the module at column `x`, row `y`. */
export function maskPatterns(x: number, y: number): number {
  let v = 0;
  for (let mask = 0; mask < 8; mask++) if (maskBit(mask, x, y)) v |= 1 << mask;
  return v;
}

/**
 * The penalty of each of the eight masks: `template` (the scoring matrix: function patterns, all
 * format modules dark, the dark module and the version modules light) with `dataBits[k]` placed at
 * module `order[k]` and masked (`patterns[k]` is `maskPatterns` of that module). `template` is not
 * modified.
 */
export function maskScores(
  template: Uint8Array,
  size: number,
  order: Int32Array,
  patterns: Uint8Array,
  dataBits: Uint8Array,
): number[] {
  const candidate = new Uint8Array(template.length);
  const scores: number[] = [];
  for (let mask = 0; mask < 8; mask++) {
    candidate.set(template);
    for (let k = 0; k < order.length; k++)
      candidate[order[k]!] = dataBits[k]! ^ ((patterns[k]! >> mask) & 1);
    scores.push(penalty(candidate, size));
  }
  return scores;
}

/** The mask with the lowest score, the lowest mask number on ties. */
export function chooseMask(scores: readonly number[]): number {
  let best = 0;
  for (let mask = 1; mask < scores.length; mask++)
    if ((scores[mask] ?? Infinity) < (scores[best] ?? Infinity)) best = mask;
  return best;
}
