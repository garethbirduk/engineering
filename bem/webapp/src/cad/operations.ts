// Factory + immutable mutation helpers for the CadModel.

import {
  arcPoint,
  loopOrientation,
  type BcAssignment,
  type Boundary,
  type BoundarySegment,
  type CadModel,
  type DirectionBc,
  type Domain,
  type Id,
  type Line,
  type LineDiscretisation,
  type Point,
  type Vec2,
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

// ─────────────────────────────────────────────────────────────────────
// Shape-builder operations
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert a rectangle aligned to world axes with corners at c1 and c2.
 * Returns the updated model plus the ids of the 4 corner Points and 4
 * Lines in walk order, so reading each Line's natural startId → endId
 * forms a connected cycle.
 *
 *   ccw (outer): BL → BR → TR → TL → BL
 *                bottom, right, top, left
 *   cw  (hole):  BL → TL → TR → BR → BL
 *                left,   top,  right, bottom (with each line's
 *                natural startId/endId chosen so the storage-order
 *                walk is connected)
 */
export function insertRectangle(
  model: CadModel,
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  orientation: "ccw" | "cw" = "ccw",
): {
  model: CadModel;
  pointIds: readonly [Id, Id, Id, Id];
  lineIds: readonly [Id, Id, Id, Id];
} {
  const minX = Math.min(c1.x, c2.x);
  const maxX = Math.max(c1.x, c2.x);
  const minY = Math.min(c1.y, c2.y);
  const maxY = Math.max(c1.y, c2.y);
  const bl = makePoint(minX, minY);
  const br = makePoint(maxX, minY);
  const tr = makePoint(maxX, maxY);
  const tl = makePoint(minX, maxY);
  if (orientation === "ccw") {
    const bottom = makeLine(bl.id, br.id);
    const right = makeLine(br.id, tr.id);
    const top = makeLine(tr.id, tl.id);
    const left = makeLine(tl.id, bl.id);
    return {
      model: {
        ...model,
        points: [...model.points, bl, br, tr, tl],
        lines: [...model.lines, bottom, right, top, left],
      },
      pointIds: [bl.id, br.id, tr.id, tl.id],
      lineIds: [bottom.id, right.id, top.id, left.id],
    };
  }
  // cw — natural directions form BL → TL → TR → BR → BL
  const leftCW = makeLine(bl.id, tl.id);
  const topCW = makeLine(tl.id, tr.id);
  const rightCW = makeLine(tr.id, br.id);
  const bottomCW = makeLine(br.id, bl.id);
  return {
    model: {
      ...model,
      points: [...model.points, bl, br, tr, tl],
      lines: [...model.lines, leftCW, topCW, rightCW, bottomCW],
    },
    pointIds: [bl.id, tl.id, tr.id, br.id],
    lineIds: [leftCW.id, topCW.id, rightCW.id, bottomCW.id],
  };
}

/**
 * Insert a circle centred at `centre` with the given radius, built
 * from four quarter-arcs. All four arcs share one centre Point so
 * the model stays tidy. Returns the arc Line ids in walk order, so
 * each arc's natural startId → endId forms a connected cycle.
 *
 *   ccw (outer): E → N → W → S → E
 *   cw  (hole):  E → S → W → N → E
 */
export function insertCircle(
  model: CadModel,
  centre: { x: number; y: number },
  radius: number,
  orientation: "ccw" | "cw" = "ccw",
): {
  model: CadModel;
  centreId: Id;
  cardinalIds: readonly [Id, Id, Id, Id];
  arcIds: readonly [Id, Id, Id, Id];
} {
  const c = makePoint(centre.x, centre.y);
  const east = makePoint(centre.x + radius, centre.y);
  const north = makePoint(centre.x, centre.y + radius);
  const west = makePoint(centre.x - radius, centre.y);
  const south = makePoint(centre.x, centre.y - radius);
  const arc = (a: Id, b: Id): Line => ({
    id: newId(),
    startId: a,
    endId: b,
    arcCentreId: c.id,
  });
  if (orientation === "ccw") {
    const a1 = arc(east.id, north.id);
    const a2 = arc(north.id, west.id);
    const a3 = arc(west.id, south.id);
    const a4 = arc(south.id, east.id);
    return {
      model: {
        ...model,
        points: [...model.points, c, east, north, west, south],
        lines: [...model.lines, a1, a2, a3, a4],
      },
      centreId: c.id,
      cardinalIds: [east.id, north.id, west.id, south.id],
      arcIds: [a1.id, a2.id, a3.id, a4.id],
    };
  }
  // cw — natural directions form E → S → W → N → E
  const a1 = arc(east.id, south.id);
  const a2 = arc(south.id, west.id);
  const a3 = arc(west.id, north.id);
  const a4 = arc(north.id, east.id);
  return {
    model: {
      ...model,
      points: [...model.points, c, east, north, west, south],
      lines: [...model.lines, a1, a2, a3, a4],
    },
    centreId: c.id,
    cardinalIds: [east.id, south.id, west.id, north.id],
    arcIds: [a1.id, a2.id, a3.id, a4.id],
  };
}

/**
 * Fillet the corner at Point `cornerId` with the given radius.
 * Requires exactly two straight Lines (no arcs) meeting at the
 * Point, both endpoints with at least `radius` of room along the
 * line. Returns the original model if any precondition fails (so the
 * caller can decide whether to no-op or surface an error).
 *
 * Operation:
 *   - inserts two tangent Points T1 (on L1, at distance d from P) and
 *     T2 (on L2, at distance d from P), where d = r / tan(α/2) and α
 *     is the angle between the two lines as they leave P;
 *   - inserts an arc-centre Point C at distance r / sin(α/2) along
 *     the bisector;
 *   - shortens L1's P-side endpoint to T1 and L2's P-side to T2;
 *   - inserts a new arc Line from T1 to T2 around C;
 *   - splices the new arc into any Boundary that contained the pair
 *     (L1, L2) as consecutive segments, preserving traversal direction.
 *
 * BCs and meshing overrides on the original Lines are preserved. The
 * new arc Line gets no BC or meshing entry (defaults).
 */
export function filletCorner(
  model: CadModel,
  cornerId: Id,
  radius: number,
): { model: CadModel; arcLineId: Id } | null {
  if (radius <= 0) return null;
  const corner = model.points.find((p) => p.id === cornerId);
  if (!corner) return null;
  const adj = model.lines.filter(
    (l) =>
      (l.startId === cornerId || l.endId === cornerId) &&
      l.arcCentreId === undefined,
  );
  if (adj.length !== 2) return null;
  const [L1, L2] = adj as [Line, Line];

  // Pull the OTHER endpoint of each adjacent line and compute unit
  // direction vectors pointing away from the corner.
  const otherId = (l: Line) => (l.startId === cornerId ? l.endId : l.startId);
  const oth1 = model.points.find((p) => p.id === otherId(L1));
  const oth2 = model.points.find((p) => p.id === otherId(L2));
  if (!oth1 || !oth2) return null;
  const v1x = oth1.x - corner.x;
  const v1y = oth1.y - corner.y;
  const v2x = oth2.x - corner.x;
  const v2y = oth2.y - corner.y;
  const len1 = Math.hypot(v1x, v1y);
  const len2 = Math.hypot(v2x, v2y);
  if (len1 === 0 || len2 === 0) return null;
  const a1x = v1x / len1;
  const a1y = v1y / len1;
  const a2x = v2x / len2;
  const a2y = v2y / len2;

  // Angle α between the two directions as they leave P:
  //   cos(α) = a1 · a2; collinear / antiparallel cases → undefined fillet.
  const dot = a1x * a2x + a1y * a2y;
  if (dot > 1 - 1e-9 || dot < -1 + 1e-9) return null;
  const alpha = Math.acos(Math.max(-1, Math.min(1, dot)));
  const tanHalf = Math.tan(alpha / 2);
  const sinHalf = Math.sin(alpha / 2);
  if (tanHalf <= 0 || sinHalf <= 0) return null;
  const d = radius / tanHalf;
  // Don't allow tangent distance to exceed either line's length —
  // would clip the line away entirely.
  if (d >= len1 || d >= len2) return null;

  // Tangent points + arc centre.
  const T1: Point = makePoint(corner.x + d * a1x, corner.y + d * a1y);
  const T2: Point = makePoint(corner.x + d * a2x, corner.y + d * a2y);
  const bisX = a1x + a2x;
  const bisY = a1y + a2y;
  const bisLen = Math.hypot(bisX, bisY);
  if (bisLen === 0) return null;
  const cDist = radius / sinHalf;
  const C: Point = makePoint(
    corner.x + (bisX / bisLen) * cDist,
    corner.y + (bisY / bisLen) * cDist,
  );
  // Decide the arc's natural orientation by looking at the boundary
  // walk. We want every segment we emit to use direction = 1, because
  // the engine reads the geometric outward normal as right-of-
  // line-natural-tangent regardless of the segment.direction flag — so
  // a direction = -1 arc would have its normal pointing into the
  // material instead of away from it.
  //
  // The corner connects two consecutive segments (L1 then L2, or L2
  // then L1) in the walk. After `replaceCorner` rewrites L1's corner
  // endpoint to T1 and L2's to T2:
  //   - if the walk order is L1 → L2, the walk leaves L1 at T1 and
  //     enters L2 at T2, so the arc must walk T1 → T2.
  //   - if the walk order is L2 → L1, the walk leaves L2 at T2 and
  //     enters L1 at T1, so the arc must walk T2 → T1.
  // Pick arc.startId / endId accordingly, then every splice uses
  // direction = 1.
  type ConsecutiveOrder = "L1_then_L2" | "L2_then_L1" | "unknown";
  let walkOrder: ConsecutiveOrder = "unknown";
  outer: for (const b of model.boundaries) {
    const n = b.segments.length;
    for (let i = 0; i < n; i++) {
      const a = b.segments[i]!;
      const nxt = b.segments[(i + 1) % n]!;
      if (a.lineId === L1.id && nxt.lineId === L2.id) {
        walkOrder = "L1_then_L2";
        break outer;
      }
      if (a.lineId === L2.id && nxt.lineId === L1.id) {
        walkOrder = "L2_then_L1";
        break outer;
      }
    }
  }
  const arcStartId = walkOrder === "L2_then_L1" ? T2.id : T1.id;
  const arcEndId = walkOrder === "L2_then_L1" ? T1.id : T2.id;
  const arcLine: Line = {
    id: newId(),
    startId: arcStartId,
    endId: arcEndId,
    arcCentreId: C.id,
  };

  // Rewrite the two adjacent lines so their P-side endpoint points at
  // the new tangent Point.
  const replaceCorner = (l: Line, t: Id): Line =>
    l.startId === cornerId
      ? { ...l, startId: t }
      : { ...l, endId: t };
  const L1prime = replaceCorner(L1, T1.id);
  const L2prime = replaceCorner(L2, T2.id);

  // Splice the new arc into any Boundary that had (L1, L2) or (L2, L1)
  // as consecutive segments. Always direction = 1 — the arc's natural
  // orientation was chosen above to match the walk.
  const boundaries = model.boundaries.map((b) => {
    const segs = b.segments;
    const out: { lineId: Id; direction: 1 | -1 }[] = [];
    let i = 0;
    while (i < segs.length) {
      const a = segs[i]!;
      const nxt = i + 1 < segs.length ? segs[i + 1]! : null;
      if (
        nxt &&
        ((a.lineId === L1.id && nxt.lineId === L2.id) ||
          (a.lineId === L2.id && nxt.lineId === L1.id))
      ) {
        out.push(a);
        out.push({ lineId: arcLine.id, direction: 1 });
        i += 1;
        continue;
      }
      out.push(a);
      i += 1;
    }
    // Wrap-around: corner shared between last and first segments.
    if (segs.length > 1) {
      const first = segs[0]!;
      const last = segs[segs.length - 1]!;
      if (
        (last.lineId === L1.id && first.lineId === L2.id) ||
        (last.lineId === L2.id && first.lineId === L1.id)
      ) {
        out.push({ lineId: arcLine.id, direction: 1 });
      }
    }
    return { ...b, segments: out };
  });

  return {
    model: {
      ...model,
      points: [
        ...model.points.filter((p) => p.id !== cornerId),
        T1,
        T2,
        C,
      ],
      lines: [
        ...model.lines.map((l) => {
          if (l.id === L1.id) return L1prime;
          if (l.id === L2.id) return L2prime;
          return l;
        }),
        arcLine,
      ],
      boundaries,
    },
    arcLineId: arcLine.id,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Auto-place: convert a fresh closed-loop segment list into a Boundary
// and place it correctly inside the model — either as a new Domain or
// as a hole inside an existing one.
// ─────────────────────────────────────────────────────────────────────

const ARC_SAMPLES = 12;

/** Polygon-sample a Boundary segment list (straight lines + arcs in
 *  traversal order) so it can be used for in/out tests. */
function buildBoundaryPolygon(
  segments: readonly BoundarySegment[],
  model: CadModel,
): Vec2[] {
  const linesById = new Map(model.lines.map((l) => [l.id, l]));
  const pointsById = pointMap(model.points);
  const pts: Vec2[] = [];
  for (const seg of segments) {
    const line = linesById.get(seg.lineId);
    if (!line) continue;
    const sId = seg.direction === 1 ? line.startId : line.endId;
    const eId = seg.direction === 1 ? line.endId : line.startId;
    const s = pointsById.get(sId);
    const e = pointsById.get(eId);
    if (!s || !e) continue;
    pts.push({ x: s.x, y: s.y });
    if (line.arcCentreId !== undefined) {
      const lineStart = pointsById.get(line.startId);
      const lineEnd = pointsById.get(line.endId);
      const centre = pointsById.get(line.arcCentreId);
      if (!lineStart || !lineEnd || !centre) continue;
      for (let i = 1; i < ARC_SAMPLES; i++) {
        const tSeg = i / ARC_SAMPLES;
        const tLine = seg.direction === 1 ? tSeg : 1 - tSeg;
        pts.push(arcPoint(lineStart, lineEnd, centre, tLine));
      }
    }
  }
  return pts;
}

/** Standard ray-casting point-in-polygon test. */
function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** Area-weighted polygon centroid (falls back to mean of vertices
 *  if the polygon is degenerate). */
function polygonCentroid(poly: readonly Vec2[]): Vec2 {
  let cx = 0;
  let cy = 0;
  let signedArea2 = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
    signedArea2 += cross;
  }
  if (Math.abs(signedArea2) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of poly) {
      sx += p.x;
      sy += p.y;
    }
    const n = Math.max(poly.length, 1);
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * signedArea2), y: cy / (3 * signedArea2) };
}

