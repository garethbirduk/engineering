// Context-aware action bar.
//
// Buttons appear only when their action is applicable. Boundaries are
// created as a by-product of creating a domain — there's no standalone
// "Create boundary" button.

interface ToolbarProps {
  readonly canCreateDomain: boolean;
  readonly canDelete: boolean;
  readonly selectionSummary: string;
  readonly onCreateDomain: () => void;
  readonly onDelete: () => void;
}

export function Toolbar({
  canCreateDomain,
  canDelete,
  selectionSummary,
  onCreateDomain,
  onDelete,
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
    </div>
  );
}
