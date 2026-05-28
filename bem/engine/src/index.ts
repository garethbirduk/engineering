// @bem/engine public API.
// Re-exported from sub-namespaces; deep imports (e.g. `@bem/engine/geometry`)
// are also supported via package "exports".

export * from "./geometry/index.js";
export * from "./elements/index.js";
export * from "./numerics/index.js";

export const ENGINE_VERSION = "0.0.1" as const;
