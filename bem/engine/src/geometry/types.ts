// Shared geometry / mesh types. Editor model IS engine model — no translation layer.
// Mirrors the MATLAB 4-file layout (pointInput, lineInput, boundaryInput, domainInput).

export type Id = string;

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Boundary condition on a single direction at a single node. */
export type Bc =
  | { readonly kind: "unknown" }
  | { readonly kind: "known"; readonly value: number };

/** Per-line boundary conditions; applied uniformly to every node of every element on the line. */
export interface LineBcs {
  readonly dx: Bc;
  readonly dy: Bc;
  readonly tx: Bc;
  readonly ty: Bc;
}

/** A geometric point. Referenced by id from Lines (start, end, arc centre). */
export interface Point {
  readonly id: Id;
  readonly x: number;
  readonly y: number;
}

/**
 * A line segment or circular arc.
 * - Straight when `arcCentreId` is undefined.
 * - Arc when `arcCentreId` is a Point id — the line curves from `startId` to `endId`
 *   along the circle centred at that point.
 * `localNodes` are the η positions of the three collocation nodes within each element
 * (e.g. [-2/3, 0, 2/3] for the standard discontinuous element).
 */
export interface Line {
  readonly id: Id;
  readonly startId: Id;
  readonly endId: Id;
  readonly arcCentreId?: Id;
  readonly nElements: number;
  readonly localNodes: readonly [number, number, number];
  readonly bcs: LineBcs;
}

/** Ordered traversal of a Line as part of a Boundary loop. */
export interface BoundarySegment {
  readonly lineId: Id;
  /** +1 if traversed start→end, -1 if reversed. */
  readonly direction: 1 | -1;
}

/** A closed loop of Lines forming part of a Domain. */
export interface Boundary {
  readonly id: Id;
  readonly name: string;
  readonly segments: readonly BoundarySegment[];
}

/** A Domain is an ordered list of Boundaries. No exterior/hole distinction at this level. */
export interface Domain {
  readonly id: Id;
  readonly name: string;
  readonly boundaryIds: readonly Id[];
}

/**
 * Complete mesh model. Same shape as the CAD editor's working state and as the
 * engine's analysis input.
 */
export interface CadModel {
  readonly points: readonly Point[];
  readonly lines: readonly Line[];
  readonly boundaries: readonly Boundary[];
  readonly domains: readonly Domain[];
}
