/**
 * Ordered-dither threshold maps.
 *
 * A Bayer matrix quantises a continuous field to 1-bit without the clumping
 * you get from a plain cutoff: each pixel is compared against its own
 * threshold, so a uniform mid-grey resolves to an even checker rather than a
 * flat block. Values are normalised to (0,1) and exclude 0 and 1 so a field
 * of exactly 0 is always off and exactly 1 is always on.
 */

const BAYER_8_RAW = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

export const BAYER_SIZE = 8;

/** Thresholds in (0,1), indexed `[(y % 8) * 8 + (x % 8)]`. */
export const BAYER_8 = Float32Array.from(BAYER_8_RAW, (v) => (v + 0.5) / 64);

/** Threshold for a pixel at integer canvas coordinates. */
export function thresholdAt(x: number, y: number): number {
  const col = ((x % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE;
  const row = ((y % BAYER_SIZE) + BAYER_SIZE) % BAYER_SIZE;
  return BAYER_8[row * BAYER_SIZE + col];
}

/** Hermite smoothstep, clamped to [0,1]. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Unnormalised gaussian, peak 1 at `x === center`. */
export function gaussian(x: number, center: number, sigma: number): number {
  const d = (x - center) / sigma;
  return Math.exp(-0.5 * d * d);
}
