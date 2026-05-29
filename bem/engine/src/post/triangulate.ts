// Post-process triangulation of the domain interior.
//
// Inputs
//   model    — the geometry/topology (lines, boundaries, domains)
//   density  — interior-sample spacing as a fraction of the AABB
//              diagonal (default 1/30, i.e. ~30 samples across)
//
// Output: an array of T6 triangles (3 vertex + 3 edge-midpoint node
// indices each) plus a flat array of node positions. Edge midpoints are
// shared between adjacent triangles by construction, giving continuous
// quadratic edges (the user's "quadratic continuous triangular sides").
//
// Strategy
//   1. Outer boundary polygon = geometry Points in CCW order along the
//      domain's outermost boundary.
//   2. Hole polygons = the same in CW order for any inner boundary.
//   3. Interior steiner points = uniform grid inside the AABB, clipped
//      to the domain interior via point-in-polygon and excluded if
//      inside any hole.
//   4. Constrained Delaunay via poly2tri.
//   5. T6 promotion: each unique edge gets a midpoint at the geometric
//      midpoint of its endpoints; midpoints are deduplicated by edge so
//      adjacent triangles share them.

import poly2tri from "poly2tri";
import type { CadModel, Id, Vec2 } from "../geometry/types.js";
import { arcPoint } from "../geometry/arc.js";
import { loopOrientation } from "../geometry/orientation.js";

/** Intermediate samples per arc segment when discretising arcs into the
 *  constrained-Delaunay polygon. Higher = closer fit to the true arc. */
const ARC_SUBDIVISIONS = 12;

export interface T6Triangle {
  /** 6 node indices into the post-mesh nodes array (3 vertex + 3 midpoints). */
  readonly nodes: readonly [number, number, number, number, number, number];
}

export interface PostMesh {
  readonly nodes: readonly Vec2[];
  readonly triangles: readonly T6Triangle[];
  /** Number of vertex (non-midpoint) nodes — first `vertexCount` entries
   *  of `nodes` are vertices; the rest are midpoints. */
  readonly vertexCount: number;
}

export interface TriangulateOptions {
  /** Interior sample spacing as a fraction of the AABB diagonal. */
  readonly density?: number;
}

const DEFAULT_DENSITY = 1 / 30;

/**
 * Triangulate the first domain of the model with T6 elements. Returns
 * `null` if the model has no domain or no valid boundary.
 */
