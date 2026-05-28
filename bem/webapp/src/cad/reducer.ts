// Pure reducer for the CAD editor's domain state.
//
// Two independent dimensions in the toolbar:
//   itemMode ∈ { point, line, boundary, domain }   — what kind of thing
//   action   ∈ { select, delete, create }          — what to do with it
//
// A click on the canvas dispatches { type: 'click', cursor, ... }. The
// reducer snaps + hit-tests INTERNALLY using its own state.model so a burst
// of synchronous clicks each sees the previous action's result.

import {
  findClosedLoop,
  projectOntoSegment,
  type Boundary,
  type CadModel,
  type Domain,
  type Id,
  type Line,
  type Point,
  type Vec2,
} from "@bem/engine";
import {
  addLine,
  addPoint,
  makeLine,
  makePoint,
  newId,
} from "./operations.js";
import { snapWorld, type SnapResult } from "./snap.js";

export type ItemMode = "point" | "line" | "boundary" | "domain";
export type Action = "select" | "delete" | "create";

export type Selection =
  | { readonly kind: "point"; readonly id: Id }
  | { readonly kind: "line"; readonly id: Id }
  | { readonly kind: "boundary"; readonly id: Id }
  | { readonly kind: "domain"; readonly id: Id }
  | null;

/** First click of a two-click create (currently used for line creation). */
export interface LineDraft {
  readonly startPointId: Id;
}

export interface CanvasState {
  readonly model: CadModel;
  readonly itemMode: ItemMode;
  readonly action: Action;
  readonly selection: Selection;
  readonly lineDraft: LineDraft | null;
  /** Line ids selected while in (boundary, create) mode. */
  readonly boundaryDraft: readonly Id[];
  /** Boundary ids selected while in (domain, create) mode. */
  readonly domainDraft: readonly Id[];
  /** Active drag — set on mousedown that initiates a drag, cleared on mouseup. */
  readonly dragSession: DragSession | null;
}

/**
 * Tracks an in-progress drag. The set of points being dragged each have a
 * snapshot of their position at drag start; on dragTo, the delta from
 * cursorOrigin to the current cursor is added to every original position.
 *
 * - Point drag in select mode: one point in the map.
 * - Line drag in select mode: line's two endpoint ids in the map.
 * - Ctrl-split drag: the new point in the map; cursorOrigin = the snapped
 *   click cursor so the delta starts at zero.
 */
export interface DragSession {
  readonly originalPositions: ReadonlyMap<Id, Vec2>;
  readonly cursorOrigin: Vec2;
}

/** Internal — what a click resolves to after snap + hit-test. */
interface HitResult {
  readonly entity:
    | { readonly kind: "point"; readonly id: Id }
    | { readonly kind: "line"; readonly id: Id }
    | null;
  readonly snap: SnapResult;
}

/** Geometric parameters needed to interpret a click. */
export interface ClickContext {
  readonly cursor: Vec2;
  readonly gridStep: number;
  readonly snapRadius: number;
  /** How close (in world units) the cursor must be to a line to hit it. */
  readonly lineTolerance: number;
}

export type CanvasAction =
  | { readonly type: "setItemMode"; readonly itemMode: ItemMode }
  | { readonly type: "setAction"; readonly action: Action }
  | { readonly type: "click"; readonly ctx: ClickContext }
  | { readonly type: "cancel" }
  | { readonly type: "clearSelection" }
  | { readonly type: "commitBoundary" }
  | { readonly type: "toggleDomainDraft"; readonly boundaryId: Id }
  | { readonly type: "commitDomain" }
  | { readonly type: "flipLine"; readonly lineId: Id }
  | {
      readonly type: "ctrlClick";
      readonly cursor: Vec2;
      readonly lineTolerance: number;
      readonly gridStep: number;
    }
  | {
      readonly type: "startSelectDrag";
      readonly cursor: Vec2;
      readonly gridStep: number;
      readonly snapRadius: number;
      readonly lineTolerance: number;
    }
  | { readonly type: "dragTo"; readonly cursor: Vec2 }
  | { readonly type: "endDrag" };

export const INITIAL_STATE: CanvasState = {
  model: { points: [], lines: [], boundaries: [], domains: [] },
  itemMode: "line",
  action: "create",
  selection: null,
  lineDraft: null,
  boundaryDraft: [],
  domainDraft: [],
  dragSession: null,
};

