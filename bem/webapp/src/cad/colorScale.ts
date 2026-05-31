// Shared rainbow colour scale for interior field contours.
//
// One palette serves both diverging fields (ux, uy, σxx, σyy, τxy, σ1,
// σ2) and positive-only fields (σvm, τmax). Five hue stops give a
// clear visual gradient with more discriminable intermediate bands
// than a 3-stop blue-green-red:
//
//     0.0   blue       (low / most-negative)
//     0.25  cyan
//     0.5   green      (zero / mid)
//     0.75  yellow
//     1.0   red        (high / most-positive)
//
// Diverging fields: t ∈ [-1, +1] is shifted to (t+1)/2 ∈ [0, 1] before
//   the palette lookup, so t = 0 lands at green (the rainbow's middle),
//   t = -1 → blue, t = +1 → red.
// Sequential fields: t ∈ [0, 1] passes through directly. t = 0 → blue,
//   t = 1 → red. Used for fields that are ≥ 0 by definition.
//
// In both cases t is quantised into BAND_COUNT bands so adjacent
// triangles of similar value snap to byte-identical colours, producing
// visible contour boundaries instead of a smooth gradient.

type RGB = readonly [number, number, number];

/** Number of contour bands. Must be odd to keep zero in the centre of
 *  the diverging scale (so a "near-zero" band straddles zero). */
export const BAND_COUNT = 11;

/** Five rainbow stops at t = 0, 0.25, 0.5, 0.75, 1.0. */
const RAINBOW: readonly { readonly t: number; readonly rgb: RGB }[] = [
  { t: 0.0, rgb: [50, 80, 220] }, // blue
  { t: 0.25, rgb: [40, 180, 220] }, // cyan
  { t: 0.5, rgb: [60, 180, 80] }, // green
  { t: 0.75, rgb: [240, 200, 50] }, // yellow
  { t: 1.0, rgb: [220, 60, 50] }, // red
];

function rgbStr(rgb: RGB): string {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** Continuous rainbow lookup at t ∈ [0, 1]. Piecewise-linear between
 *  the five stops. Out-of-range t is clamped. */
function rainbow(t: number): string {
  const x = Math.max(0, Math.min(1, t));
  for (let i = 0; i < RAINBOW.length - 1; i++) {
    const a = RAINBOW[i]!;
    const b = RAINBOW[i + 1]!;
    if (x <= b.t) {
      const f = (x - a.t) / (b.t - a.t);
      const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f);
      const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f);
      const bch = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f);
      return `rgb(${r},${g},${bch})`;
    }
  }
  return rgbStr(RAINBOW[RAINBOW.length - 1]!.rgb);
}

/** Snap t ∈ [-1, +1] to the centre of its band on the diverging scale. */
function quantiseDiverging(t: number): number {
  const x = Math.max(-1, Math.min(1, t));
  // Edges at (-1 + i·2/N) for i = 0..N. Pick the band index.
  const i = Math.max(
    0,
    Math.min(BAND_COUNT - 1, Math.floor(((x + 1) / 2) * BAND_COUNT)),
  );
  return (2 * i + 1) / BAND_COUNT - 1;
}

/** Snap t ∈ [0, +1] to the centre of its band on the sequential scale. */
function quantiseSequential(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  const i = Math.max(
    0,
    Math.min(BAND_COUNT - 1, Math.floor(x * BAND_COUNT)),
  );
  return (2 * i + 1) / (2 * BAND_COUNT);
}

/** Diverging rainbow: t ∈ [-1, +1] → rainbow at (t+1)/2. */
export function divergingUxColor(t: number): string {
  const q = quantiseDiverging(t);
  return rainbow((q + 1) / 2);
}

/** Sequential rainbow: t ∈ [0, +1] → rainbow directly. */
export function sequentialUxColor(t: number): string {
  const q = quantiseSequential(t);
  return rainbow(q);
}

// ─────────────────────────────────────────────────────────────────────
// CSS gradients for the legend bar — built from hard colour stops so
// each band shows as a solid block, matching the canvas fills exactly.
// ─────────────────────────────────────────────────────────────────────

/** Top = +1 (red), bottom = -1 (blue). For diverging fields. */
export function divergingGradientCss(): string {
  const stops: string[] = [];
  // Walk band indices top-to-bottom (highest value → lowest).
  for (let i = BAND_COUNT - 1; i >= 0; i--) {
    const tCentre = (2 * i + 1) / BAND_COUNT - 1;
    const c = divergingUxColor(tCentre);
    const topPct = ((BAND_COUNT - 1 - i) / BAND_COUNT) * 100;
    const botPct = ((BAND_COUNT - i) / BAND_COUNT) * 100;
    stops.push(`${c} ${topPct}%`, `${c} ${botPct}%`);
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/** Top = +range (red), bottom = 0 (blue). For positive-only fields. */
export function sequentialGradientCss(): string {
  const stops: string[] = [];
  for (let i = BAND_COUNT - 1; i >= 0; i--) {
    const tCentre = (2 * i + 1) / (2 * BAND_COUNT);
    const c = sequentialUxColor(tCentre);
    const topPct = ((BAND_COUNT - 1 - i) / BAND_COUNT) * 100;
    const botPct = ((BAND_COUNT - i) / BAND_COUNT) * 100;
    stops.push(`${c} ${topPct}%`, `${c} ${botPct}%`);
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

// ─────────────────────────────────────────────────────────────────────
// Band-edge value generators for the legend's numeric labels.
// ─────────────────────────────────────────────────────────────────────

/** Diverging: +range (top) → -range (bottom), N+1 values. */
export function bandEdgeValues(range: number): number[] {
  const out: number[] = new Array(BAND_COUNT + 1);
  for (let i = 0; i <= BAND_COUNT; i++) {
    out[i] = range * (1 - (2 * i) / BAND_COUNT);
  }
  return out;
}

/** Sequential: +range (top) → 0 (bottom), N+1 values. */
export function bandEdgeValuesSequential(range: number): number[] {
  const out: number[] = new Array(BAND_COUNT + 1);
  for (let i = 0; i <= BAND_COUNT; i++) {
    out[i] = range * (1 - i / BAND_COUNT);
  }
  return out;
}
