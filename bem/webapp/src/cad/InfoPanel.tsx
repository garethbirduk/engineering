// RHS info panel.
//
// Two modes:
//   - Normal: show details of the currently-selected entity.
//   - In (Domain, Create): show a checkable list of existing boundaries so
//     the user can build the domain by ticking boundaries.
//
// All state lives outside this component; it dispatches actions when the
// boundary picker is in use.

import type { CadModel, Id } from "@bem/engine";
import { pointMap } from "./operations.js";
import type {
  Action,
  CanvasAction,
  ItemMode,
  Selection,
} from "./reducer.js";

interface InfoPanelProps {
  readonly model: CadModel;
  readonly selection: Selection;
  readonly itemMode: ItemMode;
  readonly action: Action;
  readonly domainDraft: readonly Id[];
  readonly onDispatch: (action: CanvasAction) => void;
}

export function InfoPanel({
  model,
  selection,
  itemMode,
  action,
  domainDraft,
  onDispatch,
}: InfoPanelProps) {
  const isDomainPicker = itemMode === "domain" && action === "create";

  return (
    <aside className="cad-info" aria-label="Inspector">
      <header className="cad-info-header">
        <h2>{isDomainPicker ? "Pick boundaries" : "Inspector"}</h2>
      </header>
      <div className="cad-info-body">
        {isDomainPicker ? (
          <BoundaryPicker
            model={model}
            draft={domainDraft}
            onToggle={(boundaryId) =>
              onDispatch({ type: "toggleDomainDraft", boundaryId })
            }
          />
        ) : selection === null ? (
          <Empty />
        ) : selection.kind === "point" ? (
          <PointInfo model={model} pointId={selection.id} />
        ) : selection.kind === "line" ? (
          <LineInfo
            model={model}
            lineId={selection.id}
            onDispatch={onDispatch}
          />
        ) : selection.kind === "boundary" ? (
          <BoundaryInfo model={model} boundaryId={selection.id} />
        ) : (
          <DomainInfo model={model} domainId={selection.id} />
        )}
      </div>
    </aside>
  );
}

// ── boundary picker (only shown in domain+create) ────────────────────────

function BoundaryPicker({
  model,
  draft,
  onToggle,
}: {
  model: CadModel;
  draft: readonly Id[];
  onToggle: (id: Id) => void;
}) {
  if (model.boundaries.length === 0) {
    return (
      <p className="cad-info-empty">
        No boundaries yet. Create one first using <strong>Boundary · Create</strong>.
      </p>
    );
  }
  const draftSet = new Set(draft);
  return (
    <ul className="cad-picker">
      {model.boundaries.map((b) => {
        const checked = draftSet.has(b.id);
        return (
          <li key={b.id}>
            <label className={`cad-picker-row${checked ? " cad-picker-row--on" : ""}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(b.id)}
              />
              <span className="cad-picker-name">{b.name}</span>
              <span className="cad-picker-meta">
                {b.segments.length} segments
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

// ── selection detail views ───────────────────────────────────────────────

function Empty() {
  return (
    <p className="cad-info-empty">
      Select an item with the Select tool to see its details here.
    </p>
  );
}

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
          onClick={() => onDispatch({ type: "flipLine", lineId })}
          title="Swap start ↔ end; outward normal flips to the other side"
        >
          Flip direction
        </button>
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
