// RHS info panel.
//
// Empty selection         → gesture hint.
// One item selected       → full inspector for that item.
// More than one selected  → summary with counts by kind.

import { useEffect, useRef, useState } from "react";
import type { CadModel, DirectionBc, Id, LineDiscretisation } from "@bem/engine";
import { shapeFunctions } from "@bem/engine";
import {
  DEFAULT_ELEMENTS_PER_LINE,
  DEFAULT_LOCAL_NODES,
  getBcAssignment,
  getLineDiscretisation,
  pointMap,
} from "./operations.js";
import type { CanvasAction, SelectionItem } from "./reducer.js";

function countSelectedArcs(
  model: CadModel,
  selection: readonly SelectionItem[],
): number {
  const lineIds = new Set(
    selection.filter((s) => s.kind === "line").map((s) => s.id),
  );
  let n = 0;
  for (const l of model.lines) {
    if (lineIds.has(l.id) && l.arcCentreId !== undefined) n++;
  }
  return n;
}

interface InfoPanelProps {
  readonly model: CadModel;
  readonly selection: readonly SelectionItem[];
  readonly onDispatch: (action: CanvasAction) => void;
}

export function InfoPanel({ model, selection, onDispatch }: InfoPanelProps) {
  return (
    <aside className="cad-info" aria-label="Inspector">
      <header className="cad-info-header">
        <h2>{headerFor(selection)}</h2>
      </header>
      <div className="cad-info-body">{renderBody(model, selection, onDispatch)}</div>
    </aside>
  );
}

function headerFor(selection: readonly SelectionItem[]): string {
  if (selection.length === 0) return "Inspector";
  if (selection.length === 1) return "Inspector";
  return `${selection.length} items`;
}

function renderBody(
  model: CadModel,
  selection: readonly SelectionItem[],
  onDispatch: (action: CanvasAction) => void,
) {
  if (selection.length === 0) return <Empty />;

  if (selection.length === 1) {
    const item = selection[0]!;
    switch (item.kind) {
      case "point":
        return <PointInfo model={model} pointId={item.id} />;
      case "line":
        return (
          <LineInfo model={model} lineId={item.id} onDispatch={onDispatch} />
        );
      case "boundary":
        return <BoundaryInfo model={model} boundaryId={item.id} />;
      case "domain":
        return <DomainInfo model={model} domainId={item.id} />;
    }
  }

  return (
    <MultiSummary
      model={model}
      selection={selection}
      onDispatch={onDispatch}
    />
  );
}

// ── empty / hint ─────────────────────────────────────────────────────────

function Empty() {
  return (
    <div className="cad-info-empty">
      <p>Nothing selected.</p>
      <ul className="cad-hint">
        <li>
          <kbd>dbl-click</kbd> empty space → add a Point
        </li>
        <li>
          <kbd>dbl-click</kbd> + drag a Point → draw a new Line
        </li>
        <li>
          <kbd>dbl-click</kbd> + drag a Line → split + drag new Point
        </li>
        <li>
          <kbd>drag</kbd> a Point → move it
        </li>
        <li>
          <kbd>drag</kbd> a Line → translate it
        </li>
        <li>
          <kbd>shift</kbd>+click → toggle in selection (multi-select)
        </li>
        <li>
          <kbd>drag</kbd> on empty space → lasso-select Points and Lines
        </li>
        <li>
          <kbd>shift</kbd>+drag → pan · <kbd>wheel</kbd> → zoom
        </li>
      </ul>
    </div>
  );
}

// ── multi-selection summary ──────────────────────────────────────────────

