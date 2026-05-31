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
import type {
  BcAssignment,
  Boundary,
  CadModel,
  DirectionBc,
  Id,
  Line,
  Point,
  Vec2,
} from "../geometry/types.js";
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

/**
 * Per-node DOF state in 2D elasticity. Each node has 4 fields:
 * 2 displacement components (ux, uy) and 2 traction components (tx, ty).
 * Pre-solve, exactly one of each axis pair is KNOWN (filled from the BC)
 * and the other is UNKNOWN (NaN). Post-solve all 4 are populated.
 *
 * Default for any unconstrained DOF: traction known = 0 (BEM free surface),
 * displacement unknown = NaN.
 */
export interface MeshNode {
  readonly x: number;
  readonly y: number;
  readonly ux: number;
  readonly uy: number;
  readonly tx: number;
  readonly ty: number;
}

/** Default SI prefix per BC kind — mirrors the UI default (MPa / mm). */
function defaultPrefixPower(kind: "traction" | "displacement"): number {
  return kind === "traction" ? 6 : -3;
}

/** BC value in SI base units (Pa or m), applying the SI prefix. */
function siValue(bc: DirectionBc): number {
  const p = bc.prefix ?? defaultPrefixPower(bc.kind);
  return bc.value * Math.pow(10, p);
}

/**
 * Build a node's DOF tuple from the line's BC entry.
 * Free surface default (no BC entry, or no entry for that axis):
 *   tx = ty = 0 (known), ux = uy = NaN (unknown)
 * Displacement BC on an axis: that axis's u = value (known), t = NaN.
 * Traction BC on an axis:      that axis's t = value (known), u = NaN.
 */