/** Absolute polygon area, used to sort multi-loop selections so the
 *  outer (largest) loop is placed first and inner loops can find it. */
function polygonArea(poly: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Find the Domain (if any) whose material region contains `probe`
 *  (inside the CCW outer Boundary AND outside every CW hole). Exposed
 *  so the shape-builder commits can decide CCW (outer) vs CW (hole)
 *  before constructing the lines. */
export function findContainingDomain(
  model: CadModel,
  probe: Vec2,
): Domain | null {
  for (const domain of model.domains) {
    let outerPoly: Vec2[] | null = null;
    const holePolys: Vec2[][] = [];
    for (const bId of domain.boundaryIds) {
      const b = model.boundaries.find((bb) => bb.id === bId);
      if (!b || b.segments.length === 0) continue;
      const poly = buildBoundaryPolygon(b.segments, model);
      if (poly.length < 3) continue;
      const ori = loopOrientation(b.segments, model);
      if (ori === "ccw") {
        if (outerPoly === null) outerPoly = poly;
      } else if (ori === "cw") {
        holePolys.push(poly);
      }
    }
    if (!outerPoly) continue;
    if (!pointInPolygon(probe, outerPoly)) continue;
    let inHole = false;
    for (const h of holePolys) {
      if (pointInPolygon(probe, h)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return domain;
  }
  return null;
}

/**
 * Add a fresh closed-loop Boundary to the model. If its representative
 * point lies inside an existing Domain's material the loop is spliced
 * in as a hole on that Domain (flipped to CW); otherwise a new Domain
 * is created with this loop as its outer Boundary (CCW).
 *
 * The caller supplies segments in whatever orientation it naturally
 * built them; this helper does the CCW/CW flip as needed.
 *
 * Orientation flip for holes is performed by reversing the segment
 * ORDER AND swapping each referenced Line's startId ↔ endId — NOT by
 * flipping segment.direction flags. The engine reads the geometric
 * outward normal as right-of-line-natural-direction (ignoring
 * direction flags), so for a hole to have its outward normal point
 * away from the material (into the hole), the lines' natural
 * directions must encode the CW traversal directly.
 *
 * This relies on the lines being freshly created and not yet
 * referenced by any other Boundary — true for shape-primitive commits
 * and for line-selections fed to createDomainFromSelection.
 *
 * Returns the updated model plus the new boundaryId and the
 * containing Domain's id (new or existing) so the caller can update
 * the selection.
 */
export function placeBoundaryAuto(
  model: CadModel,
  segments: readonly BoundarySegment[],
): { model: CadModel; boundaryId: Id; domainId: Id } | null {
  if (segments.length < 2) return null;
  const poly = buildBoundaryPolygon(segments, model);
  if (poly.length < 3) return null;
  const probe = polygonCentroid(poly);
  const containing = findContainingDomain(model, probe);

  // Holes need CW with the geometric normal pointing into the hole
  // (away from material). Outers need CCW with the normal pointing
  // outward. If the supplied segments don't already match, flip them
  // by reversing the segment order AND flipping each underlying
  // Line's startId ↔ endId.
  const ori = loopOrientation(segments, model);
  const wantOri = containing ? "cw" : "ccw";
  let m: CadModel = model;
  let finalSegments: BoundarySegment[] = [...segments];
  if (ori !== "degenerate" && ori !== wantOri) {
    const lineIdsToFlip = new Set(segments.map((s) => s.lineId));
    m = {
      ...m,
      lines: m.lines.map((l) =>
        lineIdsToFlip.has(l.id)
          ? { ...l, startId: l.endId, endId: l.startId }
          : l,
      ),
    };
    // After the line flips, traversal in the reversed segment order
    // with the same direction flags gives the desired CW (or CCW)
    // walk with correct natural-direction normals.
    finalSegments = [...segments].reverse().map((s) => ({
      lineId: s.lineId,
      direction: s.direction,
    }));
  }

  const boundary: Boundary = {
    id: newId(),
    name: `Boundary ${m.boundaries.length + 1}`,
    segments: finalSegments,
  };
  m = {
    ...m,
    boundaries: [...m.boundaries, boundary],
  };
  let domainId: Id;
  if (containing) {
    m = {
      ...m,
      domains: m.domains.map((d) =>
        d.id === containing.id
          ? { ...d, boundaryIds: [...d.boundaryIds, boundary.id] }
          : d,
      ),
    };
    domainId = containing.id;
  } else {
    const domain: Domain = {
      id: newId(),
      name: `Domain ${m.domains.length + 1}`,
      boundaryIds: [boundary.id],
    };
    m = { ...m, domains: [...m.domains, domain] };
    domainId = domain.id;
  }
  return { model: m, boundaryId: boundary.id, domainId };
}

/** Helper for createDomainFromSelection: place a *batch* of fresh
 *  closed loops in descending-area order, so each outer loop is in
 *  place before any nested holes look for it. */
export function placeBoundariesBatch(
  model: CadModel,
  loops: readonly (readonly BoundarySegment[])[],
): { model: CadModel; boundaryIds: Id[]; domainIds: Id[] } {
  const indexed = loops.map((segs, idx) => ({
    segs,
    idx,
    area: polygonArea(buildBoundaryPolygon(segs, model)),
  }));
  indexed.sort((a, b) => b.area - a.area);
  let m = model;
  const boundaryIds: Id[] = [];
  const domainIds = new Set<Id>();
  for (const { segs } of indexed) {
    const placed = placeBoundaryAuto(m, segs);
    if (!placed) continue;
    m = placed.model;
    boundaryIds.push(placed.boundaryId);
    domainIds.add(placed.domainId);
  }
  return { model: m, boundaryIds, domainIds: [...domainIds] };
}