function MultiSummary({
  model,
  selection,
  onDispatch,
}: {
  model: CadModel;
  selection: readonly SelectionItem[];
  onDispatch: (a: CanvasAction) => void;
}) {
  const counts = { point: 0, line: 0, boundary: 0, domain: 0 };
  for (const s of selection) counts[s.kind]++;
  const arcCount = countSelectedArcs(model, selection);

  return (
    <>
      <dl className="cad-info-dl">
        <Term label="Selected">
          <ul className="cad-info-bcs">
            {counts.point > 0 && <li>{counts.point} point{counts.point === 1 ? "" : "s"}</li>}
            {counts.line > 0 && <li>{counts.line} line{counts.line === 1 ? "" : "s"}</li>}
            {counts.boundary > 0 && <li>{counts.boundary} boundar{counts.boundary === 1 ? "y" : "ies"}</li>}
            {counts.domain > 0 && <li>{counts.domain} domain{counts.domain === 1 ? "" : "s"}</li>}
          </ul>
        </Term>
      </dl>
      {(counts.line > 0 || arcCount > 0) && (
        <div className="cad-info-actions">
          {counts.line > 0 && (
            <button
              type="button"
              className="cad-info-btn"
              onClick={() => onDispatch({ type: "flipSelectedLines" })}
              title="Flip the direction of every selected line (F)"
            >
              Flip {counts.line === 1 ? "line" : `${counts.line} lines`}
              <kbd>F</kbd>
            </button>
          )}
          {arcCount > 0 && (
            <button
              type="button"
              className="cad-info-btn"
              onClick={() =>
                onDispatch({ type: "flipSelectedArcCentres" })
              }
              title="Mirror every selected arc's centre across its chord"
            >
              Flip {arcCount === 1 ? "arc" : `${arcCount} arcs`}
            </button>
          )}
        </div>
      )}
    </>
  );
}

// ── single-entity views ──────────────────────────────────────────────────

function PointInfo({
  model,
  pointId,
}: {
  model: CadModel;
  pointId: string;
}) {
  const p = model.points.find((q) => q.id === pointId);
  if (!p) return <Missing kind="Point" />;
  return (
    <dl className="cad-info-dl">
      <Term label="Kind">Point</Term>
      <Term label="x">{fmt(p.x)}</Term>
      <Term label="y">{fmt(p.y)}</Term>
      <Term label="id">
        <Mono>{p.id}</Mono>
      </Term>
    </dl>
  );
}

function LineInfo({
  model,
  lineId,
  onDispatch,
}: {
  model: CadModel;
  lineId: string;
  onDispatch: (a: CanvasAction) => void;
}) {
  const l = model.lines.find((x) => x.id === lineId);
  if (!l) return <Missing kind="Line" />;
  const pts = pointMap(model.points);
  const start = pts.get(l.startId);
  const end = pts.get(l.endId);
  const arcCentre = l.arcCentreId ? pts.get(l.arcCentreId) : undefined;
  const bc = getBcAssignment(model, lineId);
  const setBc = (direction: "x" | "y", next: DirectionBc | undefined) =>
    onDispatch({ type: "setLineBc", lineId, direction, bc: next });
  const meshing = getLineDiscretisation(model, lineId);
  const setMeshing = (
    next: Omit<LineDiscretisation, "lineId"> | undefined,
  ) => onDispatch({ type: "setLineMeshing", lineId, value: next });
  return (
    <>
      <dl className="cad-info-dl">
        <Term label="Kind">{l.arcCentreId ? "Arc" : "Line"}</Term>
        <Term label="From">{start ? coords(start) : "(missing)"}</Term>
        <Term label="To">{end ? coords(end) : "(missing)"}</Term>
        {arcCentre && <Term label="Arc centre">{coords(arcCentre)}</Term>}
      </dl>
      <div className="cad-bc-section">
        <div className="cad-bc-title">Boundary conditions</div>
        <BcEditor
          axis="x"
          bc={bc?.x}
          onChange={(next) => setBc("x", next)}
        />
        <BcEditor
          axis="y"
          bc={bc?.y}
          onChange={(next) => setBc("y", next)}
        />
      </div>
      <MeshingEditor meshing={meshing} onChange={setMeshing} />
      <div className="cad-info-actions">
        <button
          type="button"
          className="cad-info-btn"
          onClick={() => onDispatch({ type: "flipSelectedLines" })}
          title="Swap start ↔ end; outward normal flips to the other side (F)"
        >
          Flip direction
          <kbd>F</kbd>
        </button>
        {!l.arcCentreId ? (
          <button
            type="button"
            className="cad-info-btn"
            onClick={() =>
              onDispatch({ type: "convertLineToArc", lineId })
            }
            title="Make this a 90° arc; centre point goes on the outward-normal side"
          >
            Convert to arc
          </button>
        ) : (
          <button
            type="button"
            className="cad-info-btn"
            onClick={() => onDispatch({ type: "flipArcCentre", lineId })}
            title="Mirror the arc centre across the chord — the arc bulges to the other side"
          >
            Flip arc
          </button>
        )}
      </div>
    </>
  );
}

