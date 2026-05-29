// Geometry + topology + BCs.
//
// Three independent layers:
//   - GEOMETRY     : Points, Lines (straight or arc), Boundaries, Domains
//   - BCs          : sparse per-Line, per-direction
//   - DISCRETISATION: not modelled yet — deferred until the analysis engine
//                     starts consuming the geometry
//
// Layer separation lets a single mesh be reused across load cases, and lets
// the analysis derive elemental BCs from the parent line at solve time.

export type Id = string;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

// ── geometry ──────────────────────────────────────────────────────────────

/** A geometric point. Referenced by id from Lines and arcCentres. */
export interface Point {
  readonly id: Id;
  readonly x: number;
  readonly y: number;
}

/**
 * A line segment or circular arc.
 *
 * - Straight when `arcCentreId` is undefined.
 * - Arc when `arcCentreId` is a Point id — curves from `startId` to `endId`
 *   along the circle centred there.
 *
 * Discretisation (element count, nodal η positions) is intentionally NOT
 * stored on the Line. The analysis pipeline will assign that separately when
 * needed.
 */
export interface Line {
  readonly id: Id;
  readonly startId: Id;
  readonly endId: Id;
  readonly arcCentreId?: Id;
}

/** Ordered traversal of a Line as part of a Boundary loop. */
export interface BoundarySegment {
  readonly lineId: Id;
  /** +1 if traversed start→end, -1 if reversed. */
  readonly direction: 1 | -1;
}

/** A closed loop of Lines. */
export interface Boundary {
  readonly id: Id;
  readonly name: string;
  readonly segments: readonly BoundarySegment[];
}

/** A Domain is an ordered list of Boundaries. */
export interface Domain {
  readonly id: Id;
  readonly name: string;
  readonly boundaryIds: readonly Id[];
}

// ── boundary conditions ──────────────────────────────────────────────────

/**
 * For a given direction at a line, you specify EITHER the known displacement
 * OR the known traction (they're duals — one is solved for the other).
 * No assignment in a direction means the BEM default: t = 0 (free surface).
 *
 * `value` is in the units displayed to the user (i.e. multiplied by 10^prefix).
 * `prefix` is the SI exponent of the chosen prefix (M=6, k=3, none=0, m=-3, …).
 * When prefix is undefined the UI defaults to M for traction and m for
 * displacement to match the historical hardcoded MPa / mm display.
 * The physical SI value is `value * 10^prefix`.
 */
export type DirectionBc =
  | {
      readonly kind: "displacement";
      readonly value: number;
      readonly prefix?: number;
    }
  | {
      readonly kind: "traction";
      readonly value: number;
      readonly prefix?: number;
    };

/**
 * Sparse BC assignment for a single Line. Either or both directions may be
 * unset; unset directions default to t = 0.
 */
export interface BcAssignment {
  readonly lineId: Id;
  readonly x?: DirectionBc;
  readonly y?: DirectionBc;
}

// ── discretisation overrides ─────────────────────────────────────────────

/**
 * Per-line override of the default discretisation (2 elements, η = ±2/3, 0).
 * All fields are optional; missing fields fall back to the defaults.
 * Sparse: a Line with no entry uses defaults entirely.
 *
 * `localNodes` is the "base" distribution used by any element that does
 * NOT have its own entry in `elementLocalNodes`. With per-element overrides
 * you can give the first / last / each element its own nodal scheme.
 */
export interface LineDiscretisation {
  readonly lineId: Id;
  readonly elementsPerLine?: number;
  readonly localNodes?: readonly [number, number, number];
  /**
   * Sparse per-element overrides keyed by element index ("0", "1", ...).
   * Missing key → that element uses `localNodes` (or the global default).
   * Length-tied to elementsPerLine: entries with index >= elementsPerLine
   * are ignored at discretise time.
   */
  readonly elementLocalNodes?: {
    readonly [index: string]: readonly [number, number, number];
  };
  /**
   * UI flags tracking which "distinct" checkboxes are on. Independent of
   * each other — toggling one never deselects another. When undefined,
   * the UI derives them from the presence of corresponding entries in
   * `elementLocalNodes` (backward compat with older models).
   *
   * The engine itself ignores these flags; only the entries actually
   * present in `elementLocalNodes` affect discretisation. The UI is
   * responsible for keeping the two in sync when flags toggle.
   */
  readonly distinctFirst?: boolean;
  readonly distinctLast?: boolean;
  readonly distinctAll?: boolean;
}

// ── whole model ──────────────────────────────────────────────────────────

// Imported here (not from analysis/kernels.js) so the geometry layer
// doesn't pull on the analysis layer.
import type { MaterialProperties } from "../material.js";

export interface CadModel {
  readonly points: readonly Point[];
  readonly lines: readonly Line[];
  readonly boundaries: readonly Boundary[];
  readonly domains: readonly Domain[];
  /** Sparse — only Lines with an explicit BC appear. Missing = free surface. */
  readonly bcs: readonly BcAssignment[];
  /** Sparse — only Lines with non-default discretisation appear. */
  readonly meshing: readonly LineDiscretisation[];
  /** Per-project material. Optional for backwards compatibility with
   *  older saves; resolve via `resolveMaterial(model)`. */
  readonly material?: MaterialProperties;
}
