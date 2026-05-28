// Circular-arc geometry helpers.
//
// In our data model a Line with `arcCentreId` is a circular arc: it curves
// from `start` to `end` along the circle centred at the referenced Point.
// The radius is implied by |centre − start|; the second-radius constraint
// (|centre − end| should equal this) is the user's responsibility — the
// helpers here use |centre − start| and treat any discrepancy as a small
// rendering imperfection rather than a hard error.
//
// Convention for "convert line to arc": the centre is placed on the
// outward-normal side of the chord (right of line direction) at distance
// |chord|/2. This produces a 90° arc bulging to the left of the direction
// — geometrically the side opposite the outward normal.

import type { Vec2 } from "./types.js";

/**
 * Centre of a 90° arc with the given chord, placed on the right-of-direction
 * side (same side the outward normal points). The arc sweeps from start to
 * end going around this centre on the LEFT side of the chord — opposite the
 * normal.
 */
export function arcCentreFor90Degrees(start: Vec2, end: Vec2): Vec2 {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { x: start.x, y: start.y };
  // Right-of-direction unit normal.
  const nx = dy / len;
  const ny = -dx / len;
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  // For 90°: distance from chord midpoint to centre = chord_length / 2.
  const d = len / 2;
  return { x: mx + nx * d, y: my + ny * d };
}

/** Mirror a point across the infinite line through `a` and `b`. */
export function mirrorAcrossChord(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: p.x, y: p.y };
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return { x: 2 * projX - p.x, y: 2 * projY - p.y };
}

/** Distance from `centre` to `start` (used as the rendered radius). */
export function arcRadius(centre: Vec2, start: Vec2): number {
  return Math.hypot(centre.x - start.x, centre.y - start.y);
}

/**
 * Point on the arc at angular parameter t ∈ [0,1] from start to end going
 * around the centre via the side OPPOSITE the centre. Used to find the
 * arc's midpoint (t = 0.5) for the outward-normal tick.
 *
 * Algorithm: angles measured from centre. If the chord midpoint is on the
 * side of `centre` OPPOSITE the arc bulge, we want the arc going through
 * the bulge side. We pick the angular path (CCW or CW from centre's POV)
 * whose midpoint is farther from `centre` than the chord midpoint, i.e.
 * on the bulge side.
 */
export function arcPoint(
  start: Vec2,
  end: Vec2,
  centre: Vec2,
  t: number,
): Vec2 {
  const r = arcRadius(centre, start);
  if (r === 0) return { x: centre.x, y: centre.y };
  const startAng = Math.atan2(start.y - centre.y, start.x - centre.x);
  const endAng = Math.atan2(end.y - centre.y, end.x - centre.x);
  // We want the SHORT arc going from start to end around centre. There are
  // two angular paths; the short one has |Δ| ≤ π.
  let delta = endAng - startAng;
  // Normalise to (−π, π].
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  const ang = startAng + delta * t;
  return {
    x: centre.x + r * Math.cos(ang),
    y: centre.y + r * Math.sin(ang),
  };
}

/**
 * SVG `d` attribute body for a short (≤ 180°) arc from start to end around
 * centre. Use as the `d` of a `<path>` rendered inside our usual
 * `<g transform="scale(1,-1)">` group (no extra coordinate adjustment
 * needed because the path is in world coords).
 *
 * Choosing the SHORT arc means large-arc-flag = 0. Sweep-flag is picked so
 * the arc passes through the side OPPOSITE the centre (the bulge side).
 */
export function arcSvgPathD(start: Vec2, end: Vec2, centre: Vec2): string {
  const r = arcRadius(centre, start);
  // We need to pick the sweep flag so SVG renders the arc with OUR centre,
  // not the mirrored one. Two short arcs satisfy any (start, end, radius);
  // sweep flag selects which side the centre falls on.
  //
  // Derivation (path is inside <g scale(1,-1)>; path coords are world coords
  // and SVG parses them in y-down before the transform inverts):
  //   sweep 0 → SVG picks the centre at g-local "negative-y" side of chord
  //           = the side where (centre - start) × (end - start) < 0 in world
  //   sweep 1 → SVG picks the centre at g-local "positive-y" side
  //           = where the cross product is > 0 in world
  const ex = end.x - start.x;
  const ey = end.y - start.y;
  const cxv = centre.x - start.x;
  const cyv = centre.y - start.y;
  const cross = ex * cyv - ey * cxv;
  const sweepFlag = cross > 0 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 0 ${sweepFlag} ${end.x} ${end.y}`;
}

/**
 * True if `cursor` is within `tolerance` (world units) of the short arc
 * from `start` to `end` around `centre`.
 *
 * Approach: check radial distance, then check whether the point's angle
 * lies in the arc's angular sweep.
 */
export function cursorOnArc(
  cursor: Vec2,
  start: Vec2,
  end: Vec2,
  centre: Vec2,
  tolerance: number,
): boolean {
  const r = arcRadius(centre, start);
  if (r === 0) return false;
  const dx = cursor.x - centre.x;
  const dy = cursor.y - centre.y;
  const dist = Math.hypot(dx, dy);
  if (Math.abs(dist - r) > tolerance) return false;

  const startAng = Math.atan2(start.y - centre.y, start.x - centre.x);
  const endAng = Math.atan2(end.y - centre.y, end.x - centre.x);
  const cursorAng = Math.atan2(dy, dx);

  // Short-arc sweep, signed.
  let delta = endAng - startAng;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;
  // Relative angle of cursor w.r.t. start, in the same handedness as delta.
  let relCursor = cursorAng - startAng;
  while (relCursor > Math.PI) relCursor -= 2 * Math.PI;
  while (relCursor <= -Math.PI) relCursor += 2 * Math.PI;
  // Cursor angle must lie between 0 and delta (with sign).
  if (delta >= 0) {
    return relCursor >= -1e-9 && relCursor <= delta + 1e-9;
  } else {
    return relCursor <= 1e-9 && relCursor >= delta - 1e-9;
  }
}
