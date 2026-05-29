// Shared diverging colour scale for interior field contours.
//
// Symmetric blue → green → red banded scale: t ∈ [-1, +1] is quantised
// into BAND_COUNT discrete bands so equal-valued sub-triangles snap to
// identical colours. That turns the smooth gradient into a classic
// contour plot — bands of constant colour separated by jumps at known
// values, which is far easier to read than a continuous shading.
//
// BAND_COUNT is odd so a central band straddles zero — "near zero"
// reads as green, anything outside that lights up.

const BLUE: readonly [number, number, number] = [40, 90, 210];
const GREEN: readonly [number, number, number] = [40, 170, 90];
const RED: readonly [number, number, number] = [220, 60, 50];

/** Number of contour bands. Must be odd to keep zero in the middle. */
export const BAND_COUNT = 11;

function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  f: number,
): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bch = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bch})`;
}

/** Snap t ∈ [-1,+1] to the centre of its band, then look up the smooth
 *  colour at that centre. Two values that fall in the same band return
 *  byte-identical colours, which is what makes adjacent triangles
 *  collapse into visible contour regions. */
function quantise(t: number): number {
  const x = Math.max(-1, Math.min(1, t));
  // Edges at (-1 + i·2/N) for i = 0..N. The band containing x is:
  //   i = clamp(floor((x+1) * N/2), 0, N-1)
  const i = Math.max(
    0,
    Math.min(BAND_COUNT - 1, Math.floor(((x + 1) / 2) * BAND_COUNT)),
  );
  return (2 * i + 1) / BAND_COUNT - 1;
}

export function divergingUxColor(t: number): string {
  const q = quantise(t);
  return q < 0 ? mix(BLUE, GREEN, q + 1) : mix(GREEN, RED, q);
}

/** CSS background string for the legend bar (top = +1, bottom = -1).
 *  Built from hard colour stops so each band shows as a solid block,
 *  matching the canvas fills exactly. */
export function divergingGradientCss(): string {
  const stops: string[] = [];
  // Walk band indices top-to-bottom so the CSS reads in visual order.
  for (let i = BAND_COUNT - 1; i >= 0; i--) {
    const tCentre = (2 * i + 1) / BAND_COUNT - 1;
    const c = divergingUxColor(tCentre);
    const topPct = ((BAND_COUNT - 1 - i) / BAND_COUNT) * 100;
    const botPct = ((BAND_COUNT - i) / BAND_COUNT) * 100;
    stops.push(`${c} ${topPct}%`, `${c} ${botPct}%`);
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/** Field values at every band edge from +range (top) down to -range
 *  (bottom). Length = BAND_COUNT + 1. Used by the legend to print one
 *  label per band boundary so the user can read off the value of each
 *  contour transition directly. */
export function bandEdgeValues(range: number): number[] {
  const out: number[] = new Array(BAND_COUNT + 1);
  for (let i = 0; i <= BAND_COUNT; i++) {
    // i = 0 → top (+range), i = BAND_COUNT → bottom (-range).
    out[i] = range * (1 - (2 * i) / BAND_COUNT);
  }
  return out;
}
