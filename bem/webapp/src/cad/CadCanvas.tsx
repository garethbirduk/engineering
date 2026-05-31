// SVG canvas for the gesture-based CAD editor.
//
// Universal gestures (no modes):
//   double-click empty            → add Point
//   double-click Point + drag     → draw new Line from that Point
//   double-click Line + drag      → split + drag new Point
//   drag Point                    → move Point
//   drag Line                     → translate Line
//   click entity                  → select (replace)
//   ctrl+click Line/Point         → toggle in multi-selection
//   click empty space             → clear selection
//   shift+drag                    → pan
//   wheel                         → zoom
//   Del / Backspace               → delete selection
//   Esc                           → clear selection + drafts
//
// Coordinate model:
// - World coords with y up. SVG renders inside <g transform="scale(1,-1)">.

import Delaunator from "delaunator";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  arcPoint,
  arcSvgPathD,
  boundaryStress,
  createBlockCache,
  discretiseLines,
  interiorDisplacement,
  interiorStress,
  loopOrientation,
  resolveMaterial,
  shapeFunctions,
  shapeFunctionDerivatives,
  solve,
  STANDARD_NODES,
  type BlockCache,
  type MaterialProperties,
  type MeshElement,
  type StressTriple,
  type Vec2,
} from "@bem/engine";
import { Toolbar } from "./Toolbar.js";
import { InfoPanel } from "./InfoPanel.js";
import {
  isPositiveOnlyField,
  ResultsPanel,
  type EdgeProfile,
  type FieldStats,
  type InteriorField,
} from "./ResultsPanel.js";
import { divergingUxColor, sequentialUxColor } from "./colorScale.js";
import { gridStepForViewWidth } from "./gridStep.js";
import { snapWorld } from "./snap.js";
import { pointMap } from "./operations.js";
import {
  downloadAsJsonFile,
  loadFromJsonFile,
  loadFromLocalStorage,
  saveToLocalStorage,
} from "./persistence.js";
import {
  INITIAL_STATE,
  canvasReducer,
  hitTest,
  selectionCanCreateDomain,
  type CanvasState,
  type ClickContext,
} from "./reducer.js";

// ───────────────────────────────────────────────────────────────────────────
// Viewport
// ───────────────────────────────────────────────────────────────────────────

interface ViewBox {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
}

const INITIAL_VIEW: ViewBox = { cx: 0, cy: 0, width: 20, height: 20 };
const MIN_WIDTH = 1e-3;
const MAX_WIDTH = 1e6;
const ZOOM_PER_WHEEL_TICK = 1.15;
const CLICK_DRAG_PX_THRESHOLD = 3;
const DOUBLE_CLICK_WINDOW_MS = 400;
const DOUBLE_CLICK_RADIUS_PX = 5;

function viewBoxAttr(v: ViewBox): string {
  const x = v.cx - v.width / 2;
  const y = -(v.cy + v.height / 2);
  return `${x} ${y} ${v.width} ${v.height}`;
}

