// "Walk the boundary" view of U* and T* from one collocation point.
//
// Two stacked panels, one per collocation axis (a = x, a = y). Each
// panel has 4 series:
//
//     green   U*_{a,x}(s, x(arc))
//     blue    U*_{a,y}(s, x(arc))
//     orange  T*_{a,x}(s, x(arc))
//     red     T*_{a,y}(s, x(arc))
//
// X axis is arc length. Successive boundaries are stacked end-to-end
// on the global arc axis with a visible gap and a label between them
// — the curve is NaN across the gap so the eye never connects two
// disjoint boundaries by accident.
//
// Tick layers (by zoom level):
//   - always: boundary dividers + labels
//   - always: element tick marks on the x axis
//   - medium zoom: node dots (3 per element)
//   - close zoom (element occupies ≳ 30% of the x window): Gauss-point
//     marks (the rule the adaptive integrator settled on)
// Plus:
//   - vertical line at every collocation arc (where s sits on Γ; the
//     log-r / 1/r spike lives here)
//   - orange band over the currently-picked source element's arc range
//
// Interactions: wheel zoom around the cursor's x; click-drag pan;
// double-click reset.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoundaryKernelTraces } from "@bem/engine";

const BOUNDARY_GAP = 0.05; // fraction of total arc to leave between boundaries

// Series colours — chosen to read against the orange / red BC palette
// used elsewhere. Pickable per panel; same per a so the same kernel
// component is the same colour across panels.
const COLOR = {
  Ux: "rgb(34, 197, 94)",   // green
  Uy: "rgb(59, 130, 246)",  // blue
  Tx: "rgb(249, 115, 22)",  // orange
  Ty: "rgb(220, 38, 38)",   // red
} as const;

const PLOT_W = 420;
const PANEL_H = 130;
const PAD_L = 42;
const PAD_R = 8;
const PAD_T = 6;
const PAD_B = 22;
const innerW = PLOT_W - PAD_L - PAD_R;
const innerH = PANEL_H - PAD_T - PAD_B;

const ZOOM_PER_TICK = 1.2;
const MIN_VISIBLE_FRAC = 1e-4; // can't zoom past 1/10000 of total arc

interface ViewRange {
  readonly arcLo: number;
  readonly arcHi: number;
}

interface SeriesVisibility {
  readonly Ux: boolean;
  readonly Uy: boolean;
  readonly Tx: boolean;
  readonly Ty: boolean;
}
type SeriesKey = keyof SeriesVisibility;
const ALL_ON: SeriesVisibility = { Ux: true, Uy: true, Tx: true, Ty: true };