export function canvasReducer(
  state: CanvasState,
  action: CanvasAction,
): CanvasState {
  switch (action.type) {
    case "setItemMode":
      if (state.itemMode === action.itemMode) return state;
      return {
        ...state,
        itemMode: action.itemMode,
        lineDraft: null,
        boundaryDraft: [],
        domainDraft: [],
        selection: null,
      };

    case "setAction":
      if (state.action === action.action) return state;
      return {
        ...state,
        action: action.action,
        lineDraft: null,
        boundaryDraft: [],
        domainDraft: [],
      };

    case "cancel":
      if (
        state.lineDraft === null &&
        state.selection === null &&
        state.boundaryDraft.length === 0 &&
        state.domainDraft.length === 0
      ) {
        return state;
      }
      return {
        ...state,
        lineDraft: null,
        selection: null,
        boundaryDraft: [],
        domainDraft: [],
      };

    case "clearSelection":
      if (state.selection === null) return state;
      return { ...state, selection: null };

    case "click":
      return applyClick(state, computeHit(state.model, action.ctx));

    case "commitBoundary":
      return commitBoundary(state);

    case "toggleDomainDraft":
      return toggleDomainDraftBoundary(state, action.boundaryId);

    case "commitDomain":
      return commitDomain(state);

    case "flipLine":
      return flipLine(state, action.lineId);

    case "ctrlClick":
      return ctrlClickSplitLine(
        state,
        action.cursor,
        action.lineTolerance,
        action.gridStep,
      );

    case "startSelectDrag":
      return startSelectDrag(
        state,
        action.cursor,
        action.gridStep,
        action.snapRadius,
        action.lineTolerance,
      );

    case "dragTo":
      return applyDragTo(state, action.cursor);

    case "endDrag":
      if (state.dragSession === null) return state;
      return { ...state, dragSession: null };
  }
}

function computeHit(model: CadModel, ctx: ClickContext): HitResult {
  const snap = snapWorld(ctx.cursor, model.points, ctx.gridStep, ctx.snapRadius);

  // Point hit wins if the snap landed on an existing point.
  if (snap.existingPointId) {
    return {
      entity: { kind: "point", id: snap.existingPointId },
      snap,
    };
  }

  // Otherwise, line hit-test against straight segments.
  for (const l of model.lines) {
    const a = model.points.find((p) => p.id === l.startId);
    const b = model.points.find((p) => p.id === l.endId);
    if (!a || !b) continue;
    if (cursorOnSegment(ctx.cursor, a, b, ctx.lineTolerance)) {
      return { entity: { kind: "line", id: l.id }, snap };
    }
  }

  return { entity: null, snap };
}

function applyClick(state: CanvasState, hit: HitResult): CanvasState {
  const { itemMode, action } = state;

  // ── SELECT ─────────────────────────────────────────────────────────────
  if (action === "select") {
    if (itemMode === "point" && hit.entity?.kind === "point") {
      return { ...state, selection: { kind: "point", id: hit.entity.id } };
    }
    if (itemMode === "line" && hit.entity?.kind === "line") {
      return { ...state, selection: { kind: "line", id: hit.entity.id } };
    }
    // No applicable entity under cursor → clear selection.
    return state.selection ? { ...state, selection: null } : state;
  }

  // ── DELETE ─────────────────────────────────────────────────────────────
  if (action === "delete") {
    if (itemMode === "point" && hit.entity?.kind === "point") {
      return deletePoint(state, hit.entity.id);
    }
    if (itemMode === "line" && hit.entity?.kind === "line") {
      return deleteLine(state, hit.entity.id);
    }
    return state;
  }

  // ── CREATE ─────────────────────────────────────────────────────────────
  if (action === "create") {
    if (itemMode === "point") {
      return createPointAt(state, hit.snap);
    }
    if (itemMode === "line") {
      return progressLineCreation(state, hit.snap);
    }
    if (itemMode === "boundary") {
      return toggleBoundaryDraft(state, hit);
    }
    if (itemMode === "domain") {
      return toggleDomainDraftFromCanvas(state, hit);
    }
    return state;
  }

  return state;
}

function toggleBoundaryDraft(state: CanvasState, hit: HitResult): CanvasState {
  if (hit.entity?.kind !== "line") return state;
  const id = hit.entity.id;
  const draft = state.boundaryDraft.includes(id)
    ? state.boundaryDraft.filter((x) => x !== id)
    : [...state.boundaryDraft, id];
  return { ...state, boundaryDraft: draft };
}

