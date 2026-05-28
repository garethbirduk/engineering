// Factory + immutable mutation helpers for the CadModel.

import type {
  BcAssignment,
  CadModel,
  DirectionBc,
  Id,
  Line,
  LineDiscretisation,
  Point,
} from "@bem/engine";

export const EMPTY_MODEL: CadModel = {
  points: [],
  lines: [],
  boundaries: [],
  domains: [],
  bcs: [],
  meshing: [],
};

/** Default discretisation when a line has no entry in `model.meshing`. */
export const DEFAULT_ELEMENTS_PER_LINE = 2;
export const DEFAULT_LOCAL_NODES: readonly [number, number, number] = [
  -2 / 3,
  0,
  2 / 3,
];

/** Look up the per-line meshing override; undefined if defaults apply. */
export function getLineDiscretisation(
  model: CadModel,
  lineId: Id,
): LineDiscretisation | undefined {
  return model.meshing.find((m) => m.lineId === lineId);
}

export function newId(): Id {
  return crypto.randomUUID();
}

export function makePoint(x: number, y: number): Point {
  return { id: newId(), x, y };
}

export function makeLine(startId: Id, endId: Id): Line {
  return { id: newId(), startId, endId };
}

export function addPoint(model: CadModel, point: Point): CadModel {
  return { ...model, points: [...model.points, point] };
}

export function addLine(model: CadModel, line: Line): CadModel {
  return { ...model, lines: [...model.lines, line] };
}

/** Fast id → Point lookup. Build once per render. */
export function pointMap(points: readonly Point[]): ReadonlyMap<Id, Point> {
  return new Map(points.map((p) => [p.id, p]));
}

/**
 * Read the BC assignment for a single line; undefined if none. Missing
 * directions inside an assignment default to traction zero (free surface).
 */
export function getBcAssignment(
  model: CadModel,
  lineId: Id,
): BcAssignment | undefined {
  return model.bcs.find((a) => a.lineId === lineId);
}

/**
 * Human-readable description of the BC for a single direction. Used for
 * read-only Inspector display until editing UI lands.
 */
export function describeDirectionBc(bc: DirectionBc | undefined): string {
  if (!bc) return "free (t = 0)";
  if (bc.kind === "displacement") return `u = ${bc.value}`;
  return `t = ${bc.value}`;
}
