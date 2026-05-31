// RHS info panel.
//
// Empty selection         → gesture hint.
// One item selected       → full inspector for that item.
// More than one selected  → summary with counts by kind.

import { useEffect, useRef, useState } from "react";
import type {
  CadModel,
  DirectionBc,
  Id,
  LineDiscretisation,
  MaterialProperties,
  SolveStats,
} from "@bem/engine";
import { resolveMaterial, shapeFunctions } from "@bem/engine";
import { MatrixView } from "./MatrixPanel.js";
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
  /** Whether the embedded matrix view is visible (toggled from the
   *  toolbar). When true, the schematic renders at the top of the
   *  Inspector body and the user can drag the LHS resizer to make
   *  it as big as they like. */
  readonly matrixVisible: boolean;
  readonly solveStats: SolveStats | null;
  /** Global DOF indices to highlight on the matrix view — derived
   *  from the current line selection by the caller. */
  readonly matrixHighlightedDofs: ReadonlySet<number>;
}

export function InfoPanel({
  model,
  selection,
  onDispatch,
  matrixVisible,
  solveStats,
  matrixHighlightedDofs,
}: InfoPanelProps) {
  return (
    <aside className="cad-info" aria-label="Inspector">
      <header className="cad-info-header">
        <h2>{headerFor(selection)}</h2>
      </header>
      <div className="cad-info-body">
        {matrixVisible && (
          <MatrixView
            solveStats={solveStats}
            highlightedDofs={matrixHighlightedDofs}
          />
        )}
        {renderBody(model, selection, onDispatch)}
      </div>
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
  if (selection.length === 0) return <Empty model={model} onDispatch={onDispatch} />;

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

function Empty({
  model,
  onDispatch,
}: {
  model: CadModel;
  onDispatch: (a: CanvasAction) => void;
}) {
  return (
    <div className="cad-info-empty">
      <p>Nothing selected.</p>
      <MaterialEditor model={model} onDispatch={onDispatch} />
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

// ── material editor (visible when nothing selected) ──────────────────────

function MaterialEditor({
  model,
  onDispatch,
}: {
  model: CadModel;
  onDispatch: (a: CanvasAction) => void;
}) {
  const mat = resolveMaterial(model);
  const ePrefix = mat.EPrefix ?? 9;
  const eDisplay = mat.E / Math.pow(10, ePrefix);
  const ePrefixIdx = SI_PREFIXES.findIndex((p) => p.power === ePrefix);
  const ePrefixEntry =
    ePrefixIdx < 0 ? SI_PREFIXES.find((p) => p.power === 9)! : SI_PREFIXES[ePrefixIdx]!;

  const writeMat = (next: MaterialProperties) =>
    onDispatch({ type: "setMaterial", material: next });

  const setE = (displayValue: number, prefixPower: number) => {
    if (!Number.isFinite(displayValue)) return;
    writeMat({
      ...mat,
      E: displayValue * Math.pow(10, prefixPower),
      EPrefix: prefixPower,
    });
  };

  const stepEPrefix = (direction: 1 | -1) => {
    const cur = SI_PREFIXES.findIndex((p) => p.power === ePrefixEntry.power);
    const next = direction === 1 ? cur - 1 : cur + 1;
    if (next < 0 || next >= SI_PREFIXES.length) return;
    // Physical E unchanged; only the display hint moves. The input box
    // re-derives its value as E / 10^prefix on the next render.
    writeMat({ ...mat, EPrefix: SI_PREFIXES[next]!.power });
  };

  const setNu = (v: number) => {
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(0, Math.min(0.4999, v));
    writeMat({ ...mat, nu: clamped });
  };

  const setPlaneKind = (kind: "stress" | "strain") => {
    writeMat({ ...mat, planeKind: kind });
  };

  return (
    <div className="cad-bc-section">
      <div className="cad-bc-title">Material</div>
      {/* Young's modulus */}
      <div className="cad-bc-row">
        <span className="cad-bc-axis">E</span>
        <span className="cad-bc-value-wrap">
          <input
            type="number"
            className="cad-bc-value"
            value={formatBcValue(eDisplay)}
            step="any"
            onChange={(e) => setE(parseFloat(e.target.value), ePrefix)}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setE(eDisplay + 1, ePrefix);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setE(eDisplay - 1, ePrefix);
              }
            }}
          />
          <span className="cad-mesh-spin">
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => setE(eDisplay + 1, ePrefix)}
              tabIndex={-1}
              title="Increment by 1"
              aria-label="Increment"
            >
              ▲
            </button>
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => setE(eDisplay - 1, ePrefix)}
              tabIndex={-1}
              title="Decrement by 1"
              aria-label="Decrement"
            >
              ▼
            </button>
          </span>
        </span>
        <span className="cad-bc-unit">
          <span className="cad-bc-prefix-control">
            <span
              className="cad-bc-prefix"
              aria-label={`SI prefix ${ePrefixEntry.symbol || "(none)"}`}
            >
              {ePrefixEntry.symbol || "·"}
            </span>
            <span className="cad-mesh-spin">
              <button
                type="button"
                className="cad-mesh-spin-btn"
                onClick={() => stepEPrefix(1)}
                tabIndex={-1}
                aria-label="Bigger prefix"
                title="Bigger prefix (×1000)"
                disabled={ePrefixIdx === 0}
              >
                ▲
              </button>
              <button
                type="button"
                className="cad-mesh-spin-btn"
                onClick={() => stepEPrefix(-1)}
                tabIndex={-1}
                aria-label="Smaller prefix"
                title="Smaller prefix (÷1000)"
                disabled={ePrefixIdx === SI_PREFIXES.length - 1}
              >
                ▼
              </button>
            </span>
          </span>
          <span className="cad-bc-base">Pa</span>
        </span>
      </div>
      {/* Poisson's ratio */}
      <div className="cad-bc-row">
        <span className="cad-bc-axis">ν</span>
        <span className="cad-bc-value-wrap">
          <input
            type="number"
            className="cad-bc-value"
            value={formatBcValue(mat.nu)}
            step="0.01"
            min={0}
            max={0.4999}
            onChange={(e) => setNu(parseFloat(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setNu(mat.nu + 0.01);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setNu(mat.nu - 0.01);
              }
            }}
          />
          <span className="cad-mesh-spin">
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => setNu(mat.nu + 0.01)}
              tabIndex={-1}
              title="Increment by 0.01"
              aria-label="Increment"
            >
              ▲
            </button>
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => setNu(mat.nu - 0.01)}
              tabIndex={-1}
              title="Decrement by 0.01"
              aria-label="Decrement"
            >
              ▼
            </button>
          </span>
        </span>
        <span className="cad-bc-unit">
          <span className="cad-bc-base">—</span>
        </span>
      </div>
      {/* Plane kind */}
      <div className="cad-bc-row">
        <span className="cad-bc-axis">2D</span>
        <label className="cad-bc-radio">
          <input
            type="radio"
            name="plane-kind"
            checked={mat.planeKind === "stress"}
            onChange={() => setPlaneKind("stress")}
          />
          stress
        </label>
        <label className="cad-bc-radio">
          <input
            type="radio"
            name="plane-kind"
            checked={mat.planeKind === "strain"}
            onChange={() => setPlaneKind("strain")}
          />
          strain
        </label>
      </div>
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

  // Collect line IDs in selection order. BC + meshing edits below apply
  // uniformly to every line in this list.
  const selectedLineIds = selection
    .filter((s): s is Extract<SelectionItem, { kind: "line" }> => s.kind === "line")
    .map((s) => s.id);
  const firstLineId = selectedLineIds[0];
  const firstLineBc = firstLineId
    ? getBcAssignment(model, firstLineId)
    : undefined;
  const firstLineMeshing = firstLineId
    ? getLineDiscretisation(model, firstLineId)
    : undefined;

  const setBcOnAll = (
    direction: "x" | "y",
    next: DirectionBc | undefined,
  ) => {
    for (const id of selectedLineIds) {
      onDispatch({ type: "setLineBc", lineId: id, direction, bc: next });
    }
  };
  const setMeshingOnAll = (
    next: Omit<LineDiscretisation, "lineId"> | undefined,
  ) => {
    for (const id of selectedLineIds) {
      onDispatch({ type: "setLineMeshing", lineId: id, value: next });
    }
  };

  const linesPlural = counts.line === 1 ? "line" : `${counts.line} lines`;

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
              Flip {linesPlural}
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
      {/* BC + meshing editors apply uniformly to every line in the
          selection. The displayed values come from the FIRST selected
          line (selection-order representative); any edit propagates to
          all selected lines, overwriting whatever they each had. */}
      {selectedLineIds.length > 0 && (
        <>
          <div className="cad-bc-section">
            <div className="cad-bc-title">
              Boundary conditions{" "}
              <span className="cad-bc-applies">
                (apply to all {linesPlural})
              </span>
            </div>
            <BcEditor
              axis="x"
              bc={firstLineBc?.x}
              onChange={(next) => setBcOnAll("x", next)}
            />
            <BcEditor
              axis="y"
              bc={firstLineBc?.y}
              onChange={(next) => setBcOnAll("y", next)}
            />
          </div>
          <MeshingEditor
            meshing={firstLineMeshing}
            onChange={setMeshingOnAll}
          />
        </>
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
      <div className="cad-bc-section">
        <div className="cad-bc-title">Geometry</div>
        <dl className="cad-info-dl">
          <Term label="Kind">{l.arcCentreId ? "Arc" : "Line"}</Term>
          <Term label="From">{start ? coords(start) : "(missing)"}</Term>
          <Term label="To">{end ? coords(end) : "(missing)"}</Term>
          {arcCentre && <Term label="Arc centre">{coords(arcCentre)}</Term>}
        </dl>
        <div className="cad-info-actions">
          <button
            type="button"
            className="cad-info-btn"
            onClick={() => onDispatch({ type: "flipSelectedLines" })}
            title="Swap start ↔ end; outward normal flips to the other side (F)"
          >
            Flip outward normal
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
      </div>
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
/**
 * Snap-step node `k` to the next/previous SNAP_TARGETS value that's
 * strictly above (direction +1) or below (-1) its current η, and still
 * inside [-1, +1] and its neighbours. Returns the updated triple, or
 * the original if there's no valid step.
 */
function stepNode(
  nodes: readonly [number, number, number],
  k: 0 | 1 | 2,
  direction: 1 | -1,
): readonly [number, number, number] {
  let lo = -1;
  let hi = 1;
  if (k > 0) lo = nodes[k - 1]! + ORDER_EPS;
  if (k < 2) hi = nodes[k + 1]! - ORDER_EPS;
  const cur = nodes[k]!;
  let target: number | null = null;
  if (direction === 1) {
    for (const t of SNAP_TARGETS) {
      if (t <= cur + ORDER_EPS) continue;
      if (t > hi) break;
      target = t;
      break;
    }
  } else {
    for (let i = SNAP_TARGETS.length - 1; i >= 0; i--) {
      const t = SNAP_TARGETS[i]!;
      if (t >= cur - ORDER_EPS) continue;
      if (t < lo) break;
      target = t;
      break;
    }
  }
  if (target === null) return nodes;
  const next: [number, number, number] = [nodes[0]!, nodes[1]!, nodes[2]!];
  next[k] = target;
  return next;
}

/**
 * Clamp `target` to [-1, +1] AND inside its neighbours' bounds. Used for
 * typed values (no snap — typing is the escape hatch for arbitrary precision).
 */
function clampNode(
  nodes: readonly [number, number, number],
  k: 0 | 1 | 2,
  target: number,
): readonly [number, number, number] {
  let lo = -1;
  let hi = 1;
  if (k > 0) lo = nodes[k - 1]! + ORDER_EPS;
  if (k < 2) hi = nodes[k + 1]! - ORDER_EPS;
  if (lo > hi) return nodes;
  const clamped = Math.max(lo, Math.min(hi, target));
  if (clamped === nodes[k]) return nodes;
  const next: [number, number, number] = [nodes[0]!, nodes[1]!, nodes[2]!];
  next[k] = clamped;
  return next;
}

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


type Triple = readonly [number, number, number];
type PerElement = { readonly [index: string]: Triple };

function MeshingEditor({
  meshing,
  onChange,
}: {
  meshing: LineDiscretisation | undefined;
  onChange: (next: Omit<LineDiscretisation, "lineId"> | undefined) => void;
}) {
  const elements = meshing?.elementsPerLine ?? DEFAULT_ELEMENTS_PER_LINE;
  const baseNodes = meshing?.localNodes ?? DEFAULT_LOCAL_NODES;
  const perElement: PerElement = meshing?.elementLocalNodes ?? {};
  const isDefault =
    !meshing ||
    (meshing.elementsPerLine === undefined &&
      meshing.localNodes === undefined &&
      (!meshing.elementLocalNodes ||
        Object.keys(meshing.elementLocalNodes).length === 0) &&
      !meshing.distinctFirst &&
      !meshing.distinctLast &&
      !meshing.distinctAll);

  // Each flag is INDEPENDENT — backed by an explicit boolean on the model.
  // Backward compat: for older models with NO explicit flags at all, derive
  // from data presence. Once ANY flag is set explicitly all three become
  // explicit (undefined treated as false) so toggling one never silently
  // flips another via data-derivation.
  const hasExplicitFlags =
    meshing !== undefined &&
    (meshing.distinctFirst !== undefined ||
      meshing.distinctLast !== undefined ||
      meshing.distinctAll !== undefined);
  const distinctFirst = hasExplicitFlags
    ? !!meshing?.distinctFirst
    : perElement["0"] !== undefined;
  const distinctLast =
    elements > 1 &&
    (hasExplicitFlags
      ? !!meshing?.distinctLast
      : perElement[String(elements - 1)] !== undefined);
  const distinctAll =
    elements > 1 &&
    (hasExplicitFlags
      ? !!meshing?.distinctAll
      : Array.from({ length: elements }, (_, i) => perElement[String(i)]).every(
          (v) => v !== undefined,
        ));

  /** Build the next LineDiscretisation payload, dropping fields that match
   *  defaults so model.meshing stays sparse. */
  const writeBack = (
    nextBase: Triple,
    nextPerElement: PerElement,
    nextElements: number,
    nextFlags: {
      first?: boolean;
      last?: boolean;
      all?: boolean;
    } = {
      first: distinctFirst,
      last: distinctLast,
      all: distinctAll,
    },
  ) => {
    const useDefaultN = nextElements === DEFAULT_ELEMENTS_PER_LINE;
    const isDefaultBase =
      nextBase[0] === DEFAULT_LOCAL_NODES[0] &&
      nextBase[1] === DEFAULT_LOCAL_NODES[1] &&
      nextBase[2] === DEFAULT_LOCAL_NODES[2];
    const hasPerElement = Object.keys(nextPerElement).length > 0;
    onChange({
      ...(useDefaultN ? {} : { elementsPerLine: nextElements }),
      ...(isDefaultBase ? {} : { localNodes: nextBase }),
      ...(hasPerElement ? { elementLocalNodes: nextPerElement } : {}),
      ...(nextFlags.first ? { distinctFirst: true } : {}),
      ...(nextFlags.last ? { distinctLast: true } : {}),
      ...(nextFlags.all ? { distinctAll: true } : {}),
    });
  };

  // Setting the base (used by inline editor when no checkboxes are set, and
  // by the "middle / all other elements" bucket).
  const setBaseNodes = (values: Triple) => {
    writeBack(values, perElement, elements);
  };

  const setElementNodes = (index: number, values: Triple) => {
    const next: { [k: string]: Triple } = { ...perElement };
    next[String(index)] = values;
    writeBack(baseNodes, next, elements);
  };

  const setElements = (n: number) => {
    if (!Number.isFinite(n) || n < 1) return;
    const newN = Math.max(1, Math.floor(n));
    if (newN === elements) return;
    // Resize per-element overrides. Preserve first (at index 0); preserve
    // last by moving it from old N-1 to new N-1. If distinctAll was on,
    // pad new slots with copies of the base so every element still has an
    // entry.
    const next: { [k: string]: Triple } = {};
    if (distinctFirst && perElement["0"]) next["0"] = perElement["0"];
    if (
      distinctLast &&
      elements > 1 &&
      newN > 1 &&
      perElement[String(elements - 1)]
    ) {
      next[String(newN - 1)] = perElement[String(elements - 1)]!;
    }
    if (distinctAll && newN > 1) {
      for (let i = 0; i < newN; i++) {
        if (!next[String(i)]) next[String(i)] = baseNodes;
      }
    }
    writeBack(baseNodes, next, newN);
  };

  const toggleDistinctFirst = () => {
    const next: { [k: string]: Triple } = { ...perElement };
    if (distinctFirst) {
      // OFF → element 0 stops being distinct unless distinctAll is also on
      // (in which case its entry is still needed to keep distinctAll's
      // "every element has an entry" invariant).
      if (!distinctAll) delete next["0"];
    } else {
      // ON → ensure element 0 has its own entry, defaulting to base.
      if (next["0"] === undefined) next["0"] = baseNodes;
    }
    writeBack(baseNodes, next, elements, {
      first: !distinctFirst,
      last: distinctLast,
      all: distinctAll,
    });
  };

  const toggleDistinctLast = () => {
    const next: { [k: string]: Triple } = { ...perElement };
    const k = String(elements - 1);
    if (distinctLast) {
      if (!distinctAll) delete next[k];
    } else {
      if (next[k] === undefined) next[k] = baseNodes;
    }
    writeBack(baseNodes, next, elements, {
      first: distinctFirst,
      last: !distinctLast,
      all: distinctAll,
    });
  };

  const toggleDistinctAll = () => {
    const next: { [k: string]: Triple } = { ...perElement };
    if (distinctAll) {
      // OFF → drop every entry that isn't still needed by distinctFirst or
      // distinctLast. First / last entries stay if those flags are on, so
      // turning off distinctAll never silently strips them.
      const keep0 = distinctFirst;
      const keepLast = distinctLast && elements > 1;
      for (const key of Object.keys(next)) {
        if (keep0 && key === "0") continue;
        if (keepLast && key === String(elements - 1)) continue;
        delete next[key];
      }
    } else {
      // ON → ensure every index has an entry. Existing first/last entries
      // (or any other previous edits) are preserved.
      for (let i = 0; i < elements; i++) {
        if (next[String(i)] === undefined) next[String(i)] = baseNodes;
      }
    }
    writeBack(baseNodes, next, elements, {
      first: distinctFirst,
      last: distinctLast,
      all: !distinctAll,
    });
  };

  // Compute buckets to render. Empty array = single inline editor (the
  // pre-bucket layout). One or more buckets = stacked ELEMENT sections.
  type Bucket = {
    readonly key: string;
    readonly title: string;
    readonly nodes: Triple;
    readonly onChange: (next: Triple) => void;
    readonly resetWhich?: "first" | "last" | "element";
    readonly elementIndex?: number;
  };
  const buckets: Bucket[] = [];
  if (distinctAll) {
    for (let i = 0; i < elements; i++) {
      const nodes = perElement[String(i)] ?? baseNodes;
      buckets.push({
        key: `e${i}`,
        title: `Element ${i + 1}`,
        nodes,
        onChange: (next) => setElementNodes(i, next),
        resetWhich: "element",
        elementIndex: i,
      });
    }
  } else if (distinctFirst || distinctLast) {
    if (distinctFirst) {
      buckets.push({
        key: "first",
        title: "First element",
        nodes: perElement["0"]!,
        onChange: (next) => setElementNodes(0, next),
      });
    }
    const middleCount =
      elements - (distinctFirst ? 1 : 0) - (distinctLast ? 1 : 0);
    if (middleCount > 0) {
      buckets.push({
        key: "middle",
        title:
          distinctFirst && distinctLast
            ? middleCount === 1
              ? "Middle element"
              : `Middle elements (${middleCount})`
            : `All other elements (${middleCount})`,
        nodes: baseNodes,
        onChange: setBaseNodes,
      });
    }
    if (distinctLast) {
      buckets.push({
        key: "last",
        title: "Last element",
        nodes: perElement[String(elements - 1)]!,
        onChange: (next) => setElementNodes(elements - 1, next),
      });
    }
  }

  return (
    <div className="cad-bc-section">
      <div className="cad-bc-title">
        Meshing
        {!isDefault && (
          <button
            type="button"
            className="cad-bc-reset"
            onClick={() => onChange(undefined)}
            title="Reset to defaults (2 elements, η = ±2/3, 0, no per-element overrides)"
          >
            reset
          </button>
        )}
      </div>
      <div className="cad-mesh-row">
        <label className="cad-mesh-label" htmlFor="mesh-n">
          Elements on this line
        </label>
        <span className="cad-bc-value-wrap">
          <input
            id="mesh-n"
            type="number"
            className="cad-bc-value cad-mesh-int"
            min={1}
            step={1}
            value={elements}
            onChange={(e) => setElements(parseInt(e.target.value, 10))}
            onKeyDown={(e) => {
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setElements(elements + 1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setElements(elements - 1);
              }
            }}
          />
          <span className="cad-mesh-spin">
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => setElements(elements + 1)}
              tabIndex={-1}
              title="Add an element"
              aria-label="Add element"
            >
              ▲
            </button>
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => setElements(elements - 1)}
              tabIndex={-1}
              disabled={elements <= 1}
              title="Remove an element"
              aria-label="Remove element"
            >
              ▼
            </button>
          </span>
        </span>
      </div>
      {elements > 1 && (
        <div className="cad-mesh-checks">
          <label className="cad-mesh-check">
            <input
              type="checkbox"
              checked={distinctFirst}
              onChange={toggleDistinctFirst}
            />
            distinct first
          </label>
          <label className="cad-mesh-check">
            <input
              type="checkbox"
              checked={distinctLast}
              onChange={toggleDistinctLast}
            />
            distinct last
          </label>
          <label className="cad-mesh-check">
            <input
              type="checkbox"
              checked={distinctAll}
              onChange={toggleDistinctAll}
            />
            distinct all
          </label>
        </div>
      )}
      {buckets.length === 0 ? (
        <BucketEditor nodes={baseNodes} onChange={setBaseNodes} />
      ) : (
        buckets.map((b) => {
          const onReset =
            b.resetWhich === "element" && b.elementIndex !== undefined
              ? () => {
                  const next = { ...perElement };
                  delete next[String(b.elementIndex!)];
                  writeBack(baseNodes, next, elements);
                }
              : undefined;
          return (
            <ElementSection
              key={b.key}
              title={b.title}
              {...(onReset ? { onReset } : {})}
            >
              <BucketEditor nodes={b.nodes} onChange={b.onChange} />
            </ElementSection>
          );
        })
      )}
    </div>
  );
}