function commitBoundary(state: CanvasState): CanvasState {
  const segments = findClosedLoop(state.boundaryDraft, state.model);
  if (!segments) return state;
  const boundary: Boundary = {
    id: newId(),
    name: `Boundary ${state.model.boundaries.length + 1}`,
    segments,
  };
  return {
    ...state,
    model: {
      ...state.model,
      boundaries: [...state.model.boundaries, boundary],
    },
    boundaryDraft: [],
    selection: { kind: "boundary", id: boundary.id },
  };
}

/**
 * In (domain, create) mode, clicking a line on the canvas toggles the
 * boundary that contains it. If the line belongs to multiple boundaries
 * (e.g. an interior interface), we toggle the first one; the user can
 * pick the others via the side-panel list.
 */
function toggleDomainDraftFromCanvas(
  state: CanvasState,
  hit: HitResult,
): CanvasState {
  if (hit.entity?.kind !== "line") return state;
  const lineId = hit.entity.id;
  const owning = state.model.boundaries.find((b) =>
    b.segments.some((s) => s.lineId === lineId),
  );
  if (!owning) return state;
  return toggleDomainDraftBoundary(state, owning.id);
}

function toggleDomainDraftBoundary(
  state: CanvasState,
  boundaryId: Id,
): CanvasState {
  const exists = state.domainDraft.includes(boundaryId);
  const draft = exists
    ? state.domainDraft.filter((x) => x !== boundaryId)
    : [...state.domainDraft, boundaryId];
  return { ...state, domainDraft: draft };
}

/**
 * Ctrl-click on a line: split that line into two at the projected click
 * position, insert a new point there, and enter drag mode on the new point.
 * Arc-lines are skipped for now (splitting an arc requires re-deriving a
 * compatible centre/radius).
 */
function ctrlClickSplitLine(
  state: CanvasState,
  cursor: Vec2,
  lineTolerance: number,
  gridStep: number,
): CanvasState {
  for (const line of state.model.lines) {
    if (line.arcCentreId !== undefined) continue;
    const a = state.model.points.find((p) => p.id === line.startId);
    const b = state.model.points.find((p) => p.id === line.endId);
    if (!a || !b) continue;
    if (!cursorOnSegment(cursor, a, b, lineTolerance)) continue;
    return splitLineAtProjection(state, line, a, b, cursor, gridStep);
  }
  return state;
}

function splitLineAtProjection(
  state: CanvasState,
  orig: Line,
  a: Vec2,
  b: Vec2,
  cursor: Vec2,
  gridStep: number,
): CanvasState {
  const projected = projectOntoSegment(cursor, a, b);

  const newPoint: Point = {
    id: newId(),
    x: projected.x,
    y: projected.y,
  };

  // Two new lines inherit BCs, element count, and nodal positions.
  const line1: Line = {
    id: newId(),
    startId: orig.startId,
    endId: newPoint.id,
    nElements: orig.nElements,
    localNodes: orig.localNodes,
    bcs: orig.bcs,
  };
  const line2: Line = {
    id: newId(),
    startId: newPoint.id,
    endId: orig.endId,
    nElements: orig.nElements,
    localNodes: orig.localNodes,
    bcs: orig.bcs,
  };

  // Replace the original line in any boundary's segments. A +1 segment
  // becomes [line1+1, line2+1]; a -1 segment becomes [line2-1, line1-1]
  // so the physical traversal direction is preserved.
  const boundaries = state.model.boundaries.map((bd) => ({
    ...bd,
    segments: bd.segments.flatMap((seg) => {
      if (seg.lineId !== orig.id) return [seg];
      return seg.direction === 1
        ? [
            { lineId: line1.id, direction: 1 as const },
            { lineId: line2.id, direction: 1 as const },
          ]
        : [
            { lineId: line2.id, direction: -1 as const },
            { lineId: line1.id, direction: -1 as const },
          ];
    }),
  }));

  return {
    ...state,
    model: {
      ...state.model,
      points: [...state.model.points, newPoint],
      lines: state.model.lines.flatMap((l) =>
        l.id === orig.id ? [line1, line2] : [l],
      ),
      boundaries,
    },
    selection: { kind: "point", id: newPoint.id },
    dragSession: {
      originalPositions: new Map([
        [newPoint.id, { x: projected.x, y: projected.y }],
      ]),
      cursorOrigin: snapToGrid(cursor, gridStep),
    },
  };
}