export function BoundaryKernelPanel({
  trace,
  selectedElementKeys,
}: {
  trace: BoundaryKernelTraces;
  selectedElementKeys: ReadonlySet<string>;
}) {
  // ── viewport: a single arc range shared between the two panels ──────
  const totalArc = trace.totalArc;
  const arcRanges = useMemo(() => buildArcMap(trace), [trace]);
  // Mapped arc = the "compressed" axis that includes the boundary
  // gaps. Both panels render in this mapped space; the trace data
  // gets gap-injected when we build series points below.
  const mappedTotal = arcRanges.mappedTotal;
  const [view, setView] = useState<ViewRange>({
    arcLo: 0,
    arcHi: mappedTotal,
  });
  const [visibleSeries, setVisibleSeries] = useState<SeriesVisibility>(ALL_ON);
  const toggleSeries = (k: SeriesKey) =>
    setVisibleSeries((prev) => ({ ...prev, [k]: !prev[k] }));
  // Reset the view when a new boundary trace arrives (e.g. the user
  // changed the picked collocation node) — otherwise the old zoom
  // sticks across changes.
  const lastTraceRef = useRef(trace);
  useEffect(() => {
    if (lastTraceRef.current !== trace) {
      lastTraceRef.current = trace;
      setView({ arcLo: 0, arcHi: mappedTotal });
    }
  }, [trace, mappedTotal]);

  // ── series builders ─────────────────────────────────────────────────
  // For each panel a∈{0,1}, build 4 polyline strings whose points are
  // (mappedArc, kernelValue). Across boundary gaps inject a "gap"
  // entry (the NaN segment) — we render multiple sub-polylines so
  // the curve doesn't bridge gaps. The y-clip is recomputed against
  // ONLY the visible series, so toggling off a singular spike lets
  // the smaller curves expand to fill the panel.
  const seriesPaths = useMemo(
    () => buildSeriesPaths(trace, arcRanges, view, visibleSeries),
    [trace, arcRanges, view, visibleSeries],
  );

  // ── element / node / Gauss-point overlays ───────────────────────────
  const overlays = useMemo(
    () => buildOverlays(trace, arcRanges),
    [trace, arcRanges],
  );

  // Arc bands for every currently-selected element (lines / boundaries /
  // domains expanded by the caller into per-element keys). These are
  // the source-element highlight: each selected element gets one
  // orange band over its arc range. Adjacent selected elements
  // visually merge because their bands are contiguous in arc space.
  const selectedBands = useMemo(() => {
    const bands: { arcLo: number; arcHi: number }[] = [];
    for (const b of trace.boundaries) {
      for (const el of b.elements) {
        if (selectedElementKeys.has(el.elementKey)) {
          bands.push({
            arcLo: arcRanges.mapArc(el.arcStart),
            arcHi: arcRanges.mapArc(el.arcEnd),
          });
        }
      }
    }
    return bands;
  }, [trace, selectedElementKeys, arcRanges]);

  // ── wheel + drag interaction ────────────────────────────────────────
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    | { clientX: number; startLo: number; startHi: number }
    | null
  >(null);

  const clientToArc = useCallback(
    (clientX: number): number => {
      const svg = svgRef.current;
      if (!svg) return view.arcLo;
      const rect = svg.getBoundingClientRect();
      const fx = (clientX - rect.left) / rect.width;
      const px = fx * PLOT_W;
      const inside = (px - PAD_L) / innerW;
      return view.arcLo + inside * (view.arcHi - view.arcLo);
    },
    [view],
  );

  // Wheel zoom — passive: false required to preventDefault page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const aMid = clientToArc(e.clientX);
      const ticks = e.deltaY > 0 ? 1 : -1;
      const factor = Math.pow(ZOOM_PER_TICK, ticks);
      const width = view.arcHi - view.arcLo;
      let newWidth = width * factor;
      const minWidth = Math.max(MIN_VISIBLE_FRAC * mappedTotal, 1e-9);
      newWidth = Math.max(minWidth, Math.min(mappedTotal, newWidth));
      const fracL = (aMid - view.arcLo) / width;
      const newLo = aMid - fracL * newWidth;
      const newHi = newLo + newWidth;
      const shiftLo = Math.max(0, newLo) - newLo;
      const clampedLo = newLo + shiftLo;
      const clampedHi = Math.min(mappedTotal, newHi + shiftLo);
      setView({
        arcLo: Math.max(0, clampedLo - Math.max(0, clampedHi - mappedTotal)),
        arcHi: Math.min(mappedTotal, clampedHi),
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [view, clientToArc, mappedTotal]);

  // Drag pan
  const onMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragRef.current = {
        clientX: e.clientX,
        startLo: view.arcLo,
        startHi: view.arcHi,
      };
    },
    [view],
  );
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const dxPx = e.clientX - d.clientX;
      const width = d.startHi - d.startLo;
      const arcPerCssPx = width / rect.width;
      const dArc = -dxPx * arcPerCssPx;
      let lo = d.startLo + dArc;
      let hi = d.startHi + dArc;
      if (lo < 0) {
        hi -= lo;
        lo = 0;
      }
      if (hi > mappedTotal) {
        lo -= hi - mappedTotal;
        hi = mappedTotal;
      }
      setView({
        arcLo: Math.max(0, lo),
        arcHi: Math.min(mappedTotal, hi),
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [mappedTotal]);

  const onDoubleClick = useCallback(() => {
    setView({ arcLo: 0, arcHi: mappedTotal });
  }, [mappedTotal]);

  // ── y axes are auto-clipped per panel to keep singular spikes
  //    readable. Clip to the median ±5×|max(non-spike)| of the
  //    samples currently in view. Computed in buildSeriesPaths since
  //    it already has the values.
  const { yClipA0, yClipA1 } = seriesPaths;

  // ── mapping helpers used in render ─────────────────────────────────
  const xFromMappedArc = (a: number) => {
    const t = (a - view.arcLo) / (view.arcHi - view.arcLo);
    return PAD_L + t * innerW;
  };
  const yFromValue = (v: number, yLo: number, yHi: number) => {
    if (!Number.isFinite(v)) return PAD_T + innerH; // off-screen
    const clipped = Math.max(yLo, Math.min(yHi, v));
    return PAD_T + ((yHi - clipped) / (yHi - yLo)) * innerH;
  };

  // Determine zoom-dependent visibility thresholds. windowFraction =
  // size of the current view / mapped total. Smaller = more zoomed.
  const windowFraction = (view.arcHi - view.arcLo) / mappedTotal;
  // Node dots show when an element occupies > ~3% of the visible
  // window. avg element fraction = ( totalArc / N elements ) / windowSize.
  const totalElCount = trace.boundaries.reduce(
    (n, b) => n + b.elements.length,
    0,
  );
  const avgElFraction =
    totalElCount > 0 ? totalArc / totalElCount / (view.arcHi - view.arcLo) : 0;
  const showNodes = avgElFraction > 0.03;
  const showGauss = avgElFraction > 0.18;
  // Always show boundary labels — they're the user's main orienter
  // when the view spans multiple closed loops.
  const showBoundaryLabels = true;
  // Suppress an unused-warning while keeping windowFraction wired
  // for potential future zoom-gated affordances.
  void windowFraction;


  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          fontWeight: 600,
          fontFamily: "var(--font-mono, monospace)",
          marginBottom: 4,
          display: "flex",
          gap: 12,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span>Kernels along Γ</span>
        <span style={{ fontWeight: 400, fontSize: "0.78em", opacity: 0.75 }}>
          wheel = zoom · drag = pan · dbl-click = reset
        </span>
        <Legend visible={visibleSeries} onToggle={toggleSeries} />
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${PLOT_W} ${2 * PANEL_H + 6}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Kernels U* and T* sampled along the boundary"
        style={{
          width: "100%",
          maxWidth: PLOT_W,
          display: "block",
          cursor: dragRef.current ? "grabbing" : "grab",
          userSelect: "none",
        }}
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
      >
        {/* a = x panel */}
        <PanelG
          axisLabel="a = x"
          panelY={0}
          paths={seriesPaths.aX}
          overlays={overlays}
          collocationArcs={overlays.collocationArcsMapped}
          selectedBands={selectedBands}
          xFromMappedArc={xFromMappedArc}
          yFromValue={yFromValue}
          showNodes={showNodes}
          showGauss={showGauss}
          showBoundaryLabels={showBoundaryLabels}
          view={view}
          yClip={yClipA0}
          visibleSeries={visibleSeries}
        />
        {/* a = y panel */}
        <PanelG
          axisLabel="a = y"
          panelY={PANEL_H + 6}
          paths={seriesPaths.aY}
          overlays={overlays}
          collocationArcs={overlays.collocationArcsMapped}
          selectedBands={selectedBands}
          xFromMappedArc={xFromMappedArc}
          yFromValue={yFromValue}
          showNodes={showNodes}
          showGauss={showGauss}
          showBoundaryLabels={showBoundaryLabels}
          view={view}
          yClip={yClipA1}
          visibleSeries={visibleSeries}
        />
      </svg>
    </div>
  );
}