/** Local-coord inputs + presets + shape function plot for a single bucket. */
function BucketEditor({
  nodes,
  onChange,
}: {
  nodes: Triple;
  onChange: (next: Triple) => void;
}) {
  const setLocal = (idx: 0 | 1 | 2, v: number) => {
    if (!Number.isFinite(v)) return;
    const next = clampNode(nodes, idx, v);
    if (next !== nodes) onChange(next);
  };
  const step = (idx: 0 | 1 | 2, direction: 1 | -1) => {
    const next = stepNode(nodes, idx, direction);
    if (next !== nodes) onChange(next);
  };
  return (
    <>
      <div className="cad-mesh-row">
        <label className="cad-mesh-label">Local coords</label>
        <div className="cad-mesh-etas">
          {([0, 1, 2] as const).map((i) => (
            <div key={i} className="cad-mesh-eta-wrap">
              <input
                type="number"
                className="cad-bc-value cad-mesh-eta"
                step="any"
                value={formatEta(nodes[i]!)}
                onChange={(e) => setLocal(i, parseFloat(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    step(i, 1);
                  } else if (e.key === "ArrowDown") {
                    e.preventDefault();
                    step(i, -1);
                  }
                }}
                title={`η_${i + 1} ∈ [-1, +1] · ↑/↓ snap-steps`}
              />
              <div className="cad-mesh-spin">
                <button
                  type="button"
                  className="cad-mesh-spin-btn"
                  onClick={() => step(i, 1)}
                  tabIndex={-1}
                  title="Snap to next"
                  aria-label="Snap to next"
                >
                  ▲
                </button>
                <button
                  type="button"
                  className="cad-mesh-spin-btn"
                  onClick={() => step(i, -1)}
                  tabIndex={-1}
                  title="Snap to previous"
                  aria-label="Snap to previous"
                >
                  ▼
                </button>
              </div>
            </div>
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
              onClick={() => onChange(p.values)}
              title={`Set local coords to ${p.values
                .map(formatEta)
                .join(", ")}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <ShapeFunctionPlot nodes={nodes} onChange={onChange} />
    </>
  );
}

/** Collapsible sub-section labeled ELEMENT, contains a BucketEditor. */
function ElementSection({
  title,
  onReset,
  children,
}: {
  title: string;
  onReset?: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`cad-element-section ${open ? "is-open" : ""}`}>
      <div className="cad-element-header">
        <button
          type="button"
          className="cad-element-toggle"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="cad-element-arrow">{open ? "▾" : "▸"}</span>
          <span className="cad-element-eyebrow">ELEMENT</span>
          <span className="cad-element-title">{title}</span>
        </button>
        {onReset && (
          <button
            type="button"
            className="cad-bc-reset"
            onClick={onReset}
            title="Reset this element to the base distribution"
          >
            reset
          </button>
        )}
      </div>
      {open && <div className="cad-element-body">{children}</div>}
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

/**
 * SI prefixes available on the BC unit selector, ordered DESCENDING so
 * "up" means a bigger prefix (toward T) and "down" means a smaller one
 * (toward p). `power` is the exponent of 10.
 */
const SI_PREFIXES: readonly { readonly symbol: string; readonly power: number }[] = [
  { symbol: "T", power: 12 },
  { symbol: "G", power: 9 },
  { symbol: "M", power: 6 },
  { symbol: "k", power: 3 },
  { symbol: "", power: 0 },
  { symbol: "m", power: -3 },
  { symbol: "μ", power: -6 },
  { symbol: "n", power: -9 },
  { symbol: "p", power: -12 },
];

/** Default prefix per BC kind, matching the historical MPa / mm display. */
function defaultPrefixPower(kind: "traction" | "displacement"): number {
  return kind === "traction" ? 6 : -3;
}

/** Base unit per BC kind (the part after the prefix). */
function baseUnit(kind: "traction" | "displacement"): string {
  return kind === "traction" ? "Pa" : "m";
}

/** Format the BC value for display — trim trailing zeros, keep useful precision. */
function formatBcValue(v: number): string {
  if (!Number.isFinite(v)) return "0";
  if (v === 0) return "0";
  // 6 sig figs, then trim trailing zeros via parseFloat round-trip.
  return parseFloat(v.toPrecision(6)).toString();
}

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
  const prefix = bc?.prefix ?? defaultPrefixPower(kind);
  const prefixIdx = SI_PREFIXES.findIndex((p) => p.power === prefix);
  const safeIdx = prefixIdx < 0 ? SI_PREFIXES.findIndex((p) => p.power === defaultPrefixPower(kind)) : prefixIdx;
  const prefixEntry = SI_PREFIXES[safeIdx]!;
  const tractionId = `bc-${axis}-t`;
  const dispId = `bc-${axis}-d`;

  /** Step the prefix by one notch; rescale value so the physical
   *  magnitude (value · 10^prefix) is unchanged. direction +1 = bigger
   *  prefix (T-wards), -1 = smaller (p-wards). */
  const stepPrefix = (direction: 1 | -1) => {
    const next = direction === 1 ? safeIdx - 1 : safeIdx + 1;
    if (next < 0 || next >= SI_PREFIXES.length) return;
    const nextEntry = SI_PREFIXES[next]!;
    const newValue = value * Math.pow(10, prefix - nextEntry.power);
    onChange({ kind, value: newValue, prefix: nextEntry.power });
  };

  const setKind = (newKind: "traction" | "displacement") => {
    // Reset prefix to that kind's default — different base unit, different
    // natural prefix.
    onChange({ kind: newKind, value, prefix: defaultPrefixPower(newKind) });
  };

  return (
    <div className="cad-bc-row">
      <span className="cad-bc-axis">{axis.toUpperCase()}</span>
      <label className="cad-bc-radio" htmlFor={tractionId}>
        <input
          id={tractionId}
          type="radio"
          name={`bc-${axis}-kind`}
          checked={kind === "traction"}
          onChange={() => setKind("traction")}
        />
        t
      </label>
      <label className="cad-bc-radio" htmlFor={dispId}>
        <input
          id={dispId}
          type="radio"
          name={`bc-${axis}-kind`}
          checked={kind === "displacement"}
          onChange={() => setKind("displacement")}
        />
        d
      </label>
      <span className="cad-bc-value-wrap">
        <input
          type="number"
          className="cad-bc-value"
          value={formatBcValue(value)}
          step="any"
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange({ kind, value: v, prefix });
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              onChange({ kind, value: value + 1, prefix });
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              onChange({ kind, value: value - 1, prefix });
            }
          }}
        />
        <span className="cad-mesh-spin">
          <button
            type="button"
            className="cad-mesh-spin-btn"
            onClick={() => onChange({ kind, value: value + 1, prefix })}
            tabIndex={-1}
            title="Increment by 1"
            aria-label="Increment"
          >
            ▲
          </button>
          <button
            type="button"
            className="cad-mesh-spin-btn"
            onClick={() => onChange({ kind, value: value - 1, prefix })}
            tabIndex={-1}
            title="Decrement by 1"
            aria-label="Decrement"
          >
            ▼
          </button>
        </span>
      </span>
      <span className="cad-bc-unit">
        {/* Prefix + its own ▲▼ form a single widget so the arrows clearly
            control the prefix and not the input's value. */}
        <span className="cad-bc-prefix-control">
          <span
            className="cad-bc-prefix"
            aria-label={`SI prefix ${prefixEntry.symbol || "(none)"}`}
          >
            {prefixEntry.symbol || "·"}
          </span>
          <span className="cad-mesh-spin">
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => stepPrefix(1)}
              tabIndex={-1}
              aria-label="Bigger prefix"
              title="Bigger prefix (×1000)"
              disabled={safeIdx === 0}
            >
              ▲
            </button>
            <button
              type="button"
              className="cad-mesh-spin-btn"
              onClick={() => stepPrefix(-1)}
              tabIndex={-1}
              aria-label="Smaller prefix"
              title="Smaller prefix (÷1000)"
              disabled={safeIdx === SI_PREFIXES.length - 1}
            >
              ▼
            </button>
          </span>
        </span>
        <span className="cad-bc-base">{baseUnit(kind)}</span>
      </span>
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