function clientToWorld(
  svg: SVGSVGElement,
  view: ViewBox,
  clientX: number,
  clientY: number,
): Vec2 {
  const rect = svg.getBoundingClientRect();
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  return {
    x: view.cx - view.width / 2 + fx * view.width,
    y: view.cy + view.height / 2 - fy * view.height,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Grid
// ───────────────────────────────────────────────────────────────────────────

function Grid({ view, step }: { view: ViewBox; step: number }) {
  const minX = view.cx - view.width / 2;
  const maxX = view.cx + view.width / 2;
  const minY = view.cy - view.height / 2;
  const maxY = view.cy + view.height / 2;
  const startX = Math.ceil(minX / step) * step;
  const endX = Math.floor(maxX / step) * step;
  const startY = Math.ceil(minY / step) * step;
  const endY = Math.floor(maxY / step) * step;
  const verticals: number[] = [];
  for (let x = startX; x <= endX + step / 2; x += step) verticals.push(x);
  const horizontals: number[] = [];
  for (let y = startY; y <= endY + step / 2; y += step) horizontals.push(y);
  const thin = view.width * 0.0005;
  const thick = view.width * 0.0012;
  return (
    <g pointerEvents="none">
      {verticals.map((x) => (
        <line
          key={`v${x}`}
          x1={x}
          y1={minY}
          x2={x}
          y2={maxY}
          stroke="currentColor"
          strokeWidth={Math.abs(x) < step / 2 ? thick : thin}
          opacity={Math.abs(x) < step / 2 ? 0.4 : 0.12}
        />
      ))}
      {horizontals.map((y) => (
        <line
          key={`h${y}`}
          x1={minX}
          y1={y}
          x2={maxX}
          y2={y}
          stroke="currentColor"
          strokeWidth={Math.abs(y) < step / 2 ? thick : thin}
          opacity={Math.abs(y) < step / 2 ? 0.4 : 0.12}
        />
      ))}
    </g>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Geometry helpers (used by the internal-nodes filter)
// ───────────────────────────────────────────────────────────────────────────

/** Fast id→Point map used to look up Point positions from line ids. */
function pointsByIdLookup<T extends { id: string; x: number; y: number }>(
  pts: readonly T[],
): ReadonlyMap<string, T> {
  return new Map(pts.map((p) => [p.id, p]));
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

/** Squared distance from point `p` to the polyline made of `poly`'s
 *  segments (closed: edge wraps from last → first). */
function minSqDistToPolygonEdges(p: Vec2, poly: readonly Vec2[]): number {
  let minSq = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]!;
    const b = poly[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = a.x + t * dx;
    const cy = a.y + t * dy;
    const ex = p.x - cx;
    const ey = p.y - cy;
    const sq = ex * ex + ey * ey;
    if (sq < minSq) minSq = sq;
  }
  return minSq;
}

/** Pick the active interior field's scalar value at parametric `eta`
 *  on a boundary element. Displacement fields are direct shape-function
 *  interpolation of the nodal DOFs; stress fields go through
 *  `boundaryStress` (Kelvin recovery), so we never hit the singular
 *  Somigliana stress integrand on Γ. Derived scalars (σvm, σ1, σ2, τmax)
 *  are simple algebra on the Cartesian stress tensor. */
function evaluateEdgeField(
  el: MeshElement,
  eta: number,
  field: InteriorField,
  material: MaterialProperties,
): number {
  if (field === "ux" || field === "uy") {
    const Nf = shapeFunctions(eta, el.localNodes);
    const v0 = field === "ux" ? el.nodes[0].ux : el.nodes[0].uy;
    const v1 = field === "ux" ? el.nodes[1].ux : el.nodes[1].uy;
    const v2 = field === "ux" ? el.nodes[2].ux : el.nodes[2].uy;
    return Nf[0] * v0 + Nf[1] * v1 + Nf[2] * v2;
  }
  const s = boundaryStress(el, eta, material);
  switch (field) {
    case "sxx":
      return s.sxx;
    case "syy":
      return s.syy;
    case "sxy":
      return s.sxy;
    case "tmax":
      return Math.hypot((s.sxx - s.syy) / 2, s.sxy);
    case "s1":
      return (s.sxx + s.syy) / 2 + Math.hypot((s.sxx - s.syy) / 2, s.sxy);
    case "s2":
      return (s.sxx + s.syy) / 2 - Math.hypot((s.sxx - s.syy) / 2, s.sxy);
    case "svm": {
      const szz =
        material.planeKind === "strain"
          ? material.nu * (s.sxx + s.syy)
          : 0;
      return Math.sqrt(
        0.5 *
          ((s.sxx - s.syy) ** 2 +
            (s.syy - szz) ** 2 +
            (szz - s.sxx) ** 2 +
            6 * s.sxy * s.sxy),
      );
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// CadCanvas
// ───────────────────────────────────────────────────────────────────────────

export function CadCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewBox>(INITIAL_VIEW);
  const [state, dispatch] = useReducer(canvasReducer, INITIAL_STATE);
  const [cursorWorld, setCursorWorld] = useState<Vec2 | null>(null);
  const [snap, setSnap] = useState<ReturnType<typeof snapWorld> | null>(null);
  const [lhsWidth, setLhsWidth] = useState(320);
  const [rhsWidth, setRhsWidth] = useState(260);

  const {
    model,
    selection,
    dragSession,
    newLineDraft,
    meshVisible,
    resultsVisible,
    internalNodesVisible,
    interiorField,
  } = state;

  // Reducer is pure but startDragForHit composes selection + dragSession;
  // we keep a ref to the latest state for use inside refs/handlers that
  // can't read React state synchronously.
  const stateRef = useRef<CanvasState>(state);
  stateRef.current = state;

  // Pan + click-vs-drag detection.
  const panStateRef = useRef<
    | { startClientX: number; startClientY: number; startView: ViewBox }
    | null
  >(null);
  const downStateRef = useRef<
    | {
        clientX: number;
        clientY: number;
        moved: boolean;
        wasDoubleClick: boolean;
        shift: boolean;
        hitKind: "point" | "line" | null;
      }
    | null
  >(null);
  // Marquee selection: starts on drag-from-empty (no shift). World coords.
  const [marquee, setMarquee] = useState<
    { start: Vec2; current: Vec2; additive: boolean } | null
  >(null);
  // Double-click detection — track last mousedown position + time.
  const lastDownRef = useRef<
    | { time: number; clientX: number; clientY: number }
    | null
  >(null);

  const gridStep = gridStepForViewWidth(view.width);
  const snapRadius = gridStep;
  const lineTolerance = gridStep * 0.15;
  const pointsById = useMemo(() => pointMap(model.points), [model.points]);

  // Derived mesh — always recomputed (cheap; pure of inputs). Visualisation
  // and BC-glyph sample positions both consume it; rendering of the elements
  // themselves is gated on meshVisible.
  const meshElements: MeshElement[] = useMemo(
    () => discretiseLines(model),
    [model],
  );
  const elementsByLineId = useMemo(() => {
    const m = new Map<string, MeshElement[]>();
    for (const el of meshElements) {
      const arr = m.get(el.lineId);
      if (arr) arr.push(el);
      else m.set(el.lineId, [el]);
    }
    return m;
  }, [meshElements]);

  // Resolved per-project material (fallback to DEFAULT_MATERIAL when
  // the model has no override). Used by the solver AND by the interior
  // displacement / stress evaluators so the picture stays self-consistent.
  const material: MaterialProperties = useMemo(
    () => resolveMaterial(model),
    [model],
  );

  // Reanalysis cache for the BEM H/G blocks — held across renders so
  // incremental edits (one Point dragged, one BC tweaked) reuse the
  // (collocation, field-element, material) pairs that didn't change.
  // assembleHG mutates the cache in place; stale entries are pruned
  // there. We never replace this ref's identity — solve() doesn't care
  // about it being a stable React value, only that the contents
  // persist across calls.
  const blockCacheRef = useRef<BlockCache>(createBlockCache());

  // Solve. Memoised — runs on every mesh / material change. With the
  // cache passed through, only the pair-blocks touching modified
  // elements get re-integrated; everything else reuses its cached
  // contribution.
  const solvedMesh = useMemo(
    () => solve(meshElements, material, blockCacheRef.current),
    [meshElements, material],
  );

  /**
   * Auto-scale factor for the deformed-shape overlay. We multiply each node's
   * displacement by this factor before drawing so the max |u| visually equals
   * 20% of the model AABB diagonal. Returns null if the model is too
   * degenerate / has no displacement to show (no overlay rendered).
   */
  const deformedScale = useMemo(() => {
    if (solvedMesh.length === 0) return null;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    let maxU = 0;
    for (const el of solvedMesh) {
      for (const n of el.nodes) {
        if (n.x < xMin) xMin = n.x;
        if (n.x > xMax) xMax = n.x;
        if (n.y < yMin) yMin = n.y;
        if (n.y > yMax) yMax = n.y;
        const u = Math.hypot(n.ux, n.uy);
        if (Number.isFinite(u) && u > maxU) maxU = u;
      }
    }
    const diag = Math.hypot(xMax - xMin, yMax - yMin);
    if (!Number.isFinite(diag) || diag === 0 || maxU === 0) return null;
    return (0.20 * diag) / maxU;
  }, [solvedMesh]);

  /** The Displacement results toggle is only useful when there's at least
   *  one element AND the solver returned a non-zero motion. */
  const canShowResults = solvedMesh.length > 0 && deformedScale !== null;

  const canShowInternalNodes = model.domains.length > 0;

  /** Domain boundary polygons (outer CCW + holes CW) sampled from the
   *  geometry — outer + arc-subdivisions per arc segment. Used to
   *  filter Delaunay triangles by centroid AND to gate the wave-front
   *  internal-node placement below. */
  const boundaryPolygons = useMemo(() => {
    if (model.domains.length === 0) return null;
    const ARC_SAMPLES = 12;
    const linesById = new Map(model.lines.map((l) => [l.id, l]));
    const ptsById = pointsByIdLookup(model.points);
    type Poly = { points: Vec2[]; orientation: "ccw" | "cw" };
    for (const domain of model.domains) {
      const polys: Poly[] = [];
      for (const bId of domain.boundaryIds) {
        const b = model.boundaries.find((bb) => bb.id === bId);
        if (!b || b.segments.length === 0) continue;
        const pts: Vec2[] = [];
        for (const seg of b.segments) {
          const line = linesById.get(seg.lineId);
          if (!line) continue;
          const sId = seg.direction === 1 ? line.startId : line.endId;
          const eId = seg.direction === 1 ? line.endId : line.startId;
          const s = ptsById.get(sId);
          const e = ptsById.get(eId);
          if (!s || !e) continue;
          pts.push({ x: s.x, y: s.y });
          if (line.arcCentreId !== undefined) {
            const lineStart = ptsById.get(line.startId);
            const lineEnd = ptsById.get(line.endId);
            const centre = ptsById.get(line.arcCentreId);
            if (!lineStart || !lineEnd || !centre) continue;
            for (let i = 1; i < ARC_SAMPLES; i++) {
              const tSeg = i / ARC_SAMPLES;
              const tLine = seg.direction === 1 ? tSeg : 1 - tSeg;
              pts.push(arcPoint(lineStart, lineEnd, centre, tLine));
            }
          }
        }
        if (pts.length < 3) continue;
        const ori = loopOrientation(b.segments, model);
        if (ori === "degenerate") continue;
        polys.push({ points: pts, orientation: ori });
      }
      const outer = polys.find((p) => p.orientation === "ccw");
      if (outer) {
        return {
          outer: outer.points,
          holes: polys.filter((p) => p !== outer).map((p) => p.points),
        };
      }
    }
    return null;
  }, [model.points, model.lines, model.boundaries, model.domains]);

  /** Internal post-process nodes — wave-front placement.
   *
   *  For every boundary BEM element we drop perpendicular rings inward
   *  along the element's local inward normal. Rings alternate the
   *  tangential η pattern:
   *    odd k (1, 3, 5…) — "bridge" layer:
   *      midpoints between consecutive localNodes, PLUS η = -1 when
   *      localNodes don't already reach the element start. This last
   *      bit is the discontinuous-scheme fix: with localNodes at
   *      {-2/3, 0, +2/3} the inter-element gap (world 2L/3 → L+L/6)
   *      isn't bridged by midpoints alone, so each element's η = -1
   *      candidate sits on the shared corner and turns the L/3-then-
   *      2L/3-then-L/3 alternation into a uniform L/3 spacing.
   *      Continuous {-1, 0, +1} already reaches the endpoints, so no
   *      η = -1 added there — pattern is just ±0.5, uniform L/2.
   *    even k (2, 4, 6…) — "node-aligned" layer: the element's own
   *      localNodes. Continuous candidates at η = ±1 dedup with the
   *      neighbour's at ∓1 via the cluster filter. Discontinuous nodes
   *      are strictly internal, no dedup needed.
   *
   *  Per-scheme spacings then come out uniform:
   *    continuous   → odd L/2, even L/2 (interleaved at L/4 offset)
   *    discontinuous → odd L/3, even L/3 (interleaved at L/6 offset)
   *  Radial depth doubles: r_k = 0.25·L · 2^(k-1), where L is the
   *  element's chord. So 0.25L, 0.5L, 1.0L, 2.0L, …
   *
   *  The loop is depth-first across elements: ring k is computed for
   *  ALL active elements before moving to ring k+1. This way candidates
   *  see ALL elements' previously-accepted points in the cluster filter,
   *  so waves growing from opposite boundaries genuinely meet in the
   *  middle and halt cleanly. (Previous per-element layout let one
   *  element march all the way across the domain before the opposite
   *  element fired its first ring — waves never met, runaway rings.)
   *
   *  Filters per candidate:
   *    in-domain — inside outer polygon AND outside every hole.
   *    cluster   — at least 0.5 · r_k from any already-accepted point.
   *                Seeds the accepted set with BEM nodes + corner
   *                Points so the cluster check covers the boundary too.
   *
   *  Halt: as soon as ring k accepts zero candidates across all
   *  remaining active elements, the wave fronts have collectively
   *  filled the domain — stop. Also: any element whose own ring
   *  accepts zero is marked done and skipped on subsequent rings. */
  const internalNodes: readonly Vec2[] = useMemo(() => {
    if (meshElements.length === 0) return [];
    if (!boundaryPolygons) return [];

    const ANCHORS = STANDARD_NODES.continuous;
    const FIRST_RING_FACTOR = 0.25;
    const RING_GROWTH = 2.0;
    const CLUSTER_FACTOR = 0.5;
    const MAX_RINGS = 12;

    const isInDomain = (p: Vec2): boolean => {
      if (!pointInPolygon(p, boundaryPolygons.outer)) return false;
      for (const hole of boundaryPolygons.holes) {
        if (pointInPolygon(p, hole)) return false;
      }
      return true;
    };

    // Seed accepted set with the boundary itself (BEM nodes + corner
    // Points). Cluster filter checks against this, so interior candidates
    // can't pile up on top of boundary positions.
    const accepted: Vec2[] = [];
    for (const el of meshElements) {
      for (const n of el.nodes) accepted.push({ x: n.x, y: n.y });
    }
    for (const p of model.points) accepted.push({ x: p.x, y: p.y });
    const seedCount = accepted.length;

    // Per-element chord length — used for the ring offset schedule.
    const chords = meshElements.map((el) => {
      const a0 = el.anchors[0];
      const a2 = el.anchors[2];
      return Math.hypot(a2.x - a0.x, a2.y - a0.y);
    });

    // η patterns for each parity. Constructed per element so they
    // adapt to the element's localNodes (continuous vs discontinuous
    // vs custom).
    //   Odd: midpoints between consecutive localNodes, plus η = -1 if
    //   the leftmost localNode is strictly inside (discontinuous case).
    //   The -1 candidate sits at the world position of the element's
    //   start — same world point as the previous element's end —
    //   bridging the gap between elements that midpoints alone leave
    //   open under the discontinuous scheme.
    //   Even: the element's own localNodes. Continuous endpoints
    //   (η = ±1) dedup against neighbour contributions via the cluster
    //   filter; discontinuous localNodes are internal so no dedup needed.
    const ENDPOINT_EPS = 1e-9;
    const oddEtas = (
      ln: readonly [number, number, number],
    ): readonly number[] => {
      const out: number[] = [];
      if (ln[0] > -1 + ENDPOINT_EPS) out.push(-1);
      out.push((ln[0] + ln[1]) / 2);
      out.push((ln[1] + ln[2]) / 2);
      return out;
    };
    const evenEtas = (
      ln: readonly [number, number, number],
    ): readonly number[] => ln;

    const elementActive: boolean[] = new Array(meshElements.length).fill(
      true,
    );

    for (let k = 1; k <= MAX_RINGS; k++) {
      const isOdd = k % 2 === 1;
      let ringAccepted = 0;

      for (let ei = 0; ei < meshElements.length; ei++) {
        if (!elementActive[ei]) continue;
        const el = meshElements[ei]!;
        const L = chords[ei]!;
        if (L === 0) {
          elementActive[ei] = false;
          continue;
        }

        const r = FIRST_RING_FACTOR * L * Math.pow(RING_GROWTH, k - 1);
        const cluster = CLUSTER_FACTOR * r;
        const cluster2 = cluster * cluster;
        const pattern = isOdd ? oddEtas(el.localNodes) : evenEtas(el.localNodes);
        const a0 = el.anchors[0];
        const a1 = el.anchors[1];
        const a2 = el.anchors[2];

        let acceptedThisElement = 0;
        for (const eta of pattern) {
          // Position + inward normal at this η on the element's
          // isoparametric geometry.
          const Ns = shapeFunctions(eta, ANCHORS);
          const dN = shapeFunctionDerivatives(eta, ANCHORS);
          const px = Ns[0] * a0.x + Ns[1] * a1.x + Ns[2] * a2.x;
          const py = Ns[0] * a0.y + Ns[1] * a1.y + Ns[2] * a2.y;
          const dx = dN[0] * a0.x + dN[1] * a1.x + dN[2] * a2.x;
          const dy = dN[0] * a0.y + dN[1] * a1.y + dN[2] * a2.y;
          const tl = Math.hypot(dx, dy) || 1;
          // Inward normal = -(right-of-tangent) = (-dy, +dx)/|t|. The
          // sign convention works for both outer (CCW) and hole (CW)
          // loops because both traverse with the material on the left.
          const nx = -dy / tl;
          const ny = dx / tl;
          const cand: Vec2 = { x: px + nx * r, y: py + ny * r };

          if (!isInDomain(cand)) continue;

          let tooClose = false;
          for (let qi = 0; qi < accepted.length; qi++) {
            const q = accepted[qi]!;
            const ex = cand.x - q.x;
            const ey = cand.y - q.y;
            if (ex * ex + ey * ey < cluster2) {
              tooClose = true;
              break;
            }
          }
          if (tooClose) continue;

          accepted.push(cand);
          acceptedThisElement++;
        }

        if (acceptedThisElement === 0) {
          // This element's wave has met another wave (or left the
          // domain). It's done for the rest of the loop.
          elementActive[ei] = false;
        }
        ringAccepted += acceptedThisElement;
      }

      // No active element added anything this ring → ALL waves have
      // collectively met. Stop.
      if (ringAccepted === 0) break;
    }

    // Return only the interior additions (drop the boundary seeds).
    return accepted.slice(seedCount);
  }, [meshElements, model.points, boundaryPolygons]);

  /** Delaunay triangulation of (boundary BEM nodes + corner Points +
   *  interior nodes), filtered to keep only triangles whose centroid
   *  lies inside the domain. */
  const internalTriangles = useMemo(() => {
    if (!boundaryPolygons) return null;
    // Collect all point positions, dedup by quantised key.
    const POS_EPS = 1e-6;
    const ptKey = (x: number, y: number) =>
      `${Math.round(x / POS_EPS)}|${Math.round(y / POS_EPS)}`;
    const indexByKey = new Map<string, number>();
    const pts: Vec2[] = [];
    const addPt = (p: Vec2) => {
      const k = ptKey(p.x, p.y);
      if (indexByKey.has(k)) return;
      indexByKey.set(k, pts.length);
      pts.push(p);
    };
    for (const el of meshElements) {
      for (const n of el.nodes) addPt({ x: n.x, y: n.y });
    }
    for (const p of model.points) addPt({ x: p.x, y: p.y });
    for (const p of internalNodes) addPt(p);
    if (pts.length < 3) return null;

    // Flatten for delaunator: [x0, y0, x1, y1, …].
    const flat = new Float64Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      flat[2 * i] = pts[i]!.x;
      flat[2 * i + 1] = pts[i]!.y;
    }
    const d = new Delaunator(flat);
    const tris: { a: number; b: number; c: number }[] = [];
    for (let t = 0; t < d.triangles.length; t += 3) {
      const a = d.triangles[t]!;
      const b = d.triangles[t + 1]!;
      const c = d.triangles[t + 2]!;
      const pa = pts[a]!;
      const pb = pts[b]!;
      const pc = pts[c]!;
      // Centroid-in-polygon: drop if outside outer or in any hole.
      const cx = (pa.x + pb.x + pc.x) / 3;
      const cy = (pa.y + pb.y + pc.y) / 3;
      const centroid = { x: cx, y: cy };
      if (!pointInPolygon(centroid, boundaryPolygons.outer)) continue;
      let inHole = false;
      for (const h of boundaryPolygons.holes) {
        if (pointInPolygon(centroid, h)) {
          inHole = true;
          break;
        }
      }
      if (inHole) continue;
      tris.push({ a, b, c });
    }
    return { points: pts, triangles: tris };
  }, [meshElements, model.points, internalNodes, boundaryPolygons]);

  /** True when the active field needs the full Cartesian stress tensor
   *  at every vertex (cheap algebra on top derives σvm, σ1, σ2, τmax). */
  const stressActive =
    interiorField === "sxx" ||
    interiorField === "syy" ||
    interiorField === "sxy" ||
    interiorField === "svm" ||
    interiorField === "s1" ||
    interiorField === "s2" ||
    interiorField === "tmax";

  /** Per-vertex Cartesian stress, lazily evaluated. We only pay the
   *  per-point Somigliana stress integral when a stress-derived field
   *  is selected; switching between σxx/σyy/τxy/σvm/σ1/σ2/τmax reuses
   *  this memo.
   *
   *  Boundary handling: D* ~ 1/r and S* ~ 1/r² blow up when the
   *  evaluation point sits on Γ, so triangulation vertices that
   *  coincide with a BEM node OR a corner geometry Point would read
   *  garbage. Those are detected by position-match and their stress is
   *  REPLACED with the mean of their non-boundary neighbours in the
   *  triangulation. This is not a true boundary-stress recovery — that
   *  needs the local tangential strain + applied traction at the
   *  boundary point — but it keeps the colour scale meaningful (no
   *  single near-singular value pinning the symmetric range). */
  const interiorStresses: readonly StressTriple[] | null = useMemo(() => {
    if (!stressActive || !internalTriangles || solvedMesh.length === 0) {
      return null;
    }
    const N = internalTriangles.points.length;
    const POS_EPS = 1e-6;
    const ptKey = (x: number, y: number) =>
      `${Math.round(x / POS_EPS)}|${Math.round(y / POS_EPS)}`;

    // Boundary lookup: any BEM mesh node position + any corner geometry
    // Point position. These vertices live exactly on Γ.
    const boundaryKeys = new Set<string>();
    for (const el of solvedMesh) {
      for (const n of el.nodes) boundaryKeys.add(ptKey(n.x, n.y));
    }
    for (const p of model.points) boundaryKeys.add(ptKey(p.x, p.y));

    const isBoundary: boolean[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const p = internalTriangles.points[i]!;
      isBoundary[i] = boundaryKeys.has(ptKey(p.x, p.y));
    }

    // Pass 1: raw Somigliana stress at every vertex.
    const raw: StressTriple[] = new Array(N);
    for (let i = 0; i < N; i++) {
      raw[i] = interiorStress(
        internalTriangles.points[i]!,
        solvedMesh,
        material,
      );
    }

    // Build a vertex-adjacency set from the triangle list.
    const neighbours: Set<number>[] = Array.from(
      { length: N },
      () => new Set<number>(),
    );
    for (const t of internalTriangles.triangles) {
      neighbours[t.a]!.add(t.b);
      neighbours[t.a]!.add(t.c);
      neighbours[t.b]!.add(t.a);
      neighbours[t.b]!.add(t.c);
      neighbours[t.c]!.add(t.a);
      neighbours[t.c]!.add(t.b);
    }

    // Pass 2: replace boundary-vertex stress with mean of non-boundary
    // neighbours. If a boundary vertex has zero non-boundary neighbours
    // (rare — happens in very coarse meshes) we fall back to the mean
    // of ALL neighbours so the contour still has a finite value to
    // interpolate against.
    const out: StressTriple[] = new Array(N);
    for (let i = 0; i < N; i++) {
      if (!isBoundary[i]) {
        out[i] = raw[i]!;
        continue;
      }
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      let cnt = 0;
      for (const j of neighbours[i]!) {
        if (isBoundary[j]) continue;
        const r = raw[j]!;
        if (
          Number.isFinite(r.sxx) &&
          Number.isFinite(r.syy) &&
          Number.isFinite(r.sxy)
        ) {
          sxx += r.sxx;
          syy += r.syy;
          sxy += r.sxy;
          cnt++;
        }
      }
      if (cnt === 0) {
        for (const j of neighbours[i]!) {
          const r = raw[j]!;
          if (
            Number.isFinite(r.sxx) &&
            Number.isFinite(r.syy) &&
            Number.isFinite(r.sxy)
          ) {
            sxx += r.sxx;
            syy += r.syy;
            sxy += r.sxy;
            cnt++;
          }
        }
      }
      out[i] =
        cnt > 0
          ? { sxx: sxx / cnt, syy: syy / cnt, sxy: sxy / cnt }
          : { sxx: 0, syy: 0, sxy: 0 };
    }

    return out;
  }, [stressActive, internalTriangles, solvedMesh, material, model.points]);

  /** Active interior field values at every triangulation vertex.
   *  Displacement fields: BEM-node coincident points use the solved
   *  nodal DOF directly; the rest go through Somigliana via
   *  `interiorDisplacement`. Stress fields: per-vertex stress tensor
   *  is read from `interiorStresses`, then the requested component or
   *  derived scalar is computed inline. Returns null when no field is
   *  selected, no triangulation exists, or the solver hasn't produced
   *  output. */
  const interiorFieldValues: readonly number[] | null = useMemo(() => {
    if (
      !internalTriangles ||
      solvedMesh.length === 0 ||
      interiorField === null
    ) {
      return null;
    }
    const N = internalTriangles.points.length;

    if (interiorField === "ux" || interiorField === "uy") {
      const POS_EPS = 1e-6;
      const ptKey = (x: number, y: number) =>
        `${Math.round(x / POS_EPS)}|${Math.round(y / POS_EPS)}`;
      const pickNode = (n: { ux: number; uy: number }) =>
        interiorField === "ux" ? n.ux : n.uy;
      const pickInterior = (u: Vec2) =>
        interiorField === "ux" ? u.x : u.y;
      const bemByKey = new Map<string, number>();
      for (const el of solvedMesh) {
        for (const n of el.nodes) {
          const v = pickNode(n);
          if (Number.isFinite(v)) bemByKey.set(ptKey(n.x, n.y), v);
        }
      }
      const out: number[] = new Array(N);
      for (let i = 0; i < N; i++) {
        const p = internalTriangles.points[i]!;
        const known = bemByKey.get(ptKey(p.x, p.y));
        if (known !== undefined) {
          out[i] = known;
        } else {
          out[i] = pickInterior(
            interiorDisplacement(p, solvedMesh, material),
          );
        }
      }
      return out;
    }

    if (!interiorStresses) return null;

    // Plane-strain out-of-plane stress used by the von Mises formula —
    // zero for plane-stress, ν(σxx+σyy) for plane-strain.
    const planeStrain = material.planeKind === "strain";
    const nu = material.nu;
    const out: number[] = new Array(N);
    for (let i = 0; i < N; i++) {
      const { sxx, syy, sxy } = interiorStresses[i]!;
      let v: number;
      switch (interiorField) {
        case "sxx":
          v = sxx;
          break;
        case "syy":
          v = syy;
          break;
        case "sxy":
          v = sxy;
          break;
        case "tmax":
          v = Math.hypot((sxx - syy) / 2, sxy);
          break;
        case "s1": {
          const m = (sxx + syy) / 2;
          v = m + Math.hypot((sxx - syy) / 2, sxy);
          break;
        }
        case "s2": {
          const m = (sxx + syy) / 2;
          v = m - Math.hypot((sxx - syy) / 2, sxy);
          break;
        }
        case "svm": {
          const szz = planeStrain ? nu * (sxx + syy) : 0;
          v = Math.sqrt(
            0.5 *
              ((sxx - syy) ** 2 +
                (syy - szz) ** 2 +
                (szz - sxx) ** 2 +
                6 * sxy * sxy),
          );
          break;
        }
        default:
          v = NaN;
      }
      out[i] = Number.isFinite(v) ? v : 0;
    }
    return out;
  }, [internalTriangles, solvedMesh, interiorField, interiorStresses, material]);

  /** Actual min, max + a robust symmetric range for the colour scale.
   *
   *  Stress-recovery at boundary-adjacent vertices is inherently noisy
   *  (near-singular kernels even after the neighbour-averaging mask),
   *  and stress concentrations at holes can spike well above the bulk
   *  field. Either source would pin `max|v|` and squash the interior
   *  variation into the central colour band.
   *
   *  Instead of using the true max-abs as the colour scale range, we
   *  use a high-percentile clip (default 95th of |finite values|).
   *  Outliers above this still render (clipped to the top/bottom
   *  band) but no longer steal scale resolution from the bulk field.
   *  Data min / max are still reported underneath the legend so the
   *  user can see when clipping is happening. */
  const interiorFieldStats: FieldStats | null = useMemo(() => {
    if (!interiorFieldValues || interiorFieldValues.length === 0) return null;
    if (interiorField === null) return null;
    const SCALE_PERCENTILE = 0.95;
    const positive = isPositiveOnlyField(interiorField);

    const finite: number[] = [];
    for (const v of interiorFieldValues) {
      if (Number.isFinite(v)) finite.push(v);
    }
    if (finite.length === 0) return null;

    let min = Infinity;
    let max = -Infinity;
    for (const v of finite) {
      if (v < min) min = v;
      if (v > max) max = v;
    }

    // Range for the colour scale:
    //   diverging fields → 95th percentile of |v|, symmetric ±range
    //   positive-only    → 95th percentile of v itself, scale runs 0..range
    // Outliers above the percentile still render (saturated in the top
    // band) but no longer pin the scale.
    let range: number;
    if (positive) {
      const posSorted = finite.filter((v) => v >= 0).sort((a, b) => a - b);
      if (posSorted.length === 0) return null;
      const pIdx = Math.min(
        posSorted.length - 1,
        Math.floor(posSorted.length * SCALE_PERCENTILE),
      );
      range = posSorted[pIdx]!;
    } else {
      const absSorted = finite.map(Math.abs).sort((a, b) => a - b);
      const pIdx = Math.min(
        absSorted.length - 1,
        Math.floor(absSorted.length * SCALE_PERCENTILE),
      );
      range = absSorted[pIdx]!;
    }
    if (range === 0) return null;
    return { min, max, range };
  }, [interiorFieldValues, interiorField]);

  /** Can the Results panel show anything useful right now? */
  const canShowInteriorResults =
    !!internalTriangles &&
    internalTriangles.triangles.length > 0 &&
    solvedMesh.length > 0 &&
    deformedScale !== null;

  /** Profile of the active interior field along the currently-selected
   *  boundary line(s), arc-length parameterised. For multiple selected
   *  lines, segments are concatenated in selection order. Stress values
   *  come from `boundaryStress` (Kelvin recovery from traction +
   *  tangential strain) — no singular Somigliana evaluation here. */
  const edgeProfile: EdgeProfile | null = useMemo(() => {
    if (!interiorField || solvedMesh.length === 0) return null;
    const selectedLineIds = selection
      .filter((s) => s.kind === "line")
      .map((s) => s.id);
    if (selectedLineIds.length === 0) return null;

    // Index solved mesh elements by line so we can walk them in order.
    const solvedByLine = new Map<string, MeshElement[]>();
    for (const el of solvedMesh) {
      const arr = solvedByLine.get(el.lineId);
      if (arr) arr.push(el);
      else solvedByLine.set(el.lineId, [el]);
    }
    for (const arr of solvedByLine.values()) {
      arr.sort((a, b) => a.indexInLine - b.indexInLine);
    }

    const ANCHORS = STANDARD_NODES.continuous;
    const SAMPLES_PER_ELEM = 20;

    const curveByLine: { lineId: string; arc: number; value: number }[][] = [];
    const nodes: { arc: number; value: number; lineId: string }[] = [];
    const segments: {
      lineId: string;
      startArc: number;
      endArc: number;
      startPoint: Vec2;
      endPoint: Vec2;
    }[] = [];

    let arcOffset = 0;

    for (const lineId of selectedLineIds) {
      const els = solvedByLine.get(lineId);
      if (!els || els.length === 0) continue;
      const segStartArc = arcOffset;
      const segCurve: { lineId: string; arc: number; value: number }[] = [];
      let segStartPoint: Vec2 | null = null;
      let segEndPoint: Vec2 | null = null;

      for (const el of els) {
        const a0 = el.anchors[0];
        const a1 = el.anchors[1];
        const a2 = el.anchors[2];

        const samplePositions: { eta: number; arc: number }[] = [];
        let prev: Vec2 | null = null;

        for (let i = 0; i <= SAMPLES_PER_ELEM; i++) {
          const eta = -1 + (2 * i) / SAMPLES_PER_ELEM;
          const Ng = shapeFunctions(eta, ANCHORS);
          const x = Ng[0] * a0.x + Ng[1] * a1.x + Ng[2] * a2.x;
          const y = Ng[0] * a0.y + Ng[1] * a1.y + Ng[2] * a2.y;
          if (prev) {
            arcOffset += Math.hypot(x - prev.x, y - prev.y);
          } else if (segStartPoint === null) {
            segStartPoint = { x, y };
          }
          prev = { x, y };
          samplePositions.push({ eta, arc: arcOffset });
          const value = evaluateEdgeField(
            el,
            eta,
            interiorField,
            material,
          );
          segCurve.push({ lineId, arc: arcOffset, value });
        }
        if (prev) segEndPoint = prev;

        // Node samples — find arc length at each node's η by linear
        // interpolation between bracketing sample positions.
        for (let k = 0; k < 3; k++) {
          const nodeEta = el.localNodes[k]!;
          let lo = 0;
          while (
            lo < samplePositions.length - 1 &&
            samplePositions[lo + 1]!.eta < nodeEta
          ) {
            lo++;
          }
          const sLo = samplePositions[lo]!;
          const sHi =
            samplePositions[Math.min(lo + 1, samplePositions.length - 1)]!;
          const denom = sHi.eta - sLo.eta;
          const frac = denom === 0 ? 0 : (nodeEta - sLo.eta) / denom;
          const nodeArc = sLo.arc + frac * (sHi.arc - sLo.arc);
          const value = evaluateEdgeField(
            el,
            nodeEta,
            interiorField,
            material,
          );
          nodes.push({ arc: nodeArc, value, lineId });
        }
      }

      segments.push({
        lineId,
        startArc: segStartArc,
        endArc: arcOffset,
        startPoint: segStartPoint ?? { x: 0, y: 0 },
        endPoint: segEndPoint ?? { x: 0, y: 0 },
      });
      curveByLine.push(segCurve);
    }

    if (segments.length === 0) return null;

    return {
      field: interiorField,
      totalArc: arcOffset,
      curveByLine,
      nodes,
      segments,
    };
  }, [selection, interiorField, solvedMesh, material]);

  /**
   * For every (lineId, indexInLine, nodeIdx) triple, is this node's
   * world position shared with ANOTHER mesh node OR a geometry Point?
   * Used to render shared nodes as SOLID circles. "Sharing with a Point"
   * matters because a continuous-scheme node at η=±1 coincides with the
   * line endpoint — physically the same nodal DOF as the neighbouring
   * line's endpoint node. Tolerance scales with zoom.
   */
  const sharedNodeKeys = useMemo(() => {
    const tol = view.width * 1e-4;
    const tol2 = tol * tol;
    const shared = new Set<string>();
    const nodeFlat: { key: string; x: number; y: number }[] = [];
    for (const el of meshElements) {
      for (let i = 0; i < el.nodes.length; i++) {
        const n = el.nodes[i]!;
        nodeFlat.push({
          key: `${el.lineId}|${el.indexInLine}|${i}`,
          x: n.x,
          y: n.y,
        });
      }
    }
    // Node–node coincidence.
    for (let i = 0; i < nodeFlat.length; i++) {
      for (let j = i + 1; j < nodeFlat.length; j++) {
        const a = nodeFlat[i]!;
        const b = nodeFlat[j]!;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx * dx + dy * dy <= tol2) {
          shared.add(a.key);
          shared.add(b.key);
        }
      }
    }
    // Node–point coincidence (line endpoints).
    for (const n of nodeFlat) {
      for (const p of model.points) {
        const dx = n.x - p.x;
        const dy = n.y - p.y;
        if (dx * dx + dy * dy <= tol2) {
          shared.add(n.key);
          break;
        }
      }
    }
    return shared;
  }, [meshElements, model.points, view.width]);

  const makeCtx = useCallback(
    (cursor: Vec2): ClickContext => ({
      cursor,
      gridStep,
      snapRadius,
      lineTolerance,
    }),
    [gridStep, snapRadius, lineTolerance],
  );

  // ── derived: lines in committed boundaries (red); domain fill data ─────

  const linesInBoundary = useMemo(() => {
    const ids = new Set<string>();
    for (const b of model.boundaries) {
      for (const seg of b.segments) ids.add(seg.lineId);
    }
    return ids;
  }, [model.boundaries]);

  // One SVG <path> per domain so holes don't bleed across domains. A
  // bounded domain (any CCW boundary) combines every member boundary into
  // one path with fill-rule="evenodd" — inner subpaths punch holes
  // automatically (genuine SVG hole, not a layered overlay). An unbounded
  // domain (only CW boundaries) renders bands of width L/2 on the material
  // side of every constituent line.
  const domainPaths = useMemo(() => {
    const linesById = new Map(model.lines.map((l) => [l.id, l]));
    const boundariesById = new Map(model.boundaries.map((b) => [b.id, b]));
    const paths: { kind: "bounded" | "unbounded"; d: string }[] = [];

    const subpathFor = (segs: typeof model.boundaries[number]["segments"]) => {
      let sub = "";
      for (let i = 0; i < segs.length; i++) {
        const seg = segs[i]!;
        const line = linesById.get(seg.lineId);
        if (!line) return null;
        // Resolve traversal start/end honouring segment direction.
        const startId = seg.direction === 1 ? line.startId : line.endId;
        const endId = seg.direction === 1 ? line.endId : line.startId;
        const start = pointsById.get(startId);
        const end = pointsById.get(endId);
        if (!start || !end) return null;
        // First segment opens the path with M to the start point.
        if (i === 0) sub += `M ${start.x} ${start.y} `;
        if (line.arcCentreId !== undefined) {
          // Arc segment — follow the curve, not the chord. SVG `A` command.
          const centre = pointsById.get(line.arcCentreId);
          if (!centre) return null;
          const r = Math.hypot(centre.x - start.x, centre.y - start.y);
          // Sweep flag chosen so SVG renders the arc passing OPPOSITE
          // the centre side (matches the stroke render in arcSvgPathD).
          // Derived in the engine arc helpers; reproduced inline here.
          const ex = end.x - start.x;
          const ey = end.y - start.y;
          const cxv = centre.x - start.x;
          const cyv = centre.y - start.y;
          const sweepFlag = ex * cyv - ey * cxv > 0 ? 1 : 0;
          sub += `A ${r} ${r} 0 0 ${sweepFlag} ${end.x} ${end.y} `;
        } else {
          // Straight segment.
          sub += `L ${end.x} ${end.y} `;
        }
      }
      return sub + "Z";
    };

    const bandFor = (segs: typeof model.boundaries[number]["segments"]) => {
      const bands: string[] = [];
      for (const seg of segs) {
        const line = linesById.get(seg.lineId);
        if (!line) continue;
        const startId = seg.direction === 1 ? line.startId : line.endId;
        const endId = seg.direction === 1 ? line.endId : line.startId;
        const a = pointsById.get(startId);
        const b = pointsById.get(endId);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        // Outward normal (right-of-direction) is (dy, -dx)/len; the material
        // side is the opposite: (-dy, dx)/len.
        const nx = -dy / len;
        const ny = dx / len;
        const w = len / 2;
        const ox = nx * w;
        const oy = ny * w;
        bands.push(
          `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${b.x + ox} ${b.y + oy} L ${a.x + ox} ${a.y + oy} Z`,
        );
      }
      return bands.join(" ");
    };

    for (const domain of model.domains) {
      const members = domain.boundaryIds
        .map((id) => boundariesById.get(id))
        .filter(
          (b): b is NonNullable<typeof b> => !!b && b.segments.length >= 3,
        );
      if (members.length === 0) continue;

      const orientations = members.map((b) =>
        loopOrientation(b.segments, model),
      );
      const isBounded = orientations.includes("ccw");

      if (isBounded) {
        // Bounded: combine every member boundary as a subpath. Even-odd
        // automatically makes inner subpaths into holes regardless of
        // their orientation.
        const subs: string[] = [];
        for (const b of members) {
          const sub = subpathFor(b.segments);
          if (sub) subs.push(sub);
        }
        if (subs.length > 0) {
          paths.push({ kind: "bounded", d: subs.join(" ") });
        }
      } else {
        // Unbounded: bands for every member boundary's lines.
        const bandSubs: string[] = [];
        for (const b of members) {
          const bands = bandFor(b.segments);
          if (bands) bandSubs.push(bands);
        }
        if (bandSubs.length > 0) {
          paths.push({ kind: "unbounded", d: bandSubs.join(" ") });
        }
      }
    }
    return paths;
  }, [model.domains, model.boundaries, model.lines, model, pointsById]);

  // ── selection lookup sets for fast styling ─────────────────────────────

  const selectedPointIds = useMemo(
    () => new Set(selection.filter((s) => s.kind === "point").map((s) => s.id)),
    [selection],
  );
  const selectedLineIds = useMemo(
    () => new Set(selection.filter((s) => s.kind === "line").map((s) => s.id)),
    [selection],
  );

  // ── derived button-enable flags ────────────────────────────────────────

  const canCreateDomain = useMemo(
    () => selectionCanCreateDomain(state),
    [state],
  );

  // ── pointer events ─────────────────────────────────────────────────────

  const onMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;

      // Middle-mouse drag: pan immediately, no other interpretation needed.
      // Works regardless of modifiers or what's under the cursor.
      if (e.button === 1) {
        panStateRef.current = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          startView: view,
        };
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;

      const now = performance.now();
      const last = lastDownRef.current;
      const isDoubleClick =
        last !== null &&
        now - last.time < DOUBLE_CLICK_WINDOW_MS &&
        Math.hypot(e.clientX - last.clientX, e.clientY - last.clientY) <
          DOUBLE_CLICK_RADIUS_PX;

      const downCursor = clientToWorld(svg, view, e.clientX, e.clientY);
      const hit = hitTest(stateRef.current.model, makeCtx(downCursor));
      downStateRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        moved: false,
        wasDoubleClick: isDoubleClick,
        shift: e.shiftKey,
        hitKind: hit.entity?.kind ?? null,
      };

      if (isDoubleClick) {
        lastDownRef.current = null;
        const cursor = clientToWorld(svg, view, e.clientX, e.clientY);
        dispatch({ type: "doubleClick", ctx: makeCtx(cursor) });
        e.preventDefault();
        return;
      }

      lastDownRef.current = {
        time: now,
        clientX: e.clientX,
        clientY: e.clientY,
      };
      // Drag setup is lazy: a shift+drag becomes a pan, anything else becomes
      // a startDrag for the entity under the original mousedown.
      // A shift+click without drag becomes a toggle-in-selection (multi-select).
    },
    [view, makeCtx],
  );

  // ── mouse move: pan, dragging, snap/cursor preview ─────────────────────

  const onMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;

      const world = clientToWorld(svg, view, e.clientX, e.clientY);
      setCursorWorld(world);
      setSnap(snapWorld(world, model.points, gridStep, snapRadius));

      // Click→drag transition: when movement crosses the threshold for the
      // first time, decide which gesture this is:
      //   - mousedown was on a Point/Line (no shift) → drag the entity
      //   - mousedown was on empty + shift                → pan
      //   - mousedown was on empty + no shift             → marquee select
      //   - mousedown was on entity + shift               → pan (shift wins)
      const down = downStateRef.current;
      if (down && !down.moved) {
        const dx = e.clientX - down.clientX;
        const dy = e.clientY - down.clientY;
        if (
          dx * dx + dy * dy >
          CLICK_DRAG_PX_THRESHOLD * CLICK_DRAG_PX_THRESHOLD
        ) {
          down.moved = true;
          if (
            !panStateRef.current &&
            !down.wasDoubleClick &&
            stateRef.current.dragSession === null &&
            stateRef.current.newLineDraft === null &&
            marquee === null
          ) {
            const startWorld = clientToWorld(
              svg,
              view,
              down.clientX,
              down.clientY,
            );
            if (down.shift) {
              // Shift + drag (anywhere) → pan. Keeps pan accessible over
              // both empty space and entities. Additive marquee is reachable
              // via plain drag, then shift-click extras after.
              panStateRef.current = {
                startClientX: down.clientX,
                startClientY: down.clientY,
                startView: view,
              };
            } else if (down.hitKind !== null) {
              // Drag on entity → move it.
              dispatch({
                type: "startDrag",
                ctx: makeCtx(startWorld),
                toggle: false,
              });
            } else {
              // Drag on empty (no shift) → marquee select (replace).
              setMarquee({ start: startWorld, current: world, additive: false });
            }
          }
        }
      }

      // Live-update the marquee rect.
      if (marquee !== null) {
        setMarquee((m) => (m ? { ...m, current: world } : m));
      }

      // If a drag is active (existing dragSession OR just dispatched above),
      // apply the move. We re-read via stateRef in case the dispatch above
      // hasn't reflected in our captured `dragSession` yet (it won't —
      // closure captures the value at render time).
      const liveSession = stateRef.current.dragSession;
      if (liveSession) {
        const snappedToGrid: Vec2 = {
          x: Math.round(world.x / gridStep) * gridStep,
          y: Math.round(world.y / gridStep) * gridStep,
        };
        dispatch({ type: "dragTo", cursor: snappedToGrid });
        return;
      }

      // Pan in progress.
      const pan = panStateRef.current;
      if (!pan) return;
      const rect = svg.getBoundingClientRect();
      const dxPx = e.clientX - pan.startClientX;
      const dyPx = e.clientY - pan.startClientY;
      const dxWorld = (dxPx / rect.width) * pan.startView.width;
      const dyWorld = (dyPx / rect.height) * pan.startView.height;
      setView({
        ...pan.startView,
        cx: pan.startView.cx - dxWorld,
        cy: pan.startView.cy + dyWorld,
      });
    },
    [view, model.points, gridStep, snapRadius, makeCtx, marquee],
  );

  // ── mouse up ───────────────────────────────────────────────────────────

  const onMouseUp = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      // Middle-mouse release: end pan and we're done; never a click.
      if (e.button === 1) {
        panStateRef.current = null;
        e.preventDefault();
        return;
      }
      const down = downStateRef.current;
      const wasPanning = panStateRef.current !== null;
      downStateRef.current = null;
      panStateRef.current = null;

      const svg = svgRef.current;
      if (!svg) return;
      const cursor = clientToWorld(svg, view, e.clientX, e.clientY);

      // Always end any active drag / commit any new-line draft on mouseup.
      if (stateRef.current.dragSession || stateRef.current.newLineDraft) {
        dispatch({ type: "endDrag", cursor, ctx: makeCtx(cursor) });
        return;
      }

      // Commit a marquee selection if active.
      if (marquee !== null) {
        const minX = Math.min(marquee.start.x, marquee.current.x);
        const maxX = Math.max(marquee.start.x, marquee.current.x);
        const minY = Math.min(marquee.start.y, marquee.current.y);
        const maxY = Math.max(marquee.start.y, marquee.current.y);
        // Ignore degenerate (zero-area) marquees.
        if (maxX - minX > 1e-9 || maxY - minY > 1e-9) {
          dispatch({
            type: "selectInMarquee",
            minX,
            minY,
            maxX,
            maxY,
            additive: marquee.additive,
          });
        }
        setMarquee(null);
        return;
      }

      if (!down) return;
      if (down.moved) return; // drag handled (or pan handled)
      if (wasPanning) return;
      if (down.wasDoubleClick) return; // double-click already processed

      // Simple click: select. Shift = toggle (multi-select); else replace.
      dispatch({
        type: "click",
        ctx: makeCtx(cursor),
        toggle: down.shift,
      });
    },
    [view, makeCtx, marquee],
  );

  const onMouseLeave = useCallback(() => {
    downStateRef.current = null;
    panStateRef.current = null;
    setCursorWorld(null);
    setSnap(null);
    setMarquee(null);
    if (stateRef.current.dragSession || stateRef.current.newLineDraft) {
      const cursor = cursorWorld ?? { x: 0, y: 0 };
      dispatch({ type: "endDrag", cursor, ctx: makeCtx(cursor) });
    }
  }, [cursorWorld, makeCtx]);

  // ── wheel zoom (passive: false) ────────────────────────────────────────

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const worldBefore = clientToWorld(svg, view, e.clientX, e.clientY);
      const ticks = e.deltaY > 0 ? 1 : -1;
      const factor = Math.pow(ZOOM_PER_WHEEL_TICK, ticks);
      const newWidth = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, view.width * factor),
      );
      const newHeight = view.height * (newWidth / view.width);
      setView({
        cx:
          worldBefore.x - (worldBefore.x - view.cx) * (newWidth / view.width),
        cy:
          worldBefore.y -
          (worldBefore.y - view.cy) * (newHeight / view.height),
        width: newWidth,
        height: newHeight,
      });
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, [view]);

  // ── persistence (localStorage auto-save / restore) ─────────────────────

  // Restore once at mount. If a stored model exists, load it.
  useEffect(() => {
    const stored = loadFromLocalStorage();
    if (stored) {
      dispatch({ type: "loadModel", model: stored });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce-save every model change.
  useEffect(() => {
    const handle = setTimeout(() => saveToLocalStorage(model), 300);
    return () => clearTimeout(handle);
  }, [model]);

  // ── file-action handlers ───────────────────────────────────────────────

  const handleSave = useCallback(() => {
    downloadAsJsonFile(model);
  }, [model]);

  const handleLoad = useCallback(async () => {
    const loaded = await loadFromJsonFile();
    if (loaded) dispatch({ type: "loadModel", model: loaded });
  }, []);

  const onLhsResizerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = lhsWidth;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        // Dragging RIGHT widens the LHS panel (canvas shrinks);
        // dragging LEFT narrows it. Clamp to [240, 900] px.
        const next = Math.max(240, Math.min(900, startWidth + dx));
        setLhsWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [lhsWidth],
  );

  const onRhsResizerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = rhsWidth;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        // Dragging LEFT widens the RHS panel (canvas shrinks);
        // dragging RIGHT narrows it. Clamp to [220, 700] px.
        const next = Math.max(220, Math.min(700, startWidth - dx));
        setRhsWidth(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [rhsWidth],
  );

  const handleNew = useCallback(() => {
    const hasContent =
      model.points.length > 0 ||
      model.lines.length > 0 ||
      model.boundaries.length > 0 ||
      model.domains.length > 0;
    if (
      hasContent &&
      !window.confirm("Discard the current mesh and start fresh?")
    ) {
      return;
    }
    dispatch({ type: "newModel" });
  }, [model]);

  // ── aspect ratio ───────────────────────────────────────────────────────

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(() => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const pxAspect = rect.width / rect.height;
      setView((v) => {
        const targetHeight = v.width / pxAspect;
        if (Math.abs(targetHeight - v.height) < 1e-9) return v;
        return { ...v, height: targetHeight };
      });
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // ── keyboard shortcuts ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        dispatch({ type: "deleteSelection" });
      } else if (e.key === "Escape") {
        dispatch({ type: "cancel" });
      } else if (e.key === "Enter") {
        // Convenience: Enter creates a domain from the current selection
        // (handles both the boundary-selected and closed-loop-of-lines cases).
        dispatch({ type: "createDomainFromSelection" });
      } else if (e.key === "f" || e.key === "F") {
        dispatch({ type: "flipSelectedLines" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── visual sizing ──────────────────────────────────────────────────────

  const pointRadius = view.width * 0.005;
  const lineStroke = view.width * 0.002;
  const snapRingRadius = view.width * 0.009;
  const snapRingStroke = view.width * 0.0012;
  const selectionHaloRadius = pointRadius * 2.4;
  const selectionHaloStroke = view.width * 0.0018;
  const normalTickLen = view.width * 0.015;
  const bcTickLen = view.width * 0.012;
  const bcStroke = view.width * 0.0014;
  const meshStroke = view.width * 0.0016;
  const meshNodeRadius = view.width * 0.005;
  const meshEndTickLen = view.width * 0.008;

  // ── rubber-band preview for new-line draft ─────────────────────────────

  const rubberBand = useMemo(() => {
    if (!newLineDraft || !cursorWorld) return null;
    const start = pointsById.get(newLineDraft.startPointId);
    if (!start) return null;
    return { start, end: cursorWorld };
  }, [newLineDraft, cursorWorld, pointsById]);

  // ── cursor & status ────────────────────────────────────────────────────

  const cursorClass = dragSession || newLineDraft
    ? "cad-canvas--grabbing"
    : "cad-canvas--default";

  const selectionSummary = useMemo(() => {
    if (selection.length === 0) return "no selection";
    if (selection.length === 1) return `1 ${selection[0]!.kind} selected`;
    return `${selection.length} items selected`;
  }, [selection]);

  const statusBits: string[] = [];
  if (cursorWorld) {
    statusBits.push(`x ${cursorWorld.x.toFixed(3)} y ${cursorWorld.y.toFixed(3)}`);
  }
  statusBits.push(`grid ${gridStep}`);
  if (newLineDraft) statusBits.push("drawing line (release to commit, Esc to cancel)");
  if (dragSession) {
    const n = dragSession.originalPositions.size;
    statusBits.push(`dragging ${n} point${n === 1 ? "" : "s"}`);
  }
  statusBits.push(
    `pts ${model.points.length}  lns ${model.lines.length}  bds ${model.boundaries.length}  doms ${model.domains.length}`,
  );

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <div className="cad-layout">
      <Toolbar
        canCreateDomain={canCreateDomain}
        canDelete={selection.length > 0}
        meshVisible={meshVisible}
        resultsVisible={resultsVisible}
        canShowResults={canShowResults}
        internalNodesVisible={internalNodesVisible}
        canShowInternalNodes={canShowInternalNodes}
        selectionSummary={selectionSummary}
        onCreateDomain={() => dispatch({ type: "createDomainFromSelection" })}
        onDelete={() => dispatch({ type: "deleteSelection" })}
        onToggleMesh={() => dispatch({ type: "toggleMesh" })}
        onToggleResults={() => dispatch({ type: "toggleResults" })}
        onToggleInternalNodes={() => dispatch({ type: "toggleInternalNodes" })}
        onSave={handleSave}
        onLoad={handleLoad}
        onNew={handleNew}
      />
      <div
        className="cad-main"
        style={{
          gridTemplateColumns: `${lhsWidth}px 6px minmax(0, 1fr) 6px ${rhsWidth}px`,
        }}
      >
        <InfoPanel model={model} selection={selection} onDispatch={dispatch} />
        <div
          className="cad-resizer"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={onLhsResizerDown}
          title="Drag to resize the Inspector panel"
        />
        <div className="cad-canvas-host">
          <svg
            ref={svgRef}
            className={`cad-canvas ${cursorClass}`}
            viewBox={viewBoxAttr(view)}
            preserveAspectRatio="xMidYMid meet"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
          >
            <g transform="scale(1, -1)">
              <Grid view={view} step={gridStep} />

              {domainPaths.map((dp, i) => (
                <path
                  key={i}
                  d={dp.d}
                  fill="var(--boundary)"
                  fillRule={dp.kind === "bounded" ? "evenodd" : "nonzero"}
                  fillOpacity={0.18}
                  pointerEvents="none"
                />
              ))}

              {/* Interior ux contour fill. Each Delaunay triangle is
                  subdivided into N² flat-colour sub-triangles so the
                  linear field varies visibly across the parent T3.
                  Red = max +ve ux, blue = max -ve, green = 0. Gated
                  independently of the wireframe — fills can sit alone
                  or under the wireframe. */}
              {interiorField !== null &&
                interiorFieldValues &&
                interiorFieldStats !== null &&
                internalTriangles && (() => {
                  const range = interiorFieldStats.range;
                  const positive = isPositiveOnlyField(interiorField);
                  // Map raw value v to a t the colour function expects:
                  //   diverging → t = v / range, ∈ [-1, +1]
                  //   positive  → t = v / range, ∈ [0, +1]
                  // The colour function then quantises t into 11 bands
                  // and looks up the palette.
                  const colorOf = (v: number): string =>
                    positive
                      ? sequentialUxColor(v / range)
                      : divergingUxColor(v / range);
                  const N = 4;
                  const polys: React.ReactElement[] = [];
                  // Hairline seal stroke matching fill — kills the
                  // sub-pixel gap between flat-colour neighbours.
                  const seal = view.width * 0.0006;
                  internalTriangles.triangles.forEach((tri, ti) => {
                    const pA = internalTriangles.points[tri.a]!;
                    const pB = internalTriangles.points[tri.b]!;
                    const pC = internalTriangles.points[tri.c]!;
                    const vA = interiorFieldValues[tri.a]!;
                    const vB = interiorFieldValues[tri.b]!;
                    const vC = interiorFieldValues[tri.c]!;
                    // Position + value at barycentric (a,b,c).
                    const at = (
                      a: number,
                      b: number,
                      c: number,
                    ): { x: number; y: number; v: number } => ({
                      x: a * pA.x + b * pB.x + c * pC.x,
                      y: a * pA.y + b * pB.y + c * pC.y,
                      v: a * vA + b * vB + c * vC,
                    });
                    // (i,j) indexes the lattice; k = N - i - j.
                    // Upward sub-tri: (i,j), (i+1,j), (i,j+1).
                    // Downward sub-tri: (i+1,j), (i+1,j+1), (i,j+1).
                    for (let i = 0; i < N; i++) {
                      for (let j = 0; j < N - i; j++) {
                        const p1 = at(i / N, j / N, (N - i - j) / N);
                        const p2 = at((i + 1) / N, j / N, (N - i - j - 1) / N);
                        const p3 = at(i / N, (j + 1) / N, (N - i - j - 1) / N);
                        const cvVal = (p1.v + p2.v + p3.v) / 3;
                        const fill = colorOf(cvVal);
                        polys.push(
                          <polygon
                            key={`up-${ti}-${i}-${j}`}
                            points={`${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`}
                            fill={fill}
                            stroke={fill}
                            strokeWidth={seal}
                          />,
                        );
                        if (i + j < N - 1) {
                          const q1 = p2;
                          const q2 = at(
                            (i + 1) / N,
                            (j + 1) / N,
                            (N - i - j - 2) / N,
                          );
                          const q3 = p3;
                          const cvdVal = (q1.v + q2.v + q3.v) / 3;
                          const fillD = colorOf(cvdVal);
                          polys.push(
                            <polygon
                              key={`dn-${ti}-${i}-${j}`}
                              points={`${q1.x},${q1.y} ${q2.x},${q2.y} ${q3.x},${q3.y}`}
                              fill={fillD}
                              stroke={fillD}
                              strokeWidth={seal}
                            />,
                          );
                        }
                      }
                    }
                  });
                  return (
                    <g pointerEvents="none" opacity={0.85}>
                      {polys}
                    </g>
                  );
                })()}

              {/* Internal post-process mesh: triangle wireframe + node
                  dots. Triangulation is unconstrained Delaunay over
                  (boundary BEM nodes + corner Points + interior nodes),
                  with centroid-in-polygon filtering. */}
              {internalNodesVisible && (
                <g pointerEvents="none">
                  {internalTriangles && (() => {
                    // Dedupe edges so each interior edge renders once.
                    const drawnEdges = new Set<string>();
                    const edges: React.ReactElement[] = [];
                    const stroke = view.width * 0.001;
                    const addEdge = (
                      a: number,
                      b: number,
                      key: string,
                    ) => {
                      const lo = Math.min(a, b);
                      const hi = Math.max(a, b);
                      const k = `${lo}|${hi}`;
                      if (drawnEdges.has(k)) return;
                      drawnEdges.add(k);
                      const pa = internalTriangles.points[a]!;
                      const pb = internalTriangles.points[b]!;
                      edges.push(
                        <line
                          key={key}
                          x1={pa.x}
                          y1={pa.y}
                          x2={pb.x}
                          y2={pb.y}
                          stroke="var(--mesh)"
                          strokeWidth={stroke}
                          opacity={0.35}
                        />,
                      );
                    };
                    internalTriangles.triangles.forEach((t, i) => {
                      addEdge(t.a, t.b, `e${i}-ab`);
                      addEdge(t.b, t.c, `e${i}-bc`);
                      addEdge(t.c, t.a, `e${i}-ca`);
                    });
                    return edges;
                  })()}
                  {internalNodes.map((p, i) => (
                    <circle
                      key={`in${i}`}
                      cx={p.x}
                      cy={p.y}
                      r={view.width * 0.004}
                      fill="canvas"
                      stroke="var(--mesh)"
                      strokeWidth={view.width * 0.0012}
                    />
                  ))}
                </g>
              )}

              {/* Lines (straight or arc) + outward-normal ticks. */}
              <g pointerEvents="none">
                {model.lines.map((l) => {
                  const start = pointsById.get(l.startId);
                  const end = pointsById.get(l.endId);
                  if (!start || !end) return null;
                  const isSelected = selectedLineIds.has(l.id);
                  const inBoundary = linesInBoundary.has(l.id);
                  const stroke = isSelected
                    ? "var(--accent)"
                    : inBoundary
                      ? "var(--boundary)"
                      : "var(--geom)";
                  const strokeW = isSelected ? lineStroke * 1.8 : lineStroke;

                  // Arc render path. Falls back to straight if the centre
                  // Point has been deleted out from under it.
                  const centre = l.arcCentreId
                    ? pointsById.get(l.arcCentreId)
                    : undefined;
                  const isArc = centre !== undefined;

                  // Midpoint for the normal tick + the tangent direction
                  // at that midpoint (so the tick is perpendicular).
                  let mx: number, my: number;
                  let tickDx: number, tickDy: number; // line direction at mid
                  if (isArc) {
                    const mid = arcPoint(start, end, centre, 0.5);
                    mx = mid.x;
                    my = mid.y;
                    // Tangent at midpoint = perpendicular to radius, in the
                    // direction of arc travel start→end.
                    const rx = mid.x - centre.x;
                    const ry = mid.y - centre.y;
                    const rl = Math.hypot(rx, ry);
                    // Two tangent candidates: (-ry, rx) and (ry, -rx). Pick
                    // the one whose dot product with (end - start) is +ve.
                    const cdx = end.x - start.x;
                    const cdy = end.y - start.y;
                    const t1x = -ry / rl;
                    const t1y = rx / rl;
                    if (t1x * cdx + t1y * cdy >= 0) {
                      tickDx = t1x;
                      tickDy = t1y;
                    } else {
                      tickDx = -t1x;
                      tickDy = -t1y;
                    }
                  } else {
                    mx = (start.x + end.x) / 2;
                    my = (start.y + end.y) / 2;
                    const cdx = end.x - start.x;
                    const cdy = end.y - start.y;
                    const cl = Math.hypot(cdx, cdy);
                    tickDx = cl > 0 ? cdx / cl : 1;
                    tickDy = cl > 0 ? cdy / cl : 0;
                  }
                  // Outward normal = right-of-direction = (dy, -dx).
                  const tickEnd = {
                    x: mx + tickDy * normalTickLen,
                    y: my - tickDx * normalTickLen,
                  };
                  // Hide tick on very short geometry to avoid clutter.
                  const chordLen = Math.hypot(end.x - start.x, end.y - start.y);
                  const showTick = chordLen > normalTickLen * 1.2;

                  return (
                    <g key={l.id}>
                      {isArc ? (
                        <path
                          d={arcSvgPathD(start, end, centre)}
                          fill="none"
                          stroke={stroke}
                          strokeWidth={strokeW}
                          strokeLinecap="round"
                        />
                      ) : (
                        <line
                          x1={start.x}
                          y1={start.y}
                          x2={end.x}
                          y2={end.y}
                          stroke={stroke}
                          strokeWidth={strokeW}
                          strokeLinecap="round"
                        />
                      )}
                      {showTick && (
                        <line
                          x1={mx}
                          y1={my}
                          x2={tickEnd.x}
                          y2={tickEnd.y}
                          stroke={stroke}
                          strokeWidth={lineStroke * 0.8}
                          strokeLinecap="round"
                          opacity={0.75}
                        />
                      )}
                    </g>
                  );
                })}
              </g>

              {/* Points (geometry layer — render BEFORE mesh + BC glyphs so
                  those analysis-layer overlays sit visually on top of the
                  geometry, matching the conceptual stack). */}
              <g pointerEvents="none">
                {model.points.map((p) => {
                  const isSelected = selectedPointIds.has(p.id);
                  return (
                    <g key={p.id}>
                      {isSelected && (
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={selectionHaloRadius}
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth={selectionHaloStroke}
                        />
                      )}
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={pointRadius}
                        fill="canvas"
                        stroke="var(--geom)"
                        strokeWidth={lineStroke}
                      />
                    </g>
                  );
                })}
              </g>

              {/* Mesh overlay (toggled). Elements coincide with the parent
                  geometry — same path, just stroked in navy on top — with
                  short perpendicular end ticks bracketing each element and
                  3 open circles at the 3 node positions (η = -2/3, 0, +2/3). */}
              {meshVisible && (
                <g pointerEvents="none">
                  {meshElements.flatMap((el) => {
                    const line = model.lines.find((l) => l.id === el.lineId);
                    if (!line) return [];
                    const lineStart = pointsById.get(line.startId);
                    const lineEnd = pointsById.get(line.endId);
                    if (!lineStart || !lineEnd) return [];
                    const centre = line.arcCentreId
                      ? pointsById.get(line.arcCentreId)
                      : undefined;

                    // Outward normal at parametric t along the line (used only
                    // for the perpendicular end-tick orientation).
                    const normalAt = (t: number): Vec2 => {
                      if (centre) {
                        const p = arcPoint(lineStart, lineEnd, centre, t);
                        const rx = p.x - centre.x;
                        const ry = p.y - centre.y;
                        const rl = Math.hypot(rx, ry) || 1;
                        const cdx = lineEnd.x - lineStart.x;
                        const cdy = lineEnd.y - lineStart.y;
                        let tdx = -ry / rl;
                        let tdy = rx / rl;
                        if (tdx * cdx + tdy * cdy < 0) {
                          tdx = -tdx;
                          tdy = -tdy;
                        }
                        return { x: tdy, y: -tdx };
                      }
                      const dx = lineEnd.x - lineStart.x;
                      const dy = lineEnd.y - lineStart.y;
                      const dl = Math.hypot(dx, dy) || 1;
                      return { x: dy / dl, y: -dx / dl };
                    };

                    // Build the rail ON the geometry. For arcs, sample 9
                    // points so the rail follows the curve; for straight, 2
                    // endpoints suffice.
                    const rail: Vec2[] = [];
                    const N = centre ? 9 : 2;
                    for (let i = 0; i < N; i++) {
                      const local = i / (N - 1);
                      const t = el.tStart + local * (el.tEnd - el.tStart);
                      const p = centre
                        ? arcPoint(lineStart, lineEnd, centre, t)
                        : {
                            x: lineStart.x + t * (lineEnd.x - lineStart.x),
                            y: lineStart.y + t * (lineEnd.y - lineStart.y),
                          };
                      rail.push(p);
                    }
                    const railD = rail
                      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
                      .join(" ");

                    // End ticks: perpendicular bars crossing the line at
                    // tStart and tEnd, centred on the line.
                    const startNormal = normalAt(el.tStart);
                    const endNormal = normalAt(el.tEnd);
                    const startTickA = {
                      x: el.start.x - startNormal.x * meshEndTickLen,
                      y: el.start.y - startNormal.y * meshEndTickLen,
                    };
                    const startTickB = {
                      x: el.start.x + startNormal.x * meshEndTickLen,
                      y: el.start.y + startNormal.y * meshEndTickLen,
                    };
                    const endTickA = {
                      x: el.end.x - endNormal.x * meshEndTickLen,
                      y: el.end.y - endNormal.y * meshEndTickLen,
                    };
                    const endTickB = {
                      x: el.end.x + endNormal.x * meshEndTickLen,
                      y: el.end.y + endNormal.y * meshEndTickLen,
                    };

                    // 3 nodes on the line. Hollow by default; filled
                    // (solid) when the node's world position is shared
                    // with another element's node — i.e. continuous
                    // across the element boundary.
                    const nodeCircles = el.nodes.map((node, i) => {
                      const key = `${el.lineId}|${el.indexInLine}|${i}`;
                      const shared = sharedNodeKeys.has(key);
                      return (
                        <circle
                          key={`n${i}`}
                          cx={node.x}
                          cy={node.y}
                          r={meshNodeRadius}
                          fill={shared ? "var(--mesh)" : "canvas"}
                          stroke="var(--mesh)"
                          strokeWidth={meshStroke}
                        />
                      );
                    });

                    return [
                      <g key={`${el.lineId}-${el.indexInLine}`}>
                        <path
                          d={railD}
                          fill="none"
                          stroke="var(--mesh)"
                          strokeWidth={meshStroke}
                          strokeLinecap="round"
                        />
                        <line
                          x1={startTickA.x}
                          y1={startTickA.y}
                          x2={startTickB.x}
                          y2={startTickB.y}
                          stroke="var(--mesh)"
                          strokeWidth={meshStroke}
                          strokeLinecap="round"
                        />
                        <line
                          x1={endTickA.x}
                          y1={endTickA.y}
                          x2={endTickB.x}
                          y2={endTickB.y}
                          stroke="var(--mesh)"
                          strokeWidth={meshStroke}
                          strokeLinecap="round"
                        />
                        {nodeCircles}
                      </g>,
                    ];
                  })}
                </g>
              )}

              {/* BC glyphs.
                  Displacement (anchor):
                    tick in the world constrained-axis direction (outward),
                    short bar at the tip perpendicular to the tick.
                    The tick goes on the OUTWARD side of the line so the symbol
                    sits outside the material.
                  Traction (arrow):
                    arrow whose body lies in the world traction-axis direction,
                    sign of the value flips it; arrow drawn on the OUTWARD side
                    of the line, base on the line, head in the force direction. */}
              <g pointerEvents="none">
                {model.bcs.flatMap((bc) => {
                  const line = model.lines.find((l) => l.id === bc.lineId);
                  if (!line) return [];
                  const start = pointsById.get(line.startId);
                  const end = pointsById.get(line.endId);
                  if (!start || !end) return [];
                  const centre = line.arcCentreId
                    ? pointsById.get(line.arcCentreId)
                    : undefined;
                  const els: React.ReactElement[] = [];
                  const tickLen = bcTickLen;
                  const barHalf = bcTickLen * 0.45;
                  const arrowHeadLen = bcTickLen * 0.45;
                  const arrowHeadHalf = bcTickLen * 0.3;

                  // Sample positions on the line.
                  //   mesh on  → at the mesh nodes (the discrete BC points
                  //              the analysis would use). Position comes
                  //              from el.nodes (isoparametric) so the glyph
                  //              sits exactly where the analysis would put
                  //              the node — for arcs this is on the quadratic
                  //              approximation, NOT on the true arc.
                  //   mesh off → 5 evenly-spaced geometric points on the
                  //              true line geometry.
                  let samples: { pos: Vec2 | null; t: number }[];
                  if (meshVisible) {
                    const els2 = elementsByLineId.get(line.id);
                    if (els2 && els2.length > 0) {
                      samples = [];
                      for (const el of els2) {
                        for (let k = 0; k < 3; k++) {
                          samples.push({ pos: el.nodes[k]!, t: el.nodeTs[k]! });
                        }
                      }
                    } else {
                      samples = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
                        pos: null,
                        t,
                      }));
                    }
                  } else {
                    samples = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
                      pos: null,
                      t,
                    }));
                  }

                  for (let i = 0; i < samples.length; i++) {
                    const { pos, t } = samples[i]!;
                    // Position: either the iso node position (mesh on) or
                    // derived from t on the true geometry (mesh off / no
                    // element for this line).
                    let p: Vec2;
                    let nx: number;
                    let ny: number;
                    if (centre) {
                      p = pos ?? arcPoint(start, end, centre, t);
                      // Tangent at p: rotate radius 90° in the travel direction.
                      const rx = p.x - centre.x;
                      const ry = p.y - centre.y;
                      const rl = Math.hypot(rx, ry) || 1;
                      const cdx = end.x - start.x;
                      const cdy = end.y - start.y;
                      let tdx = -ry / rl;
                      let tdy = rx / rl;
                      if (tdx * cdx + tdy * cdy < 0) {
                        tdx = -tdx;
                        tdy = -tdy;
                      }
                      // Outward normal = right-of-tangent = (tdy, -tdx).
                      nx = tdy;
                      ny = -tdx;
                    } else {
                      p = pos ?? {
                        x: start.x + t * (end.x - start.x),
                        y: start.y + t * (end.y - start.y),
                      };
                      const dx = end.x - start.x;
                      const dy = end.y - start.y;
                      const dl = Math.hypot(dx, dy) || 1;
                      nx = dy / dl;
                      ny = -dx / dl;
                    }

                    for (const dir of ["x", "y"] as const) {
                      const dBc = dir === "x" ? bc.x : bc.y;
                      if (!dBc) continue;

                      if (dBc.kind === "displacement") {
                        // Anchor on the outward side. Tick is in the world
                        // constrained axis (x for dx, y for dy); the sign is
                        // chosen so the tick points to the outward-normal side.
                        const axisSign =
                          dir === "x"
                            ? nx >= 0
                              ? 1
                              : -1
                            : ny >= 0
                              ? 1
                              : -1;
                        const tipX = dir === "x" ? p.x + axisSign * tickLen : p.x;
                        const tipY = dir === "y" ? p.y + axisSign * tickLen : p.y;
                        // Bar at the tip, perpendicular to the tick — in the
                        // other axis.
                        const barAX =
                          dir === "x" ? tipX : tipX - barHalf;
                        const barAY =
                          dir === "y" ? tipY : tipY - barHalf;
                        const barBX =
                          dir === "x" ? tipX : tipX + barHalf;
                        const barBY =
                          dir === "y" ? tipY : tipY + barHalf;

                        els.push(
                          <line
                            key={`${bc.lineId}-d${dir}-${i}-tick`}
                            x1={p.x}
                            y1={p.y}
                            x2={tipX}
                            y2={tipY}
                            stroke="var(--bc-anchor)"
                            strokeWidth={bcStroke}
                            strokeLinecap="round"
                          />,
                          <line
                            key={`${bc.lineId}-d${dir}-${i}-bar`}
                            x1={barAX}
                            y1={barAY}
                            x2={barBX}
                            y2={barBY}
                            stroke="var(--bc-anchor)"
                            strokeWidth={bcStroke}
                            strokeLinecap="round"
                          />,
                        );
                      } else if (dBc.value !== 0) {
                        // Traction arrow. Body in world traction-axis direction,
                        // sign from the value. Base on the line, head in the
                        // force direction. To keep the symbol on the outward
                        // side we offset the base by a small amount along the
                        // outward normal.
                        const sign = dBc.value > 0 ? 1 : -1;
                        const bodyLen = tickLen * 1.2;
                        // Small base offset so the tail doesn't sit exactly on
                        // the line.
                        const baseOffset = bcStroke * 1.5;
                        const baseX = p.x + nx * baseOffset;
                        const baseY = p.y + ny * baseOffset;
                        const tipX =
                          dir === "x"
                            ? baseX + sign * bodyLen
                            : baseX;
                        const tipY =
                          dir === "y"
                            ? baseY + sign * bodyLen
                            : baseY;
                        // Arrowhead: two short lines from tip back toward base,
                        // offset perpendicular to the body (so along the OTHER
                        // axis).
                        const headBaseX =
                          dir === "x" ? tipX - sign * arrowHeadLen : tipX;
                        const headBaseY =
                          dir === "y" ? tipY - sign * arrowHeadLen : tipY;
                        const perpDX = dir === "x" ? 0 : arrowHeadHalf;
                        const perpDY = dir === "x" ? arrowHeadHalf : 0;
                        const h1X = headBaseX - perpDX;
                        const h1Y = headBaseY - perpDY;
                        const h2X = headBaseX + perpDX;
                        const h2Y = headBaseY + perpDY;

                        els.push(
                          <line
                            key={`${bc.lineId}-t${dir}-${i}-body`}
                            x1={baseX}
                            y1={baseY}
                            x2={tipX}
                            y2={tipY}
                            stroke="var(--bc-traction)"
                            strokeWidth={bcStroke}
                            strokeLinecap="round"
                          />,
                          <line
                            key={`${bc.lineId}-t${dir}-${i}-head1`}
                            x1={tipX}
                            y1={tipY}
                            x2={h1X}
                            y2={h1Y}
                            stroke="var(--bc-traction)"
                            strokeWidth={bcStroke}
                            strokeLinecap="round"
                          />,
                          <line
                            key={`${bc.lineId}-t${dir}-${i}-head2`}
                            x1={tipX}
                            y1={tipY}
                            x2={h2X}
                            y2={h2Y}
                            stroke="var(--bc-traction)"
                            strokeWidth={bcStroke}
                            strokeLinecap="round"
                          />,
                        );
                      }
                    }
                  }
                  return els;
                })}
              </g>

              {/* Deformed-shape overlay (toggled). For each element, sample
                  10 points along η ∈ [-1, +1]; at each, the displaced
                  position is the original geometry point + scale × displacement
                  interpolated from the 3 nodes via shape functions. The 3
                  displaced nodes are also drawn as dashed open circles. */}
              {resultsVisible && deformedScale !== null && (
                <g pointerEvents="none">
                  {solvedMesh.flatMap((el) => {
                    const line = model.lines.find((l) => l.id === el.lineId);
                    if (!line) return [];
                    const lineStart = pointsById.get(line.startId);
                    const lineEnd = pointsById.get(line.endId);
                    if (!lineStart || !lineEnd) return [];
                    const centre = line.arcCentreId
                      ? pointsById.get(line.arcCentreId)
                      : undefined;

                    const pointAt = (t: number): Vec2 =>
                      centre
                        ? arcPoint(lineStart, lineEnd, centre, t)
                        : {
                            x: lineStart.x + t * (lineEnd.x - lineStart.x),
                            y: lineStart.y + t * (lineEnd.y - lineStart.y),
                          };

                    // Build a polyline along the deformed element.
                    const N = 10;
                    const samples: Vec2[] = [];
                    for (let i = 0; i < N; i++) {
                      const eta = -1 + (i / (N - 1)) * 2;
                      const local = (eta + 1) / 2;
                      const t = el.tStart + local * (el.tEnd - el.tStart);
                      const orig = pointAt(t);
                      const Ns = shapeFunctions(eta, el.localNodes);
                      const ux =
                        Ns[0] * el.nodes[0].ux +
                        Ns[1] * el.nodes[1].ux +
                        Ns[2] * el.nodes[2].ux;
                      const uy =
                        Ns[0] * el.nodes[0].uy +
                        Ns[1] * el.nodes[1].uy +
                        Ns[2] * el.nodes[2].uy;
                      samples.push({
                        x: orig.x + deformedScale * ux,
                        y: orig.y + deformedScale * uy,
                      });
                    }
                    const railD = samples
                      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
                      .join(" ");

                    // Displaced node positions.
                    const dashedDot = `${meshStroke * 1.5} ${meshStroke * 1.5}`;
                    const nodeCircles = el.nodes.map((n, i) => (
                      <circle
                        key={`dn${i}`}
                        cx={n.x + deformedScale * n.ux}
                        cy={n.y + deformedScale * n.uy}
                        r={meshNodeRadius}
                        fill="none"
                        stroke="var(--results)"
                        strokeWidth={meshStroke}
                        strokeDasharray={dashedDot}
                      />
                    ));

                    return [
                      <g key={`${el.lineId}-${el.indexInLine}-def`}>
                        <path
                          d={railD}
                          fill="none"
                          stroke="var(--results)"
                          strokeWidth={meshStroke}
                          strokeLinecap="round"
                          strokeDasharray={`${meshStroke * 3} ${meshStroke * 2}`}
                        />
                        {nodeCircles}
                      </g>,
                    ];
                  })}
                </g>
              )}

              {/* New-line rubber band. */}
              {rubberBand && (
                <line
                  x1={rubberBand.start.x}
                  y1={rubberBand.start.y}
                  x2={rubberBand.end.x}
                  y2={rubberBand.end.y}
                  stroke="var(--accent)"
                  strokeWidth={lineStroke}
                  strokeDasharray={`${lineStroke * 4} ${lineStroke * 3}`}
                  opacity={0.7}
                  pointerEvents="none"
                />
              )}

              {/* Marquee selection rectangle. */}
              {marquee && (() => {
                const minX = Math.min(marquee.start.x, marquee.current.x);
                const maxX = Math.max(marquee.start.x, marquee.current.x);
                const minY = Math.min(marquee.start.y, marquee.current.y);
                const maxY = Math.max(marquee.start.y, marquee.current.y);
                return (
                  <rect
                    x={minX}
                    y={minY}
                    width={maxX - minX}
                    height={maxY - minY}
                    fill="var(--accent)"
                    fillOpacity={0.08}
                    stroke="var(--accent)"
                    strokeWidth={lineStroke * 0.8}
                    strokeDasharray={`${lineStroke * 3} ${lineStroke * 2}`}
                    pointerEvents="none"
                  />
                );
              })()}

              {/* Snap indicator. */}
              {snap && (
                <circle
                  cx={snap.snapped.x}
                  cy={snap.snapped.y}
                  r={snapRingRadius}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={snapRingStroke}
                  opacity={snap.existingPointId ? 1 : 0.6}
                  pointerEvents="none"
                />
              )}
            </g>
          </svg>
          <div className="cad-canvas-status">{statusBits.join("  ·  ")}</div>
        </div>
        <div
          className="cad-resizer"
          role="separator"
          aria-orientation="vertical"
          onMouseDown={onRhsResizerDown}
          title="Drag to resize the Results panel"
        />
        <ResultsPanel
          activeField={interiorField}
          stats={interiorFieldStats}
          canShowResults={canShowInteriorResults}
          edgeProfile={edgeProfile}
          onSelectField={(field) =>
            dispatch({ type: "setInteriorField", field })
          }
        />
      </div>
    </div>
  );
}
