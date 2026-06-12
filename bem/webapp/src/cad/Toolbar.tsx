// Context-aware action bar.
//
// Left group  — selection-driven create/delete actions.
// Right group — always-visible file actions (New / Save / Load).
// Between    — selection summary + last-solve work-done counters.

import { useState } from "react";
import type { SolveStats } from "@bem/engine";
import type { HoverContext } from "./operations.js";
import type { SelectionItem } from "./reducer.js";

interface ToolbarProps {
  readonly canCreateDomain: boolean;
  readonly canDelete: boolean;
  readonly meshVisible: boolean;
  readonly resultsVisible: boolean;
  readonly canShowResults: boolean;
  readonly internalNodesVisible: boolean;
  readonly canShowInternalNodes: boolean;
  readonly matrixVisible: boolean;
  readonly labelsVisible: boolean;
  readonly equationsVisible: boolean;
  readonly sliceMode: boolean;
  readonly canSlice: boolean;
  readonly shapeMode: "circle" | "rect" | "fillet" | null;
  readonly canFillet: boolean;
  readonly hoverContext: HoverContext | null;
  readonly selection: readonly SelectionItem[];
  readonly model: import("@bem/engine").CadModel;
  readonly onConvertHoleToBemDomain: (holeBoundaryId: string) => void;
  readonly onConvertDomainToVoid: (domainId: string) => void;
  readonly selectionSummary: string;
  readonly solveStats: SolveStats | null;
  readonly onCreateDomain: () => void;
  readonly onDelete: () => void;
  readonly onToggleMesh: () => void;
  readonly onToggleResults: () => void;
  readonly onToggleInternalNodes: () => void;
  readonly onToggleMatrix: () => void;
  readonly onToggleLabels: () => void;
  readonly onToggleEquations: () => void;
  readonly onToggleSlice: () => void;
  readonly onSetShapeMode: (
    mode: "circle" | "rect" | "fillet" | null,
  ) => void;
  readonly onSave: () => void;
  readonly onLoad: () => void;
  readonly onNew: () => void;
}

/** Compact number formatter — "1.2k", "47k", "2.3M". Keeps the
 *  toolbar pill narrow for large element counts. */
function fmtCount(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10_000) return (n / 1000).toFixed(1) + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1) + "M";
}

function SolveStatsPill({ stats }: { stats: SolveStats }) {
  const { hits, misses, gaussEvals } = stats.assemble;
  const totalPairs = hits + misses;
  // Reused fraction = hits / total — shows reanalysis savings directly.
  // For a cold solve (cache empty) hits = 0 → 0% reuse → all work fresh.
  // For a no-op re-solve hits = total → 100% reuse → ~0 G-evals.
  const reusedPct =
    totalPairs > 0 ? Math.round((100 * hits) / totalPairs) : 0;
  // Estimate of what the assemble would have cost without the cache.
  // Each pair averages (gaussEvals / misses) evals, so a cold equivalent
  // is roughly totalPairs × that average. Used for the "saved" line in
  // the tooltip — purely informational.
  const evalsPerMiss = misses > 0 ? gaussEvals / misses : 0;
  const coldEstimate = Math.round(totalPairs * evalsPerMiss);
  const luCost = Math.round((stats.unknownDofs ** 3) / 3);
  const tooltip =
    `This solve:\n` +
    `  ${fmtCount(gaussEvals)} Gauss-pt evals (assemble work actually done)\n` +
    `  ${hits.toLocaleString()} / ${totalPairs.toLocaleString()} pair-blocks reused from cache (${reusedPct}%)\n` +
    `  ${misses.toLocaleString()} pair-blocks re-integrated\n` +
    (coldEstimate > gaussEvals
      ? `\nWithout the cache this would have been ~${fmtCount(coldEstimate)} G-evals (${Math.round(100 * (1 - gaussEvals / coldEstimate))}% saved)\n`
      : "") +
    `\nLU on ${stats.unknownDofs} unknown DOFs ≈ ${fmtCount(luCost)} flops`;
  return (
    <div
      className="cad-toolbar-stats"
      title={tooltip}
      aria-label={`Last solve: ${gaussEvals} Gauss-pt evaluations, ${reusedPct}% reused from cache`}
    >
      <span className="cad-toolbar-stats-num">{fmtCount(gaussEvals)}</span>
      <span className="cad-toolbar-stats-unit">G-evals</span>
      <span className="cad-toolbar-stats-sep">·</span>
      <span className="cad-toolbar-stats-reuse">{reusedPct}% cached</span>
    </div>
  );
}

