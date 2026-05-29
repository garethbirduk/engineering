// @bem/engine public API.
// Re-exported from sub-namespaces; deep imports (e.g. `@bem/engine/geometry`)
// are also supported via package "exports".

export * from "./geometry/index.js";
export * from "./elements/index.js";
export * from "./numerics/index.js";
export * from "./analysis/index.js";
// MaterialProperties + DEFAULT_MATERIAL are re-exported by analysis/* —
// don't re-export from ./material.js here or it duplicates the symbols.
export * from "./serialize.js";

import type { CadModel } from "./geometry/types.js";
import { DEFAULT_MATERIAL, type MaterialProperties } from "./material.js";

/** Resolve the active material for `model`, falling back to
 *  DEFAULT_MATERIAL when the model has none set (older saves). */
export function resolveMaterial(model: CadModel): MaterialProperties {
  return model.material ?? DEFAULT_MATERIAL;
}

export const ENGINE_VERSION = "0.0.1" as const;
