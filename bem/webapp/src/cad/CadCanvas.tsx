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
  discretiseLines,
  evaluatePostField,
  loopOrientation,
  shapeFunctions,
  shapeFunctionsT6,
  solve,
  triangulateDomain,
  type MeshElement,
  type Vec2,
} from "@bem/engine";
import { Toolbar } from "./Toolbar.js";
import { InfoPanel } from "./InfoPanel.js";
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
// Post-process render helpers
// ───────────────────────────────────────────────────────────────────────────

/** Diverging blue → green → red colormap, auto-scaled to ±vMax.
 *  v = vMax → red; v = -vMax → blue; v = 0 → green. */
function divergingColor(v: number, vMax: number): string {
  const t = Math.max(-1, Math.min(1, v / vMax));
  // Green at zero, red at +1, blue at -1.
  const green: [number, number, number] = [74, 174, 74];
  const red: [number, number, number] = [204, 51, 34];
  const blue: [number, number, number] = [54, 102, 204];
  const target = t > 0 ? red : blue;
  const a = Math.abs(t);
  const r = Math.round(green[0] * (1 - a) + target[0] * a);
  const g = Math.round(green[1] * (1 - a) + target[1] * a);
  const b = Math.round(green[2] * (1 - a) + target[2] * a);
  return `rgb(${r},${g},${b})`;
}

/** Subdivide one T6 into N×N flat-colour sub-triangles. Returns SVG
 *  <polygon> elements. Geometry is linear (T6 anchors coplanar); colour
 *  uses the quadratic T6 interpolation of nodal field values. */
