// Material model — shared between the geometry layer (where it sits on
// CadModel as a per-project setting) and the analysis layer (where the
// kernels consume it). Kept in its own file so neither module has to
// reach into the other.

/**
 * 2D linear-elastic material.
 *
 * `planeKind` chooses how the out-of-plane assumption maps Poisson:
 *   "strain" → ν' = ν           (long body, no out-of-plane strain)
 *   "stress" → ν' = ν / (1+ν)   (thin sheet, no out-of-plane stress)
 *
 * `EPrefix` is a UI display hint (SI-prefix exponent of 10) so the
 * Inspector can re-render "207 GPa" instead of "2.07e+11 Pa" after a
 * reload — purely cosmetic, doesn't affect any calculation.
 */
export interface MaterialProperties {
  readonly E: number;
  readonly nu: number;
  readonly planeKind: "strain" | "stress";
  readonly EPrefix?: number;
}

/** Default: mild steel (~207 GPa), Poisson 0.3, plane stress. */
export const DEFAULT_MATERIAL: MaterialProperties = {
  E: 207e9,
  nu: 0.3,
  planeKind: "stress",
  EPrefix: 9,
};