/**
 * Mousedown in select mode: if the cursor is over an entity matching the
 * itemMode (Point or Line), set selection and start a drag session.
 * In any other case, do nothing — the canvas's regular mouseup/click flow
 * still applies.
 */
function startSelectDrag(
  state: CanvasState,
  cursor: Vec2,
  gridStep: number,
  snapRadius: number,
  lineTolerance: number,
): CanvasState {
  if (state.action !== "select") return state;

  const snap = snapWorld(cursor, state.model.points, gridStep, snapRadius);

  // Point hit — applies in both Point and Line item modes for convenience
  // (clicking exactly on a point is usually intentional).
  if (snap.existingPointId) {
    const point = state.model.points.find(
      (p) => p.id === snap.existingPointId,
    );
    if (!point) return state;
    if (state.itemMode !== "point" && state.itemMode !== "line") return state;
    return {
      ...state,
      selection: { kind: "point", id: point.id },
      dragSession: {
        originalPositions: new Map([[point.id, { x: point.x, y: point.y }]]),
        cursorOrigin: snapToGrid(cursor, gridStep),
      },
    };
  }

  // Line hit (only meaningful for line item mode).
  if (state.itemMode === "line") {
    for (const line of state.model.lines) {
      if (line.arcCentreId !== undefined) continue;
      const a = state.model.points.find((p) => p.id === line.startId);
      const b = state.model.points.find((p) => p.id === line.endId);
      if (!a || !b) continue;
      if (!cursorOnSegment(cursor, a, b, lineTolerance)) continue;
      return {
        ...state,
        selection: { kind: "line", id: line.id },
        dragSession: {
          originalPositions: new Map([
            [a.id, { x: a.x, y: a.y }],
            [b.id, { x: b.x, y: b.y }],
          ]),
          cursorOrigin: snapToGrid(cursor, gridStep),
        },
      };
    }
  }

  return state;
}

function applyDragTo(state: CanvasState, cursor: Vec2): CanvasState {
  const session = state.dragSession;
  if (!session) return state;

  // Single-point drag (select+point, or split-and-drag): the point sits at
  // the snapped cursor directly. This ensures the result is on the grid even
  // if the point started off-grid (e.g. after a split-at-projection).
  if (session.originalPositions.size === 1) {
    const [pointId] = session.originalPositions.keys();
    if (pointId === undefined) return state;
    return updatePointPosition(state, pointId, cursor);
  }

  // Multi-point drag (select+line): translate by the snapped delta so the
  // shape of the line is preserved. If the endpoints were already on grid,
  // they remain on grid; if not, they retain their relative offset.
  const dx = cursor.x - session.cursorOrigin.x;
  const dy = cursor.y - session.cursorOrigin.y;
  if (dx === 0 && dy === 0) return state;
  return {
    ...state,
    model: {
      ...state.model,
      points: state.model.points.map((p) => {
        const original = session.originalPositions.get(p.id);
        if (!original) return p;
        return { ...p, x: original.x + dx, y: original.y + dy };
      }),
    },
  };
}

function updatePointPosition(
  state: CanvasState,
  pointId: Id,
  position: Vec2,
): CanvasState {
  return {
    ...state,
    model: {
      ...state.model,
      points: state.model.points.map((p) =>
        p.id === pointId
          ? { ...p, x: position.x, y: position.y }
          : p,
      ),
    },
  };
}

function snapToGrid(p: Vec2, gridStep: number): Vec2 {
  return {
    x: Math.round(p.x / gridStep) * gridStep,
    y: Math.round(p.y / gridStep) * gridStep,
  };
}

/**
 * Reverse a line's natural direction (swap startId ↔ endId). To keep any
 * containing boundaries traversing the same physical path, every
 * BoundarySegment that references this line gets its direction flipped too.
 *
 * The visual outward normal will move to the opposite side (it's computed
 * as right-of-natural-direction).
 */
function flipLine(state: CanvasState, lineId: Id): CanvasState {
  const line = state.model.lines.find((l) => l.id === lineId);
  if (!line) return state;
  const flipped: Line = {
    ...line,
    startId: line.endId,
    endId: line.startId,
  };
  return {
    ...state,
    model: {
      ...state.model,
      lines: state.model.lines.map((l) => (l.id === lineId ? flipped : l)),
      boundaries: state.model.boundaries.map((b) => ({
        ...b,
        segments: b.segments.map((seg) =>
          seg.lineId === lineId
            ? { ...seg, direction: (seg.direction === 1 ? -1 : 1) as 1 | -1 }
            : seg,
        ),
      })),
    },
  };
}

