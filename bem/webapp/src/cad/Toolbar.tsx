// Context-aware action bar.
//
// Left group  — selection-driven create/delete actions.
// Right group — always-visible file actions (New / Save / Load).
// Between    — selection summary + last-solve work-done counters.

import type { SolveStats } from "@bem/engine";

interface ToolbarProps {
  readonly canCreateDomain: boolean;
  readonly canDelete: boolean;
  readonly meshVisible: boolean;
  readonly resultsVisible: boolean;
  readonly canShowResults: boolean;
  readonly internalNodesVisible: boolean;
  readonly canShowInternalNodes: boolean;
  readonly matrixVisible: boolean;
  readonly selectionSummary: string;
  readonly solveStats: SolveStats | null;
  readonly onCreateDomain: () => void;
  readonly onDelete: () => void;
  readonly onToggleMesh: () => void;
  readonly onToggleResults: () => void;
  readonly onToggleInternalNodes: () => void;
  readonly onToggleMatrix: () => void;
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

export function Toolbar({
  canCreateDomain,
  canDelete,
  meshVisible,
  resultsVisible,
  canShowResults,
  internalNodesVisible,
  canShowInternalNodes,
  matrixVisible,
  selectionSummary,
  solveStats,
  onCreateDomain,
  onDelete,
  onToggleMesh,
  onToggleResults,
  onToggleInternalNodes,
  onToggleMatrix,
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
      <div className="cad-toolbar-spacer" />
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
