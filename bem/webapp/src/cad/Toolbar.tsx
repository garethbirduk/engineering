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
  readonly selectionSummary: string;
  readonly onCreateDomain: () => void;
  readonly onDelete: () => void;
  readonly onToggleMesh: () => void;
  readonly onToggleResults: () => void;
  readonly onToggleInternalNodes: () => void;
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
  selectionSummary,
  onCreateDomain,
  onDelete,
  onToggleMesh,
  onToggleResults,
  onToggleInternalNodes,
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
        className={`cad-tool ${resultsVisible ? "cad-tool--active" : ""}`}
        onClick={onToggleResults}
        aria-pressed={resultsVisible}
        disabled={!canShowResults}
        title={
          canShowResults
            ? "Show / hide the deformed-shape overlay (computed displacement)"
            : "Add geometry + boundary conditions to enable"
        }
      >
        Displacement results
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