function BoundaryInfo({
  model,
  boundaryId,
}: {
  model: CadModel;
  boundaryId: string;
}) {
  const b = model.boundaries.find((x) => x.id === boundaryId);
  if (!b) return <Missing kind="Boundary" />;
  const pts = pointMap(model.points);
  const lns = new Map(model.lines.map((l) => [l.id, l]));
  return (
    <dl className="cad-info-dl">
      <Term label="Kind">Boundary</Term>
      <Term label="Name">{b.name}</Term>
      <Term label="Segments">
        <ol className="cad-info-segments">
          {b.segments.map((seg, i) => {
            const l = lns.get(seg.lineId);
            if (!l) return <li key={i}>(missing line)</li>;
            const start = pts.get(seg.direction === 1 ? l.startId : l.endId);
            const end = pts.get(seg.direction === 1 ? l.endId : l.startId);
            return (
              <li key={i}>
                {start ? coords(start) : "?"} → {end ? coords(end) : "?"}
              </li>
            );
          })}
        </ol>
      </Term>
    </dl>
  );
}

function DomainInfo({
  model,
  domainId,
}: {
  model: CadModel;
  domainId: string;
}) {
  const d = model.domains.find((x) => x.id === domainId);
  if (!d) return <Missing kind="Domain" />;
  const bById = new Map(model.boundaries.map((b) => [b.id, b]));
  return (
    <dl className="cad-info-dl">
      <Term label="Kind">Domain</Term>
      <Term label="Name">{d.name}</Term>
      <Term label="Boundaries">
        <ol className="cad-info-segments">
          {d.boundaryIds.map((bid, i) => {
            const b = bById.get(bid);
            return (
              <li key={i}>
                {b ? `${b.name} (${b.segments.length} segments)` : "(missing)"}
              </li>
            );
          })}
        </ol>
      </Term>
    </dl>
  );
}

// ── Meshing editor ───────────────────────────────────────────────────────

const NODE_PRESETS: readonly {
  readonly label: string;
  readonly values: readonly [number, number, number];
}[] = [
  { label: "Continuous", values: [-1, 0, 1] },
  { label: "Uniform", values: [-2 / 3, 0, 2 / 3] },
];

/**
 * Snap targets a dragged handle can settle on. Every 1/10 in [-1, +1] plus
 * the canonical irrationals (±1/3, ±2/3) and the half-quarter splits
 * (±0.25, ±0.75) that don't fall on the 1/10 grid.
 */
const SNAP_TARGETS: readonly number[] = (() => {
  const s = new Set<number>();
  for (let i = -10; i <= 10; i++) s.add(i / 10);
  for (const v of [
    0.25, -0.25,
    0.75, -0.75,
    1 / 3, -1 / 3,
    2 / 3, -2 / 3,
    5 / 6, -5 / 6,
  ]) {
    s.add(v);
  }
  return [...s].sort((a, b) => a - b);
})();

/** Tiny epsilon so adjacent handles can't sit on top of each other. */
const ORDER_EPS = 1e-6;

/**
 * Move node `k` toward `targetEta`, clamped to [-1, +1] and strictly inside
 * its neighbours, then snapped to the nearest valid snap target. Returns the
 * updated triple. If the neighbours are too close to leave any room, returns
 * the original.
 */
