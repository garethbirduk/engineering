// Project a 2D point onto a finite line segment.
//
// Returns the closest point on the segment to the input. The result is
// clamped to the segment endpoints — i.e. if the perpendicular foot lies
// past either end, the corresponding endpoint is returned instead.
//
// For a degenerate segment (a === b), the segment "is" the point a, and a is
// returned regardless of the input.

import type { Vec2 } from "./types.js";

export function projectOntoSegment(
  point: Vec2,
  a: Vec2,
  b: Vec2,
): Vec2 {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: a.x, y: a.y };
  const tRaw = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq;
  const t = Math.max(0, Math.min(1, tRaw));
  return { x: a.x + t * dx, y: a.y + t * dy };
}