function Legend({
  visible,
  onToggle,
}: {
  visible: SeriesVisibility;
  onToggle: (k: SeriesKey) => void;
}) {
  const items: { key: SeriesKey; label: string; color: string }[] = [
    { key: "Ux", label: "U*_{a,x}", color: COLOR.Ux },
    { key: "Uy", label: "U*_{a,y}", color: COLOR.Uy },
    { key: "Tx", label: "T*_{a,x}", color: COLOR.Tx },
    { key: "Ty", label: "T*_{a,y}", color: COLOR.Ty },
  ];
  return (
    <span style={{ display: "inline-flex", gap: 10, fontSize: "0.78em" }}>
      {items.map(({ key, label, color }) => {
        const on = visible[key];
        return (
          <button
            key={key}
            type="button"
            onClick={() => onToggle(key)}
            title={`Toggle ${label}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "1px 4px",
              border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
              borderRadius: 3,
              background: "transparent",
              color: "inherit",
              font: "inherit",
              cursor: "pointer",
              opacity: on ? 1 : 0.4,
              textDecoration: on ? "none" : "line-through",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 2,
                background: color,
                opacity: on ? 1 : 0.5,
              }}
            />
            <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
              {label}
            </span>
          </button>
        );
      })}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface ArcMap {
  /** Map a true arc value (≤ totalArc) to its visible position on the
   *  mapped (gap-injected) axis. */
  readonly mapArc: (arc: number) => number;
  readonly mappedTotal: number;
  /** For each boundary, the mapped arc where it starts and ends, and
   *  the gap (in mapped space) that precedes it (0 for the first). */
  readonly boundaries: readonly {
    readonly id: string;
    readonly name: string;
    readonly mappedStart: number;
    readonly mappedEnd: number;
    readonly gapBefore: number;
  }[];
}

function buildArcMap(trace: BoundaryKernelTraces): ArcMap {
  const total = trace.totalArc;
  const gap = trace.boundaries.length > 1 ? BOUNDARY_GAP * total : 0;
  const boundaries: ArcMap["boundaries"][number][] = [];
  let cursor = 0;
  for (let i = 0; i < trace.boundaries.length; i++) {
    const b = trace.boundaries[i]!;
    const gapBefore = i === 0 ? 0 : gap;
    cursor += gapBefore;
    boundaries.push({
      id: b.boundaryId,
      name: b.name,
      mappedStart: cursor,
      mappedEnd: cursor + b.arcLength,
      gapBefore,
    });
    cursor += b.arcLength;
  }
  const mappedTotal = cursor || 1;

  const mapArc = (arc: number): number => {
    // Find which boundary this real arc belongs to.
    let acc = 0;
    for (let i = 0; i < trace.boundaries.length; i++) {
      const b = trace.boundaries[i]!;
      const next = acc + b.arcLength;
      if (arc <= next + 1e-12 || i === trace.boundaries.length - 1) {
        const local = arc - acc;
        return boundaries[i]!.mappedStart + local;
      }
      acc = next;
    }
    return mappedTotal;
  };

  return { mapArc, mappedTotal, boundaries };
}

interface SeriesPaths {
  aX: SeriesPathSet;
  aY: SeriesPathSet;
  yClipA0: { lo: number; hi: number };
  yClipA1: { lo: number; hi: number };
}

interface SeriesPathSet {
  /** Per series, an array of sub-polyline strings — one per
   *  contiguous run (boundary gaps split them). */
  readonly Ux: readonly string[];
  readonly Uy: readonly string[];
  readonly Tx: readonly string[];
  readonly Ty: readonly string[];
}

function buildSeriesPaths(
  trace: BoundaryKernelTraces,
  arcMap: ArcMap,
  view: ViewRange,
  visible: SeriesVisibility,
): SeriesPaths {
  // Walk every sample of every element, in order. Split sub-runs at
  // boundary boundaries. Build path strings.
  const partsA0: SubRuns = { Ux: [], Uy: [], Tx: [], Ty: [] };
  const partsA1: SubRuns = { Ux: [], Uy: [], Tx: [], Ty: [] };

  // For y-axis clipping: collect non-singular magnitudes in view.
  const inView = (arc: number) => arc >= view.arcLo && arc <= view.arcHi;
  const valuesA0: number[] = [];
  const valuesA1: number[] = [];

  for (const b of trace.boundaries) {
    const subUxA0: PathPoint[] = [];
    const subUyA0: PathPoint[] = [];
    const subTxA0: PathPoint[] = [];
    const subTyA0: PathPoint[] = [];
    const subUxA1: PathPoint[] = [];
    const subUyA1: PathPoint[] = [];
    const subTxA1: PathPoint[] = [];
    const subTyA1: PathPoint[] = [];

    for (const el of b.elements) {
      for (const s of el.samples) {
        const mapped = arcMap.mapArc(s.arc);
        const sUxA0 = s.U[0][0];
        const sUyA0 = s.U[0][1];
        const sTxA0 = s.T[0][0];
        const sTyA0 = s.T[0][1];
        const sUxA1 = s.U[1][0];
        const sUyA1 = s.U[1][1];
        const sTxA1 = s.T[1][0];
        const sTyA1 = s.T[1][1];
        subUxA0.push({ x: mapped, y: sUxA0 });
        subUyA0.push({ x: mapped, y: sUyA0 });
        subTxA0.push({ x: mapped, y: sTxA0 });
        subTyA0.push({ x: mapped, y: sTyA0 });
        subUxA1.push({ x: mapped, y: sUxA1 });
        subUyA1.push({ x: mapped, y: sUyA1 });
        subTxA1.push({ x: mapped, y: sTxA1 });
        subTyA1.push({ x: mapped, y: sTyA1 });
        if (inView(mapped) && Number.isFinite(sUxA0)) {
          if (visible.Ux) {
            valuesA0.push(sUxA0);
            valuesA1.push(sUxA1);
          }
          if (visible.Uy) {
            valuesA0.push(sUyA0);
            valuesA1.push(sUyA1);
          }
          if (visible.Tx) {
            valuesA0.push(sTxA0);
            valuesA1.push(sTxA1);
          }
          if (visible.Ty) {
            valuesA0.push(sTyA0);
            valuesA1.push(sTyA1);
          }
        }
      }
    }
    partsA0.Ux.push(subUxA0);
    partsA0.Uy.push(subUyA0);
    partsA0.Tx.push(subTxA0);
    partsA0.Ty.push(subTyA0);
    partsA1.Ux.push(subUxA1);
    partsA1.Uy.push(subUyA1);
    partsA1.Tx.push(subTxA1);
    partsA1.Ty.push(subTyA1);
  }

  return {
    aX: subRunsToPaths(partsA0),
    aY: subRunsToPaths(partsA1),
    yClipA0: clipY(valuesA0),
    yClipA1: clipY(valuesA1),
  };
}

type PathPoint = { x: number; y: number };
type SubRuns = {
  Ux: PathPoint[][];
  Uy: PathPoint[][];
  Tx: PathPoint[][];
  Ty: PathPoint[][];
};

function subRunsToPaths(parts: SubRuns): SeriesPathSet {
  const toPaths = (runs: PathPoint[][]): string[] =>
    runs.map((points) => {
      if (points.length === 0) return "";
      const finite = points.every((p) => Number.isFinite(p.y));
      if (finite) {
        return points
          .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y}`)
          .join(" ");
      }
      // Fallback (shouldn't happen for normal kernels far from s).
      return points
        .map((p, i) =>
          Number.isFinite(p.y) ? `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y}` : "",
        )
        .join(" ");
    });
  return {
    Ux: toPaths(parts.Ux),
    Uy: toPaths(parts.Uy),
    Tx: toPaths(parts.Tx),
    Ty: toPaths(parts.Ty),
  };
}

/** Choose a symmetric y-clip that ignores the singular-spike tail.
 *
 *  Kernels U* / T* grow without bound as the integration walks past
 *  the collocation point. A few percent of the dense samples — those
 *  closest to s — can be orders of magnitude larger than the rest.
 *  Including them in the scale collapses every other curve onto the
 *  zero line, which is exactly what we don't want.
 *
 *  Strategy: anchor the clip on the 85th percentile of |value|
 *  (captures every regular sample, drops the top 15% which are the
 *  spike), then pad ×1.5 for headroom. Singular samples get clipped
 *  to the panel edge — the dashed red line at s still tells the user
 *  the spike is there. */
function clipY(values: number[]): { lo: number; hi: number } {
  if (values.length === 0) return { lo: -1, hi: 1 };
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { lo: -1, hi: 1 };
  const abs = finite.map(Math.abs).sort((a, b) => a - b);
  const p85 = abs[Math.floor(abs.length * 0.85)] || abs[abs.length - 1] || 1;
  // Headroom factor so a real curve that happens to cross p85 isn't
  // shoulder-on-the-frame.
  const clip = Math.max(p85 * 1.5, 1e-12);
  return { lo: -clip, hi: +clip };
}

interface Overlays {
  /** Per boundary: mapped start/end + name. */
  readonly boundaries: readonly {
    readonly id: string;
    readonly name: string;
    readonly mappedStart: number;
    readonly mappedEnd: number;
    readonly gapBefore: number;
  }[];
  /** All element start/end positions in mapped arc space. */
  readonly elementTicks: readonly number[];
  /** Node dot positions (mapped arc). */
  readonly nodes: readonly { mapped: number; x: number; y: number }[];
  /** Gauss-point positions per element (mapped arc). */
  readonly gauss: readonly { mapped: number; isTelles: boolean }[];
  /** Collocation arcs (where s lies on Γ) in mapped arc space. */
  readonly collocationArcsMapped: readonly number[];
}

function buildOverlays(
  trace: BoundaryKernelTraces,
  arcMap: ArcMap,
): Overlays {
  const elementTicks: number[] = [];
  const nodes: { mapped: number; x: number; y: number }[] = [];
  const gauss: { mapped: number; isTelles: boolean }[] = [];
  for (const b of trace.boundaries) {
    for (const el of b.elements) {
      elementTicks.push(arcMap.mapArc(el.arcStart));
      elementTicks.push(arcMap.mapArc(el.arcEnd));
      for (const n of el.nodes) {
        nodes.push({ mapped: arcMap.mapArc(n.arc), x: n.x, y: n.y });
      }
      for (const ga of el.gauss.arcs) {
        gauss.push({ mapped: arcMap.mapArc(ga), isTelles: el.gauss.isTelles });
      }
    }
  }
  return {
    boundaries: arcMap.boundaries,
    elementTicks,
    nodes,
    gauss,
    collocationArcsMapped: trace.collocationArcs.map((c) => arcMap.mapArc(c.arc)),
  };
}

function PanelG({
  axisLabel,
  panelY,
  paths,
  overlays,
  collocationArcs,
  selectedBands,
  xFromMappedArc,
  yFromValue,
  showNodes,
  showGauss,
  showBoundaryLabels,
  view,
  yClip,
  visibleSeries,
}: {
  axisLabel: string;
  panelY: number;
  paths: SeriesPathSet;
  overlays: Overlays;
  collocationArcs: readonly number[];
  selectedBands: readonly { arcLo: number; arcHi: number }[];
  xFromMappedArc: (a: number) => number;
  yFromValue: (v: number, lo: number, hi: number) => number;
  showNodes: boolean;
  showGauss: boolean;
  showBoundaryLabels: boolean;
  view: ViewRange;
  yClip: { lo: number; hi: number };
  visibleSeries: SeriesVisibility;
}) {
  const y0 = panelY + PAD_T;
  const yEnd = panelY + PAD_T + innerH;
  const yMid = (y0 + yEnd) / 2;
  const yMap = (v: number) =>
    panelY + yFromValue(v, yClip.lo, yClip.hi) - PAD_T + PAD_T;

  // buildSeriesPaths emits path strings whose coordinates are RAW
  // (mapped-arc, kernel-value) — neither is in SVG pixel space.
  // Transform both x (mapped arc → pixel) and y (kernel value → pixel
  // within this panel's vertical band) on the way out.
  const offsetPath = (d: string): string =>
    d.replace(/(L|M) (\S+) (\S+)/g, (_m, cmd, x, y) => {
      const xNum = parseFloat(x);
      const yNum = parseFloat(y);
      return `${cmd} ${xFromMappedArc(xNum).toFixed(2)} ${yMap(yNum).toFixed(2)}`;
    });

  const xLo = PAD_L;
  const xHi = PAD_L + innerW;

  return (
    <g>
      {/* frame */}
      <rect
        x={xLo}
        y={y0}
        width={innerW}
        height={innerH}
        fill="none"
        stroke="currentColor"
        strokeWidth={0.5}
        opacity={0.3}
      />
      {/* Selected-element highlight bands. Drawn first so the boundary
          gap dividers and the kernel curves both sit on top. */}
      {selectedBands.map((band, i) => {
        const x1 = Math.max(xLo, xFromMappedArc(band.arcLo));
        const x2 = Math.min(xHi, xFromMappedArc(band.arcHi));
        const w = Math.max(0, x2 - x1);
        if (w === 0) return null;
        return (
          <rect
            key={`sel${i}`}
            x={x1}
            y={y0}
            width={w}
            height={innerH}
            fill="rgb(249, 115, 22)"
            fillOpacity={0.14}
            stroke="none"
          />
        );
      })}
      {/* Boundary gap fills + dividers. The fill is a tinted band over
          the inter-boundary gap; the divider lines are solid at both
          edges so the eye reads the gap as "this is the join between
          two distinct boundaries". */}
      {overlays.boundaries.map((b, i) =>
        i === 0 ? null : (
          <g key={`gap${i}`}>
            <rect
              x={xFromMappedArc(b.mappedStart - b.gapBefore)}
              y={y0}
              width={
                xFromMappedArc(b.mappedStart) -
                xFromMappedArc(b.mappedStart - b.gapBefore)
              }
              height={innerH}
              fill="currentColor"
              opacity={0.12}
            />
            <line
              x1={xFromMappedArc(b.mappedStart - b.gapBefore)}
              y1={y0}
              x2={xFromMappedArc(b.mappedStart - b.gapBefore)}
              y2={yEnd}
              stroke="currentColor"
              strokeWidth={0.8}
              opacity={0.5}
            />
            <line
              x1={xFromMappedArc(b.mappedStart)}
              y1={y0}
              x2={xFromMappedArc(b.mappedStart)}
              y2={yEnd}
              stroke="currentColor"
              strokeWidth={0.8}
              opacity={0.5}
            />
          </g>
        ),
      )}
      {/* y=0 line */}
      <line
        x1={xLo}
        y1={yMid}
        x2={xHi}
        y2={yMid}
        stroke="currentColor"
        strokeWidth={0.5}
        opacity={0.35}
      />
      {/* collocation singular vertical lines */}
      {collocationArcs.map((a, i) => {
        const x = xFromMappedArc(a);
        if (x < xLo || x > xHi) return null;
        return (
          <line
            key={`coll${i}`}
            x1={x}
            y1={y0}
            x2={x}
            y2={yEnd}
            stroke="rgb(220, 38, 38)"
            strokeWidth={0.8}
            strokeDasharray="3 2"
            opacity={0.65}
          />
        );
      })}
      {/* element tick marks at top + bottom of frame */}
      {overlays.elementTicks.map((a, i) => {
        const x = xFromMappedArc(a);
        if (x < xLo - 0.5 || x > xHi + 0.5) return null;
        return (
          <line
            key={`et${i}`}
            x1={x}
            y1={yEnd}
            x2={x}
            y2={yEnd - 3}
            stroke="currentColor"
            strokeWidth={0.5}
            opacity={0.4}
          />
        );
      })}
      {/* node dots on x-axis (medium zoom) */}
      {showNodes &&
        overlays.nodes.map((n, i) => {
          const x = xFromMappedArc(n.mapped);
          if (x < xLo || x > xHi) return null;
          return (
            <circle
              key={`nd${i}`}
              cx={x}
              cy={yEnd}
              r={1.8}
              fill="currentColor"
              opacity={0.55}
            >
              <title>{`node @ (${n.x.toFixed(3)}, ${n.y.toFixed(3)})`}</title>
            </circle>
          );
        })}
      {/* Gauss points (close zoom) */}
      {showGauss &&
        overlays.gauss.map((g, i) => {
          const x = xFromMappedArc(g.mapped);
          if (x < xLo || x > xHi) return null;
          return (
            <line
              key={`gx${i}`}
              x1={x}
              y1={yEnd - 1}
              x2={x}
              y2={yEnd - 5}
              stroke={g.isTelles ? "rgb(220, 38, 38)" : "rgb(120, 53, 15)"}
              strokeWidth={0.7}
              opacity={0.85}
            />
          );
        })}
      {/* boundary labels at top */}
      {showBoundaryLabels &&
        overlays.boundaries.map((b, i) => {
          const cx = xFromMappedArc((b.mappedStart + b.mappedEnd) / 2);
          if (cx < xLo || cx > xHi) return null;
          return (
            <text
              key={`bl${i}`}
              x={cx}
              y={y0 + 10}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              opacity={0.6}
              fontFamily="var(--font-mono, monospace)"
            >
              {b.name}
            </text>
          );
        })}
      {/* The 4 series. Each series is multiple sub-paths (one per
          boundary), each shifted into this panel's vertical band.
          Series toggled off via the legend are omitted entirely. */}
      {visibleSeries.Ux &&
        paths.Ux.map((d, i) => (
          <path key={`ux${i}`} d={offsetPath(d)} fill="none" stroke={COLOR.Ux} strokeWidth={1.2} />
        ))}
      {visibleSeries.Uy &&
        paths.Uy.map((d, i) => (
          <path key={`uy${i}`} d={offsetPath(d)} fill="none" stroke={COLOR.Uy} strokeWidth={1.2} />
        ))}
      {visibleSeries.Tx &&
        paths.Tx.map((d, i) => (
          <path key={`tx${i}`} d={offsetPath(d)} fill="none" stroke={COLOR.Tx} strokeWidth={1.2} />
        ))}
      {visibleSeries.Ty &&
        paths.Ty.map((d, i) => (
          <path key={`ty${i}`} d={offsetPath(d)} fill="none" stroke={COLOR.Ty} strokeWidth={1.2} />
        ))}
      {/* axis label + y range readout */}
      <text
        x={PAD_L - 3}
        y={y0 + 9}
        textAnchor="end"
        fontSize={9}
        fontFamily="var(--font-mono, monospace)"
        fill="currentColor"
        opacity={0.7}
      >
        {axisLabel}
      </text>
      <text
        x={PAD_L - 3}
        y={yEnd - 2}
        textAnchor="end"
        fontSize={8}
        fill="currentColor"
        opacity={0.55}
      >
        {fmtClip(yClip.lo)} / {fmtClip(yClip.hi)}
      </text>
      {/* x-axis arc range readout (under bottom panel only — handled in caller) */}
      <text
        x={xLo}
        y={yEnd + 14}
        fontSize={8}
        fontFamily="var(--font-mono, monospace)"
        fill="currentColor"
        opacity={0.55}
      >
        arc = {view.arcLo.toFixed(3)}
      </text>
      <text
        x={xHi}
        y={yEnd + 14}
        textAnchor="end"
        fontSize={8}
        fontFamily="var(--font-mono, monospace)"
        fill="currentColor"
        opacity={0.55}
      >
        {view.arcHi.toFixed(3)}
      </text>
    </g>
  );
}

function fmtClip(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e4 || abs < 1e-3) return v.toExponential(1);
  return v.toPrecision(2);
}
