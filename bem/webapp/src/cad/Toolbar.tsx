// Two-axis toolbar: ItemMode × Action.
//
//   [ Point | Line | Boundary | Domain ]   ←  the *kind* of thing
//   [ Select | Delete | Create          ]   ←  the *action*
//
// Hotkeys (handled in CadCanvas):
//   1/2/3/4 — Point / Line / Boundary / Domain
//   S/D/C   — Select / Delete / Create
//   Esc     — cancel current operation / clear selection

import type { Action, ItemMode } from "./reducer.js";

interface ItemModeDef {
  readonly value: ItemMode;
  readonly label: string;
  readonly hotkey: string;
}

interface ActionDef {
  readonly value: Action;
  readonly label: string;
  readonly hotkey: string;
}

const ITEM_MODES: readonly ItemModeDef[] = [
  { value: "point", label: "Point", hotkey: "1" },
  { value: "line", label: "Line", hotkey: "2" },
  { value: "boundary", label: "Boundary", hotkey: "3" },
  { value: "domain", label: "Domain", hotkey: "4" },
];

const ACTIONS: readonly ActionDef[] = [
  { value: "select", label: "Select", hotkey: "S" },
  { value: "delete", label: "Delete", hotkey: "D" },
  { value: "create", label: "Create", hotkey: "C" },
];

interface ToolbarProps {
  readonly itemMode: ItemMode;
  readonly action: Action;
  readonly onItemMode: (mode: ItemMode) => void;
  readonly onAction: (action: Action) => void;
}

export function Toolbar({
  itemMode,
  action,
  onItemMode,
  onAction,
}: ToolbarProps) {
  return (
    <div className="cad-toolbar" role="toolbar" aria-label="CAD tools">
      <div className="cad-toolgroup" aria-label="Item mode">
        {ITEM_MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            className={`cad-tool${
              itemMode === m.value ? " cad-tool--active" : ""
            }`}
            aria-pressed={itemMode === m.value}
            onClick={() => onItemMode(m.value)}
          >
            <span>{m.label}</span>
            <kbd>{m.hotkey}</kbd>
          </button>
        ))}
      </div>

      <div className="cad-toolgroup-sep" aria-hidden="true" />

      <div className="cad-toolgroup" aria-label="Action">
        {ACTIONS.map((a) => (
          <button
            key={a.value}
            type="button"
            className={`cad-tool cad-tool--${a.value}${
              action === a.value ? " cad-tool--active" : ""
            }`}
            aria-pressed={action === a.value}
            onClick={() => onAction(a.value)}
          >
            <span>{a.label}</span>
            <kbd>{a.hotkey}</kbd>
          </button>
        ))}
      </div>
    </div>
  );
}
