// Discretisation: turn each Line into a sequence of quadratic elements.
//
// Strategy: a uniform split into N elements per line. Each element has 3
// nodes at the local η coordinates supplied (default ±2/3, 0 — the
// "discontinuous" configuration). With 2 elements per line and those nodes
// the 6 nodes are uniformly spaced on the line including across the element
// boundary, with half-gaps to the line endpoints.
//
// Isoparametric placement: node positions are computed via
//   x(η) = Σ N_k(η) · x_k^anchor
// where the 3 anchors are sampled from the true line geometry at element-
// local η = -1, 0, +1, and N_k is the continuous-basis shape function (Eq
// 2.42 with nodes {-1, 0, +1}). This is exactly the formula the future
// solver will use at every Gauss-point query, so the visualised nodes match
// the analysis positions — for straight lines this is exact, for arcs it
// produces a quadratic approximation of the curve (within O(h³) of the
// true arc).

import { arcPoint } from "../geometry/arc.js";
import type { CadModel, Line, Point, Vec2 } from "../geometry/types.js";
import {
  STANDARD_NODES,
  shapeFunctions,
  type LocalNodes,
} from "./shapeFunctions.js";

/**
 * The 3 anchor η coords used for the isoparametric geometry. Always
 * continuous {-1, 0, +1} — anchors sit at the element corners and midpoint.
 */
const GEOMETRY_ANCHORS: LocalNodes = STANDARD_NODES.continuous;

export interface MeshElement {
  readonly lineId: string;
  /** 0-based index of this element along its parent line. */
  readonly indexInLine: number;
  /** Parent-line parametric t at η = -1 and η = +1. */
  readonly tStart: number;
  readonly tEnd: number;
  /** World positions of the element endpoints (t = tStart, t = tEnd). */
  readonly start: Vec2;
  readonly end: Vec2;
  /** World positions of the 3 nodes at the local η coords. */
  readonly nodes: readonly [Vec2, Vec2, Vec2];
  /** Local η coords (∈ [-1, +1]) of the 3 nodes — same values used to place them. */
  readonly localNodes: readonly [number, number, number];
  /** Parent-line parametric t corresponding to each node. */
  readonly nodeTs: readonly [number, number, number];
}

export interface DiscretiseOptions {
  /** Elements per line (default 2). */
  readonly elementsPerLine?: number;
  /** Local η coords for the 3 nodes (default STANDARD_NODES.discontinuous). */
  readonly localNodes?: LocalNodes;
}

/** Point on a Line at parametric t ∈ [0, 1]. Straight or arc. */
export function pointAtT(
  line: Line,
  t: number,
  points: ReadonlyMap<string, Point>,
): Vec2 | null {
  const s = points.get(line.startId);
  const e = points.get(line.endId);
  if (!s || !e) return null;
  if (line.arcCentreId) {
    const c = points.get(line.arcCentreId);
    if (!c) return null;
    return arcPoint(s, e, c, t);
  }
  return { x: s.x + t * (e.x - s.x), y: s.y + t * (e.y - s.y) };
}

/**
 * Discretise every Line in the model into quadratic elements. Per-line
 * overrides in `model.meshing` win over `opts`, which wins over the
 * built-in defaults (2 elements, η = ±2/3, 0). Lines with missing
 * referenced points are silently skipped.
 */
export function discretiseLines(
  model: Pick<CadModel, "lines" | "points"> & {
    meshing?: readonly {
      readonly lineId: string;
      readonly elementsPerLine?: number;
      readonly localNodes?: readonly [number, number, number];
      readonly elementLocalNodes?: {
        readonly [index: string]: readonly [number, number, number];
      };
    }[];
  },
  opts: DiscretiseOptions = {},
): MeshElement[] {
  const defaultN = opts.elementsPerLine ?? 2;
  const defaultNodes = opts.localNodes ?? STANDARD_NODES.discontinuous;
  const points = new Map(model.points.map((p) => [p.id, p] as const));
  const meshingByLineId = new Map(
    (model.meshing ?? []).map((m) => [m.lineId, m] as const),
  );
  const out: MeshElement[] = [];

  for (const line of model.lines) {
    const override = meshingByLineId.get(line.id);
    const n = Math.max(1, Math.floor(override?.elementsPerLine ?? defaultN));
    const baseNodes = override?.localNodes ?? defaultNodes;
    const perElement = override?.elementLocalNodes;

    for (let i = 0; i < n; i++) {
      // Per-element override wins over the line-level base.
      const nodes = perElement?.[String(i)] ?? baseNodes;
      const tStart = i / n;
      const tEnd = (i + 1) / n;
      const tMid = (tStart + tEnd) / 2;
      // Anchors at element-local η = -1, 0, +1 — sampled from the true
      // line geometry. These define the isoparametric quadratic geometry
      // of the element.
      const anchor0 = pointAtT(line, tStart, points);
      const anchor1 = pointAtT(line, tMid, points);
      const anchor2 = pointAtT(line, tEnd, points);
      if (!anchor0 || !anchor1 || !anchor2) continue;
      // Element endpoints = anchors at η = ±1.
      const start = anchor0;
      const end = anchor2;

      // Node positions via shape-function interpolation on the anchors —
      // identical to what the solver will compute at every Gauss point.
      const nodePts: Vec2[] = [];
      const nodeTs: number[] = [];
      for (const eta of nodes) {
        const N = shapeFunctions(eta, GEOMETRY_ANCHORS);
        const px = N[0] * anchor0.x + N[1] * anchor1.x + N[2] * anchor2.x;
        const py = N[0] * anchor0.y + N[1] * anchor1.y + N[2] * anchor2.y;
        nodePts.push({ x: px, y: py });
        const local = (eta + 1) / 2;
        nodeTs.push(tStart + local * (tEnd - tStart));
      }

      out.push({
        lineId: line.id,
        indexInLine: i,
        tStart,
        tEnd,
        start,
        end,
        nodes: [nodePts[0]!, nodePts[1]!, nodePts[2]!] as const,
        localNodes: [nodes[0]!, nodes[1]!, nodes[2]!] as const,
        nodeTs: [nodeTs[0]!, nodeTs[1]!, nodeTs[2]!] as const,
      });
    }
  }
  return out;
}
