// Shared diverging colour scale for interior field contours.
//
// Symmetric blue → green → red: t ∈ [-1, +1] maps so that t = -1 is the
// most-negative colour, t = 0 is "no signal", and t = +1 is the most-
// positive. Used by both the canvas fills (per-sub-triangle solid fills)
// and the results-panel legend (CSS linear-gradient).

const BLUE: readonly [number, number, number] = [40, 90, 210];
const GREEN: readonly [number, number, number] = [40, 170, 90];
const RED: readonly [number, number, number] = [220, 60, 50];

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

export function divergingUxColor(t: number): string {
  const x = Math.max(-1, Math.min(1, t));
  return x < 0 ? mix(BLUE, GREEN, x + 1) : mix(GREEN, RED, x);
}

/** CSS background string for a vertical legend bar (top = +1, bottom = -1). */
export function divergingGradientCss(): string {
  return [
    "linear-gradient(to bottom",
    `${divergingUxColor(1)} 0%`,
    `${divergingUxColor(0.5)} 25%`,
    `${divergingUxColor(0)} 50%`,
    `${divergingUxColor(-0.5)} 75%`,
    `${divergingUxColor(-1)} 100%)`,
  ].join(", ");
}
