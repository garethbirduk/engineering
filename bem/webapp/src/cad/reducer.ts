// Gesture-driven reducer for the CAD editor.
//
// Universal gestures (no modes):
//   double-click on empty        → add Point at snap
//   double-click on Point + drag → start drawing a new Line from that point
//   double-click on Line + drag  → split line at projection + drag new Point
//   click + drag on Point        → move the Point
//   click + drag on Line         → translate the Line (both endpoints)
//   click on entity              → select (replace selection)
//   ctrl + click on Line         → toggle in multi-selection
//   click on empty space         → clear selection
//
// Action buttons (in the small top bar):
//   Create boundary → from currently selected Lines if they form a closed loop
//   Create domain   → from currently selected Boundaries
//   Delete          → remove every selected entity (cascades)
//
// Keyboard: Delete/Backspace = Delete; Escape = clear selection + cancel drafts.

import {
  arcCentreFor90Degrees,
  cursorOnArc,
  findAllClosedLoops,
  findClosedLoop,
  mirrorAcrossChord,
  projectOntoSegment,
  type BcAssignment,
  type Boundary,
  type CadModel,
  type DirectionBc,
  type Domain,
  type Id,
  type Line,
  type LineDiscretisation,
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

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

export type SelectionItem =
  | { readonly kind: "point"; readonly id: Id }
  | { readonly kind: "line"; readonly id: Id }
  | { readonly kind: "boundary"; readonly id: Id }
  | { readonly kind: "domain"; readonly id: Id };

/**
 * In-progress drag of existing geometry (move-point, move-line, or
 * split-and-drag). One entry per dragged point; cursorOrigin is the snapped
 * cursor at drag start.
 */
export interface DragSession {
  readonly originalPositions: ReadonlyMap<Id, Vec2>;
  readonly cursorOrigin: Vec2;
}

/**
 * In-progress new-line draw, started by double-clicking on a Point and
 * dragging. The canvas renders a rubber band from this point to the current
 * cursor; mouseup commits the new line.
 */
export interface NewLineDraft {
  readonly startPointId: Id;
}

export interface CanvasState {
  readonly model: CadModel;
  readonly selection: readonly SelectionItem[];
  readonly dragSession: DragSession | null;
  readonly newLineDraft: NewLineDraft | null;
  /** When true, render the derived mesh overlay (elements + nodes). */
  readonly meshVisible: boolean;
  /** When true, render the dashed deformed-shape overlay from solve(). */
  readonly resultsVisible: boolean;
  /** When true, draw the interior post-process nodes (corners of the
   *  future triangulation). Currently shows nothing — placeholder. */
  readonly internalNodesVisible: boolean;
  /** Which interior field is contoured on the triangulation, or null
   *  if no contour is shown. Each entry in the Results panel maps to
   *  one of these.
   *  - Displacement: ux, uy
   *  - Cartesian stress: sxx, syy, sxy
   *  - Derived stress scalars: svm (von Mises), s1, s2 (principals),
   *    tmax (max in-plane shear) */
  readonly interiorField:
    | "ux"
    | "uy"
    | "sxx"
    | "syy"
    | "sxy"
    | "svm"
    | "s1"
    | "s2"
    | "tmax"
    | null;
  /** Whether the matrix-visualisation panel (between the Inspector and
   *  the canvas) is shown. Lets the user see the H·u = G·t schematic
   *  for the current BEM system size. */
  readonly matrixVisible: boolean;
}

/** Geometric parameters needed to interpret a click/double-click. */
export interface ClickContext {
  readonly cursor: Vec2;
  readonly gridStep: number;
  readonly snapRadius: number;
  /** Tolerance (in world units) for cursor-on-line hit testing. */
  readonly lineTolerance: number;
}

export type CanvasAction =
  // Pointer gestures
  | { readonly type: "click"; readonly ctx: ClickContext; readonly toggle: boolean }
  | { readonly type: "doubleClick"; readonly ctx: ClickContext }
  | {
      readonly type: "startDrag";
      readonly ctx: ClickContext;
      readonly toggle: boolean;
    }
  | { readonly type: "dragTo"; readonly cursor: Vec2 }
  | { readonly type: "endDrag"; readonly cursor: Vec2; readonly ctx: ClickContext }
  // Selection ops
  | { readonly type: "clearSelection" }
  | { readonly type: "toggleSelect"; readonly item: SelectionItem }
  | { readonly type: "selectOnly"; readonly item: SelectionItem }
  // Buttons
  | { readonly type: "createDomainFromSelection" }
  | { readonly type: "deleteSelection" }
  | { readonly type: "flipSelectedLines" }
  | { readonly type: "convertLineToArc"; readonly lineId: Id }
  | { readonly type: "flipArcCentre"; readonly lineId: Id }
  | { readonly type: "flipSelectedArcCentres" }
  | { readonly type: "loadModel"; readonly model: CadModel }
  | { readonly type: "newModel" }
  | {
      readonly type: "setLineBc";
      readonly lineId: Id;
      readonly direction: "x" | "y";
      readonly bc: DirectionBc | undefined;
    }
  | {
      /**
       * Set (or clear) the per-line discretisation override. `value: undefined`
       * removes the entry (line reverts to defaults).
       */
      readonly type: "setLineMeshing";
      readonly lineId: Id;
      readonly value: Omit<LineDiscretisation, "lineId"> | undefined;
    }
  | {
      readonly type: "selectInMarquee";
      readonly minX: number;
      readonly minY: number;
      readonly maxX: number;
      readonly maxY: number;
      readonly additive: boolean;
    }
  | { readonly type: "cancel" }
  | { readonly type: "toggleMesh" }
  | { readonly type: "toggleResults" }
  | { readonly type: "toggleInternalNodes" }
  | { readonly type: "toggleMatrix" }
  | {
      readonly type: "setInteriorField";
      readonly field: CanvasState["interiorField"];
    }
  | {
      readonly type: "setMaterial";
      readonly material: NonNullable<CadModel["material"]>;
    };

export const INITIAL_STATE: CanvasState = {
  model: { points: [], lines: [], boundaries: [], domains: [], bcs: [], meshing: [] },
  selection: [],
  dragSession: null,
  newLineDraft: null,
  meshVisible: false,
  resultsVisible: false,
  internalNodesVisible: false,
  interiorField: null,
  matrixVisible: false,
};

// ───────────────────────────────────────────────────────────────────────────
// Reducer
// ───────────────────────────────────────────────────────────────────────────

export function canvasReducer(
  state: CanvasState,
  action: CanvasAction,
): CanvasState {
  switch (action.type) {
    case "click":
      return applyClick(state, action.ctx, action.toggle);

    case "doubleClick":
      return applyDoubleClick(state, action.ctx);

    case "startDrag":
      return startDragForHit(state, action.ctx, action.toggle);

    case "dragTo":
      return applyDragTo(state, action.cursor);

    case "endDrag":
      return applyEndDrag(state, action.cursor, action.ctx);

    case "clearSelection":
      if (state.selection.length === 0) return state;
      return { ...state, selection: [] };

    case "toggleSelect":
      return { ...state, selection: toggleItem(state.selection, action.item) };

    case "selectOnly":
      return { ...state, selection: [action.item] };

    case "createDomainFromSelection":
      return createDomainFromSelection(state);

    case "deleteSelection":
      return deleteSelection(state);

    case "flipSelectedLines":
      return flipSelectedLines(state);

    case "convertLineToArc":
      return convertLineToArc(state, action.lineId);

    case "flipArcCentre":
      return flipArcCentre(state, action.lineId);

    case "flipSelectedArcCentres":
      return flipSelectedArcCentres(state);

    case "loadModel":
      return { ...INITIAL_STATE, model: action.model };

    case "newModel":
      return INITIAL_STATE;

    case "setLineBc":
      return setLineBc(state, action.lineId, action.direction, action.bc);

    case "setLineMeshing":
      return setLineMeshing(state, action.lineId, action.value);

    case "selectInMarquee":
      return applyMarqueeSelect(
        state,
        action.minX,
        action.minY,
        action.maxX,
        action.maxY,
        action.additive,
      );

    case "toggleMesh":
      return { ...state, meshVisible: !state.meshVisible };

    case "toggleResults":
      return { ...state, resultsVisible: !state.resultsVisible };

    case "toggleInternalNodes":
      return { ...state, internalNodesVisible: !state.internalNodesVisible };

    case "toggleMatrix":
      return { ...state, matrixVisible: !state.matrixVisible };

    case "setInteriorField":
      return { ...state, interiorField: action.field };

    case "setMaterial":
      return {
        ...state,
        model: { ...state.model, material: action.material },
      };

    case "cancel":
      if (
        state.selection.length === 0 &&
        state.dragSession === null &&
        state.newLineDraft === null
      ) {
        return state;
      }
      return {
        ...state,
        selection: [],
        dragSession: null,
        newLineDraft: null,
      };
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Click handling
// ───────────────────────────────────────────────────────────────────────────

interface HitResult {
  readonly entity:
    | { readonly kind: "point"; readonly id: Id }
    | { readonly kind: "line"; readonly id: Id }
    | null;
  readonly snap: SnapResult;
}

export function hitTest(model: CadModel, ctx: ClickContext): HitResult {
  return computeHit(model, ctx);
}

function computeHit(model: CadModel, ctx: ClickContext): HitResult {
  const snap = snapWorld(
    ctx.cursor,
    model.points,
    ctx.gridStep,
    ctx.snapRadius,
  );
  if (snap.existingPointId) {
    return { entity: { kind: "point", id: snap.existingPointId }, snap };
  }
  for (const l of model.lines) {
    const a = model.points.find((p) => p.id === l.startId);
    const b = model.points.find((p) => p.id === l.endId);
    if (!a || !b) continue;
    if (l.arcCentreId !== undefined) {
      const c = model.points.find((p) => p.id === l.arcCentreId);
      if (!c) continue;
      if (cursorOnArc(ctx.cursor, a, b, c, ctx.lineTolerance)) {
        return { entity: { kind: "line", id: l.id }, snap };
      }
    } else {
      if (cursorOnSegment(ctx.cursor, a, b, ctx.lineTolerance)) {
        return { entity: { kind: "line", id: l.id }, snap };
      }
    }
  }
  return { entity: null, snap };
}

function applyClick(
  state: CanvasState,
  ctx: ClickContext,
  toggle: boolean,
): CanvasState {
  const hit = computeHit(state.model, ctx);
  if (!hit.entity) {
    // Click on empty space → clear selection (unless this was a toggle).
    if (toggle) return state;
    return state.selection.length === 0 ? state : { ...state, selection: [] };
  }
  if (toggle) {
    return { ...state, selection: toggleItem(state.selection, hit.entity) };
  }
  // Replace selection.
  return { ...state, selection: [hit.entity] };
}

function toggleItem(
  selection: readonly SelectionItem[],
  item: SelectionItem,
): readonly SelectionItem[] {
  const idx = selection.findIndex(
    (s) => s.kind === item.kind && s.id === item.id,
  );
  if (idx >= 0) {
    return selection.filter((_, i) => i !== idx);
  }
  return [...selection, item];
}

// ───────────────────────────────────────────────────────────────────────────
// Double-click handling — context-sensitive create
// ───────────────────────────────────────────────────────────────────────────

function applyDoubleClick(state: CanvasState, ctx: ClickContext): CanvasState {
  const hit = computeHit(state.model, ctx);

  // Empty → add a Point.
  if (!hit.entity) {
    if (hit.snap.existingPointId) {
      // Snap landed on an existing point even though hit-test was empty —
      // probably degenerate. Just select that point.
      return {
        ...state,
        selection: [{ kind: "point", id: hit.snap.existingPointId }],
      };
    }
    const p = makePoint(hit.snap.snapped.x, hit.snap.snapped.y);
    return {
      ...state,
      model: addPoint(state.model, p),
      selection: [{ kind: "point", id: p.id }],
    };
  }

  // Point → start drawing a new Line from this point.
  if (hit.entity.kind === "point") {
    return {
      ...state,
      newLineDraft: { startPointId: hit.entity.id },
      selection: [hit.entity],
    };
  }

  // Line → split at projection, drag the new point.
  return splitLineAtProjection(state, hit.entity.id, ctx);
}

function splitLineAtProjection(
  state: CanvasState,
  lineId: Id,
  ctx: ClickContext,
): CanvasState {
  const orig = state.model.lines.find((l) => l.id === lineId);
  if (!orig || orig.arcCentreId !== undefined) return state;
  const a = state.model.points.find((p) => p.id === orig.startId);
  const b = state.model.points.find((p) => p.id === orig.endId);
  if (!a || !b) return state;

  const projected = projectOntoSegment(ctx.cursor, a, b);
  const newPoint: Point = { id: newId(), x: projected.x, y: projected.y };

  const line1: Line = {
    id: newId(),
    startId: orig.startId,
    endId: newPoint.id,
  };
  const line2: Line = {
    id: newId(),
    startId: newPoint.id,
    endId: orig.endId,
  };

  // Inherit BCs from the parent line if any — both children get the same
  // assignment (under the parent's semantics, the whole line carried that
  // BC, so both halves do too).
  const origBc = state.model.bcs.find((bc) => bc.lineId === orig.id);
  const inheritedBcs = origBc
    ? [
        { ...origBc, lineId: line1.id },
        { ...origBc, lineId: line2.id },
      ]
    : [];

  // Same inheritance for meshing overrides.
  const origMeshing = state.model.meshing.find((m) => m.lineId === orig.id);
  const inheritedMeshing = origMeshing
    ? [
        { ...origMeshing, lineId: line1.id },
        { ...origMeshing, lineId: line2.id },
      ]
    : [];

  // Fix up containing boundary segments.
  const boundaries = state.model.boundaries.map((bd) => ({
    ...bd,
    segments: bd.segments.flatMap((seg) => {
      if (seg.lineId !== lineId) return [seg];
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
        l.id === lineId ? [line1, line2] : [l],
      ),
      boundaries,
      bcs: [
        ...state.model.bcs.filter((bc) => bc.lineId !== lineId),
        ...inheritedBcs,
      ],
      meshing: [
        ...state.model.meshing.filter((m) => m.lineId !== lineId),
        ...inheritedMeshing,
      ],
    },
    selection: [{ kind: "point", id: newPoint.id }],
    dragSession: {
      originalPositions: new Map([
        [newPoint.id, { x: projected.x, y: projected.y }],
      ]),
      cursorOrigin: snapToGrid(ctx.cursor, ctx.gridStep),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Drag handling
// ───────────────────────────────────────────────────────────────────────────

/**
 * Called by the canvas before mousemove dispatching, to set up a drag for an
 * existing point or line under the cursor. Returns the new state with both
 * selection (single-replace) and dragSession set.
 */
/**
 * Mousedown→drag setup. If the hit entity is already part of the current
 * selection, the WHOLE selection is dragged (all selected Points + all
 * endpoints of selected Lines). Otherwise the selection is replaced (or
 * toggled with shift), and only the hit entity is dragged.
 *
 * dragTo decides between "single point follows snapped cursor" and
 * "multi-point translate by snapped delta" based on the size of the
 * resulting originalPositions map, which is correct in both modes.
 */
export function startDragForHit(
  state: CanvasState,
  ctx: ClickContext,
  toggle: boolean,
): CanvasState {
  const hit = computeHit(state.model, ctx);
  if (!hit.entity) return state;
  if (hit.entity.kind === "line") {
    const line = state.model.lines.find((l) => l.id === hit.entity!.id);
    if (!line || line.arcCentreId !== undefined) return state;
  }

  const hitInSelection = state.selection.some(
    (s) => s.kind === hit.entity!.kind && s.id === hit.entity!.id,
  );

  // Decide what to drag and how the selection should look afterwards.
  let dragItems: readonly SelectionItem[];
  let newSelection: readonly SelectionItem[];
  if (hitInSelection) {
    dragItems = state.selection;
    newSelection = state.selection;
  } else if (toggle) {
    newSelection = toggleItem(state.selection, hit.entity);
    dragItems = [hit.entity];
  } else {
    newSelection = [hit.entity];
    dragItems = [hit.entity];
  }

  // Collect the point ids we'll drag (directly-selected points, plus
  // endpoints of selected lines — deduped via Set).
  const pointIds = new Set<Id>();
  for (const item of dragItems) {
    if (item.kind === "point") {
      pointIds.add(item.id);
    } else if (item.kind === "line") {
      const line = state.model.lines.find((l) => l.id === item.id);
      if (line && line.arcCentreId === undefined) {
        pointIds.add(line.startId);
        pointIds.add(line.endId);
      }
    }
    // Boundaries / Domains: leave alone for now — could later translate
    // every point of their constituent lines.
  }
  if (pointIds.size === 0) {
    // Nothing actually movable; just update selection.
    return { ...state, selection: newSelection };
  }

  const originalPositions = new Map<Id, Vec2>();
  for (const p of state.model.points) {
    if (pointIds.has(p.id)) {
      originalPositions.set(p.id, { x: p.x, y: p.y });
    }
  }

  return {
    ...state,
    selection: newSelection,
    dragSession: {
      originalPositions,
      cursorOrigin: snapToGrid(ctx.cursor, ctx.gridStep),
    },
  };
}

function applyDragTo(state: CanvasState, cursor: Vec2): CanvasState {
  const session = state.dragSession;
  if (!session) return state;

  // Single-point drag → point follows snapped cursor directly.
  if (session.originalPositions.size === 1) {
    const [pointId] = session.originalPositions.keys();
    if (pointId === undefined) return state;
    return updatePointPosition(state, pointId, cursor);
  }

  // Multi-point drag → translate by snapped delta.
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

/**
 * End of a drag gesture. If a new-line draft is active, commit it (creating
 * the second endpoint and the line itself). Otherwise just clear the drag
 * session.
 */
function applyEndDrag(
  state: CanvasState,
  cursor: Vec2,
  ctx: ClickContext,
): CanvasState {
  // New-line draft commit takes precedence over dragSession (a split-drag
  // would not set newLineDraft, so this is unambiguous).
  if (state.newLineDraft) {
    return commitNewLine(state, cursor, ctx);
  }
  if (state.dragSession === null) return state;
  return { ...state, dragSession: null };
}

function commitNewLine(
  state: CanvasState,
  cursor: Vec2,
  ctx: ClickContext,
): CanvasState {
  const draft = state.newLineDraft;
  if (!draft) return state;

  // Resolve endpoint: prefer snapping onto an existing point (other than the
  // start point); otherwise create a new point at the snapped cursor.
  const snap = snapWorld(cursor, state.model.points, ctx.gridStep, ctx.snapRadius);
  let model = state.model;
  let endId: Id;
  if (snap.existingPointId && snap.existingPointId !== draft.startPointId) {
    endId = snap.existingPointId;
  } else if (snap.existingPointId === draft.startPointId) {
    // Released on the start point — cancel (degenerate line).
    return { ...state, newLineDraft: null };
  } else {
    const p = makePoint(snap.snapped.x, snap.snapped.y);
    model = addPoint(model, p);
    endId = p.id;
  }

  // Also refuse if start and end resolved to the same coordinates (rare).
  const start = state.model.points.find((p) => p.id === draft.startPointId);
  if (!start) return { ...state, newLineDraft: null };
  const end = model.points.find((p) => p.id === endId);
  if (!end) return { ...state, newLineDraft: null };
  if (start.x === end.x && start.y === end.y) {
    return { ...state, newLineDraft: null };
  }

  const line = makeLine(draft.startPointId, endId);
  return {
    ...state,
    model: addLine(model, line),
    newLineDraft: null,
    selection: [{ kind: "line", id: line.id }],
  };
}

function updatePointPosition(
  state: CanvasState,
  pointId: Id,
  position: Vec2,
): CanvasState {
  // Early-return when the snapped cursor lands on the point's current
  // coords — mousemove fires constantly during a drag and most events
  // snap back to the cell we're already in. Returning the same state
  // object means React skips the re-render and the BEM solve doesn't
  // pointlessly re-run on a content-identical mesh (which would then
  // show "100% cached, 0 G-evals" in the toolbar, overwriting the
  // meaningful reanalysis numbers from the actual move).
  const current = state.model.points.find((p) => p.id === pointId);
  if (!current) return state;
  if (current.x === position.x && current.y === position.y) return state;
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

// ───────────────────────────────────────────────────────────────────────────
// Buttons: create / delete
// ───────────────────────────────────────────────────────────────────────────

/**
 * Create a Domain from the current selection. Combines two sources:
 *
 *  - Any already-selected Boundary ids → carried over directly.
 *  - Any selected Lines that decompose into one or more closed loops →
 *    each loop becomes a new Boundary; all new boundaries are added to
 *    the domain.
 *
 * For multi-boundary domains (e.g. exterior + hole), lasso-select all
 * the lines and click Create domain. evenodd fill at render time turns
 * inner boundaries into actual holes regardless of their orientation.
 */
function createDomainFromSelection(state: CanvasState): CanvasState {
  const existingBoundaryIds = state.selection
    .filter((s) => s.kind === "boundary")
    .map((s) => s.id);

  const lineIds = state.selection
    .filter((s) => s.kind === "line")
    .map((s) => s.id);

  let model = state.model;
  const newBoundaryIds: Id[] = [];

  if (lineIds.length > 0) {
    const loops = findAllClosedLoops(lineIds, state.model);
    if (loops === null) {
      // Selected lines don't decompose cleanly into closed loops. If we
      // had no boundary selection either, the action can't proceed.
      if (existingBoundaryIds.length === 0) return state;
    } else {
      for (const segments of loops) {
        // model.boundaries grows each iteration, so its length already
        // accounts for previously-created loops in this commit.
        const boundary: Boundary = {
          id: newId(),
          name: `Boundary ${model.boundaries.length + 1}`,
          segments: [...segments],
        };
        model = {
          ...model,
          boundaries: [...model.boundaries, boundary],
        };
        newBoundaryIds.push(boundary.id);
      }
    }
  }

  const allBoundaryIds = [...existingBoundaryIds, ...newBoundaryIds];
  if (allBoundaryIds.length === 0) return state;

  const domain: Domain = {
    id: newId(),
    name: `Domain ${model.domains.length + 1}`,
    boundaryIds: allBoundaryIds,
  };
  return {
    ...state,
    model: {
      ...model,
      domains: [...model.domains, domain],
    },
    selection: [{ kind: "domain", id: domain.id }],
  };
}

function deleteSelection(state: CanvasState): CanvasState {
  if (state.selection.length === 0) return state;

  const pointIds = new Set(
    state.selection.filter((s) => s.kind === "point").map((s) => s.id),
  );
  const lineIdsDirect = new Set(
    state.selection.filter((s) => s.kind === "line").map((s) => s.id),
  );
  const boundaryIds = new Set(
    state.selection.filter((s) => s.kind === "boundary").map((s) => s.id),
  );
  const domainIds = new Set(
    state.selection.filter((s) => s.kind === "domain").map((s) => s.id),
  );

  // Lines that disappear: directly-selected ones, plus any that referenced
  // a deleted point.
  const survivingLines = state.model.lines.filter(
    (l) =>
      !lineIdsDirect.has(l.id) &&
      !pointIds.has(l.startId) &&
      !pointIds.has(l.endId) &&
      (l.arcCentreId === undefined || !pointIds.has(l.arcCentreId)),
  );
  const removedLineIds = new Set(
    state.model.lines
      .filter((l) => !survivingLines.includes(l))
      .map((l) => l.id),
  );

  // Boundaries: drop directly-selected. For the rest, drop any segment whose
  // line was removed (boundary may end up empty — kept as empty for now).
  const survivingBoundaries = state.model.boundaries
    .filter((b) => !boundaryIds.has(b.id))
    .map((b) => ({
      ...b,
      segments: b.segments.filter((s) => !removedLineIds.has(s.lineId)),
    }));
  const removedBoundaryIds = new Set(
    state.model.boundaries
      .filter((b) => !survivingBoundaries.find((sb) => sb.id === b.id))
      .map((b) => b.id),
  );

  // Domains: drop directly-selected. For the rest, drop refs to removed
  // boundaries.
  const survivingDomains = state.model.domains
    .filter((d) => !domainIds.has(d.id))
    .map((d) => ({
      ...d,
      boundaryIds: d.boundaryIds.filter((id) => !removedBoundaryIds.has(id)),
    }));

  return {
    ...state,
    model: {
      ...state.model,
      points: state.model.points.filter((p) => !pointIds.has(p.id)),
      lines: survivingLines,
      boundaries: survivingBoundaries,
      domains: survivingDomains,
      // BCs follow their line. Drop any whose line was removed.
      bcs: state.model.bcs.filter((bc) => !removedLineIds.has(bc.lineId)),
      // Same for meshing overrides.
      meshing: state.model.meshing.filter(
        (m) => !removedLineIds.has(m.lineId),
      ),
    },
    selection: [],
  };
}

/**
 * Flip every Line in the current selection (swap startId↔endId and flip
 * the corresponding segment.direction in any containing Boundary so the
 * physical traversal of the boundary is preserved).
 *
 * Atomic across the whole selection — one render, one update.
 */
/**
 * Marquee-select: include every Point that sits inside the rect, and every
 * Line whose *both* endpoints sit inside the rect (strict containment —
 * cleaner than partial-overlap and matches most editors).
 *
 * If `additive` is true, append to the existing selection (skipping items
 * already in it); otherwise replace.
 */
function applyMarqueeSelect(
  state: CanvasState,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  additive: boolean,
): CanvasState {
  const inside = (x: number, y: number) =>
    x >= minX && x <= maxX && y >= minY && y <= maxY;
  const pById = new Map(state.model.points.map((p) => [p.id, p]));

  const hits: SelectionItem[] = [];
  for (const p of state.model.points) {
    if (inside(p.x, p.y)) hits.push({ kind: "point", id: p.id });
  }
  for (const l of state.model.lines) {
    const a = pById.get(l.startId);
    const b = pById.get(l.endId);
    if (!a || !b) continue;
    if (inside(a.x, a.y) && inside(b.x, b.y)) {
      hits.push({ kind: "line", id: l.id });
    }
  }

  if (!additive) {
    return { ...state, selection: hits };
  }
  // Additive: union, preserving order.
  const seen = new Set(
    state.selection.map((s) => `${s.kind}:${s.id}`),
  );
  const merged: SelectionItem[] = [...state.selection];
  for (const h of hits) {
    const key = `${h.kind}:${h.id}`;
    if (!seen.has(key)) {
      merged.push(h);
      seen.add(key);
    }
  }
  return { ...state, selection: merged };
}

function flipSelectedLines(state: CanvasState): CanvasState {
  const ids = new Set<Id>();
  for (const s of state.selection) {
    if (s.kind === "line") ids.add(s.id);
  }
  if (ids.size === 0) return state;

  return {
    ...state,
    model: {
      ...state.model,
      lines: state.model.lines.map((l) => {
        if (!ids.has(l.id)) return l;
        return { ...l, startId: l.endId, endId: l.startId };
      }),
      boundaries: state.model.boundaries.map((b) => ({
        ...b,
        segments: b.segments.map((seg) => {
          if (!ids.has(seg.lineId)) return seg;
          return {
            ...seg,
            direction: (seg.direction === 1 ? -1 : 1) as 1 | -1,
          };
        }),
      })),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * True if `cursor` is within `tolerance` of the segment from a to b.
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

/**
 * Promote a straight Line to an arc by creating a new Point at the 90°
 * centre position and setting `line.arcCentreId` to point at it. No-op if
 * the line is already an arc.
 */
function convertLineToArc(state: CanvasState, lineId: Id): CanvasState {
  const line = state.model.lines.find((l) => l.id === lineId);
  if (!line || line.arcCentreId !== undefined) return state;
  const start = state.model.points.find((p) => p.id === line.startId);
  const end = state.model.points.find((p) => p.id === line.endId);
  if (!start || !end) return state;

  const c = arcCentreFor90Degrees(start, end);
  const centre: Point = { id: newId(), x: c.x, y: c.y };
  return {
    ...state,
    model: {
      ...state.model,
      points: [...state.model.points, centre],
      lines: state.model.lines.map((l) =>
        l.id === lineId ? { ...l, arcCentreId: centre.id } : l,
      ),
    },
  };
}

/**
 * Mirror an arc's centre Point across the chord (start↔end). The arc now
 * bulges to the opposite side. The Point's id is preserved (other arcs or
 * references stay valid).
 */
/**
 * Flip every arc-centre point for every selected arc. Each centre is
 * mirrored across its own chord, so each arc bulges to the other side.
 * Atomic: one render for all of them.
 */
function flipSelectedArcCentres(state: CanvasState): CanvasState {
  const lineIds = new Set(
    state.selection.filter((s) => s.kind === "line").map((s) => s.id),
  );
  if (lineIds.size === 0) return state;

  // Collect updates: centre point id → new position. A centre shared by
  // multiple arcs gets flipped once relative to the first arc's chord (rare;
  // by default each arc has its own centre, so this is just bookkeeping).
  const centreMoves = new Map<Id, Vec2>();
  for (const l of state.model.lines) {
    if (!lineIds.has(l.id) || l.arcCentreId === undefined) continue;
    const start = state.model.points.find((p) => p.id === l.startId);
    const end = state.model.points.find((p) => p.id === l.endId);
    const centre = state.model.points.find((p) => p.id === l.arcCentreId);
    if (!start || !end || !centre) continue;
    if (centreMoves.has(centre.id)) continue;
    centreMoves.set(centre.id, mirrorAcrossChord(centre, start, end));
  }
  if (centreMoves.size === 0) return state;

  return {
    ...state,
    model: {
      ...state.model,
      points: state.model.points.map((p) => {
        const m = centreMoves.get(p.id);
        return m ? { ...p, x: m.x, y: m.y } : p;
      }),
    },
  };
}

function flipArcCentre(state: CanvasState, lineId: Id): CanvasState {
  const line = state.model.lines.find((l) => l.id === lineId);
  if (!line || line.arcCentreId === undefined) return state;
  const start = state.model.points.find((p) => p.id === line.startId);
  const end = state.model.points.find((p) => p.id === line.endId);
  const centre = state.model.points.find((p) => p.id === line.arcCentreId);
  if (!start || !end || !centre) return state;
  const mirrored = mirrorAcrossChord(centre, start, end);
  return {
    ...state,
    model: {
      ...state.model,
      points: state.model.points.map((p) =>
        p.id === centre.id ? { ...p, x: mirrored.x, y: mirrored.y } : p,
      ),
    },
  };
}

/**
 * Set (or clear) the BC for one direction (x or y) of one line. Pass
 * `bc: undefined` to clear (revert that direction to the free-surface
 * default). If both directions become undefined the whole assignment is
 * dropped from the sparse array.
 */
function setLineMeshing(
  state: CanvasState,
  lineId: Id,
  value: Omit<LineDiscretisation, "lineId"> | undefined,
): CanvasState {
  if (!state.model.lines.some((l) => l.id === lineId)) return state;
  const others = state.model.meshing.filter((m) => m.lineId !== lineId);
  const hasPerEl =
    value?.elementLocalNodes !== undefined &&
    Object.keys(value.elementLocalNodes).length > 0;
  const hasFlag =
    value?.distinctFirst || value?.distinctLast || value?.distinctAll;
  if (
    !value ||
    (value.elementsPerLine === undefined &&
      value.localNodes === undefined &&
      !hasPerEl &&
      !hasFlag)
  ) {
    if (others.length === state.model.meshing.length) return state;
    return {
      ...state,
      model: { ...state.model, meshing: others },
    };
  }
  const next: LineDiscretisation = {
    lineId,
    ...(value.elementsPerLine !== undefined
      ? { elementsPerLine: value.elementsPerLine }
      : {}),
    ...(value.localNodes !== undefined ? { localNodes: value.localNodes } : {}),
    ...(hasPerEl ? { elementLocalNodes: value.elementLocalNodes } : {}),
    ...(value.distinctFirst ? { distinctFirst: true } : {}),
    ...(value.distinctLast ? { distinctLast: true } : {}),
    ...(value.distinctAll ? { distinctAll: true } : {}),
  };
  return {
    ...state,
    model: { ...state.model, meshing: [...others, next] },
  };
}

function setLineBc(
  state: CanvasState,
  lineId: Id,
  direction: "x" | "y",
  bc: DirectionBc | undefined,
): CanvasState {
  if (!state.model.lines.some((l) => l.id === lineId)) return state;
  const existing = state.model.bcs.find((a) => a.lineId === lineId);
  const newX = direction === "x" ? bc : existing?.x;
  const newY = direction === "y" ? bc : existing?.y;
  const others = state.model.bcs.filter((a) => a.lineId !== lineId);
  if (!newX && !newY) {
    return {
      ...state,
      model: { ...state.model, bcs: others },
    };
  }
  const next: BcAssignment = {
    lineId,
    ...(newX ? { x: newX } : {}),
    ...(newY ? { y: newY } : {}),
  };
  return {
    ...state,
    model: { ...state.model, bcs: [...others, next] },
  };
}

function snapToGrid(p: Vec2, gridStep: number): Vec2 {
  return {
    x: Math.round(p.x / gridStep) * gridStep,
    y: Math.round(p.y / gridStep) * gridStep,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Derived helpers (used by canvas/UI)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Are the selected lines decomposable into one or more closed loops? (Each
 * loop becomes a Boundary; all become a single Domain.)
 */
export function selectionFormsClosedLoop(state: CanvasState): boolean {
  const lineIds = state.selection
    .filter((s) => s.kind === "line")
    .map((s) => s.id);
  if (lineIds.length === 0) return false;
  return findAllClosedLoops(lineIds, state.model) !== null;
}

/** How many boundaries are currently selected (for Create Domain). */
export function countSelectedBoundaries(state: CanvasState): number {
  return state.selection.filter((s) => s.kind === "boundary").length;
}

/** How many selected lines are arcs (have arcCentreId set). */
export function countSelectedArcs(state: CanvasState): number {
  const lineIds = new Set(
    state.selection.filter((s) => s.kind === "line").map((s) => s.id),
  );
  let n = 0;
  for (const l of state.model.lines) {
    if (lineIds.has(l.id) && l.arcCentreId !== undefined) n++;
  }
  return n;
}

/**
 * True if the current selection can be turned into a Domain in one click:
 *   - ≥1 boundary selected, OR
 *   - lines forming a closed loop selected.
 */
export function selectionCanCreateDomain(state: CanvasState): boolean {
  return (
    countSelectedBoundaries(state) > 0 || selectionFormsClosedLoop(state)
  );
}