function renderT6Contour(
  tri: { readonly nodes: readonly [number, number, number, number, number, number] },
  postNodes: readonly Vec2[],
  postU: readonly Vec2[],
  vMax: number,
  triIdx: number,
): React.ReactElement[] {
  const N = 4; // 16 sub-triangles per T6 — visually smooth enough.
  const v1 = postNodes[tri.nodes[0]]!;
  const v2 = postNodes[tri.nodes[1]]!;
  const v3 = postNodes[tri.nodes[2]]!;
  const u: readonly [number, number, number, number, number, number] = [
    postU[tri.nodes[0]]!.x,
    postU[tri.nodes[1]]!.x,
    postU[tri.nodes[2]]!.x,
    postU[tri.nodes[3]]!.x,
    postU[tri.nodes[4]]!.x,
    postU[tri.nodes[5]]!.x,
  ];

  // Sub-vertex at barycentric (i/N, j/N, (N-i-j)/N) — position is linear,
  // field is quadratic via T6 shape functions.
  const pos = (i: number, j: number): Vec2 => {
    const L1 = i / N;
    const L2 = j / N;
    const L3 = 1 - L1 - L2;
    return {
      x: L1 * v1.x + L2 * v2.x + L3 * v3.x,
      y: L1 * v1.y + L2 * v2.y + L3 * v3.y,
    };
  };
  const field = (i: number, j: number): number => {
    const L1 = i / N;
    const L2 = j / N;
    const L3 = 1 - L1 - L2;
    const Ns = shapeFunctionsT6(L1, L2, L3);
    return (
      u[0] * Ns[0] + u[1] * Ns[1] + u[2] * Ns[2] +
      u[3] * Ns[3] + u[4] * Ns[4] + u[5] * Ns[5]
    );
  };

  const out: React.ReactElement[] = [];
  let subIdx = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - i; j++) {
      // "Up" sub-triangle: (i,j), (i+1,j), (i,j+1)
      const a = pos(i, j);
      const b = pos(i + 1, j);
      const c = pos(i, j + 1);
      const avgU = (field(i, j) + field(i + 1, j) + field(i, j + 1)) / 3;
      out.push(
        <polygon
          key={`c${triIdx}-${subIdx++}`}
          points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`}
          fill={divergingColor(avgU, vMax)}
          stroke="none"
        />,
      );
      // "Down" sub-triangle: (i+1,j), (i+1,j+1), (i,j+1) if it fits.
      if (i + j + 1 < N) {
        const d = pos(i + 1, j);
        const e = pos(i + 1, j + 1);
        const f = pos(i, j + 1);
        const avgU2 =
          (field(i + 1, j) + field(i + 1, j + 1) + field(i, j + 1)) / 3;
        out.push(
          <polygon
            key={`c${triIdx}-${subIdx++}`}
            points={`${d.x},${d.y} ${e.x},${e.y} ${f.x},${f.y}`}
            fill={divergingColor(avgU2, vMax)}
            stroke="none"
          />,
        );
      }
    }
  }
  return out;
}

/** Wireframe of the T6 post-mesh: edges + vertex dots + midpoint dots. */
function renderPostMeshWireframe(
  postMesh: {
    readonly nodes: readonly Vec2[];
    readonly triangles: readonly { readonly nodes: readonly [number, number, number, number, number, number] }[];
    readonly vertexCount: number;
  },
  viewW: number,
): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  const stroke = viewW * 0.0012;
  const vertexR = viewW * 0.004;
  const midR = viewW * 0.0025;
  // Dedupe edges per (lo, hi) sorted pair.
  const drawnEdges = new Set<string>();
  const drawEdge = (a: number, b: number, key: string) => {
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const k = `${lo}|${hi}`;
    if (drawnEdges.has(k)) return;
    drawnEdges.add(k);
    const pa = postMesh.nodes[a]!;
    const pb = postMesh.nodes[b]!;
    out.push(
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
  postMesh.triangles.forEach((t, ti) => {
    drawEdge(t.nodes[0], t.nodes[1], `e${ti}-01`);
    drawEdge(t.nodes[1], t.nodes[2], `e${ti}-12`);
    drawEdge(t.nodes[2], t.nodes[0], `e${ti}-20`);
  });
  // Vertex dots (filled).
  for (let i = 0; i < postMesh.vertexCount; i++) {
    const p = postMesh.nodes[i]!;
    out.push(
      <circle
        key={`v${i}`}
        cx={p.x}
        cy={p.y}
        r={vertexR}
        fill="var(--mesh)"
      />,
    );
  }
  // Mid-edge dots (smaller, hollow).
  for (let i = postMesh.vertexCount; i < postMesh.nodes.length; i++) {
    const p = postMesh.nodes[i]!;
    out.push(
      <circle
        key={`m${i}`}
        cx={p.x}
        cy={p.y}
        r={midR}
        fill="canvas"
        stroke="var(--mesh)"
        strokeWidth={stroke}
      />,
    );
  }
  return out;
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
  const [rhsWidth, setRhsWidth] = useState(320);

  const {
    model,
    selection,
    dragSession,
    newLineDraft,
    meshVisible,
    resultsVisible,
    internalMeshVisible,
    contourVisible,
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

  // Solve. Memoised — runs synchronously on every model change (cheap in
  // 2D for the stub). Real BEM kernel drops in behind the same signature.
  const solvedMesh = useMemo(() => solve(meshElements), [meshElements]);

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

  /** Average boundary element chord length — used as the interior
   *  steiner spacing so the post-mesh density matches the BEM mesh. */
  const avgBoundaryElementSize = useMemo(() => {
    if (meshElements.length === 0) return null;
    let total = 0;
    for (const el of meshElements) {
      total += Math.hypot(el.end.x - el.start.x, el.end.y - el.start.y);
    }
    return total / meshElements.length;
  }, [meshElements]);

  /** Interior triangulation for post-processing. Boundary polygon comes
   *  from BEM mesh nodes (so triangulation boundary edges coincide with
   *  BEM elements). Steiner spacing tracks the boundary element size. */
  const postMesh = useMemo(() => {
    if (model.domains.length === 0) return null;
    return triangulateDomain(
      model,
      meshElements,
      avgBoundaryElementSize !== null
        ? { spacing: avgBoundaryElementSize }
        : {},
    );
  }, [
    model.points,
    model.lines,
    model.boundaries,
    model.domains,
    meshElements,
    avgBoundaryElementSize,
  ]);
  const canShowContour = postMesh !== null && postMesh.triangles.length > 0;

  /** Field values at every post-mesh node — Somigliana evaluation against
   *  the solved boundary. Recomputes when either the triangulation or
   *  the solved boundary changes. */
  const postField = useMemo(() => {
    if (!postMesh || !canShowResults) return null;
    return evaluatePostField(postMesh, solvedMesh, {
      E: 200e9,
      nu: 0.3,
      planeKind: "stress",
    });
  }, [postMesh, solvedMesh, canShowResults]);

  /** Auto-scaled colormap range for u_x (the only field for v1). */
  const contourRange = useMemo(() => {
    if (!postField) return null;
    let vMax = 0;
    for (const u of postField.u) {
      const v = Math.abs(u.x);
      if (Number.isFinite(v) && v > vMax) vMax = v;
    }
    if (vMax === 0) return null;
    return vMax;
  }, [postField]);

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

  const onResizerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = rhsWidth;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        // Dragging LEFT widens the panel (canvas shrinks); dragging RIGHT
        // narrows it. Clamp to [280, 900] px.
        const next = Math.max(280, Math.min(900, startWidth - dx));
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
        internalMeshVisible={internalMeshVisible}
        contourVisible={contourVisible}
        canShowContour={canShowContour}
        selectionSummary={selectionSummary}
        onCreateDomain={() => dispatch({ type: "createDomainFromSelection" })}
        onDelete={() => dispatch({ type: "deleteSelection" })}
        onToggleMesh={() => dispatch({ type: "toggleMesh" })}
        onToggleResults={() => dispatch({ type: "toggleResults" })}
        onToggleInternalMesh={() => dispatch({ type: "toggleInternalMesh" })}
        onToggleContour={() => dispatch({ type: "toggleContour" })}
        onSave={handleSave}
        onLoad={handleLoad}
        onNew={handleNew}
      />
      <div
        className="cad-main"
        style={{
          gridTemplateColumns: `minmax(0, 1fr) 6px ${rhsWidth}px`,
        }}
      >
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
                  fillOpacity={contourVisible ? 0 : 0.18}
                  pointerEvents="none"
                />
              ))}

              {/* Field contour fill — each T6 is subdivided into N×N
                  flat-colour sub-triangles; sub-vertex world position is
                  linear (anchors are coplanar), sub-vertex colour comes
                  from the quadratic T6 interpolation of nodal u values. */}
              {contourVisible && postMesh && postField && contourRange !== null && (
                <g pointerEvents="none">
                  {postMesh.triangles.flatMap((tri, ti) =>
                    renderT6Contour(tri, postMesh.nodes, postField.u, contourRange, ti),
                  )}
                </g>
              )}

              {/* Internal post-mesh wireframe. */}
              {internalMeshVisible && postMesh && (
                <g pointerEvents="none">
                  {renderPostMeshWireframe(postMesh, view.width)}
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
          onMouseDown={onResizerDown}
          title="Drag to resize the Inspector panel"
        />
        <InfoPanel
          model={model}
          selection={selection}
          onDispatch={dispatch}
        />
      </div>
    </div>
  );
}
