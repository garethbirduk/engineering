// Factory + immutable mutation helpers for the CadModel.
// Kept tiny and pure; UI is the only mutator of state, so it lives here in
// the webapp rather than in @bem/engine.

import {
  STANDARD_NODES,
  type CadModel,
  type Id,
  type Line,
  type LineBcs,
  type Point,
} from "@bem/engine";

export const EMPTY_MODEL: CadModel = {
  points: [],
  lines: [],
  boundaries: [],
  domains: [],
};

/** Default per-line BCs: all four directions unknown. */
export const DEFAULT_LINE_BCS: LineBcs = {
  dx: { kind: "unknown" },
  dy: { kind: "unknown" },
  tx: { kind: "unknown" },
  ty: { kind: "unknown" },
};

export function newId(): Id {
  return crypto.randomUUID();
}

export function makePoint(x: number, y: number): Point {
  return { id: newId(), x, y };
}

export function makeLine(startId: Id, endId: Id): Line {
  return {
    id: newId(),
    startId,
    endId,
    nElements: 1,
    localNodes: STANDARD_NODES.discontinuous,
    bcs: DEFAULT_LINE_BCS,
  };
}

export function addPoint(model: CadModel, point: Point): CadModel {
  return { ...model, points: [...model.points, point] };
}

export function addLine(model: CadModel, line: Line): CadModel {
  return { ...model, lines: [...model.lines, line] };
}

/** Fast id → Point lookup. Build once per render, not per line. */
export function pointMap(points: readonly Point[]): ReadonlyMap<Id, Point> {
  return new Map(points.map((p) => [p.id, p]));
}