export function triangulateDomain(
  model: CadModel,
  opts: TriangulateOptions = {},
): PostMesh | null {
  const density = opts.density ?? DEFAULT_DENSITY;
  if (model.domains.length === 0) return null;

  // Scan domains for the first one with a usable boundary set (CCW outer
  // + optional holes). User models sometimes accumulate empty domains
  // (leftover Create-domain clicks before lines existed); skip those.
  let outer: { points: Vec2[]; orientation: "ccw" | "cw" } | null = null;
  let holes: { points: Vec2[]; orientation: "ccw" | "cw" }[] = [];
  for (const domain of model.domains) {
    const polys: { points: Vec2[]; orientation: "ccw" | "cw" }[] = [];
    for (const bId of domain.boundaryIds) {
      const b = model.boundaries.find((bb) => bb.id === bId);
      if (!b || b.segments.length === 0) continue;
      const pts = boundaryPolygon(b, model);
      if (!pts || pts.length < 3) continue;
      const ori = loopOrientation(b.segments, model);
      if (ori === "degenerate") continue;
      polys.push({ points: pts, orientation: ori });
    }
    const candidate = polys.find((p) => p.orientation === "ccw");
    if (candidate) {
      outer = candidate;
      holes = polys.filter((p) => p !== candidate);
      break;
    }
  }
  if (!outer) return null;

  // Build the Steiner grid inside the outer AABB, masked to domain.
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of outer.points) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  const diag = Math.hypot(xMax - xMin, yMax - yMin);
  const step = Math.max(1e-9, diag * density);
  const steiner: Vec2[] = [];
  // Offset by half-step so grid doesn't land exactly on boundary chords.
  for (let x = xMin + step * 0.5; x < xMax; x += step) {
    for (let y = yMin + step * 0.5; y < yMax; y += step) {
      const pt = { x, y };
      if (!pointInPolygon(pt, outer.points)) continue;
      // Skip any inside a hole.
      let inHole = false;
      for (const h of holes) {
        if (pointInPolygon(pt, h.points)) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      steiner.push(pt);
    }
  }

  // poly2tri wants outer as a closed polyline of Point objects.
  const ctx = new poly2tri.SweepContext(
    outer.points.map((p) => new poly2tri.Point(p.x, p.y)),
  );
  for (const h of holes) {
    ctx.addHole(h.points.map((p) => new poly2tri.Point(p.x, p.y)));
  }
  for (const s of steiner) ctx.addPoint(new poly2tri.Point(s.x, s.y));

  try {
    ctx.triangulate();
  } catch {
    return null;
  }
  const tris = ctx.getTriangles();

  // Build the post-mesh: dedupe all vertices by position, then add
  // midpoints (also deduped per edge so shared between adjacent
  // triangles).
  const nodes: Vec2[] = [];
  const vertexIndexByKey = new Map<string, number>();
  const addNode = (p: { x: number; y: number }): number => {
    const key = posKey(p.x, p.y);
    const existing = vertexIndexByKey.get(key);
    if (existing !== undefined) return existing;
    const idx = nodes.length;
    vertexIndexByKey.set(key, idx);
    nodes.push({ x: p.x, y: p.y });
    return idx;
  };
  const triVertexIdxs: [number, number, number][] = tris.map((t) => {
    const a = t.getPoint(0);
    const b = t.getPoint(1);
    const c = t.getPoint(2);
    return [addNode(a), addNode(b), addNode(c)];
  });
  const vertexCount = nodes.length;

  // Per-edge midpoints. Key by sorted vertex-index pair so the same
  // edge from two adjacent triangles returns the same midpoint.
  const midpointByEdge = new Map<string, number>();
  const midpointFor = (a: number, b: number): number => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const key = `${lo}|${hi}`;
    const existing = midpointByEdge.get(key);
    if (existing !== undefined) return existing;
    const na = nodes[a]!;
    const nb = nodes[b]!;
    const m = { x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 };
    const idx = nodes.length;
    nodes.push(m);
    midpointByEdge.set(key, idx);
    return idx;
  };

  const triangles: T6Triangle[] = triVertexIdxs.map(([v1, v2, v3]) => {
    // Edges per the node numbering convention in shapeFunctionsT6:
    //   N4 = midpoint(1, 2)
    //   N5 = midpoint(2, 3)
    //   N6 = midpoint(3, 1)
    const m4 = midpointFor(v1, v2);
    const m5 = midpointFor(v2, v3);
    const m6 = midpointFor(v3, v1);
    return { nodes: [v1, v2, v3, m4, m5, m6] };
  });

  return { nodes, triangles, vertexCount };
}

/** Walk a boundary's segments and return the ordered sequence of points
 *  encountered, in traversal direction. Straight segments contribute
 *  just the start point; arc segments contribute the start + multiple
 *  intermediate samples along the curve, so the polygon hugs the arc
 *  instead of cutting across the chord. */
function boundaryPolygon(
  b: { segments: readonly { lineId: Id; direction: 1 | -1 }[] },
  model: Pick<CadModel, "lines" | "points">,
): Vec2[] | null {
  const linesById = new Map(model.lines.map((l) => [l.id, l]));
  const pointsById = new Map(model.points.map((p) => [p.id, p]));
  const out: Vec2[] = [];
  for (const seg of b.segments) {
    const line = linesById.get(seg.lineId);
    if (!line) return null;
    const startId = seg.direction === 1 ? line.startId : line.endId;
    const s = pointsById.get(startId);
    if (!s) return null;
    out.push({ x: s.x, y: s.y });

    // For arc segments, add intermediate samples along the curve so the
    // constrained polygon approximates the arc, not its chord.
    if (line.arcCentreId !== undefined) {
      const lineStart = pointsById.get(line.startId);
      const lineEnd = pointsById.get(line.endId);
      const centre = pointsById.get(line.arcCentreId);
      if (!lineStart || !lineEnd || !centre) return null;
      for (let i = 1; i < ARC_SUBDIVISIONS; i++) {
        const tSeg = i / ARC_SUBDIVISIONS; // 0 → seg start, 1 → seg end
        // arcPoint uses line-parametric t (start of line → end of line),
        // so flip when the segment traverses the line in reverse.
        const tLine = seg.direction === 1 ? tSeg : 1 - tSeg;
        out.push(arcPoint(lineStart, lineEnd, centre, tLine));
      }
    }
  }
  return out;
}

function posKey(x: number, y: number): string {
  return `${Math.round(x / 1e-9)}|${Math.round(y / 1e-9)}`;
}

/** Standard ray-casting point-in-polygon. */
function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    const intersect =
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
