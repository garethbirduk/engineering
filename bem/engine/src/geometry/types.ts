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
 */
export type DirectionBc =
  | { readonly kind: "displacement"; readonly value: number }
  | { readonly kind: "traction"; readonly value: number };

/**
 * Sparse BC assignment for a single Line. Either or both directions may be
 * unset; unset directions default to t = 0.
 */
export interface BcAssignment {
  readonly lineId: Id;
  readonly x?: DirectionBc;
  readonly y?: DirectionBc;
}

// ── whole model ──────────────────────────────────────────────────────────

export interface CadModel {
  readonly points: readonly Point[];
  readonly lines: readonly Line[];
  readonly boundaries: readonly Boundary[];
  readonly domains: readonly Domain[];
  /** Sparse — only Lines with an explicit BC appear. Missing = free surface. */
  readonly bcs: readonly BcAssignment[];
}
