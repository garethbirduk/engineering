// RHS info panel.
//
// Empty selection         → gesture hint.
// One item selected       → full inspector for that item.
// More than one selected  → summary with counts by kind.

import type { CadModel } from "@bem/engine";
import { pointMap } from "./operations.js";
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
  return (
    <>
      <dl className="cad-info-dl">
        <Term label="Kind">{l.arcCentreId ? "Arc" : "Line"}</Term>
        <Term label="From">{start ? coords(start) : "(missing)"}</Term>
        <Term label="To">{end ? coords(end) : "(missing)"}</Term>
        {arcCentre && <Term label="Arc centre">{coords(arcCentre)}</Term>}
        <Term label="Elements">{l.nElements}</Term>
        <Term label="Local η">
          [{l.localNodes.map((n) => fmt(n, 3)).join(", ")}]
        </Term>
        <Term label="BCs">
          <ul className="cad-info-bcs">
            <li>dx: <BcView bc={l.bcs.dx} /></li>
            <li>dy: <BcView bc={l.bcs.dy} /></li>
            <li>tx: <BcView bc={l.bcs.tx} /></li>
            <li>ty: <BcView bc={l.bcs.ty} /></li>
          </ul>
        </Term>
      </dl>
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

function BcView({ bc }: { bc: { kind: string; value?: number } }) {
  if (bc.kind === "unknown") return <em>unknown</em>;
  return <code className="cad-info-mono">= {fmt(bc.value ?? 0)}</code>;
}

function fmt(n: number, digits = 4): string {
  if (Number.isInteger(n)) return n.toString();
  return parseFloat(n.toFixed(digits)).toString();
}

function coords(p: { x: number; y: number }): string {
  return `(${fmt(p.x)}, ${fmt(p.y)})`;
}