function commitDomain(state: CanvasState): CanvasState {
  if (state.domainDraft.length === 0) return state;
  const domain: Domain = {
    id: newId(),
    name: `Domain ${state.model.domains.length + 1}`,
    boundaryIds: state.domainDraft,
  };
  return {
    ...state,
    model: {
      ...state.model,
      domains: [...state.model.domains, domain],
    },
    domainDraft: [],
    selection: { kind: "domain", id: domain.id },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Action implementations
// ──────────────────────────────────────────────────────────────────────────

function createPointAt(state: CanvasState, snap: SnapResult): CanvasState {
  // Don't duplicate an existing point at the snap location.
  if (snap.existingPointId !== null) return state;
  return {
    ...state,
    model: addPoint(
      state.model,
      makePoint(snap.snapped.x, snap.snapped.y),
    ),
  };
}

function progressLineCreation(
  state: CanvasState,
  snap: SnapResult,
): CanvasState {
  // Resolve the click to a point id, creating one if there isn't one there.
  let model = state.model;
  let pointId = snap.existingPointId;
  if (pointId === null) {
    const p = makePoint(snap.snapped.x, snap.snapped.y);
    model = addPoint(model, p);
    pointId = p.id;
  }

  if (state.lineDraft === null) {
    return { ...state, model, lineDraft: { startPointId: pointId } };
  }

  if (pointId === state.lineDraft.startPointId) {
    // Same point twice → abort without creating a degenerate line.
    return { ...state, model, lineDraft: null };
  }

  return {
    ...state,
    model: addLine(model, makeLine(state.lineDraft.startPointId, pointId)),
    lineDraft: null,
  };
}

function deletePoint(state: CanvasState, pointId: Id): CanvasState {
  // Cascade: any line that uses this point is removed too.
  const survivingLines = state.model.lines.filter(
    (l) =>
      l.startId !== pointId &&
      l.endId !== pointId &&
      l.arcCentreId !== pointId,
  );
  const removedLineIds = new Set(
    state.model.lines
      .filter((l) => !survivingLines.includes(l))
      .map((l) => l.id),
  );

  // Cascade further: boundaries that referenced removed lines drop those
  // segments. (For now: if a boundary becomes empty, we keep it as empty —
  // boundary topology repair is its own step.)
  const boundaries = state.model.boundaries.map((b) => ({
    ...b,
    segments: b.segments.filter((s) => !removedLineIds.has(s.lineId)),
  }));

  // Selection: clear if it pointed at something we deleted.
  const selection =
    state.selection?.kind === "point" && state.selection.id === pointId
      ? null
      : state.selection?.kind === "line" &&
          removedLineIds.has(state.selection.id)
        ? null
        : state.selection;

  return {
    ...state,
    model: {
      ...state.model,
      points: state.model.points.filter((p) => p.id !== pointId),
      lines: survivingLines,
      boundaries,
    },
    selection,
    lineDraft:
      state.lineDraft?.startPointId === pointId ? null : state.lineDraft,
  };
}

function deleteLine(state: CanvasState, lineId: Id): CanvasState {
  const boundaries = state.model.boundaries.map((b) => ({
    ...b,
    segments: b.segments.filter((s) => s.lineId !== lineId),
  }));
  const selection =
    state.selection?.kind === "line" && state.selection.id === lineId
      ? null
      : state.selection;
  return {
    ...state,
    model: {
      ...state.model,
      lines: state.model.lines.filter((l) => l.id !== lineId),
      boundaries,
    },
    selection,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Hit-testing helpers (used by the canvas before dispatching a click).
// Pure functions of model + cursor.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns true if `cursor` is within `tolerance` of the line segment
 * defined by (a, b) — straight-line distance from point to segment.
 */
export function cursorOnSegment(
  cursor: Vec2,
  a: Vec2,
  b: Vec2,
  tolerance: number,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // Degenerate: distance to point a.
    const ex = cursor.x - a.x;
    const ey = cursor.y - a.y;
    return ex * ex + ey * ey <= tolerance * tolerance;
  }
  const t = ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / lenSq;
  const tc = Math.max(0, Math.min(1, t));
  const px = a.x + tc * dx;
  const py = a.y + tc * dy;
  const ex = cursor.x - px;
  const ey = cursor.y - py;
  return ex * ex + ey * ey <= tolerance * tolerance;
}