function nodeDofsFromBc(
  bc: BcAssignment | undefined,
): { ux: number; uy: number; tx: number; ty: number } {
  let ux = NaN;
  let uy = NaN;
  let tx = 0;
  let ty = 0;
  if (bc?.x) {
    const v = siValue(bc.x);
    if (bc.x.kind === "displacement") {
      ux = v;
      tx = NaN;
    } else {
      tx = v;
    }
  }
  if (bc?.y) {
    const v = siValue(bc.y);
    if (bc.y.kind === "displacement") {
      uy = v;
      ty = NaN;
    } else {
      ty = v;
    }
  }
  return { ux, uy, tx, ty };
}

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
  /**
   * World positions of the 3 isoparametric geometry anchors at element-
   * local η = -1, 0, +1. Anchors define the element's quadratic geometry;
   * solver integrations evaluate x(η) and dx/dη via shape functions on
   * these. anchors[0] === start, anchors[2] === end by construction.
   */
  readonly anchors: readonly [Vec2, Vec2, Vec2];
  /**
   * 3 nodes at the local η coords. Each carries its world position AND
   * the 4 DOFs (ux, uy, tx, ty) — knowns populated from the line's BC,
   * unknowns set to NaN. After solve() runs, the unknowns are filled in.
   */
  readonly nodes: readonly [MeshNode, MeshNode, MeshNode];
  /** Local η coords (∈ [-1, +1]) of the 3 nodes — same values used to place them. */
  readonly localNodes: readonly [number, number, number];
  /** Parent-line parametric t corresponding to each node. */
  readonly nodeTs: readonly [number, number, number];
  /** True when this element belongs to a boundary segment with
   *  direction = -1 — i.e. the boundary is traversed against the line's
   *  native start→end. The element's own data (anchors, nodes,
   *  localNodes, indexInLine, tStart/tEnd) is unchanged; only its
   *  position in the global mesh array reflects the boundary walk.
   *
   *  The assembler reads this flag to walk node indices [2,1,0]
   *  instead of [0,1,2] when assigning global DOF indices, so adjacent
   *  rows of H/G/u/t correspond to geometrically adjacent DOFs along
   *  the boundary traversal — making the system matrix's row order
   *  follow boundary → line → element → node (boundary-walk side) → axis. */
  readonly traverseReversed?: boolean;
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
    boundaries?: readonly Boundary[];
    meshing?: readonly {
      readonly lineId: string;
      readonly elementsPerLine?: number;
      readonly localNodes?: readonly [number, number, number];
      readonly elementLocalNodes?: {
        readonly [index: string]: readonly [number, number, number];
      };
    }[];
    bcs?: readonly BcAssignment[];
  },
  opts: DiscretiseOptions = {},
): MeshElement[] {
  const defaultN = opts.elementsPerLine ?? 2;
  const defaultNodes = opts.localNodes ?? STANDARD_NODES.discontinuous;
  const points = new Map(model.points.map((p) => [p.id, p] as const));
  const meshingByLineId = new Map(
    (model.meshing ?? []).map((m) => [m.lineId, m] as const),
  );
  const bcByLineId = new Map(
    (model.bcs ?? []).map((b) => [b.lineId, b] as const),
  );

  // Phase 1 — discretise each line independently into its native (start →
  // end) sequence of elements. Stored by lineId so phase 2 can pull them
  // out in boundary-traversal order.
  const elementsByLineId = new Map<Id, MeshElement[]>();
  for (const line of model.lines) {
    const override = meshingByLineId.get(line.id);
    const n = Math.max(1, Math.floor(override?.elementsPerLine ?? defaultN));
    const baseNodes = override?.localNodes ?? defaultNodes;
    const perElement = override?.elementLocalNodes;
    // Pre-solve DOF state for every node on this line, derived from the
    // line-level BC entry. Same fan-out to every element/node along the
    // line — the BC applies uniformly. The solver later replaces NaN
    // entries with computed values.
    const nodeDofs = nodeDofsFromBc(bcByLineId.get(line.id));
    const lineElems: MeshElement[] = [];

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
      // Each MeshNode also carries its 4 DOFs (ux, uy, tx, ty) populated
      // from the line-level BC (unknowns left as NaN for the solver).
      const nodePts: MeshNode[] = [];
      const nodeTs: number[] = [];
      for (const eta of nodes) {
        const N = shapeFunctions(eta, GEOMETRY_ANCHORS);
        const px = N[0] * anchor0.x + N[1] * anchor1.x + N[2] * anchor2.x;
        const py = N[0] * anchor0.y + N[1] * anchor1.y + N[2] * anchor2.y;
        nodePts.push({ x: px, y: py, ...nodeDofs });
        const local = (eta + 1) / 2;
        nodeTs.push(tStart + local * (tEnd - tStart));
      }

      lineElems.push({
        lineId: line.id,
        indexInLine: i,
        tStart,
        tEnd,
        start,
        end,
        anchors: [anchor0, anchor1, anchor2] as const,
        nodes: [nodePts[0]!, nodePts[1]!, nodePts[2]!] as const,
        localNodes: [nodes[0]!, nodes[1]!, nodes[2]!] as const,
        nodeTs: [nodeTs[0]!, nodeTs[1]!, nodeTs[2]!] as const,
      });
    }
    elementsByLineId.set(line.id, lineElems);
  }

  // Phase 2 — flatten into mesh order. Walk every boundary's segments in
  // order, honouring direction. The mesh array's order drives the global
  // DOF ordering in assembleHG (collocation row index = order of first
  // appearance), so this is what gives H/G/u/t the
  //   boundary → line → element → node (boundary-walk side) → axis
  // row layout.
  //
  // Reversed segments (direction = -1): emit that line's elements in
  // reverse order and tag each with `traverseReversed: true`. The flag
  // tells assembleHG's node-registry pass to walk node indices [2,1,0]
  // instead of [0,1,2], so within the element the boundary-walk-first
  // node still gets the smallest fresh global index.
  //
  // Lines not referenced by ANY boundary segment are appended at the end
  // in JSON order (covers minimal test models that omit boundaries and
  // any in-progress geometry the user hasn't committed to a boundary).
  const out: MeshElement[] = [];
  const visited = new Set<Id>();
  for (const boundary of model.boundaries ?? []) {
    for (const segment of boundary.segments) {
      const lineElems = elementsByLineId.get(segment.lineId);
      if (!lineElems) continue;
      visited.add(segment.lineId);
      if (segment.direction === 1) {
        for (const el of lineElems) out.push(el);
      } else {
        for (let i = lineElems.length - 1; i >= 0; i--) {
          out.push({ ...lineElems[i]!, traverseReversed: true });
        }
      }
    }
  }
  for (const line of model.lines) {
    if (visited.has(line.id)) continue;
    const lineElems = elementsByLineId.get(line.id);
    if (!lineElems) continue;
    for (const el of lineElems) out.push(el);
  }
  return out;
}
