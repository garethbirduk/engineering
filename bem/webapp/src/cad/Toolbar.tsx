// Context-aware action bar.
//
// Left group  — selection-driven create/delete actions.
// Right group — always-visible file actions (New / Save / Load).
// Between    — selection summary.

interface ToolbarProps {
  readonly canCreateDomain: boolean;
  readonly canDelete: boolean;
  readonly meshVisible: boolean;
  readonly resultsVisible: boolean;
  readonly canShowResults: boolean;
  readonly internalNodesVisible: boolean;
  readonly canShowInternalNodes: boolean;
  readonly interiorResultsVisible: boolean;
  readonly canShowInteriorResults: boolean;
  readonly selectionSummary: string;
  readonly onCreateDomain: () => void;
  readonly onDelete: () => void;
  readonly onToggleMesh: () => void;
  readonly onToggleResults: () => void;
  readonly onToggleInternalNodes: () => void;
  readonly onToggleInteriorResults: () => void;
  readonly onSave: () => void;
  readonly onLoad: () => void;
  readonly onNew: () => void;
}

export function Toolbar({
  canCreateDomain,
  canDelete,
  meshVisible,
  resultsVisible,
  canShowResults,
  internalNodesVisible,
  canShowInternalNodes,
  interiorResultsVisible,
  canShowInteriorResults,
  selectionSummary,
  onCreateDomain,
  onDelete,
  onToggleMesh,
  onToggleResults,
  onToggleInternalNodes,
  onToggleInteriorResults,
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
        className={`cad-tool ${interiorResultsVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleInteriorResults}
        aria-pressed={interiorResultsVisible}
        disabled={!canShowInteriorResults}
        title={
          canShowInteriorResults
            ? "Show / hide interior ux contour (red +ve, blue -ve, green zero)"
            : "Need a domain + boundary conditions to enable"
        }
      >
        Interior results (ux)
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
