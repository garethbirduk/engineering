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
import type { MeshElement } from "../elements/discretise.js";
import { arcPoint } from "../geometry/arc.js";
import { loopOrientation } from "../geometry/orientation.js";

/** Intermediate samples per arc segment when discretising arcs into the
 *  boundary polygon (chord-arc fit). BEM nodes are added as steiners
 *  on top of this, so this just needs to be dense enough that the
 *  polygon hugs the curve. */
const ARC_SUBDIVISIONS = 12;

/** Ring radii (× arc radius) for the concentric steiner rings placed
 *  around each unique arc centre. Captures gradient near features. */
const RING_RADII_FACTORS: readonly number[] = [1.2, 1.5];

/** Proximity rejection threshold for candidate steiner points,
 *  expressed as a fraction of the steiner spacing. Candidates within
 *  this distance of any boundary sample or already-accepted steiner
 *  get dropped — keeps the triangulation from getting pathological in
 *  tight spaces. */
const PROXIMITY_THRESHOLD_FRAC = 0.5;

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
  /** Absolute spacing for the interior steiner grid, in world units.
   *  Overrides `density` when both supplied. Typically set to the
   *  average boundary element size so the interior mesh matches the
   *  boundary discretisation. */
  readonly spacing?: number;
  /** Interior sample spacing as a fraction of the AABB diagonal.
   *  Used when `spacing` is not given. */
  readonly density?: number;
  /** Ring radii (× arc radius) for the concentric steiner rings placed
   *  around each unique arc centre. Default [1.2, 1.5]. Empty array
   *  disables ring placement (uniform grid only). */
  readonly ringFactors?: readonly number[];
}

const DEFAULT_DENSITY = 1 / 30;

/**
 * Triangulate the first domain of the model with T6 elements. Returns
 * `null` if the model has no domain or no valid boundary.
 */
