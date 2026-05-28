// Classify a closed-loop polygon as CCW or CW using the signed-area
// (shoelace) formula in world coords (y-up).
//
//   A = 0.5 · Σ (x_i · y_{i+1} − x_{i+1} · y_i)
//
//   A > 0  → CCW (counter-clockwise)
//   A < 0  → CW
//   A ≈ 0  → degenerate (collinear or zero-area)
//
// In our BEM convention the *outward* normal of every Line is right-of-
// direction. For a CCW-traversed boundary that normal points OUT of the
// enclosed region — so the enclosed area is the material (bounded domain).
// For CW, the normal points INTO the enclosed region — so the material is
// the unbounded exterior of the polygon.

import type { BoundarySegment, CadModel } from "./types.js";

export type LoopOrientation = "ccw" | "cw" | "degenerate";

const EPS = 1e-12;

export function loopOrientation(
  segments: readonly BoundarySegment[],
  model: Pick<CadModel, "lines" | "points">,
): LoopOrientation {
  if (segments.length < 3) return "degenerate";
  const linesById = new Map(model.lines.map((l) => [l.id, l]));
  const pointsById = new Map(model.points.map((p) => [p.id, p]));

  // Vertices in traversal order — the start of each segment in its effective
  // direction. Loop closes back to the first implicitly.
  let sum = 0;
  let prevX = 0,
    prevY = 0;
  let firstX = 0,
    firstY = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const line = linesById.get(seg.lineId);
    if (!line) return "degenerate";
    const startId = seg.direction === 1 ? line.startId : line.endId;
    const p = pointsById.get(startId);
    if (!p) return "degenerate";
    if (i === 0) {
      firstX = p.x;
      firstY = p.y;
    } else {
      sum += prevX * p.y - p.x * prevY;
    }
    prevX = p.x;
    prevY = p.y;
  }
  // Close the loop.
  sum += prevX * firstY - firstX * prevY;

  if (Math.abs(sum) < EPS) return "degenerate";
  return sum > 0 ? "ccw" : "cw";
}