function dragNode(
  nodes: readonly [number, number, number],
  k: 0 | 1 | 2,
  targetEta: number,
): readonly [number, number, number] {
  let lo = -1;
  let hi = 1;
  if (k > 0) lo = nodes[k - 1]! + ORDER_EPS;
  if (k < 2) hi = nodes[k + 1]! - ORDER_EPS;
  if (lo > hi) return nodes;
  const clamped = Math.max(lo, Math.min(hi, targetEta));
  let best = clamped;
  let bestDist = Infinity;
  for (const t of SNAP_TARGETS) {
    if (t < lo || t > hi) continue;
    const d = Math.abs(t - clamped);
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  if (best === nodes[k]) return nodes;
  const next: [number, number, number] = [nodes[0]!, nodes[1]!, nodes[2]!];
  next[k] = best;
  return next;
}


function MeshingEditor({
  meshing,
  onChange,
}: {
  meshing: LineDiscretisation | undefined;
  onChange: (next: Omit<LineDiscretisation, "lineId"> | undefined) => void;
}) {
  const elements = meshing?.elementsPerLine ?? DEFAULT_ELEMENTS_PER_LINE;
  const localNodes = meshing?.localNodes ?? DEFAULT_LOCAL_NODES;
  const isDefault =
    !meshing ||
    (meshing.elementsPerLine === undefined &&
      meshing.localNodes === undefined);

  const setElements = (n: number) => {
    if (!Number.isFinite(n) || n < 1) return;
    const intN = Math.max(1, Math.floor(n));
    const useDefault = intN === DEFAULT_ELEMENTS_PER_LINE;
    onChange({
      ...(useDefault ? {} : { elementsPerLine: intN }),
      ...(meshing?.localNodes !== undefined
        ? { localNodes: meshing.localNodes }
        : {}),
    });
  };

  // Single helper for any localNodes change (typed input, preset chip,
  // dragged handle). If the new values match the defaults exactly we drop
  // the override so the model stays sparse.
  const setLocalNodes = (values: readonly [number, number, number]) => {
    const isDefaultLocal =
      values[0] === DEFAULT_LOCAL_NODES[0] &&
      values[1] === DEFAULT_LOCAL_NODES[1] &&
      values[2] === DEFAULT_LOCAL_NODES[2];
    onChange({
      ...(meshing?.elementsPerLine !== undefined
        ? { elementsPerLine: meshing.elementsPerLine }
        : {}),
      ...(isDefaultLocal ? {} : { localNodes: values }),
    });
  };

  const setPreset = (values: readonly [number, number, number]) => {
    setLocalNodes(values);
  };

  const setLocal = (idx: 0 | 1 | 2, v: number) => {
    if (!Number.isFinite(v)) return;
    const next: [number, number, number] = [
      localNodes[0]!,
      localNodes[1]!,
      localNodes[2]!,
    ];
    next[idx] = v;
    setLocalNodes(next);
  };

  return (
    <div className="cad-bc-section">
      <div className="cad-bc-title">
        Meshing
        {!isDefault && (
          <button
            type="button"
            className="cad-bc-reset"
            onClick={() => onChange(undefined)}
            title="Reset to defaults (2 elements, η = ±2/3, 0)"
          >
            reset
          </button>
        )}
      </div>
      <div className="cad-mesh-row">
        <label className="cad-mesh-label" htmlFor="mesh-n">
          Elements on this line
        </label>
        <input
          id="mesh-n"
          type="number"
          className="cad-bc-value cad-mesh-int"
          min={1}
          step={1}
          value={elements}
          onChange={(e) => setElements(parseInt(e.target.value, 10))}
        />
      </div>
      <div className="cad-mesh-row">
        <label className="cad-mesh-label">Local coords</label>
        <div className="cad-mesh-etas">
          {([0, 1, 2] as const).map((i) => (
            <input
              key={i}
              type="number"
              className="cad-bc-value cad-mesh-eta"
              step="any"
              value={formatEta(localNodes[i]!)}
              onChange={(e) => setLocal(i, parseFloat(e.target.value))}
              title={`η_${i + 1} ∈ [-1, +1]`}
            />
          ))}
        </div>
      </div>
      <div className="cad-mesh-row">
        <label className="cad-mesh-label">Presets</label>
        <div className="cad-mesh-presets">
          {NODE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="cad-mesh-preset"
              onClick={() => setPreset(p.values)}
              title={`Set local coords to ${p.values
                .map(formatEta)
                .join(", ")}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <ShapeFunctionPlot nodes={localNodes} onChange={setLocalNodes} />
    </div>
  );
}

/**
 * Small SVG preview of the three quadratic shape functions over η ∈ [-1, +1].
 * Plots y ∈ [-2, +2]. Updates live whenever the user edits the local coords.
 * The three curves are coloured distinctly; each curve gets Kronecker-delta
 * markers at every node (1 at its own node, 0 at the others).
 */
function ShapeFunctionPlot({
  nodes,
  onChange,
}: {
  nodes: readonly [number, number, number];
  onChange?: (next: readonly [number, number, number]) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragIdx, setDragIdx] = useState<0 | 1 | 2 | null>(null);
  const W = 260;
  const H = 130;
  const padL = 22;
  const padR = 6;
  const padT = 6;
  const padB = 18;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xMin = -1;
  const xMax = 1;
  const yMin = -2;
  const yMax = 2;
  const xPx = (x: number) =>
    padL + ((x - xMin) / (xMax - xMin)) * innerW;
  const yPx = (y: number) =>
    padT + ((yMax - y) / (yMax - yMin)) * innerH;
  // Convert a client-space x (CSS pixels) to η on the plot.
  const clientToEta = (clientX: number): number => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const rect = svg.getBoundingClientRect();
    // SVG uses viewBox 0..W with preserveAspectRatio=meet and height:auto,
    // so client width maps linearly to viewBox width.
    const svgX = ((clientX - rect.left) / rect.width) * W;
    const frac = (svgX - padL) / innerW;
    return xMin + frac * (xMax - xMin);
  };

  // Ref to the latest nodes so the move handler always sees the freshest
  // triple without us having to re-attach window listeners every frame.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Global mouse handlers while dragging — listening on the window means
  // the handle keeps tracking even when the cursor leaves the SVG.
  useEffect(() => {
    if (dragIdx === null) return;
    const onMove = (e: MouseEvent) => {
      const eta = clientToEta(e.clientX);
      const cur = nodesRef.current;
      const next = dragNode(cur, dragIdx, eta);
      if (next !== cur) onChange?.(next);
    };
    const onUp = () => setDragIdx(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIdx]);

  const SAMPLES = 81;
  const xs: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    xs.push(xMin + (i / (SAMPLES - 1)) * (xMax - xMin));
  }
  const curves: [number[], number[], number[]] = [[], [], []];
  for (const x of xs) {
    const N = shapeFunctions(x, nodes);
    curves[0].push(N[0]);
    curves[1].push(N[1]);
    curves[2].push(N[2]);
  }

  const colors = [
    "var(--accent)",
    "var(--bc-anchor)",
    "var(--bc-traction)",
  ] as const;

  const pathFor = (vals: readonly number[]) =>
    vals
      .map((v, i) => `${i === 0 ? "M" : "L"} ${xPx(xs[i]!)} ${yPx(v)}`)
      .join(" ");

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="cad-mesh-plot"
      aria-label="Shape function preview"
    >
      {/* y = 0 axis */}
      <line
        x1={padL}
        y1={yPx(0)}
        x2={W - padR}
        y2={yPx(0)}
        stroke="currentColor"
        strokeWidth={0.5}
        opacity={0.4}
      />
      {/* y = 1 reference line */}
      <line
        x1={padL}
        y1={yPx(1)}
        x2={W - padR}
        y2={yPx(1)}
        stroke="currentColor"
        strokeWidth={0.5}
        opacity={0.15}
        strokeDasharray="2 2"
      />
      {/* x = 0 axis */}
      <line
        x1={xPx(0)}
        y1={padT}
        x2={xPx(0)}
        y2={H - padB}
        stroke="currentColor"
        strokeWidth={0.5}
        opacity={0.4}
      />
      {/* vertical guides at each node coord */}
      {nodes.map((n, i) => (
        <line
          key={`vg${i}`}
          x1={xPx(n)}
          y1={padT}
          x2={xPx(n)}
          y2={H - padB}
          stroke="currentColor"
          strokeWidth={0.5}
          opacity={0.18}
          strokeDasharray="2 2"
        />
      ))}
      {/* 3 shape function curves */}
      {curves.map((vals, k) => (
        <path
          key={`c${k}`}
          d={pathFor(vals)}
          fill="none"
          stroke={colors[k]}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {/* Kronecker-delta markers: N_k(η_j) = δ_kj. For each (k, j), a dot at
          (η_j, 1) if k===j else (η_j, 0). 9 dots total, coloured by k. */}
      {nodes.map((_, k) =>
        nodes.map((etaJ, j) => (
          <circle
            key={`m${k}-${j}`}
            cx={xPx(etaJ)}
            cy={yPx(k === j ? 1 : 0)}
            r={2.3}
            fill={colors[k]}
            stroke="canvas"
            strokeWidth={0.5}
          />
        )),
      )}
      {/* x-axis labels */}
      <text x={xPx(-1)} y={H - 4} textAnchor="middle" fontSize="8" fill="currentColor" opacity={0.55}>−1</text>
      <text x={xPx(0)} y={H - 4} textAnchor="middle" fontSize="8" fill="currentColor" opacity={0.55}>0</text>
      <text x={xPx(1)} y={H - 4} textAnchor="middle" fontSize="8" fill="currentColor" opacity={0.55}>+1</text>
      {/* y-axis labels */}
      <text x={padL - 3} y={yPx(0) + 3} textAnchor="end" fontSize="8" fill="currentColor" opacity={0.55}>0</text>
      <text x={padL - 3} y={yPx(1) + 3} textAnchor="end" fontSize="8" fill="currentColor" opacity={0.55}>1</text>
      <text x={padL - 3} y={yPx(2) + 3} textAnchor="end" fontSize="8" fill="currentColor" opacity={0.55}>2</text>
      <text x={padL - 3} y={yPx(-1) + 3} textAnchor="end" fontSize="8" fill="currentColor" opacity={0.55}>−1</text>
      <text x={padL - 3} y={yPx(-2) + 3} textAnchor="end" fontSize="8" fill="currentColor" opacity={0.55}>−2</text>
      {/* Draggable handles on the x-axis at each node coord — black filled
          circles with a halo on hover/drag, slightly larger hit area for
          easier grabbing. */}
      {onChange &&
        nodes.map((eta, k) => {
          const idx = k as 0 | 1 | 2;
          const active = dragIdx === idx;
          return (
            <g key={`h${k}`}>
              <circle
                cx={xPx(eta)}
                cy={yPx(0)}
                r={7}
                fill="transparent"
                style={{ cursor: "ew-resize" }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDragIdx(idx);
                }}
              />
              <circle
                cx={xPx(eta)}
                cy={yPx(0)}
                r={active ? 4.5 : 3.5}
                fill="black"
                stroke="canvas"
                strokeWidth={1.2}
                pointerEvents="none"
              />
            </g>
          );
        })}
    </svg>
  );
}

/** Show η = ±2/3 etc. as a 4-dp decimal, trimming trailing zeros. */
function formatEta(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return n.toString();
  return parseFloat(n.toFixed(4)).toString();
}

// ── BC editor ────────────────────────────────────────────────────────────

function BcEditor({
  axis,
  bc,
  onChange,
}: {
  axis: "x" | "y";
  bc: DirectionBc | undefined;
  onChange: (next: DirectionBc | undefined) => void;
}) {
  // Defaults when the line has no entry in this direction: traction = 0,
  // matching the BEM free-surface convention.
  const kind = bc?.kind ?? "traction";
  const value = bc?.value ?? 0;
  const unit = kind === "traction" ? "MPa" : "mm";
  const tractionId = `bc-${axis}-t`;
  const dispId = `bc-${axis}-d`;

  return (
    <div className="cad-bc-row">
      <span className="cad-bc-axis">{axis.toUpperCase()}</span>
      <label className="cad-bc-radio" htmlFor={tractionId}>
        <input
          id={tractionId}
          type="radio"
          name={`bc-${axis}-kind`}
          checked={kind === "traction"}
          onChange={() => onChange({ kind: "traction", value })}
        />
        t
      </label>
      <label className="cad-bc-radio" htmlFor={dispId}>
        <input
          id={dispId}
          type="radio"
          name={`bc-${axis}-kind`}
          checked={kind === "displacement"}
          onChange={() => onChange({ kind: "displacement", value })}
        />
        d
      </label>
      <input
        type="number"
        className="cad-bc-value"
        value={value}
        step="any"
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v)) onChange({ kind, value: v });
        }}
      />
      <span className="cad-bc-unit">{unit}</span>
    </div>
  );
}

// ── small helpers ────────────────────────────────────────────────────────

function Term({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Missing({ kind }: { kind: string }) {
  return (
    <p className="cad-info-empty">
      {kind} no longer exists (probably deleted).
    </p>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="cad-info-mono">{children}</code>;
}

function fmt(n: number, digits = 4): string {
  if (Number.isInteger(n)) return n.toString();
  return parseFloat(n.toFixed(digits)).toString();
}

function coords(p: { x: number; y: number }): string {
  return `(${fmt(p.x)}, ${fmt(p.y)})`;
}
