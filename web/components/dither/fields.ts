import { gaussian, smoothstep } from "./bayer";

/**
 * Signal fields.
 *
 * Each returns strength in [0,1] for a point in normalised space, at loop phase
 * `t` (0→1). The space is a unit square: every motif below draws itself inside
 * (0,0)-(1,1) and returns 0 outside, so the renderer can letterbox it into a
 * box of any shape without the mark stretching or running off an edge.
 *
 * These are the raw material for the dither: a continuous field in, a 1-bit
 * image out. Different surfaces get different motifs so the texture reads as a
 * family of radio instruments rather than one repeated logo.
 */

export type Motif = "wifi" | "radar" | "waveform" | "ripple" | "liquid";
export type Field = (nx: number, ny: number, t: number) => number;

const TAU = Math.PI * 2;

/**
 * Emitter low and centred, arcs fanning up — the wifi glyph.
 *
 * The radii are sized so the inked mark fits the unit square with room to
 * spare. What has to clear the edge is not the nominal outer radius 0.593 but
 * the gaussian's tail: the dither lights a pixel from a field value of 1/128,
 * so ink reaches about three sigma past the arc, and the widest point of the
 * 45° cone lands at 0.675 · sin 45° ≈ 0.48 from the axis. The emitter sits at
 * y = 0.79, which centres that reach vertically against the dot below it.
 */
const wifi: Field = (nx, ny, t) => {
  const dx = nx - 0.5;
  const dy = ny - 0.79;
  const r = Math.hypot(dx, dy);

  const dot = 1 - smoothstep(0.072, 0.094, r);
  if (dot > 0.99) return 1;
  if (dy > 0) return dot;

  const cone = Math.PI / 4;
  const spread = 1 - smoothstep(cone * 0.72, cone, Math.abs(Math.atan2(dx, -dy)));
  if (spread <= 0) return dot;

  let arcs = 0;
  for (const radius of [0.21, 0.4, 0.593]) arcs = Math.max(arcs, gaussian(r, radius, 0.0273));

  const pulse = gaussian(r, t * 0.9, 0.1);
  return Math.max(dot, Math.min(1, arcs * spread * (0.42 + 0.72 * pulse)));
};

/** Range rings with a beam sweeping clockwise, trailing a decaying wake. */
const radar: Field = (nx, ny, t) => {
  const dx = nx - 0.5;
  const dy = ny - 0.5;
  const r = Math.hypot(dx, dy);
  if (r > 0.48) return 0;

  const sweep = t * TAU;
  let behind = (sweep - Math.atan2(dy, dx)) % TAU;
  if (behind < 0) behind += TAU;
  const beam = Math.exp(-behind * 2.4);

  let rings = 0;
  for (const radius of [0.16, 0.28, 0.4]) rings = Math.max(rings, gaussian(r, radius, 0.014));
  const spokes = gaussian(Math.abs(behind - Math.PI) % Math.PI, Math.PI / 2, 0.02) * 0.35;
  const hub = 1 - smoothstep(0.012, 0.024, r);

  const edge = 1 - smoothstep(0.42, 0.48, r);
  return Math.min(1, Math.max(hub, (rings * (0.3 + 1.1 * beam) + spokes + beam * 0.34) * edge));
};

/** An oscilloscope trace: three detuned sines scrolling under a centre axis. */
const waveform: Field = (nx, ny, t) => {
  const phase = t * TAU;
  const wave =
    0.55 * Math.sin(nx * 7.2 + phase) +
    0.3 * Math.sin(nx * 15.7 - phase * 1.6) +
    0.15 * Math.sin(nx * 29.1 + phase * 2.3);

  // Amplitude swells toward the middle so the trace has somewhere to go.
  const envelope = 0.16 + 0.12 * Math.sin(nx * Math.PI);
  const trace = gaussian(ny, 0.5 + wave * envelope, 0.018);
  const axis = gaussian(ny, 0.5, 0.004) * 0.3;

  return Math.min(1, Math.max(trace, axis));
};

/** Omnidirectional rings leaving the centre — a beacon rather than a device. */
const ripple: Field = (nx, ny, t) => {
  const dx = nx - 0.5;
  const dy = ny - 0.5;
  const r = Math.hypot(dx, dy);

  let rings = 0;
  for (let k = 0; k < 3; k++) {
    const front = ((t + k / 3) % 1) * 0.5;
    rings = Math.max(rings, gaussian(r, front, 0.022) * (1 - front / 0.5) ** 0.6);
  }
  const hub = 1 - smoothstep(0.014, 0.03, r);
  return Math.min(1, Math.max(hub, rings * (1 - smoothstep(0.38, 0.5, r))));
};

