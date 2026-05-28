// Snap a world-coord cursor position to either an existing Point (preferred)
// or to the nearest grid intersection.
//
// Policy:
// 1. Compute the nearest grid intersection (distance gridDist).
// 2. Find the existing point closest to the cursor, within `snapRadius`.
// 3. If such a point exists AND it's at least as close as the grid intersection,
//    snap to that point.
// 4. Otherwise snap to the grid intersection.
//
// Tied distances go to the existing point, so a point sitting *on* a grid
// intersection is always preferred when the cursor is closest to that
// intersection — which is what users want for revisiting an endpoint.

import type { Point, Vec2 } from "@bem/engine";

export interface SnapResult {
  readonly snapped: Vec2;
  /** Id of the existing Point we snapped to, or null if we snapped to grid. */
  readonly existingPointId: string | null;
}

export function snapWorld(
  cursor: Vec2,
  points: readonly Point[],
  gridStep: number,
  snapRadius: number,
): SnapResult {
  // Nearest grid intersection.
  const gridX = Math.round(cursor.x / gridStep) * gridStep;
  const gridY = Math.round(cursor.y / gridStep) * gridStep;
  const gdx = cursor.x - gridX;
  const gdy = cursor.y - gridY;
  const gridDistSq = gdx * gdx + gdy * gdy;

  // Closest existing point within snapRadius.
  let bestPoint: Point | null = null;
  let bestDistSq = snapRadius * snapRadius;
  for (const p of points) {
    const dx = p.x - cursor.x;
    const dy = p.y - cursor.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDistSq) {
      bestDistSq = d2;
      bestPoint = p;
    }
  }

  if (bestPoint && bestDistSq <= gridDistSq) {
    return {
      snapped: { x: bestPoint.x, y: bestPoint.y },
      existingPointId: bestPoint.id,
    };
  }

  return {
    snapped: { x: gridX, y: gridY },
    existingPointId: null,
  };
}
