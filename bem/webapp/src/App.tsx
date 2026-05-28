import { ENGINE_VERSION } from "@bem/engine";
import { CadCanvas } from "./cad/CadCanvas.js";

export function App() {
  return (
    <div className="app">
      <header className="app-header">
        <h1>bem</h1>
        <span className="app-tag">
          DBE-SBFEM port · engine {ENGINE_VERSION}
        </span>
      </header>
      <CadCanvas />
    </div>
  );
}