/**
 * Drifting metaballs — the one motif that draws nothing in particular.
 *
 * The others are diagrams: a wifi glyph, a radar sweep, a trace. This is weather. Six blobs
 * wander on slow lissajous paths and their gaussian falloffs sum, so they swell, merge and part
 * without ever repeating inside a human attention span. Through the ordered dither it resolves
 * into soft halftone clouds, which is what makes it usable as a ground: it has no edge, no
 * subject and no centre to compete with the text laid over it.
 *
 * Prime-ish frequency pairs keep the paths from re-synchronising into an obvious loop.
 */
const liquid: Field = (nx, ny, t) => {
  const phase = t * TAU;
  let sum = 0;

  for (let k = 0; k < BLOBS.length; k++) {
    const b = BLOBS[k]!;
    const cx = b.x + b.ax * Math.sin(phase * b.fx + b.px);
    const cy = b.y + b.ay * Math.cos(phase * b.fy + b.py);

    // Anisotropic, and paired with a smaller lobe that orbits it. A single round gaussian
    // dithers into a perfect ellipse, which reads as a shape someone drew; two unequal lobes
    // drifting against each other never settle into one.
    const dx = (nx - cx) / b.sx;
    const dy = (ny - cy) / b.sy;
    sum += Math.exp(-(dx * dx + dy * dy) / 2);

    const lx = (nx - (cx + b.lx * Math.cos(phase * b.lf + b.px))) / (b.sx * 0.62);
    const ly = (ny - (cy + b.ly * Math.sin(phase * b.lf + b.py))) / (b.sy * 0.62);
    sum += 0.55 * Math.exp(-(lx * lx + ly * ly) / 2);
  }

  // The floor is the whole trick. A gaussian never reaches zero, so without cutting one off the
  // field sits just high enough everywhere to light a scattering of dots — a grey haze rather
  // than clouds on paper.
  //
  // The ceiling matters as much: clamped at 1 the core saturates and fills solid, which is a
  // blob of colour, not a halftone. Holding the peak under the top Bayer threshold keeps the
  // densest part of a cloud made of dots.
  return Math.min(0.78, Math.max(0, (sum - 0.3) * 1.25));
};

// Four, at the corners, so the middle of the screen — where a column of text sits — stays paper.
const BLOBS = [
  { x: 0.12, y: 0.17, ax: 0.09, ay: 0.07, fx: 1, fy: 0.7, px: 0, py: 1.1, sx: 0.115, sy: 0.085, lx: 0.07, ly: 0.05, lf: 0.6 },
  { x: 0.88, y: 0.13, ax: 0.08, ay: 0.08, fx: 0.7, fy: 1.1, px: 2.2, py: 0.4, sx: 0.1, sy: 0.095, lx: 0.06, ly: 0.06, lf: 0.85 },
  { x: 0.91, y: 0.85, ax: 0.09, ay: 0.07, fx: 1.3, fy: 0.9, px: 4.1, py: 2.7, sx: 0.12, sy: 0.08, lx: 0.07, ly: 0.04, lf: 0.7 },
  { x: 0.09, y: 0.87, ax: 0.08, ay: 0.07, fx: 0.9, fy: 1.3, px: 1.4, py: 3.3, sx: 0.105, sy: 0.09, lx: 0.05, ly: 0.05, lf: 1.05 },
];

export const FIELDS: Record<Motif, Field> = { wifi, radar, waveform, ripple, liquid };

/**
 * Motifs sampled over the largest centred square of the canvas rather than the
 * whole of it, so the mark keeps its proportions and stays whole in any box.
 * The waveform is excluded on purpose: a trace is meant to run the full width
 * of whatever strip it is given.
 */
export const FITTED: Record<Motif, boolean> = {
  wifi: true,
  radar: true,
  ripple: true,
  waveform: false,
  // Weather fills whatever it is given; letterboxing it into a square would leave bare corners.
  liquid: false,
};

/** Phase to hold when motion is reduced: each motif's most legible frame. */
export const RESTING_PHASE: Record<Motif, number> = {
  liquid: 0.31,
  wifi: 0.62,
  radar: 0.14,
  waveform: 0.25,
  ripple: 0.45,
};
