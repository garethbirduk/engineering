// localStorage auto-save + file download/upload for the CadModel.

import { deserialize, serialize, type CadModel } from "@bem/engine";

const STORAGE_KEY = "bem-cad-model";

/** Persist to localStorage. Best-effort — quota / privacy errors are logged. */
export function saveToLocalStorage(model: CadModel): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(model));
  } catch (e) {
    console.warn("[bem] localStorage save failed:", e);
  }
}

/** Read from localStorage; null if nothing there or unreadable. */
export function loadFromLocalStorage(): CadModel | null {
  try {
    const json = localStorage.getItem(STORAGE_KEY);
    if (!json) return null;
    return deserialize(json);
  } catch (e) {
    console.warn("[bem] localStorage load failed:", e);
    return null;
  }
}

/** Trigger a browser download of the model as a JSON file. */
export function downloadAsJsonFile(model: CadModel): void {
  const blob = new Blob([serialize(model)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bem-mesh-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Pop the OS file picker and resolve to the parsed model, or null if
 * cancelled / failed. On parse error we alert with the reason — failures
 * shouldn't silently leave the user without feedback.
 */
export function loadFromJsonFile(): Promise<CadModel | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((text) => {
          try {
            resolve(deserialize(text));
          } catch (e) {
            alert(`Could not load ${file.name}:\n${(e as Error).message}`);
            resolve(null);
          }
        })
        .catch((e) => {
          alert(`Could not read ${file.name}:\n${String(e)}`);
          resolve(null);
        });
    };
    input.click();
  });
}
