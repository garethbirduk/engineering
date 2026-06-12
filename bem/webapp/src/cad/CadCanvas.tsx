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
  buildLineDomainMap,
  createBlockCache,
  discretiseLines,
  interiorDisplacement,
  interiorStress,
  loopOrientation,
  referenceStress,
  resolveMaterial,
  shapeFunctions,
  solveMultiDomain,
  shapeFunctionDerivatives,
  solve,
  STANDARD_NODES,
  type BlockCache,
  type MaterialProperties,
  type MeshElement,
  type SolveStats,
  type StressTriple,
  type Vec2,
} from "@bem/engine";
import { Toolbar } from "./Toolbar.js";
import { InfoPanel } from "./InfoPanel.js";
import type { EquationsPick } from "./EquationsPanel.js";
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
  buildDomainPolygons,
  buildSubdomainMesh,
  detectHoverContext,
  type HoverContext,
} from "./operations.js";
// Bundled default example — loaded on first visit (no localStorage yet)
// so the deployed page opens with something interesting instead of an
// empty canvas. ?raw gives us the file contents as a string so we can
// reuse the existing `deserialize` parser.
import defaultExampleText from "../examples/plate-with-hole.json?raw";
import { deserialize } from "@bem/engine";
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
const EMPTY_NODE_POSITIONS: readonly Vec2[] = [];
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

/** Squared distance from point `p` to the line segment a→b. Standard
 *  projection onto the segment, clamped to [0, 1]. Used for element
 *  hover hit-testing (each element's straight chord). */
