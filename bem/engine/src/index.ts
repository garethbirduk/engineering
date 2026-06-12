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

import type { CadModel, DirectionBc } from "./geometry/types.js";
import { DEFAULT_MATERIAL, type MaterialProperties } from "./material.js";

/** Resolve the active material for `model`, falling back to
 *  DEFAULT_MATERIAL when the model has none set (older saves). */
export function resolveMaterial(model: CadModel): MaterialProperties {
  return model.material ?? DEFAULT_MATERIAL;
}

/** Resolve the material for a specific Domain. Per-Domain `material`
 *  wins; then model-level material; then DEFAULT_MATERIAL. Used by
 *  the multi-zone wiring so each Domain's elements can assemble with
 *  their own elastic properties. */
export function resolveDomainMaterial(
  model: CadModel,
  domainId: string,
): MaterialProperties {
  const d = model.domains.find((dd) => dd.id === domainId);
  if (d?.material) return d.material as MaterialProperties;
  return model.material ?? DEFAULT_MATERIAL;
}

/** Build a quick lookup from Line id → Domain id by walking
 *  Domain → Boundary → segment.lineId. The first Domain that
 *  references a given Line wins (rare to have a Line in multiple
 *  Domains; happens for shared interfaces in future multi-zone work).
 *  Returns the map plus the resolved material per Domain so callers
 *  can index by Line directly. */
export function buildLineDomainMap(
  model: CadModel,
): {
  lineDomainId: ReadonlyMap<string, string>;
  domainMaterial: ReadonlyMap<string, MaterialProperties>;
} {
  const lineDomainId = new Map<string, string>();
  const domainMaterial = new Map<string, MaterialProperties>();
  const boundariesById = new Map(model.boundaries.map((b) => [b.id, b]));
  for (const d of model.domains) {
    domainMaterial.set(d.id, resolveDomainMaterial(model, d.id));
    for (const bId of d.boundaryIds) {
      const b = boundariesById.get(bId);
      if (!b) continue;
      for (const seg of b.segments) {
        if (!lineDomainId.has(seg.lineId)) {
          lineDomainId.set(seg.lineId, d.id);
        }
      }
    }
  }
  return { lineDomainId, domainMaterial };
}

/** SI value of a DirectionBc, applying its prefix (G=9, M=6, k=3, …).
 *  Mirrors the converter in elements/discretise.ts but exposed here so
 *  callers that only need the magnitude (e.g. the stress-concentration
 *  reference stress) don't have to rebuild the mesh. */
function bcSiValue(bc: DirectionBc): number {
  const defaultPrefix = bc.kind === "traction" ? 9 : -3;
  return bc.value * Math.pow(10, bc.prefix ?? defaultPrefix);
}

/**
 * Reference stress for stress-concentration-factor (SCF) computations.
 * Defined as the largest applied-traction magnitude across all BCs:
 *
 *   σ_ref = max_lines √( (t_x if prescribed else 0)² + (t_y if prescribed else 0)² )
 *
 * Returns 0 when no traction BCs are set — callers must guard against
 * dividing by zero (a pure-displacement problem has no natural nominal
 * stress; the SCF field is undefined in that case).
 *
 * Units are SI base (Pa).
 */
export function referenceStress(model: CadModel): number {
  let maxMag = 0;
  for (const bc of model.bcs) {
    const tx = bc.x?.kind === "traction" ? bcSiValue(bc.x) : 0;
    const ty = bc.y?.kind === "traction" ? bcSiValue(bc.y) : 0;
    const mag = Math.hypot(tx, ty);
    if (mag > maxMag) maxMag = mag;
  }
  return maxMag;
}

export const ENGINE_VERSION = "0.0.1" as const;