/**
 * Live chip in the toolbar that shows what zone kind the cursor is
 * currently sitting in, and offers conversions via a small dropdown.
 *
 * Today: "BEM" (cursor in some Domain's material) and "void" (cursor
 * in a hole or external space). Designed to extend — the dropdown
 * options come from a simple list, so adding SBFEM-zone or
 * infinite-domain-BEM later is a one-row change.
 */
function ZoneChip({
  hoverContext,
  selection,
  model,
  onConvertHoleToBemDomain,
  onConvertDomainToVoid,
}: {
  readonly hoverContext: HoverContext | null;
  readonly selection: readonly SelectionItem[];
  readonly model: import("@bem/engine").CadModel;
  readonly onConvertHoleToBemDomain: (holeBoundaryId: string) => void;
  readonly onConvertDomainToVoid: (domainId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // Selection drives the chip whenever it contains zone items
  // (Domains or void-holes). That way moving the cursor up to the
  // toolbar — where hoverContext becomes null — doesn't blank out the
  // chip; what you selected stays put until you click again.
  // Otherwise the chip mirrors the live hover.
  const zoneSelection = selection.filter(
    (s): s is Extract<SelectionItem, { kind: "domain" | "void-hole" }> =>
      s.kind === "domain" || s.kind === "void-hole",
  );

  let label: string;
  let subLabel: string | null = null;
  let chipKind: "bem" | "void" | "neutral" = "neutral";
  // Hole boundary ids that the chip's dropdown should convert in bulk
  // (void → BEM). Domain ids similarly for the reverse direction
  // (BEM → void).
  const selectedHoleBoundaryIds: string[] = [];
  const selectedDomainIds: string[] = [];

  if (zoneSelection.length > 0) {
    const first = zoneSelection[0]!;
    if (first.kind === "domain") {
      label = "BEM";
      chipKind = "bem";
      const dName =
        model.domains.find((d) => d.id === first.id)?.name ?? "domain";
      subLabel =
        zoneSelection.length === 1
          ? dName
          : `${dName} + ${zoneSelection.length - 1} more`;
    } else {
      label = "void";
      chipKind = "void";
      const parentName =
        model.domains.find((d) => d.id === first.containingDomainId)?.name ??
        "domain";
      subLabel =
        zoneSelection.length === 1
          ? `in ${parentName}`
          : `in ${parentName} + ${zoneSelection.length - 1} more`;
    }
    // Bulk-conversion targets: any selected void-hole can convert
    // to BEM; any selected Domain can convert back to void.
    for (const s of zoneSelection) {
      if (s.kind === "void-hole")
        selectedHoleBoundaryIds.push(s.holeBoundaryId);
      else if (s.kind === "domain") selectedDomainIds.push(s.id);
    }
  } else if (!hoverContext) {
    label = "—";
  } else if (hoverContext.kind === "bem") {
    label = "BEM";
    chipKind = "bem";
    subLabel = hoverContext.domainName;
  } else if (hoverContext.kind === "void-hole") {
    label = "void";
    chipKind = "void";
    subLabel = `in ${hoverContext.containingDomainName}`;
    selectedHoleBoundaryIds.push(hoverContext.holeBoundaryId);
  } else {
    label = "void";
    chipKind = "void";
    subLabel = "external";
  }

  const options: { key: string; label: string; onClick: () => void }[] = [];
  if (selectedHoleBoundaryIds.length > 0) {
    const allSuffix =
      selectedHoleBoundaryIds.length > 1
        ? ` (convert ${selectedHoleBoundaryIds.length} → zones)`
        : " (convert hole → zone)";
    options.push({
      key: "void-hole-to-bem",
      label: `BEM${allSuffix}`,
      onClick: () => {
        for (const id of selectedHoleBoundaryIds) {
          onConvertHoleToBemDomain(id);
        }
        setOpen(false);
      },
    });
  }
  if (selectedDomainIds.length > 0) {
    const allSuffix =
      selectedDomainIds.length > 1
        ? ` (convert ${selectedDomainIds.length} → void)`
        : " (convert zone → void)";
    options.push({
      key: "domain-to-void",
      label: `void${allSuffix}`,
      onClick: () => {
        for (const id of selectedDomainIds) {
          onConvertDomainToVoid(id);
        }
        setOpen(false);
      },
    });
  }

  const dropdownEnabled = options.length > 0;
  return (
    <div className="cad-zone-chip-wrap">
      <button
        type="button"
        className={`cad-zone-chip ${
          dropdownEnabled ? "cad-zone-chip--active" : ""
        } cad-zone-chip--${chipKind}`}
        onClick={() => dropdownEnabled && setOpen((v) => !v)}
        aria-haspopup={dropdownEnabled ? "menu" : undefined}
        aria-expanded={open}
        title={
          dropdownEnabled
            ? "Click to convert this region"
            : "Region under cursor / selection"
        }
      >
        <span className="cad-zone-chip-kind">{label}</span>
        {subLabel && <span className="cad-zone-chip-sub">{subLabel}</span>}
        {dropdownEnabled && (
          <span className="cad-zone-chip-caret" aria-hidden="true">
            ▾
          </span>
        )}
      </button>
      {open && dropdownEnabled && (
        <div className="cad-zone-chip-menu" role="menu">
          {options.map((o) => (
            <button
              key={o.key}
              type="button"
              role="menuitem"
              className="cad-zone-chip-menu-item"
              onClick={o.onClick}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Toolbar({
  canCreateDomain,
  canDelete,
  meshVisible,
  resultsVisible,
  canShowResults,
  internalNodesVisible,
  canShowInternalNodes,
  matrixVisible,
  labelsVisible,
  equationsVisible,
  sliceMode,
  canSlice,
  shapeMode,
  canFillet,
  hoverContext,
  selection,
  model,
  onConvertHoleToBemDomain,
  onConvertDomainToVoid,
  selectionSummary,
  solveStats,
  onCreateDomain,
  onDelete,
  onToggleMesh,
  onToggleResults,
  onToggleInternalNodes,
  onToggleMatrix,
  onToggleLabels,
  onToggleEquations,
  onToggleSlice,
  onSetShapeMode,
  onSave,
  onLoad,
  onNew,
}: ToolbarProps) {
  return (
    <div className="cad-toolbar" role="toolbar" aria-label="CAD actions">
      {canCreateDomain && (
        <button
          type="button"
          className="cad-tool"
          onClick={onCreateDomain}
          title="Create a domain from the selection (Enter)"
        >
          Create domain
          <kbd>↵</kbd>
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          className="cad-tool cad-tool--delete"
          onClick={onDelete}
          title="Delete selected items (Del / Backspace)"
        >
          Delete
          <kbd>Del</kbd>
        </button>
      )}
      <button
        type="button"
        className={`cad-tool ${shapeMode === "rect" ? "cad-tool--active" : ""}`}
        onClick={() => onSetShapeMode(shapeMode === "rect" ? null : "rect")}
        aria-pressed={shapeMode === "rect"}
        title="Rectangle: click + drag two corners"
      >
        Rect
      </button>
      <button
        type="button"
        className={`cad-tool ${shapeMode === "circle" ? "cad-tool--active" : ""}`}
        onClick={() => onSetShapeMode(shapeMode === "circle" ? null : "circle")}
        aria-pressed={shapeMode === "circle"}
        title="Circle: click + drag from centre to radius (four CCW quarter-arcs)"
      >
        Circle
      </button>
      <button
        type="button"
        className={`cad-tool ${shapeMode === "fillet" ? "cad-tool--active" : ""}`}
        onClick={() =>
          onSetShapeMode(shapeMode === "fillet" ? null : "fillet")
        }
        aria-pressed={shapeMode === "fillet"}
        disabled={!canFillet}
        title={
          canFillet
            ? "Fillet: click a corner Point + drag to set the radius (tangent arc replaces the sharp corner)"
            : "Need a Point joining two straight Lines to enable"
        }
      >
        Fillet
      </button>
      <div className="cad-toolbar-spacer" />
      <ZoneChip
        hoverContext={hoverContext}
        selection={selection}
        model={model}
        onConvertHoleToBemDomain={onConvertHoleToBemDomain}
        onConvertDomainToVoid={onConvertDomainToVoid}
      />
      {solveStats && <SolveStatsPill stats={solveStats} />}
      <div className="cad-toolbar-status" aria-live="polite">
        {selectionSummary}
      </div>
      <div className="cad-toolgroup-sep" aria-hidden="true" />
      <button
        type="button"
        className={`cad-tool ${meshVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleMesh}
        aria-pressed={meshVisible}
        title="Show / hide the derived mesh (2 quadratic elements per line)"
      >
        Mesh
      </button>
      <button
        type="button"
        className={`cad-tool ${internalNodesVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleInternalNodes}
        aria-pressed={internalNodesVisible}
        disabled={!canShowInternalNodes}
        title={
          canShowInternalNodes
            ? "Show / hide interior post-process nodes"
            : "Need a domain to enable"
        }
      >
        Internal nodes
      </button>
      <button
        type="button"
        className={`cad-tool ${resultsVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleResults}
        aria-pressed={resultsVisible}
        disabled={!canShowResults}
        title={
          canShowResults
            ? "Show / hide the deformed boundary overlay (computed displacement)"
            : "Add geometry + boundary conditions to enable"
        }
      >
        Boundary results
      </button>
      <button
        type="button"
        className={`cad-tool ${matrixVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleMatrix}
        aria-pressed={matrixVisible}
        title="Show / hide the BEM system-matrix schematic panel"
      >
        Matrix
      </button>
      <button
        type="button"
        className={`cad-tool ${labelsVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleLabels}
        aria-pressed={labelsVisible}
        title="Show / hide D/B/L/E element address labels + local node numbers"
      >
        Labels
      </button>
      <button
        type="button"
        className={`cad-tool ${equationsVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleEquations}
        aria-pressed={equationsVisible}
        title="Pick a collocation node + a source element to see the 2×6 H and G submatrices"
      >
        Equations
      </button>
      <button
        type="button"
        className={`cad-tool ${sliceMode ? "cad-tool--active" : ""}`}
        onClick={onToggleSlice}
        aria-pressed={sliceMode}
        disabled={!canSlice}
        title={
          canSlice
            ? "Drag a slice line across the domain — the active field is plotted along it in the Results panel"
            : "Pick a field in the Results panel to enable slicing"
        }
      >
        Slice
      </button>
      <div className="cad-toolgroup-sep" aria-hidden="true" />
      <div className="cad-toolgroup" aria-label="File">
        <button
          type="button"
          className="cad-tool"
          onClick={onNew}
          title="Clear the mesh and start fresh"
        >
          New
        </button>
        <button
          type="button"
          className="cad-tool"
          onClick={onSave}
          title="Download the mesh as a JSON file"
        >
          Save
        </button>
        <button
          type="button"
          className="cad-tool"
          onClick={onLoad}
          title="Load a mesh from a JSON file (replaces current)"
        >
          Load
        </button>
      </div>
    </div>
  );
}