function pointToSegmentSq(p: Vec2, a: Vec2, b: Vec2): number {
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
  return ex * ex + ey * ey;
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
 *  Somigliana stress integrand on Γ. Derived scalars (σvm, σ1, σ2, τmax,
 *  Kt) are simple algebra on the Cartesian stress tensor.
 *
 *  `sigmaRef` is the SCF denominator (max applied traction magnitude);
 *  used only for `field === "scf"`. Caller must pass a positive value
 *  in that case — caller is responsible for the no-traction-BC guard. */
function evaluateEdgeField(
  el: MeshElement,
  eta: number,
  field: InteriorField,
  material: MaterialProperties,
  sigmaRef: number,
): number {
  if (field === "ux" || field === "uy") {
    const Nf = shapeFunctions(eta, el.localNodes);
    const v0 = field === "ux" ? el.nodes[0].ux : el.nodes[0].uy;
    const v1 = field === "ux" ? el.nodes[1].ux : el.nodes[1].uy;
    const v2 = field === "ux" ? el.nodes[2].ux : el.nodes[2].uy;
    return Nf[0] * v0 + Nf[1] * v1 + Nf[2] * v2;
  }
  const s = boundaryStress(el, eta, material);
  const vmStress = () => {
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
  };
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
    case "svm":
      return vmStress();
    case "scf":
      return vmStress() / sigmaRef;
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
  // World position of the Results-panel plot's hover crosshair. Set
  // by ResultsPanel via onHoverWorld; rendered on the canvas as a
  // small white tracking circle so the user can see where the
  // currently-pointed graph value lives in the model.
  const [profileHoverWorld, setProfileHoverWorld] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [snap, setSnap] = useState<ReturnType<typeof snapWorld> | null>(null);
  // Hover state for the matrix view's element-level highlight. The ref
  // shadows the state so the change-detection in onMouseMove doesn't
  // need to depend on React's re-render cycle — set the ref first, then
  // call setHoveredElementKey only when the value actually changed,
  // which throttles re-renders to once per element transition.
  const [hoveredElementKey, setHoveredElementKey] = useState<string | null>(
    null,
  );
  const hoveredElementKeyRef = useRef<string | null>(null);
  // Reverse direction — matrix-view hover. The matrix view reports
  // both a row DOF (cursor Y) and a col DOF (cursor X, only when over
  // H or G). We translate both into canvas highlights — one node ring
  // for the row, another for the col when the two differ.
  const [hoveredMatrixRow, setHoveredMatrixRow] = useState<number | null>(
    null,
  );
  const [hoveredMatrixCol, setHoveredMatrixCol] = useState<number | null>(
    null,
  );
  const hoveredMatrixRowRef = useRef<number | null>(null);
  const hoveredMatrixColRef = useRef<number | null>(null);
  const onHoverMatrixDof = useCallback(
    (row: number | null, col: number | null) => {
      if (row !== hoveredMatrixRowRef.current) {
        hoveredMatrixRowRef.current = row;
        setHoveredMatrixRow(row);
      }
      if (col !== hoveredMatrixColRef.current) {
        hoveredMatrixColRef.current = col;
        setHoveredMatrixCol(col);
      }
    },
    [],
  );
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
    matrixVisible,
    labelsVisible,
    equationsVisible,
  } = state;

  // Equations panel pick state — just the collocation node now (global
  // index). Source elements come from the standard line/boundary
  // selection, so they're driven by the reducer, not a separate pin.
  // Lives in canvas-local state because the node click bypasses the
  // selection reducer.
  const [equationsPick, setEquationsPick] = useState<EquationsPick>({
    nodeIdx: null,
  });
  // Hover preview for a node target in equations mode. Non-node hits
  // (lines / empty space) fall through to normal selection — no
  // separate element preview anymore.
  const [equationsHover, setEquationsHover] = useState<
    { kind: "node"; nodeIdx: number; pos: Vec2 } | null
  >(null);
  // Clear stale picks when the toolbar toggle goes off, or when the
  // mesh resolves no nodes anymore (cleared model). Wrapped in an
  // effect so we don't dispatch during render.
  useEffect(() => {
    if (!equationsVisible) {
      setEquationsHover(null);
    }
  }, [equationsVisible]);

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
        /** True when the user held Ctrl/Cmd at mousedown — drives both
         *  the multi-select toggle for Domain / void clicks and the
         *  ctrl+drag-from-Point duplicate gesture. */
        ctrl: boolean;
        /** True when the user held Ctrl (or Cmd) on mousedown over a
         *  Point — the eventual drag will spawn a duplicate + line. */
        duplicate: boolean;
        hitKind: "point" | "line" | null;
        /** Id of the Point the user pressed on, if any — needed to
         *  parameterise startDuplicateDrag at the drag-threshold
         *  moment. */
        hitPointId: string | null;
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
  // Slice-mode drag: the start point of the current slice while the
  // user holds the left button down. Non-null implies "actively
  // drawing a slice"; mouseup clears it (the committed slice lives in
  // reducer state). A new mousedown replaces the previous slice
  // immediately, so the old one disappears the moment the new drag
  // begins.
  const sliceDragRef = useRef<Vec2 | null>(null);
  // Shape-builder drag: holds the "first point" of the in-progress
  // shape (centre for circle, first corner for rect, corner Point id
  // for fillet) while the user holds the left button down. mouseup
  // clears it (the committed shape lives in the model).
  const shapeDragRef = useRef<
    | { kind: "circle" | "rect"; start: Vec2 }
    | { kind: "fillet"; cornerId: string; corner: Vec2 }
    | null
  >(null);

  const gridStep = gridStepForViewWidth(view.width);
  // gridStep is now ~viewWidth/60 (4× denser than the old visual). Keep
  // the click-target size in world units roughly where it used to be by
  // multiplying through — otherwise users would have to land snaps and
  // line-hovers inside a target ¼ the previous size.
  const snapRadius = gridStep * 4;
  const lineTolerance = gridStep * 0.6;
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
  // contribution. The solveStatsRef captures hit/miss/Gauss-eval
  // counts side-channel; we promote it to React state for the toolbar
  // via an effect below.
  //
  // StrictMode caveat: in dev React double-invokes useMemo callbacks
  // back-to-back with the same deps. The second invocation finds the
  // cache fully warm from the first → all hits → stats show 100%
  // cached. To avoid that misleading display, only let the FIRST
  // invocation per dep-change overwrite the displayed stats. The
  // double-invoke uses the same dep references, so a ref-equality
  // check catches it cleanly.
  const solveStatsRef = useRef<{ value?: SolveStats }>({});
  const lastSolveDepsRef = useRef<{
    mesh: readonly MeshElement[];
    mat: MaterialProperties;
  } | null>(null);
  const stableSolveStatsRef = useRef<SolveStats | null>(null);
  const solvedMesh = useMemo(() => {
    solveStatsRef.current = {};
    // Multi-zone: partition elements by Domain via the line → domain
    // map, solve each Domain independently with its own material, and
    // concatenate. Lines not belonging to any Domain (loose sketch
    // geometry) go through a final "default" solve with the model
    // material.
    //
    // INTERFACE CAVEAT — if any Line is referenced by Boundaries
    // belonging to MORE THAN ONE Domain (i.e. a multi-zone interface
    // produced by `subdivideDomainAlongInterface`), the current
    // independent-solve strategy is incorrect: each subdomain's
    // boundary integral excludes the other side's contributions and
    // the interface DOFs have no coupling. We detect that case here
    // and short-circuit with an empty mesh so the user gets no
    // results rather than wrong ones. Coupled multi-domain assembly
    // per the thesis §2.7 (u_I1 = u_I2, t_I1 = -t_I2) is on the
    // roadmap.
    const lineDomainCount = new Map<string, number>();
    const seenLineDomain = new Set<string>();
    for (const d of model.domains) {
      const boundariesById = new Map(
        model.boundaries.map((b) => [b.id, b]),
      );
      for (const bId of d.boundaryIds) {
        const b = boundariesById.get(bId);
        if (!b) continue;
        for (const seg of b.segments) {
          const key = `${seg.lineId}|${d.id}`;
          if (seenLineDomain.has(key)) continue;
          seenLineDomain.add(key);
          lineDomainCount.set(
            seg.lineId,
            (lineDomainCount.get(seg.lineId) ?? 0) + 1,
          );
        }
      }
    }
    let hasInterface = false;
    for (const c of lineDomainCount.values()) {
      if (c > 1) {
        hasInterface = true;
        break;
      }
    }
    const { lineDomainId, domainMaterial } = buildLineDomainMap(model);

    if (hasInterface) {
      // Multi-zone coupled BEM: each subdomain assembles over its full
      // boundary (interfaces included), and solveMultiDomain enforces
      // u_I1=u_I2, t_I1=-t_I2 at every shared-position node.
      const subdomainInputs = model.domains.map((d) => ({
        mesh: buildSubdomainMesh(model, d.id),
        material: domainMaterial.get(d.id) ?? material,
      }));
      const couplingStats: { value?: SolveStats } = {};
      const solvedPerDomain = solveMultiDomain(
        subdomainInputs,
        blockCacheRef.current,
        couplingStats,
      );
      // Interface lines appear in two subdomains' meshes, so the
      // concatenation contains both copies. Their displacement DOFs
      // agree (we enforced u_I^A = u_I^B in the coupling), so render
      // and downstream stages need only one element per (lineId,
      // indexInLine). Keep the first-encountered copy so each physical
      // interface element is drawn once. Tractions on the dropped copy
      // would be the sign-flipped side-B values — they're recoverable
      // from the side-A copy by negating, which the interior-stress
      // path will need when it gains per-Domain awareness.
      const seen = new Set<string>();
      const concatenated: MeshElement[] = [];
      for (const sm of solvedPerDomain) {
        for (const el of sm) {
          const key = `${el.lineId}|${el.indexInLine}`;
          if (seen.has(key)) continue;
          seen.add(key);
          concatenated.push(el);
        }
      }
      solveStatsRef.current = couplingStats;
      const prev = lastSolveDepsRef.current;
      const sameAsPrev =
        prev !== null && prev.mesh === meshElements && prev.mat === material;
      if (!sameAsPrev) {
        lastSolveDepsRef.current = { mesh: meshElements, mat: material };
        if (couplingStats.value) {
          const v = couplingStats.value;
          const noWork =
            v.assemble.misses === 0 && v.assemble.gaussEvals === 0;
          if (!noWork || stableSolveStatsRef.current === null) {
            stableSolveStatsRef.current = v;
          }
        }
      }
      return concatenated;
    }
    const elementsByDomain = new Map<string, MeshElement[]>();
    const loose: MeshElement[] = [];
    for (const el of meshElements) {
      const dId = lineDomainId.get(el.lineId);
      if (dId === undefined) {
        loose.push(el);
        continue;
      }
      const arr = elementsByDomain.get(dId);
      if (arr) arr.push(el);
      else elementsByDomain.set(dId, [el]);
    }

    const out: MeshElement[] = [];
    const aggStats: { value?: SolveStats } = {};
    // Mutable working accumulators (SolveStats fields are readonly,
    // so we collect into local mutables and snapshot at the end).
    let asmHits = 0;
    let asmMisses = 0;
    let asmGaussEvals = 0;
    let asmNodeCount = 0;
    let asmElementCount = 0;
    let unknownDofs = 0;
    const dofsByLineId = new Map<string, ReadonlySet<number>>();
    const dofsByElement = new Map<string, ReadonlySet<number>>();
    const nodePositions: Vec2[] = [];
    const elementsByNodeIndex = new Map<number, ReadonlySet<string>>();
    let mergedAny = false;
    const mergeStats = (s: SolveStats | undefined) => {
      if (!s) return;
      asmHits += s.assemble.hits;
      asmMisses += s.assemble.misses;
      asmGaussEvals += s.assemble.gaussEvals;
      asmNodeCount += s.assemble.nodeCount;
      asmElementCount += s.assemble.elementCount;
      unknownDofs += s.unknownDofs;
      for (const [k, v] of s.dofsByLineId) dofsByLineId.set(k, v);
      for (const [k, v] of s.dofsByElement) dofsByElement.set(k, v);
      for (const p of s.nodePositions) nodePositions.push(p);
      for (const [k, v] of s.elementsByNodeIndex)
        elementsByNodeIndex.set(k, v);
      mergedAny = true;
    };

    for (const [dId, elements] of elementsByDomain) {
      const mat = domainMaterial.get(dId) ?? material;
      const localStats: { value?: SolveStats } = {};
      const solved = solve(elements, mat, blockCacheRef.current, localStats);
      out.push(...solved);
      mergeStats(localStats.value);
    }
    if (loose.length > 0) {
      const localStats: { value?: SolveStats } = {};
      const solved = solve(loose, material, blockCacheRef.current, localStats);
      out.push(...solved);
      mergeStats(localStats.value);
    }

    if (mergedAny) {
      aggStats.value = {
        assemble: {
          hits: asmHits,
          misses: asmMisses,
          gaussEvals: asmGaussEvals,
          nodeCount: asmNodeCount,
          elementCount: asmElementCount,
        },
        unknownDofs,
        dofsByLineId,
        dofsByElement,
        nodePositions,
        elementsByNodeIndex,
      };
    }
    solveStatsRef.current = aggStats;
    const prev = lastSolveDepsRef.current;
    const sameAsPrev =
      prev !== null && prev.mesh === meshElements && prev.mat === material;
    if (!sameAsPrev) {
      lastSolveDepsRef.current = { mesh: meshElements, mat: material };
      if (aggStats.value) {
        const v = aggStats.value;
        const noWork = v.assemble.misses === 0 && v.assemble.gaussEvals === 0;
        if (!noWork || stableSolveStatsRef.current === null) {
          stableSolveStatsRef.current = v;
        }
      }
    }
    return out;
  }, [meshElements, material, model]);

  // Promote the solver's latest stats into React state so the toolbar
  // re-renders with the new counts. useState + effect keeps the
  // toolbar reactive without coupling the BEM solve to React internals.
  const [solveStats, setSolveStats] = useState<SolveStats | null>(null);
  useEffect(() => {
    if (stableSolveStatsRef.current) {
      setSolveStats(stableSolveStatsRef.current);
    }
  }, [solvedMesh]);

  // For the matrix view: turn the line selection into a set of global
  // DOF indices (rows in H/G/u/t) that should get highlighted. The
  // solve exposes a lineId → DOF-set map; we just union over the
  // selected lines.
  const matrixHighlightedDofs = useMemo<ReadonlySet<number>>(() => {
    if (!solveStats) return new Set<number>();
    const out = new Set<number>();
    for (const item of selection) {
      if (item.kind !== "line") continue;
      const dofs = solveStats.dofsByLineId.get(item.id);
      if (!dofs) continue;
      for (const d of dofs) out.add(d);
    }
    return out;
  }, [selection, solveStats]);

  // Hovering a mesh element narrows the matrix highlight to JUST that
  // element's 6 DOFs. When a hovered key is present, the orange "hover"
  // set displaces the yellow line-selection set on the matrix view.
  const matrixHoveredDofs = useMemo<ReadonlySet<number>>(() => {
    if (!solveStats || hoveredElementKey === null) {
      return new Set<number>();
    }
    return solveStats.dofsByElement.get(hoveredElementKey) ?? new Set();
  }, [hoveredElementKey, solveStats]);

  // Standard line/boundary/domain selection → set of element keys, used
  // by the Equations panel to drive per-element submatrices and by the
  // boundary kernel plot to draw highlight bands. Boundaries expand to
  // their constituent lines; domains expand to their boundaries' lines.
  const selectedElementKeys = useMemo<ReadonlySet<string>>(() => {
    const lineIds = new Set<string>();
    for (const item of selection) {
      if (item.kind === "line") {
        lineIds.add(item.id);
      } else if (item.kind === "boundary") {
        const b = model.boundaries.find((bb) => bb.id === item.id);
        if (b) for (const seg of b.segments) lineIds.add(seg.lineId);
      } else if (item.kind === "domain") {
        const d = model.domains.find((dd) => dd.id === item.id);
        if (d) {
          for (const bId of d.boundaryIds) {
            const b = model.boundaries.find((bb) => bb.id === bId);
            if (b) for (const seg of b.segments) lineIds.add(seg.lineId);
          }
        }
      }
    }
    const keys = new Set<string>();
    for (const el of meshElements) {
      if (lineIds.has(el.lineId)) {
        keys.add(`${el.lineId}|${el.indexInLine}`);
      }
    }
    return keys;
  }, [selection, model.boundaries, model.domains, meshElements]);

  // Reverse hover from the matrix view — translates a DOF index to
  // its global node position + the set of elements that contain that
  // node. Computed for both the row DOF (cursor Y) and the col DOF
  // (cursor X on H or G). The canvas overlay below draws each as a
  // separate ring + element-stroke group so the user can read the
  // matrix entry as "this row's node connects to this col's node
  // via the Kelvin kernel".
  type ReverseHover = {
    nodePos: Vec2 | null;
    elementKeys: ReadonlySet<string>;
    axis: 0 | 1 | null;
  };
  const emptyReverseHover: ReverseHover = {
    nodePos: null,
    elementKeys: new Set(),
    axis: null,
  };
  const lookupReverseHover = (dof: number | null): ReverseHover => {
    if (!solveStats || dof === null) return emptyReverseHover;
    const nodeIdx = Math.floor(dof / 2);
    const axis = (dof & 1) as 0 | 1;
    const pos = solveStats.nodePositions[nodeIdx] ?? null;
    const els = solveStats.elementsByNodeIndex.get(nodeIdx) ?? new Set();
    return { nodePos: pos, elementKeys: els, axis };
  };
  const reverseHoverRow = useMemo(
    () => lookupReverseHover(hoveredMatrixRow),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hoveredMatrixRow, solveStats],
  );
  const reverseHoverCol = useMemo(
    () => lookupReverseHover(hoveredMatrixCol),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hoveredMatrixCol, solveStats],
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

  /** Polygons (outer + holes) per Domain, so the canvas can render
   *  a hover-highlight on the Domain under the cursor and the zone
   *  chip can classify the cursor position without rebuilding
   *  polygons every mousemove. */
  const domainPolygons = useMemo(() => buildDomainPolygons(model), [model]);

  /** Zone classification at the cursor: which Domain (if any) holds
   *  it, or which hole / external void it sits in. Drives the
   *  highlight + the toolbar chip + the convert-hole-to-zone action. */
  const hoverContext: HoverContext | null = useMemo(
    () => detectHoverContext(cursorWorld, model),
    [cursorWorld, model],
  );

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
  /** Geometry Points whose adjacent BEM elements have a tangent
   *  discontinuity wider than ~5° — i.e. real corners as opposed to
   *  smooth meeting Points (like the four arc joins on a hole circle).
   *  Used by `internalNodes` to push the first-ring offset further from
   *  corner-adjacent elements (so interior nodes don't land in the
   *  two-element nearly-singular zone of the Somigliana stress kernels)
   *  and by `interiorStresses` to choose between boundaryStress (smooth
   *  side) and a generic boundary-vertex evaluation. */
  const sharpCorners: readonly Vec2[] = useMemo(() => {
    if (meshElements.length === 0) return [];
    const POS_EPS = 1e-6;
    const ptKey = (x: number, y: number) =>
      `${Math.round(x / POS_EPS)}|${Math.round(y / POS_EPS)}`;
    const SHARP_DOT_MAX = -Math.cos((5 * Math.PI) / 180); // ≈ -0.9962

    // Quadratic-element tangent (chord vector in η direction):
    //   start (η=-1):  -1.5 a0 + 2 a1 - 0.5 a2
    //   end   (η=+1):   0.5 a0 - 2 a1 + 1.5 a2
    // We flip the end-tangent so all tangents point *into* the
    // element interior, away from the touching Point. For a smooth
    // boundary the two tangents at the meeting Point are antiparallel
    // (dot ≈ -1); a sharp corner deviates from antiparallel.
    const incidentTangents = new Map<
      string,
      { tx: number; ty: number }[]
    >();
    const pushTangent = (k: string, tx: number, ty: number) => {
      const m = Math.hypot(tx, ty);
      if (m === 0) return;
      const t = { tx: tx / m, ty: ty / m };
      const list = incidentTangents.get(k);
      if (list) list.push(t);
      else incidentTangents.set(k, [t]);
    };
    for (const el of meshElements) {
      const a0 = el.anchors[0];
      const a1 = el.anchors[1];
      const a2 = el.anchors[2];
      pushTangent(
        ptKey(a0.x, a0.y),
        -1.5 * a0.x + 2 * a1.x - 0.5 * a2.x,
        -1.5 * a0.y + 2 * a1.y - 0.5 * a2.y,
      );
      pushTangent(
        ptKey(a2.x, a2.y),
        -(0.5 * a0.x - 2 * a1.x + 1.5 * a2.x),
        -(0.5 * a0.y - 2 * a1.y + 1.5 * a2.y),
      );
    }

    const out: Vec2[] = [];
    for (const p of model.points) {
      const tans = incidentTangents.get(ptKey(p.x, p.y));
      if (!tans || tans.length < 2) continue;
      let sharp = false;
      for (let i = 0; i < tans.length && !sharp; i++) {
        for (let j = i + 1; j < tans.length && !sharp; j++) {
          const dot =
            tans[i]!.tx * tans[j]!.tx + tans[i]!.ty * tans[j]!.ty;
          if (dot > SHARP_DOT_MAX) sharp = true;
        }
      }
      if (sharp) out.push({ x: p.x, y: p.y });
    }
    return out;
  }, [meshElements, model.points]);

  /**  Filters per candidate:
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
    // Elements touching a sharp-tangent geometry Point (e.g. a 90°
    // corner) get pushed further so first-ring candidates don't land
    // in the two-element nearly-singular zone of the Somigliana stress
    // kernels. 0.6 sits well outside the worst-case 1/r² peak from
    // perpendicular neighbour elements while still giving us a vertex
    // in the first ring for the contour to interpolate against.
    const FIRST_RING_FACTOR_AT_CORNER = 0.6;
    const RING_GROWTH = 2.0;
    const CLUSTER_FACTOR = 0.5;
    const MAX_RINGS = 12;
    const POS_EPS = 1e-6;
    const ptKey = (x: number, y: number) =>
      `${Math.round(x / POS_EPS)}|${Math.round(y / POS_EPS)}`;
    const sharpKeys = new Set(
      sharpCorners.map((c) => ptKey(c.x, c.y)),
    );

    // Accept the candidate if it sits inside the material region of
    // ANY Domain (inside that Domain's CCW outer AND not inside any
    // of its CW holes). Multi-zone: an inner Domain's outer would be
    // a hole of the outer Domain; checking per-Domain keeps wave-
    // front seed points inside inner zones.
    const isInDomain = (p: Vec2): boolean => {
      for (const dp of domainPolygons.values()) {
        if (!pointInPolygon(p, dp.outer)) continue;
        let inHole = false;
        for (const hole of dp.holes) {
          if (pointInPolygon(p, hole)) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
      return false;
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

        const a0 = el.anchors[0];
        const a1 = el.anchors[1];
        const a2 = el.anchors[2];
        const touchesSharp =
          sharpKeys.has(ptKey(a0.x, a0.y)) ||
          sharpKeys.has(ptKey(a2.x, a2.y));
        const baseFactor = touchesSharp
          ? FIRST_RING_FACTOR_AT_CORNER
          : FIRST_RING_FACTOR;
        const r = baseFactor * L * Math.pow(RING_GROWTH, k - 1);
        const cluster = CLUSTER_FACTOR * r;
        const cluster2 = cluster * cluster;
        const pattern = isOdd ? oddEtas(el.localNodes) : evenEtas(el.localNodes);

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
  }, [meshElements, model.points, boundaryPolygons, domainPolygons, sharpCorners]);

  /** Delaunay triangulation of (boundary BEM nodes + corner Points +
   *  interior nodes), filtered to keep only triangles whose centroid
   *  lies inside the domain. */
  const internalTriangles = useMemo(() => {
    if (!boundaryPolygons) return null;
    // Collect all point positions, dedup by quantised key. We also
    // record which vertices sit on Γ and via which (elementIdx, η)
    // they can be evaluated — interiorStresses uses that to call
    // boundaryStress (Kelvin recovery from traction + tangential
    // strain) instead of the near-singular Somigliana integrand. The
    // map is keyed by the triangulation vertex index.
    const POS_EPS = 1e-6;
    const ptKey = (x: number, y: number) =>
      `${Math.round(x / POS_EPS)}|${Math.round(y / POS_EPS)}`;
    const indexByKey = new Map<string, number>();
    const pts: Vec2[] = [];
    const boundaryInfo = new Map<
      number,
      { elementIdx: number; eta: number }
    >();
    const addPt = (
      p: Vec2,
      info?: { elementIdx: number; eta: number },
    ) => {
      const k = ptKey(p.x, p.y);
      const existing = indexByKey.get(k);
      if (existing !== undefined) {
        // First owner wins. Multiple BEM nodes never coincide under
        // the discontinuous default, but corner Points may match a
        // continuous-scheme node at η = ±1 — keep the first mapping.
        if (info && !boundaryInfo.has(existing)) {
          boundaryInfo.set(existing, info);
        }
        return;
      }
      const idx = pts.length;
      indexByKey.set(k, idx);
      pts.push(p);
      if (info) boundaryInfo.set(idx, info);
    };
    for (let ei = 0; ei < meshElements.length; ei++) {
      const el = meshElements[ei]!;
      for (let nk = 0; nk < 3; nk++) {
        const n = el.nodes[nk]!;
        addPt(
          { x: n.x, y: n.y },
          { elementIdx: ei, eta: el.localNodes[nk]! },
        );
      }
    }
    // Geometry corner Points. Under the discontinuous scheme these
    // are NOT BEM nodes; we map each to the η = +1 end of an element
    // that ends here (or η = -1 of an element that starts here).
    // boundaryStress evaluated at those η-values gives the recovered
    // tangential-strain stress at the corner from one side — exactly
    // what the edge-profile plot already uses.
    const endAtPoint = new Map<string, number>();
    const startAtPoint = new Map<string, number>();
    for (let ei = 0; ei < meshElements.length; ei++) {
      const el = meshElements[ei]!;
      endAtPoint.set(
        ptKey(el.anchors[2].x, el.anchors[2].y),
        ei,
      );
      startAtPoint.set(
        ptKey(el.anchors[0].x, el.anchors[0].y),
        ei,
      );
    }
    for (const p of model.points) {
      const k = ptKey(p.x, p.y);
      const eiEnd = endAtPoint.get(k);
      if (eiEnd !== undefined) {
        addPt({ x: p.x, y: p.y }, { elementIdx: eiEnd, eta: 1 });
        continue;
      }
      const eiStart = startAtPoint.get(k);
      if (eiStart !== undefined) {
        addPt({ x: p.x, y: p.y }, { elementIdx: eiStart, eta: -1 });
        continue;
      }
      // Orphan Point not on any boundary element (rare; pre-boundary
      // sketching state). Add as a plain interior vertex.
      addPt({ x: p.x, y: p.y });
    }
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
    // Build a list of all Domain polygons so the centroid-in-polygon
    // test keeps any triangle inside ANY Domain's material region.
    // Multi-zone case: an inner Domain's outer is a hole of the outer
    // Domain — the old single-Domain check would drop those triangles
    // (treat the inner zone as hole). Iterating per-Domain instead
    // keeps triangles whose centroid is inside an outer of one Domain
    // AND not inside any hole of that same Domain.
    const domainPolyEntries = Array.from(domainPolygons.values());
    for (let t = 0; t < d.triangles.length; t += 3) {
      const a = d.triangles[t]!;
      const b = d.triangles[t + 1]!;
      const c = d.triangles[t + 2]!;
      const pa = pts[a]!;
      const pb = pts[b]!;
      const pc = pts[c]!;
      const cx = (pa.x + pb.x + pc.x) / 3;
      const cy = (pa.y + pb.y + pc.y) / 3;
      const centroid = { x: cx, y: cy };
      let inAnyMaterial = false;
      for (const poly of domainPolyEntries) {
        if (!pointInPolygon(centroid, poly.outer)) continue;
        let inHole = false;
        for (const h of poly.holes) {
          if (pointInPolygon(centroid, h)) {
            inHole = true;
            break;
          }
        }
        if (!inHole) {
          inAnyMaterial = true;
          break;
        }
      }
      if (!inAnyMaterial) continue;
      tris.push({ a, b, c });
    }
    return { points: pts, triangles: tris, boundaryInfo };
  }, [
    meshElements,
    model.points,
    internalNodes,
    boundaryPolygons,
    domainPolygons,
  ]);

  /** True when the active field needs the full Cartesian stress tensor
   *  at every vertex (cheap algebra on top derives σvm, σ1, σ2, τmax). */
  const stressActive =
    interiorField === "sxx" ||
    interiorField === "syy" ||
    interiorField === "sxy" ||
    interiorField === "svm" ||
    interiorField === "s1" ||
    interiorField === "s2" ||
    interiorField === "tmax" ||
    interiorField === "scf";

  /** Per-vertex Cartesian stress, lazily evaluated. We only pay the
   *  per-point Somigliana stress integral when a stress-derived field
   *  is selected; switching between σxx/σyy/τxy/σvm/σ1/σ2/τmax reuses
   *  this memo.
   *
   *  Boundary handling: D* ~ 1/r and S* ~ 1/r² blow up when the
   *  evaluation point sits on Γ, so triangulation vertices that
   *  coincide with a BEM node OR a geometry Point would read garbage
   *  out of the Somigliana integrand. Those vertices are evaluated
   *  via `boundaryStress` instead (Kelvin recovery from boundary
   *  traction + tangential strain — same machinery the edge-profile
   *  plot uses, no near-singular kernels).
   *
   *  Sharp-corner near-singular zone: the first ring of interior
   *  nodes around a 90° corner would otherwise sit inside the
   *  combined nearly-singular zone of TWO perpendicular boundary
   *  elements. `internalNodes` pushes the first ring further out at
   *  corner-adjacent elements (FIRST_RING_FACTOR_AT_CORNER), so by
   *  the time we get here the Somigliana evaluation already has
   *  enough room to be accurate. No post-hoc averaging needed. */
  const interiorStresses: readonly StressTriple[] | null = useMemo(() => {
    if (!stressActive || !internalTriangles || solvedMesh.length === 0) {
      return null;
    }
    const N = internalTriangles.points.length;
    const out: StressTriple[] = new Array(N);
    // boundaryInfo.elementIdx is an index into the *unsolved*
    // meshElements array (built once and stable). solvedMesh, on the
    // other hand, is the multi-domain solve result — concatenated and
    // deduplicated by (lineId, indexInLine) — so its array indexing
    // differs. Build a (lineId, indexInLine) → solved element map for
    // robust lookup. For the single-domain happy path it's just a
    // 1:1 mirror of solvedMesh.
    const solvedByKey = new Map<string, MeshElement>();
    for (const el of solvedMesh) {
      solvedByKey.set(`${el.lineId}|${el.indexInLine}`, el);
    }
    for (let i = 0; i < N; i++) {
      const info = internalTriangles.boundaryInfo.get(i);
      if (info !== undefined) {
        const unsolved = meshElements[info.elementIdx];
        const solved = unsolved
          ? solvedByKey.get(`${unsolved.lineId}|${unsolved.indexInLine}`)
          : undefined;
        if (solved) {
          // On Γ — use the Kelvin boundary recovery for an exact value
          // (matches the edge-profile plot).
          out[i] = boundaryStress(solved, info.eta, material);
          continue;
        }
      }
      // Interior or no solved match — Somigliana stress identity.
      out[i] = interiorStress(
        internalTriangles.points[i]!,
        solvedMesh,
        material,
      );
    }
    return out;
  }, [stressActive, internalTriangles, solvedMesh, material, meshElements]);

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
    // SCF denominator: max applied traction magnitude. Zero ⇒ no
    // traction BCs ⇒ SCF undefined; we return null below in that case.
    const sigmaRef = interiorField === "scf" ? referenceStress(model) : 0;
    if (interiorField === "scf" && sigmaRef === 0) return null;
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
        case "scf": {
          const szz = planeStrain ? nu * (sxx + syy) : 0;
          const svm = Math.sqrt(
            0.5 *
              ((sxx - syy) ** 2 +
                (syy - szz) ** 2 +
                (szz - sxx) ** 2 +
                6 * sxy * sxy),
          );
          v = svm / sigmaRef;
          break;
        }
        default:
          v = NaN;
      }
      out[i] = Number.isFinite(v) ? v : 0;
    }
    return out;
  }, [internalTriangles, solvedMesh, interiorField, interiorStresses, material, model]);

  /** Actual min, max + the symmetric range used by the colour scale.
   *  The range spans the true data extreme so the top/bottom legend
   *  labels match observed peaks (e.g. Kt ≈ 3 on a plate-with-hole).
   *  The boundary-vertex neighbour-averaging mask in `interiorStresses`
   *  already suppresses the near-singular kernel spike that would
   *  otherwise pin the scale. */
  const interiorFieldStats: FieldStats | null = useMemo(() => {
    if (!interiorFieldValues || interiorFieldValues.length === 0) return null;
    if (interiorField === null) return null;
    const positive = isPositiveOnlyField(interiorField);

    let min = Infinity;
    let max = -Infinity;
    let count = 0;
    for (const v of interiorFieldValues) {
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      count++;
    }
    if (count === 0) return null;

    // Range for the colour scale:
    //   diverging fields → max(|min|, |max|), symmetric ±range
    //   positive-only    → max, scale runs 0..range
    const range = positive ? max : Math.max(Math.abs(min), Math.abs(max));
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

    // SCF denominator. Zero ⇒ no traction BCs ⇒ SCF undefined.
    const sigmaRef = interiorField === "scf" ? referenceStress(model) : 0;
    if (interiorField === "scf" && sigmaRef === 0) return null;

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

    const curveByLine: {
      lineId: string;
      arc: number;
      value: number;
      x: number;
      y: number;
    }[][] = [];
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
      const segCurve: {
        lineId: string;
        arc: number;
        value: number;
        x: number;
        y: number;
      }[] = [];
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
            sigmaRef,
          );
          segCurve.push({ lineId, arc: arcOffset, value, x, y });
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
            sigmaRef,
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
  }, [selection, interiorField, solvedMesh, material, model]);

  /** Profile of the active interior field along the user's slice
   *  line. Dense uniform sampling along the parametric line, with
   *  samples that fall outside the domain (or inside a hole) snapped
   *  to value = 0. The single curveByLine entry preserves the
   *  vertical "step to zero" the user expects when the slice crosses
   *  a hole — interior values plunge to 0 at the hole boundary, sit
   *  at 0 across the hole, and jump back up on exit. */
  const sliceProfile: EdgeProfile | null = useMemo(() => {
    if (!state.slice || !interiorField || solvedMesh.length === 0) return null;
    if (!boundaryPolygons) return null;

    const start = state.slice.start;
    const end = state.slice.end;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const totalArc = Math.hypot(dx, dy);
    if (totalArc < 1e-12) return null;

    const planeStrain = material.planeKind === "strain";
    const nu = material.nu;
    const sigmaRef = interiorField === "scf" ? referenceStress(model) : 0;
    // SCF with no traction BCs → undefined; bail.
    if (interiorField === "scf" && sigmaRef === 0) return null;

    const inDomain = (p: Vec2): boolean => {
      if (!pointInPolygon(p, boundaryPolygons.outer)) return false;
      for (const h of boundaryPolygons.holes) {
        if (pointInPolygon(p, h)) return false;
      }
      return true;
    };

    // Reduce a stress triple to the active scalar field.
    const stressScalar = (s: { sxx: number; syy: number; sxy: number }): number => {
      switch (interiorField) {
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
          const szz = planeStrain ? nu * (s.sxx + s.syy) : 0;
          return Math.sqrt(
            0.5 *
              ((s.sxx - s.syy) ** 2 +
                (s.syy - szz) ** 2 +
                (szz - s.sxx) ** 2 +
                6 * s.sxy * s.sxy),
          );
        }
        case "scf": {
          const szz = planeStrain ? nu * (s.sxx + s.syy) : 0;
          const svm = Math.sqrt(
            0.5 *
              ((s.sxx - s.syy) ** 2 +
                (s.syy - szz) ** 2 +
                (szz - s.sxx) ** 2 +
                6 * s.sxy * s.sxy),
          );
          return svm / sigmaRef;
        }
        default:
          return NaN;
      }
    };

    // Near-boundary threshold. Samples within this radius of any BEM
    // element chord get evaluated via Kelvin boundary recovery
    // (boundaryStress / shape-function-interp of nodal DOFs) instead
    // of the nearly-singular Somigliana integrand. Matches the same
    // mesh-scale heuristic the internalNodes ring-offset uses.
    let minChord = Infinity;
    for (const el of solvedMesh) {
      const a0 = el.anchors[0];
      const a2 = el.anchors[2];
      const c = Math.hypot(a2.x - a0.x, a2.y - a0.y);
      if (c > 0 && c < minChord) minChord = c;
    }
    const NEAR_BOUNDARY_FACTOR = 0.25;
    const nearEps = Number.isFinite(minChord)
      ? NEAR_BOUNDARY_FACTOR * minChord
      : 0;
    const nearEpsSq = nearEps * nearEps;

    /** If `p` is within nearEps of any BEM element chord, return the
     *  closest element and the chord-projected η. Otherwise null. */
    const nearestBoundary = (
      p: Vec2,
    ): { elementIdx: number; eta: number } | null => {
      let bestSq = nearEpsSq;
      let bestIdx = -1;
      let bestT = 0;
      for (let ei = 0; ei < solvedMesh.length; ei++) {
        const el = solvedMesh[ei]!;
        const a = el.anchors[0];
        const b = el.anchors[2];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const lenSq = ex * ex + ey * ey;
        if (lenSq === 0) continue;
        let t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / lenSq;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const cx = a.x + t * ex;
        const cy = a.y + t * ey;
        const dx2 = p.x - cx;
        const dy2 = p.y - cy;
        const sq = dx2 * dx2 + dy2 * dy2;
        if (sq < bestSq) {
          bestSq = sq;
          bestIdx = ei;
          bestT = t;
        }
      }
      if (bestIdx < 0) return null;
      return { elementIdx: bestIdx, eta: -1 + 2 * bestT };
    };

    const evalAt = (p: Vec2): number => {
      const nb = nearestBoundary(p);
      if (interiorField === "ux" || interiorField === "uy") {
        if (nb) {
          const el = solvedMesh[nb.elementIdx]!;
          const Nf = shapeFunctions(nb.eta, el.localNodes);
          const v0 = interiorField === "ux" ? el.nodes[0].ux : el.nodes[0].uy;
          const v1 = interiorField === "ux" ? el.nodes[1].ux : el.nodes[1].uy;
          const v2 = interiorField === "ux" ? el.nodes[2].ux : el.nodes[2].uy;
          return Nf[0] * v0 + Nf[1] * v1 + Nf[2] * v2;
        }
        const u = interiorDisplacement(p, solvedMesh, material);
        return interiorField === "ux" ? u.x : u.y;
      }
      const s = nb
        ? boundaryStress(solvedMesh[nb.elementIdx]!, nb.eta, material)
        : interiorStress(p, solvedMesh, material);
      return stressScalar(s);
    };

    // 200 samples gives a sharp visual step at hole boundaries (~one
    // sample wide) without making interiorStress dominate render
    // time. Scale up if you want finer steps; this is plenty for the
    // current example sizes.
    const SAMPLES = 200;
    const curve: {
      lineId: string;
      arc: number;
      value: number;
      x: number;
      y: number;
    }[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      const arc = t * totalArc;
      const p: Vec2 = { x: start.x + t * dx, y: start.y + t * dy };
      const v = inDomain(p) ? evalAt(p) : 0;
      curve.push({
        lineId: "slice",
        arc,
        value: Number.isFinite(v) ? v : 0,
        x: p.x,
        y: p.y,
      });
    }

    return {
      field: interiorField,
      totalArc,
      curveByLine: [curve],
      nodes: [],
      segments: [
        {
          lineId: "slice",
          startArc: 0,
          endArc: totalArc,
          startPoint: start,
          endPoint: end,
        },
      ],
    };
  }, [state.slice, interiorField, solvedMesh, material, model, boundaryPolygons]);

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
    const paths: {
      kind: "bounded" | "unbounded";
      d: string;
      domainId: string;
    }[] = [];

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
          paths.push({
            kind: "bounded",
            d: subs.join(" "),
            domainId: domain.id,
          });
        }
      } else {
        // Unbounded: bands for every member boundary's lines.
        const bandSubs: string[] = [];
        for (const b of members) {
          const bands = bandFor(b.segments);
          if (bands) bandSubs.push(bands);
        }
        if (bandSubs.length > 0) {
          paths.push({
            kind: "unbounded",
            d: bandSubs.join(" "),
            domainId: domain.id,
          });
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

      // Slice mode takes over the left-mouse gesture: mousedown
      // starts a new slice (replacing any previous one immediately),
      // mousemove updates the endpoint, mouseup commits.
      if (stateRef.current.sliceMode) {
        const start = clientToWorld(svg, view, e.clientX, e.clientY);
        sliceDragRef.current = start;
        dispatch({
          type: "setSlice",
          slice: { start, end: start },
        });
        e.preventDefault();
        return;
      }

      // Shape-builder modes also take over the left-mouse gesture.
      const sm = stateRef.current.shapeMode;
      if (sm !== null) {
        const downWorld = clientToWorld(svg, view, e.clientX, e.clientY);
        if (sm === "circle") {
          // Snap centre to grid for tidy radii / coords.
          const snapped: Vec2 = {
            x: Math.round(downWorld.x / gridStep) * gridStep,
            y: Math.round(downWorld.y / gridStep) * gridStep,
          };
          shapeDragRef.current = { kind: "circle", start: snapped };
          dispatch({
            type: "setShapeDraft",
            draft: { kind: "circle", centre: snapped, edge: snapped },
          });
          e.preventDefault();
          return;
        }
        if (sm === "rect") {
          const snapped: Vec2 = {
            x: Math.round(downWorld.x / gridStep) * gridStep,
            y: Math.round(downWorld.y / gridStep) * gridStep,
          };
          shapeDragRef.current = { kind: "rect", start: snapped };
          dispatch({
            type: "setShapeDraft",
            draft: { kind: "rect", c1: snapped, c2: snapped },
          });
          e.preventDefault();
          return;
        }
        if (sm === "fillet") {
          // Fillet target picking: only Point hits matter; clicks on
          // empty / lines are no-ops.
          const hit = hitTest(stateRef.current.model, makeCtx(downWorld));
          if (hit.entity?.kind === "point") {
            const pt = stateRef.current.model.points.find(
              (p) => p.id === hit.entity!.id,
            );
            if (pt) {
              shapeDragRef.current = {
                kind: "fillet",
                cornerId: pt.id,
                corner: { x: pt.x, y: pt.y },
              };
              dispatch({
                type: "setShapeDraft",
                draft: { kind: "fillet", cornerId: pt.id, radius: 0 },
              });
              e.preventDefault();
              return;
            }
          }
          // Picking didn't land on a Point — fall through? Better to
          // just swallow so the user doesn't accidentally start a
          // marquee / drag while in fillet mode.
          e.preventDefault();
          return;
        }
      }

      const now = performance.now();
      const last = lastDownRef.current;
      const isDoubleClick =
        last !== null &&
        now - last.time < DOUBLE_CLICK_WINDOW_MS &&
        Math.hypot(e.clientX - last.clientX, e.clientY - last.clientY) <
          DOUBLE_CLICK_RADIUS_PX;

      const downCursor = clientToWorld(svg, view, e.clientX, e.clientY);
      const hit = hitTest(stateRef.current.model, makeCtx(downCursor));
      const hitPointId =
        hit.entity?.kind === "point" ? hit.entity.id : null;
      downStateRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        moved: false,
        wasDoubleClick: isDoubleClick,
        shift: e.shiftKey,
        ctrl: e.ctrlKey || e.metaKey,
        duplicate: (e.ctrlKey || e.metaKey) && hitPointId !== null,
        hitKind: hit.entity?.kind ?? null,
        hitPointId,
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

      // Slice-mode drag: stretch the active slice's endpoint to the
      // current cursor. Skip everything else (no selection / matrix /
      // equations hover work fires while drawing a slice).
      if (sliceDragRef.current !== null) {
        dispatch({
          type: "setSlice",
          slice: { start: sliceDragRef.current, end: world },
        });
        return;
      }

      // Shape-builder drag: update the draft (rect's second corner,
      // circle's edge point, or fillet's radius — derived from the
      // distance to the picked corner Point).
      const sd = shapeDragRef.current;
      if (sd !== null) {
        if (sd.kind === "rect") {
          const snapped: Vec2 = {
            x: Math.round(world.x / gridStep) * gridStep,
            y: Math.round(world.y / gridStep) * gridStep,
          };
          dispatch({
            type: "setShapeDraft",
            draft: { kind: "rect", c1: sd.start, c2: snapped },
          });
        } else if (sd.kind === "circle") {
          dispatch({
            type: "setShapeDraft",
            draft: { kind: "circle", centre: sd.start, edge: world },
          });
        } else if (sd.kind === "fillet") {
          const r = Math.hypot(world.x - sd.corner.x, world.y - sd.corner.y);
          dispatch({
            type: "setShapeDraft",
            draft: { kind: "fillet", cornerId: sd.cornerId, radius: r },
          });
        }
        return;
      }

      // Mesh-element hover, for the matrix view. We only compute when
      // the matrix view is on (otherwise it's wasted work — no UI
      // consumer). Hit-test against each element's chord; pick the
      // closest within lineTolerance. setState only fires on a CHANGE
      // of the hovered element, so mousemove spam doesn't cause a
      // re-render storm.
      if (matrixVisible) {
        let bestKey: string | null = null;
        let bestSq = lineTolerance * lineTolerance;
        for (const el of meshElements) {
          const a = el.anchors[0];
          const b = el.anchors[2];
          const sq = pointToSegmentSq(world, a, b);
          if (sq < bestSq) {
            bestSq = sq;
            bestKey = `${el.lineId}|${el.indexInLine}`;
          }
        }
        if (bestKey !== hoveredElementKeyRef.current) {
          hoveredElementKeyRef.current = bestKey;
          setHoveredElementKey(bestKey);
        }
      }

      // Equations-mode hover: only previews nearest mesh node within
      // snap radius. Non-node hits fall through to normal selection,
      // so the user picks elements via the regular line/boundary
      // selection mechanism.
      if (equationsVisible) {
        const nodePositions = solveStats?.nodePositions ?? [];
        let bestNodeIdx = -1;
        let bestNodeSq = snapRadius * snapRadius;
        for (let i = 0; i < nodePositions.length; i++) {
          const p = nodePositions[i]!;
          const dx = world.x - p.x;
          const dy = world.y - p.y;
          const sq = dx * dx + dy * dy;
          if (sq < bestNodeSq) {
            bestNodeSq = sq;
            bestNodeIdx = i;
          }
        }
        if (bestNodeIdx >= 0) {
          const pos = nodePositions[bestNodeIdx]!;
          setEquationsHover((prev) =>
            prev && prev.nodeIdx === bestNodeIdx
              ? prev
              : { kind: "node", nodeIdx: bestNodeIdx, pos },
          );
        } else {
          setEquationsHover((prev) => (prev === null ? prev : null));
        }
      }

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
            } else if (down.duplicate && down.hitPointId !== null) {
              // Ctrl/Cmd + drag from a Point → spawn a duplicate and
              // drag it. Trails a connecting Line back to the original.
              dispatch({
                type: "startDuplicateDrag",
                originalPointId: down.hitPointId,
                cursorOrigin: startWorld,
              });
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
        // Snap the dragged cursor to existing non-dragged Points so
        // drops onto coincidence are easy. The merge-on-drop logic in
        // applyEndDrag turns the perfect coincidence into a single
        // shared Point. Falls back to grid-snap when no Point is
        // within reach.
        const draggedIds = liveSession.originalPositions;
        const candidates = stateRef.current.model.points.filter(
          (p) => !draggedIds.has(p.id),
        );
        const snap = snapWorld(world, candidates, gridStep, snapRadius);
        dispatch({ type: "dragTo", cursor: snap.snapped });
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
    [
      view,
      model.points,
      gridStep,
      snapRadius,
      makeCtx,
      marquee,
      matrixVisible,
      meshElements,
      lineTolerance,
      equationsVisible,
      solveStats,
    ],
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

      // Slice-mode mouseup: keep the slice as-is (it was being kept in
      // sync on every mousemove). If start == end (no drag — pure
      // click), drop it; otherwise leave it in place for the Results
      // panel to plot.
      if (sliceDragRef.current !== null) {
        const start = sliceDragRef.current;
        sliceDragRef.current = null;
        const dx = cursor.x - start.x;
        const dy = cursor.y - start.y;
        if (dx * dx + dy * dy < 1e-12) {
          dispatch({ type: "setSlice", slice: null });
        }
        return;
      }

      // Shape-builder mouseup: commit via the appropriate action.
      const sd = shapeDragRef.current;
      if (sd !== null) {
        shapeDragRef.current = null;
        if (sd.kind === "rect") {
          const snapped: Vec2 = {
            x: Math.round(cursor.x / gridStep) * gridStep,
            y: Math.round(cursor.y / gridStep) * gridStep,
          };
          dispatch({
            type: "commitRectangle",
            c1: sd.start,
            c2: snapped,
          });
        } else if (sd.kind === "circle") {
          const r = Math.hypot(
            cursor.x - sd.start.x,
            cursor.y - sd.start.y,
          );
          dispatch({
            type: "commitCircle",
            centre: sd.start,
            radius: r,
          });
        } else if (sd.kind === "fillet") {
          const r = Math.hypot(
            cursor.x - sd.corner.x,
            cursor.y - sd.corner.y,
          );
          dispatch({
            type: "commitFillet",
            cornerId: sd.cornerId,
            radius: r,
          });
        }
        return;
      }

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

      // Equations mode: a plain click on a node-hover target toggles
      // the collocation pin (re-click → unpin → graphs disappear).
      // Non-node clicks fall through to normal selection so the user
      // can pick the line / boundary / domain whose elements the
      // submatrices should be computed for.
      if (equationsVisible && equationsHover) {
        setEquationsPick((prev) => ({
          nodeIdx:
            prev.nodeIdx === equationsHover.nodeIdx
              ? null
              : equationsHover.nodeIdx,
        }));
        return;
      }

      // Simple click: select. Shift or Ctrl/Cmd = toggle (multi-select);
      // else replace.
      dispatch({
        type: "click",
        ctx: makeCtx(cursor),
        toggle: down.shift || down.ctrl,
      });
    },
    [view, makeCtx, marquee, equationsVisible, equationsHover],
  );

  const onMouseLeave = useCallback(() => {
    downStateRef.current = null;
    panStateRef.current = null;
    sliceDragRef.current = null;
    if (shapeDragRef.current !== null) {
      shapeDragRef.current = null;
      dispatch({ type: "setShapeDraft", draft: null });
    }
    setCursorWorld(null);
    setSnap(null);
    setMarquee(null);
    // Clear any element hover when the cursor leaves the canvas, so
    // the matrix view reverts to the line-selection highlight.
    if (hoveredElementKeyRef.current !== null) {
      hoveredElementKeyRef.current = null;
      setHoveredElementKey(null);
    }
    setEquationsHover(null);
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

  // Restore once at mount. If a stored model exists, load it; otherwise
  // (first visit / cleared cache / fresh deploy) load the bundled
  // plate-with-hole example so the page opens with something the user
  // can immediately interact with.
  useEffect(() => {
    const stored = loadFromLocalStorage();
    if (stored) {
      dispatch({ type: "loadModel", model: stored });
      return;
    }
    try {
      const example = deserialize(defaultExampleText);
      dispatch({ type: "loadModel", model: example });
    } catch (e) {
      // Bundled example shouldn't ever fail to parse, but if it does
      // (e.g. someone bumped serialise version without migrating it)
      // we just stay on the empty INITIAL_STATE rather than crashing.
      console.warn("[bem] bundled default example failed to load:", e);
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
      // Undo / redo. Ctrl+Z = undo, Ctrl+Y or Ctrl+Shift+Z = redo.
      // Use ctrlKey OR metaKey so Cmd+Z works on macOS.
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        dispatch({ type: "undo" });
        return;
      }
      if (
        mod &&
        ((e.shiftKey && (e.key === "z" || e.key === "Z")) ||
          e.key === "y" ||
          e.key === "Y")
      ) {
        e.preventDefault();
        dispatch({ type: "redo" });
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
  const labelFontSize = view.width * 0.013;
  const labelNodeFontSize = view.width * 0.007;
  const labelOutwardOffset = view.width * 0.018;

  // Per-element address (D{domain} B{boundary} L{line-in-boundary} E{el}).
  // Domain index = 1-based position of the domain containing the boundary
  // that contains this element's line.
  // Boundary index = 1-based position of the boundary that contains a
  // segment referencing this lineId.
  // Line index = 1-based position of this lineId within that boundary's
  // segments list.
  // Element index = el.indexInLine + 1.
  // Lines NOT referenced by any boundary fall back to "L{lineIdx}|E{idx}"
  // (using their position in model.lines), with D/B blank.
  const elementLabels = useMemo(() => {
    const lineToBoundary = new Map<
      string,
      { boundaryIdx: number; lineIdxInBoundary: number }
    >();
    model.boundaries.forEach((b, bIdx) => {
      b.segments.forEach((seg, sIdx) => {
        if (!lineToBoundary.has(seg.lineId)) {
          lineToBoundary.set(seg.lineId, {
            boundaryIdx: bIdx + 1,
            lineIdxInBoundary: sIdx + 1,
          });
        }
      });
    });
    const boundaryToDomain = new Map<string, number>();
    model.domains.forEach((d, dIdx) => {
      for (const bId of d.boundaryIds) {
        if (!boundaryToDomain.has(bId)) boundaryToDomain.set(bId, dIdx + 1);
      }
    });
    const lineIdxFallback = new Map(
      model.lines.map((l, i) => [l.id, i + 1] as const),
    );
    return meshElements.map((el) => {
      const bm = lineToBoundary.get(el.lineId);
      const boundary = bm ? model.boundaries[bm.boundaryIdx - 1] : undefined;
      const domainIdx = boundary ? boundaryToDomain.get(boundary.id) : undefined;
      const parts: string[] = [];
      if (domainIdx !== undefined) parts.push(`D${domainIdx}`);
      if (bm) parts.push(`B${bm.boundaryIdx}`);
      parts.push(
        bm ? `L${bm.lineIdxInBoundary}` : `L${lineIdxFallback.get(el.lineId) ?? "?"}`,
      );
      parts.push(`E${el.indexInLine + 1}`);
      return parts.join(" ");
    });
  }, [meshElements, model.lines, model.boundaries, model.domains]);

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
        matrixVisible={matrixVisible}
        labelsVisible={labelsVisible}
        equationsVisible={equationsVisible}
        sliceMode={state.sliceMode}
        canSlice={interiorField !== null && canShowInteriorResults}
        shapeMode={state.shapeMode}
        canFillet={true}
        hoverContext={hoverContext}
        selection={selection}
        model={model}
        onConvertHoleToBemDomain={(holeBoundaryId) =>
          dispatch({ type: "convertHoleToBemDomain", holeBoundaryId })
        }
        onConvertDomainToVoid={(domainId) =>
          dispatch({ type: "convertDomainToVoid", domainId })
        }
        selectionSummary={selectionSummary}
        solveStats={solveStats}
        onCreateDomain={() => dispatch({ type: "createDomainFromSelection" })}
        onDelete={() => dispatch({ type: "deleteSelection" })}
        onToggleMesh={() => dispatch({ type: "toggleMesh" })}
        onToggleResults={() => dispatch({ type: "toggleResults" })}
        onToggleInternalNodes={() => dispatch({ type: "toggleInternalNodes" })}
        onToggleMatrix={() => dispatch({ type: "toggleMatrix" })}
        onToggleLabels={() => dispatch({ type: "toggleLabels" })}
        onToggleEquations={() => dispatch({ type: "toggleEquations" })}
        onToggleSlice={() => dispatch({ type: "toggleSlice" })}
        onSetShapeMode={(mode) => dispatch({ type: "setShapeMode", mode })}
        onSave={handleSave}
        onLoad={handleLoad}
        onNew={handleNew}
      />
      <div
        className="cad-main"
        style={{
          // 5 columns: Inspector | resizer | canvas | resizer | Results.
          // The matrix view, when toggled on, renders INSIDE the
          // Inspector (resizable via the existing LHS resizer).
          gridTemplateColumns: `${lhsWidth}px 6px minmax(0, 1fr) 6px ${rhsWidth}px`,
        }}
      >
        <InfoPanel
          model={model}
          selection={selection}
          onDispatch={dispatch}
          matrixVisible={matrixVisible}
          solveStats={solveStats}
          matrixHighlightedDofs={matrixHighlightedDofs}
          matrixHoveredDofs={matrixHoveredDofs}
          onHoverMatrixDof={onHoverMatrixDof}
          equationsVisible={equationsVisible}
          equationsPick={equationsPick}
          meshElements={meshElements}
          material={material}
          nodePositions={solveStats?.nodePositions ?? EMPTY_NODE_POSITIONS}
          selectedElementKeys={selectedElementKeys}
          onClearEquationsPick={() => setEquationsPick({ nodeIdx: null })}
        />
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

              {(() => {
                // Hovered Domain id — both "bem" and "void-hole"
                // resolve to the Domain owning the region.
                const hoveredId =
                  hoverContext?.kind === "bem"
                    ? hoverContext.domainId
                    : hoverContext?.kind === "void-hole"
                      ? hoverContext.containingDomainId
                      : null;
                // Selected Domain ids and selected hole-void
                // boundary ids — used to layer a stronger fill /
                // grey overlay on top of the base domain fills.
                const selectedDomainIds = new Set<string>();
                const selectedHoleBoundaryIds = new Set<string>();
                for (const s of selection) {
                  if (s.kind === "domain") selectedDomainIds.add(s.id);
                  else if (s.kind === "void-hole")
                    selectedHoleBoundaryIds.add(s.holeBoundaryId);
                }
                return domainPaths.map((dp, i) => {
                  const isSelected = selectedDomainIds.has(dp.domainId);
                  const isHovered = dp.domainId === hoveredId;
                  // Selected dominates hover; both are subtler than
                  // the contour fills but distinct enough to read at
                  // a glance.
                  const opacity = isSelected ? 0.45 : isHovered ? 0.34 : 0.18;
                  return (
                    <path
                      key={i}
                      d={dp.d}
                      fill="var(--boundary)"
                      fillRule={dp.kind === "bounded" ? "evenodd" : "nonzero"}
                      fillOpacity={opacity}
                      pointerEvents="none"
                    />
                  );
                });
              })()}

              {/* Selected void-hole overlay — light grey fill over
                  any hole region the user has clicked to select.
                  Rendered above the domain fills so the colour reads
                  through the parent Domain's tint. */}
              {(() => {
                const selectedHoleIds = new Set<string>();
                for (const s of selection) {
                  if (s.kind === "void-hole")
                    selectedHoleIds.add(s.holeBoundaryId);
                }
                if (selectedHoleIds.size === 0) return null;
                const pathDs: string[] = [];
                for (const b of model.boundaries) {
                  if (!selectedHoleIds.has(b.id)) continue;
                  // Reuse the subpathFor logic inline — small enough
                  // to inline here rather than refactoring.
                  let sub = "";
                  for (let i = 0; i < b.segments.length; i++) {
                    const seg = b.segments[i]!;
                    const line = model.lines.find((l) => l.id === seg.lineId);
                    if (!line) {
                      sub = "";
                      break;
                    }
                    const startId =
                      seg.direction === 1 ? line.startId : line.endId;
                    const endId =
                      seg.direction === 1 ? line.endId : line.startId;
                    const start = pointsById.get(startId);
                    const end = pointsById.get(endId);
                    if (!start || !end) {
                      sub = "";
                      break;
                    }
                    if (i === 0) sub += `M ${start.x} ${start.y} `;
                    if (line.arcCentreId !== undefined) {
                      const centre = pointsById.get(line.arcCentreId);
                      if (!centre) {
                        sub = "";
                        break;
                      }
                      const r = Math.hypot(
                        centre.x - start.x,
                        centre.y - start.y,
                      );
                      const ex = end.x - start.x;
                      const ey = end.y - start.y;
                      const cxv = centre.x - start.x;
                      const cyv = centre.y - start.y;
                      const sweep = ex * cyv - ey * cxv > 0 ? 1 : 0;
                      sub += `A ${r} ${r} 0 0 ${sweep} ${end.x} ${end.y} `;
                    } else {
                      sub += `L ${end.x} ${end.y} `;
                    }
                  }
                  if (sub) pathDs.push(sub + "Z");
                }
                if (pathDs.length === 0) return null;
                return (
                  <path
                    d={pathDs.join(" ")}
                    fill="var(--void-selected, #9ca3af)"
                    fillOpacity={0.45}
                    pointerEvents="none"
                  />
                );
              })()}

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

              {/* Debug labels overlay (toggled). For each element draws
                  the D/B/L/E address tag offset outward from the
                  midpoint anchor, and the local node index (1, 2, 3)
                  centred on each node. Y is flipped per-text so glyphs
                  stay upright in our y-up world frame. */}
              {labelsVisible && (
                <g pointerEvents="none">
                  {meshElements.flatMap((el, elIdx) => {
                    const line = model.lines.find((l) => l.id === el.lineId);
                    if (!line) return [];
                    const lineStart = pointsById.get(line.startId);
                    const lineEnd = pointsById.get(line.endId);
                    if (!lineStart || !lineEnd) return [];
                    const centre = line.arcCentreId
                      ? pointsById.get(line.arcCentreId)
                      : undefined;
                    // Right-of-direction normal at the element midpoint,
                    // matching the BEM outward-normal convention (CCW
                    // loops → outward; CW loops → inward, which is fine
                    // for a debug label).
                    const t = (el.tStart + el.tEnd) / 2;
                    let nx = 0;
                    let ny = 0;
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
                      nx = tdy;
                      ny = -tdx;
                    } else {
                      const dx = lineEnd.x - lineStart.x;
                      const dy = lineEnd.y - lineStart.y;
                      const dl = Math.hypot(dx, dy) || 1;
                      nx = dy / dl;
                      ny = -dx / dl;
                    }
                    const mid = el.anchors[1];
                    const lx = mid.x + nx * labelOutwardOffset;
                    const ly = mid.y + ny * labelOutwardOffset;
                    const label = elementLabels[elIdx] ?? "";
                    return [
                      <g key={`lbl-${el.lineId}-${el.indexInLine}`}>
                        {/* Element address: y-flipped because the parent
                            SVG flips world Y to put y-up on screen. */}
                        <text
                          x={lx}
                          y={ly}
                          fontSize={labelFontSize}
                          fontFamily="var(--font-mono, monospace)"
                          fontWeight={600}
                          fill="var(--mesh)"
                          textAnchor="middle"
                          dominantBaseline="central"
                          transform={`scale(1,-1) translate(0,${-2 * ly})`}
                          paintOrder="stroke"
                          stroke="canvas"
                          strokeWidth={labelFontSize * 0.18}
                          strokeLinejoin="round"
                        >
                          {label}
                        </text>
                        {/* Local node indices 1, 2, 3 centred on each node. */}
                        {el.nodes.map((n, i) => (
                          <text
                            key={`nlbl-${i}`}
                            x={n.x}
                            y={n.y}
                            fontSize={labelNodeFontSize}
                            fontFamily="var(--font-mono, monospace)"
                            fontWeight={700}
                            fill="var(--mesh)"
                            textAnchor="middle"
                            dominantBaseline="central"
                            transform={`scale(1,-1) translate(0,${-2 * n.y})`}
                            paintOrder="stroke"
                            stroke="canvas"
                            strokeWidth={labelNodeFontSize * 0.18}
                            strokeLinejoin="round"
                          >
                            {i + 1}
                          </text>
                        ))}
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

                    // Displaced node positions — only when the mesh
                    // overlay is on, otherwise the node markers clutter
                    // the bare deformed shape.
                    const dashedDot = `${meshStroke * 1.5} ${meshStroke * 1.5}`;
                    const nodeCircles = meshVisible
                      ? el.nodes.map((n, i) => (
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
                        ))
                      : null;

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

              {/* Plot-hover tracker — when the user hovers the
                  Results-panel graph crosshair, mirror the matching
                  world position with a small white circle so the
                  hovered value's location is visible in the model. */}
              {profileHoverWorld && (
                <g pointerEvents="none">
                  <circle
                    cx={profileHoverWorld.x}
                    cy={profileHoverWorld.y}
                    r={lineStroke * 3.5}
                    fill="white"
                    stroke="black"
                    strokeWidth={lineStroke * 0.6}
                    opacity={0.95}
                  />
                </g>
              )}

              {/* Shape-builder live preview — only visible during the
                  drag. Rectangle outline, circle outline, or fillet
                  tangent arc. The committed shape lives in the model
                  on mouseup, so this preview vanishes the moment the
                  user releases. */}
              {state.shapeDraft && state.shapeDraft.kind === "rect" && (() => {
                const { c1, c2 } = state.shapeDraft;
                const minX = Math.min(c1.x, c2.x);
                const minY = Math.min(c1.y, c2.y);
                const w = Math.abs(c2.x - c1.x);
                const h = Math.abs(c2.y - c1.y);
                return (
                  <rect
                    x={minX}
                    y={minY}
                    width={w}
                    height={h}
                    fill="var(--accent)"
                    fillOpacity={0.08}
                    stroke="var(--accent)"
                    strokeWidth={lineStroke}
                    strokeDasharray={`${lineStroke * 4} ${lineStroke * 3}`}
                    pointerEvents="none"
                  />
                );
              })()}
              {state.shapeDraft && state.shapeDraft.kind === "circle" && (() => {
                const { centre, edge } = state.shapeDraft;
                const r = Math.hypot(edge.x - centre.x, edge.y - centre.y);
                return (
                  <g pointerEvents="none">
                    <circle
                      cx={centre.x}
                      cy={centre.y}
                      r={r}
                      fill="var(--accent)"
                      fillOpacity={0.08}
                      stroke="var(--accent)"
                      strokeWidth={lineStroke}
                      strokeDasharray={`${lineStroke * 4} ${lineStroke * 3}`}
                    />
                    <circle
                      cx={centre.x}
                      cy={centre.y}
                      r={lineStroke * 2}
                      fill="var(--accent)"
                    />
                    <line
                      x1={centre.x}
                      y1={centre.y}
                      x2={edge.x}
                      y2={edge.y}
                      stroke="var(--accent)"
                      strokeWidth={lineStroke * 0.8}
                      opacity={0.6}
                      strokeDasharray={`${lineStroke * 2} ${lineStroke * 2}`}
                    />
                  </g>
                );
              })()}
              {state.shapeDraft && state.shapeDraft.kind === "fillet" && (() => {
                const draft = state.shapeDraft;
                const corner = state.model.points.find(
                  (p) => p.id === draft.cornerId,
                );
                if (!corner) return null;
                return (
                  <g pointerEvents="none">
                    <circle
                      cx={corner.x}
                      cy={corner.y}
                      r={draft.radius}
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth={lineStroke}
                      strokeDasharray={`${lineStroke * 4} ${lineStroke * 3}`}
                      opacity={0.6}
                    />
                    <circle
                      cx={corner.x}
                      cy={corner.y}
                      r={lineStroke * 2.5}
                      fill="var(--accent)"
                    />
                  </g>
                );
              })()}

              {/* Slice line — committed slice + endpoint dots. Rendered
                  whenever a slice exists, regardless of whether slice
                  mode is still active, so the line stays visible
                  alongside the Results plot. */}
              {state.slice && (
                <g pointerEvents="none">
                  <line
                    x1={state.slice.start.x}
                    y1={state.slice.start.y}
                    x2={state.slice.end.x}
                    y2={state.slice.end.y}
                    stroke="var(--accent)"
                    strokeWidth={lineStroke}
                    strokeDasharray={`${lineStroke * 5} ${lineStroke * 2}`}
                    opacity={0.85}
                  />
                  <circle
                    cx={state.slice.start.x}
                    cy={state.slice.start.y}
                    r={lineStroke * 2.5}
                    fill="var(--accent)"
                  />
                  <circle
                    cx={state.slice.end.x}
                    cy={state.slice.end.y}
                    r={lineStroke * 2.5}
                    fill="var(--accent)"
                  />
                </g>
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

              {/* Matrix → canvas reverse hover. Up to two highlights:
                  the row DOF's node (from cursor Y in the matrix) and
                  the col DOF's node (from cursor X on H or G). Same
                  node → only one is drawn. */}
              {(reverseHoverRow.nodePos || reverseHoverCol.nodePos) && (
                <g pointerEvents="none">
                  {(() => {
                    const groups: {
                      tag: string;
                      hover: typeof reverseHoverRow;
                      tone: "row" | "col";
                    }[] = [];
                    if (reverseHoverRow.nodePos) {
                      groups.push({ tag: "row", hover: reverseHoverRow, tone: "row" });
                    }
                    if (
                      reverseHoverCol.nodePos &&
                      // Don't duplicate when row and col map to the same node.
                      reverseHoverCol.nodePos !== reverseHoverRow.nodePos
                    ) {
                      groups.push({ tag: "col", hover: reverseHoverCol, tone: "col" });
                    }
                    return groups.flatMap(({ tag, hover, tone }) => {
                      const ringFill =
                        tone === "row"
                          ? "rgba(252, 211, 77, 0.45)"
                          : "rgba(132, 204, 22, 0.45)"; // lime for col
                      const ringStroke =
                        tone === "row" ? "rgb(245, 158, 11)" : "rgb(101, 163, 13)";
                      const tickStroke = ringStroke;
                      const elemStroke =
                        tone === "row" ? "rgb(252, 211, 77)" : "rgb(132, 204, 22)";
                      return [
                        // Element chord highlights for elements containing
                        // this node.
                        ...meshElements
                          .filter((el) =>
                            hover.elementKeys.has(
                              `${el.lineId}|${el.indexInLine}`,
                            ),
                          )
                          .map((el) => (
                            <line
                              key={`mxh-${tag}-${el.lineId}-${el.indexInLine}`}
                              x1={el.anchors[0].x}
                              y1={el.anchors[0].y}
                              x2={el.anchors[2].x}
                              y2={el.anchors[2].y}
                              stroke={elemStroke}
                              strokeWidth={view.width * 0.005}
                              strokeLinecap="round"
                              opacity={0.85}
                            />
                          )),
                        // Ring at the node.
                        <circle
                          key={`mxh-${tag}-ring`}
                          cx={hover.nodePos!.x}
                          cy={hover.nodePos!.y}
                          r={view.width * 0.014}
                          fill={ringFill}
                          stroke={ringStroke}
                          strokeWidth={view.width * 0.0022}
                        />,
                        // Axis tick (horizontal = ux/tx, vertical = uy/ty).
                        hover.axis === 0 ? (
                          <line
                            key={`mxh-${tag}-tick`}
                            x1={hover.nodePos!.x - view.width * 0.014}
                            y1={hover.nodePos!.y}
                            x2={hover.nodePos!.x + view.width * 0.014}
                            y2={hover.nodePos!.y}
                            stroke={tickStroke}
                            strokeWidth={view.width * 0.003}
                            strokeLinecap="round"
                          />
                        ) : (
                          <line
                            key={`mxh-${tag}-tick`}
                            x1={hover.nodePos!.x}
                            y1={hover.nodePos!.y - view.width * 0.014}
                            x2={hover.nodePos!.x}
                            y2={hover.nodePos!.y + view.width * 0.014}
                            stroke={tickStroke}
                            strokeWidth={view.width * 0.003}
                            strokeLinecap="round"
                          />
                        ),
                      ];
                    });
                  })()}
                </g>
              )}

              {/* Equations mode: collocation-node pin + hover preview.
                  Pinned = solid orange ring; previewed = dashed
                  softer ring. Elements come from the standard line /
                  boundary selection now, not a separate pin. */}
              {equationsVisible && (() => {
                const pinNode =
                  equationsPick.nodeIdx !== null && solveStats
                    ? solveStats.nodePositions[equationsPick.nodeIdx] ?? null
                    : null;
                const eqOrange = "rgb(249, 115, 22)";
                const eqOrangeSoft = "rgba(249, 115, 22, 0.45)";
                const eqOrangeRingFill = "rgba(249, 115, 22, 0.18)";
                const previewDash = `${view.width * 0.005} ${view.width * 0.003}`;
                return (
                  <g pointerEvents="none">
                    {pinNode && (
                      <circle
                        cx={pinNode.x}
                        cy={pinNode.y}
                        r={view.width * 0.014}
                        fill={eqOrangeRingFill}
                        stroke={eqOrange}
                        strokeWidth={view.width * 0.0028}
                      />
                    )}
                    {equationsHover && (
                      <circle
                        cx={equationsHover.pos.x}
                        cy={equationsHover.pos.y}
                        r={view.width * 0.018}
                        fill="none"
                        stroke={eqOrangeSoft}
                        strokeWidth={view.width * 0.0024}
                        strokeDasharray={previewDash}
                      />
                    )}
                  </g>
                );
              })()}
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
          // Slice profile takes precedence over the boundary-line edge
          // profile so a committed slice immediately replaces whatever
          // was plotted from the selected lines.
          edgeProfile={sliceProfile ?? edgeProfile}
          isSlice={sliceProfile !== null}
          onHoverWorld={setProfileHoverWorld}
          onSelectField={(field) =>
            dispatch({ type: "setInteriorField", field })
          }
        />
      </div>
    </div>
  );
}