export function triangulateDomain(
  model: CadModel,
  mesh: readonly MeshElement[],
  opts: TriangulateOptions = {},
): PostMesh | null {
  if (model.domains.length === 0) {
    // eslint-disable-next-line no-console
    console.debug("[triangulate] no domains");
    return null;
  }
  if (mesh.length === 0) {
    // eslint-disable-next-line no-console
    console.debug("[triangulate] empty BEM mesh");
    return null;
  }

  // Group BEM elements by their parent line, in element-order. The
  // triangulation boundary polygon walks segments and appends each
  // element's 3 nodes — that way every boundary triangle edge IS a
  // BEM element (or part of one), and boundary triangle vertices
  // coincide with solved BEM nodes.
  const elsByLineId = new Map<Id, MeshElement[]>();
  for (const el of mesh) {
    const arr = elsByLineId.get(el.lineId);
    if (arr) arr.push(el);
    else elsByLineId.set(el.lineId, [el]);
  }
  for (const arr of elsByLineId.values()) {
    arr.sort((a, b) => a.indexInLine - b.indexInLine);
  }

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
      const pts = boundaryPolygonFromGeometry(b, model);
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
  if (!outer) {
    // eslint-disable-next-line no-console
    console.debug(
      "[triangulate] no CCW outer boundary found across",
      model.domains.length,
      "domain(s);",
      "boundaries scanned:",
      model.domains
        .flatMap((d) => d.boundaryIds)
        .map((id) => {
          const b = model.boundaries.find((bb) => bb.id === id);
          return b
            ? { name: b.name, segs: b.segments.length }
            : { name: "?", segs: 0 };
        }),
    );
    return null;
  }

  // Build the Steiner grid inside the outer AABB, masked to domain.
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const p of outer.points) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  const diag = Math.hypot(xMax - xMin, yMax - yMin);
  // Pick the steiner spacing: explicit `spacing` wins, otherwise
  // density × diag, otherwise default density.
  const step = Math.max(
    1e-9,
    opts.spacing ?? diag * (opts.density ?? DEFAULT_DENSITY),
  );
  const proximity = step * PROXIMITY_THRESHOLD_FRAC;
  const proximity2 = proximity * proximity;

  // Reusable inside-domain test.
  const insideDomain = (pt: Vec2): boolean => {
    if (!pointInPolygon(pt, outer.points)) return false;
    for (const h of holes) if (pointInPolygon(pt, h.points)) return false;
    return true;
  };

  // Collect boundary samples (the polygon points we just built) — used
  // for the proximity test against candidate steiner points.
  const boundarySamples: Vec2[] = [
    ...outer.points,
    ...holes.flatMap((h) => h.points),
  ];

  const steiner: Vec2[] = [];
  const tooCloseToAccepted = (p: Vec2): boolean => {
    for (const b of boundarySamples) {
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy < proximity2) return true;
    }
    for (const s of steiner) {
      const dx = p.x - s.x;
      const dy = p.y - s.y;
      if (dx * dx + dy * dy < proximity2) return true;
    }
    return false;
  };
  const tryAccept = (pt: Vec2) => {
    if (!insideDomain(pt)) return;
    if (tooCloseToAccepted(pt)) return;
    steiner.push(pt);
  };

  // ── 0. BEM mesh nodes as steiners (unconditionally). poly2tri places
  // them as triangulation vertices; if they sit on the polygon edge it
  // implicitly subdivides that edge. This gives us the property that
  // boundary triangle vertices ARE BEM nodes, without needing to feed
  // them into the polygon directly (which broke for straight edges due
  // to collinear-adjacent vertices). Dedup by position to handle the
  // continuous-scheme shared corner nodes. */
  {
    const seenKeys = new Set<string>();
    for (const el of mesh) {
      for (const n of el.nodes) {
        const k = `${Math.round(n.x / 1e-9)}|${Math.round(n.y / 1e-9)}`;
        if (seenKeys.has(k)) continue;
        seenKeys.add(k);
        // Don't apply the proximity filter for BEM nodes — they're load-
        // bearing for analysis. Just dedup and add.
        steiner.push({ x: n.x, y: n.y });
      }
    }
  }

  // ── 1. Concentric rings around unique arc centres ──
  // Find each line that's an arc, group by arc-centre id, take any
  // line's radius as the representative for that centre.
  const arcsByCentre = new Map<Id, { centre: Vec2; radius: number }>();
  for (const line of model.lines) {
    if (line.arcCentreId === undefined) continue;
    if (arcsByCentre.has(line.arcCentreId)) continue;
    const c = model.points.find((p) => p.id === line.arcCentreId);
    const s = model.points.find((p) => p.id === line.startId);
    if (!c || !s) continue;
    const r = Math.hypot(s.x - c.x, s.y - c.y);
    if (r > 0)
      arcsByCentre.set(line.arcCentreId, { centre: { x: c.x, y: c.y }, radius: r });
  }
  const ringFactors = opts.ringFactors ?? RING_RADII_FACTORS;
  for (const { centre, radius } of arcsByCentre.values()) {
    for (const factor of ringFactors) {
      const ringR = radius * factor;
      // Angular density: 1 point per `step` of arc length.
      const nPoints = Math.max(8, Math.ceil((2 * Math.PI * ringR) / step));
      for (let i = 0; i < nPoints; i++) {
        const theta = (2 * Math.PI * i) / nPoints;
        tryAccept({
          x: centre.x + ringR * Math.cos(theta),
          y: centre.y + ringR * Math.sin(theta),
        });
      }
    }
  }

  // ── 2. Uniform background grid filling the rest ──
  // Offset by half-step so grid doesn't land exactly on boundary chords.
  for (let x = xMin + step * 0.5; x < xMax; x += step) {
    for (let y = yMin + step * 0.5; y < yMax; y += step) {
      tryAccept({ x, y });
    }
  }

  // eslint-disable-next-line no-console
  console.debug(
    "[triangulate] outer pts:",
    outer.points.length,
    "holes:",
    holes.length,
    "steiner:",
    steiner.length,
    "step:",
    step.toFixed(4),
  );

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
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[triangulate] poly2tri threw:", e);
    return null;
  }
  const tris = ctx.getTriangles();
  // eslint-disable-next-line no-console
  console.debug("[triangulate] poly2tri produced", tris.length, "triangles");

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

/** Walk a boundary's segments and assemble the polygon as corner Points
 *  plus arc-sampled intermediate vertices (no BEM nodes — those are
 *  added separately as steiner points to avoid the collinear-adjacent
 *  vertex case poly2tri can't handle on straight edges). */
function boundaryPolygonFromGeometry(
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
    if (line.arcCentreId !== undefined) {
      const lineStart = pointsById.get(line.startId);
      const lineEnd = pointsById.get(line.endId);
      const centre = pointsById.get(line.arcCentreId);
      if (!lineStart || !lineEnd || !centre) return null;
      for (let i = 1; i < ARC_SUBDIVISIONS; i++) {
        const tSeg = i / ARC_SUBDIVISIONS;
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
