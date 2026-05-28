// SVG canvas for the CAD editor.
//
// Interaction model:
//   itemMode ∈ { point, line, boundary, domain }
//   action   ∈ { select, delete, create }
// A click is dispatched to the reducer with a HitResult (entity under cursor +
// snap result), and the reducer's (itemMode × action) matrix decides what
// happens.
//
// Coordinate model:
// - All inputs/outputs (Point.x, Point.y, ...) are WORLD coords with y up.
// - SVG natively has y down. We render inside <g transform="scale(1, -1)"> so
//   children specify positions in world coords directly.
// - viewBox holds world coords; we flip its y-extent so panning feels natural.
//
// Pan: shift + left-drag. Zoom: wheel.

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { findClosedLoop, type Vec2 } from "@bem/engine";
import { Toolbar } from "./Toolbar.js";
import { InfoPanel } from "./InfoPanel.js";
import { gridStepForViewWidth } from "./gridStep.js";
import { snapWorld } from "./snap.js";
import { pointMap } from "./operations.js";
import {
  INITIAL_STATE,
  canvasReducer,
  type Action,
  type ItemMode,
} from "./reducer.js";

// ───────────────────────────────────────────────────────────────────────────
// Viewport
// ───────────────────────────────────────────────────────────────────────────

interface ViewBox {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
}

const INITIAL_VIEW: ViewBox = { cx: 0, cy: 0, width: 20, height: 20 };
const MIN_WIDTH = 1e-3;
const MAX_WIDTH = 1e6;
const ZOOM_PER_WHEEL_TICK = 1.15;
const CLICK_DRAG_PX_THRESHOLD = 3;

function viewBoxAttr(v: ViewBox): string {
  const x = v.cx - v.width / 2;
  const y = -(v.cy + v.height / 2);
  return `${x} ${y} ${v.width} ${v.height}`;
}

function clientToWorld(
  svg: SVGSVGElement,
  view: ViewBox,
  clientX: number,
  clientY: number,
): Vec2 {
  const rect = svg.getBoundingClientRect();
  const fx = (clientX - rect.left) / rect.width;
  const fy = (clientY - rect.top) / rect.height;
  return {
    x: view.cx - view.width / 2 + fx * view.width,
    y: view.cy + view.height / 2 - fy * view.height,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Grid
// ───────────────────────────────────────────────────────────────────────────

function Grid({ view, step }: { view: ViewBox; step: number }) {
  const minX = view.cx - view.width / 2;
  const maxX = view.cx + view.width / 2;
  const minY = view.cy - view.height / 2;
  const maxY = view.cy + view.height / 2;
  const startX = Math.ceil(minX / step) * step;
  const endX = Math.floor(maxX / step) * step;
  const startY = Math.ceil(minY / step) * step;
  const endY = Math.floor(maxY / step) * step;

  const verticals: number[] = [];
  for (let x = startX; x <= endX + step / 2; x += step) verticals.push(x);
  const horizontals: number[] = [];
  for (let y = startY; y <= endY + step / 2; y += step) horizontals.push(y);

  const thin = view.width * 0.0005;
  const thick = view.width * 0.0012;
  return (
    <g pointerEvents="none">
      {verticals.map((x) => (
        <line
          key={`v${x}`}
          x1={x}
          y1={minY}
          x2={x}
          y2={maxY}
          stroke="currentColor"
          strokeWidth={Math.abs(x) < step / 2 ? thick : thin}
          opacity={Math.abs(x) < step / 2 ? 0.4 : 0.12}
        />
      ))}
      {horizontals.map((y) => (
        <line
          key={`h${y}`}
          x1={minX}
          y1={y}
          x2={maxX}
          y2={y}
          stroke="currentColor"
          strokeWidth={Math.abs(y) < step / 2 ? thick : thin}
          opacity={Math.abs(y) < step / 2 ? 0.4 : 0.12}
        />
      ))}
    </g>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CadCanvas
// ───────────────────────────────────────────────────────────────────────────

export function CadCanvas() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<ViewBox>(INITIAL_VIEW);
  const [
    {
      model,
      itemMode,
      action,
      selection,
      lineDraft,
      boundaryDraft,
      domainDraft,
      dragSession,
    },
    dispatch,
  ] = useReducer(canvasReducer, INITIAL_STATE);
  const [cursorWorld, setCursorWorld] = useState<Vec2 | null>(null);
  const [snap, setSnap] = useState<ReturnType<typeof snapWorld> | null>(null);

  const panStateRef = useRef<
    | { startClientX: number; startClientY: number; startView: ViewBox }
    | null
  >(null);
  const downStateRef = useRef<
    | { clientX: number; clientY: number; moved: boolean }
    | null
  >(null);

  const gridStep = gridStepForViewWidth(view.width);
  const snapRadius = gridStep;
  const lineTolerance = gridStep * 0.15;
  const pointsById = useMemo(() => pointMap(model.points), [model.points]);

  // ── pan ────────────────────────────────────────────────────────────────

  const onMouseDown = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (e.button !== 0) return;
      downStateRef.current = {
        clientX: e.clientX,
        clientY: e.clientY,
        moved: false,
      };
      if (e.shiftKey) {
        panStateRef.current = {
          startClientX: e.clientX,
          startClientY: e.clientY,
          startView: view,
        };
        e.preventDefault();
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const svg = svgRef.current;
        if (!svg) return;
        const cursor = clientToWorld(svg, view, e.clientX, e.clientY);
        dispatch({ type: "ctrlClick", cursor, lineTolerance, gridStep });
        e.preventDefault();
        return;
      }
      if (action === "select") {
        const svg = svgRef.current;
        if (!svg) return;
        const cursor = clientToWorld(svg, view, e.clientX, e.clientY);
        dispatch({
          type: "startSelectDrag",
          cursor,
          gridStep,
          snapRadius,
          lineTolerance,
        });
      }
    },
    [view, action, gridStep, snapRadius, lineTolerance],
  );

  // ── mouse-move: cursor, snap preview, pan, drag detection ──────────────

  const onMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg) return;

      const world = clientToWorld(svg, view, e.clientX, e.clientY);
      setCursorWorld(world);

      // Drag (point, line, or split-and-drag) takes priority over everything.
      if (dragSession !== null) {
        const snappedToGrid: Vec2 = {
          x: Math.round(world.x / gridStep) * gridStep,
          y: Math.round(world.y / gridStep) * gridStep,
        };
        dispatch({ type: "dragTo", cursor: snappedToGrid });
        return;
      }

      // Snap preview is relevant for any action other than maybe boundary mode
      // where we'll later highlight whole lines; for now always show.
      setSnap(snapWorld(world, model.points, gridStep, snapRadius));

      const down = downStateRef.current;
      if (down && !down.moved) {
        const dx = e.clientX - down.clientX;
        const dy = e.clientY - down.clientY;
        if (
          dx * dx + dy * dy >
          CLICK_DRAG_PX_THRESHOLD * CLICK_DRAG_PX_THRESHOLD
        ) {
          down.moved = true;
        }
      }

      const pan = panStateRef.current;
      if (!pan) return;
      const rect = svg.getBoundingClientRect();
      const dxPx = e.clientX - pan.startClientX;
      const dyPx = e.clientY - pan.startClientY;
      const dxWorld = (dxPx / rect.width) * pan.startView.width;
      const dyWorld = (dyPx / rect.height) * pan.startView.height;
      setView({
        ...pan.startView,
        cx: pan.startView.cx - dxWorld,
        cy: pan.startView.cy + dyWorld,
      });
    },
    [view, model.points, gridStep, snapRadius, dragSession],
  );

  // ── mouse-up: dispatch click to reducer ────────────────────────────────

  const onMouseUp = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const down = downStateRef.current;
      const wasDragging = panStateRef.current !== null;
      downStateRef.current = null;
      panStateRef.current = null;

      // End any active drag. Don't fire a normal click — selection
      // was already set when the drag started.
      if (dragSession !== null) {
        dispatch({ type: "endDrag" });
        return;
      }

      if (!down) return;
      if (down.moved) return;
      if (wasDragging) return;
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;

      const svg = svgRef.current;
      if (!svg) return;
      const world = clientToWorld(svg, view, e.clientX, e.clientY);
      dispatch({
        type: "click",
        ctx: { cursor: world, gridStep, snapRadius, lineTolerance },
      });
    },
    [view, gridStep, snapRadius, lineTolerance, dragSession],
  );

  const onMouseLeave = useCallback(() => {
    downStateRef.current = null;
    panStateRef.current = null;
    setCursorWorld(null);
    setSnap(null);
    if (dragSession !== null) {
      dispatch({ type: "endDrag" });
    }
  }, [dragSession]);

  // ── zoom (wheel, imperative for passive: false) ────────────────────────

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const worldBefore = clientToWorld(svg, view, e.clientX, e.clientY);
      const ticks = e.deltaY > 0 ? 1 : -1;
      const factor = Math.pow(ZOOM_PER_WHEEL_TICK, ticks);
      const newWidth = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, view.width * factor),
      );
      const newHeight = view.height * (newWidth / view.width);
      setView({
        cx:
          worldBefore.x - (worldBefore.x - view.cx) * (newWidth / view.width),
        cy:
          worldBefore.y -
          (worldBefore.y - view.cy) * (newHeight / view.height),
        width: newWidth,
        height: newHeight,
      });
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, [view]);

  // ── aspect-ratio sync ──────────────────────────────────────────────────

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver(() => {
      const rect = svg.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const pxAspect = rect.width / rect.height;
      setView((v) => {
        const targetHeight = v.width / pxAspect;
        if (Math.abs(targetHeight - v.height) < 1e-9) return v;
        return { ...v, height: targetHeight };
      });
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // ── keyboard shortcuts ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const t = e.target;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        (t instanceof HTMLElement && t.isContentEditable)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      const itemKeys: Record<string, ItemMode> = {
        "1": "point",
        "2": "line",
        "3": "boundary",
        "4": "domain",
      };
      const actionKeys: Record<string, Action> = {
        s: "select",
        d: "delete",
        c: "create",
      };
      if (key in itemKeys) {
        dispatch({ type: "setItemMode", itemMode: itemKeys[key]! });
      } else if (key in actionKeys) {
        dispatch({ type: "setAction", action: actionKeys[key]! });
      } else if (e.key === "Escape") {
        dispatch({ type: "cancel" });
      } else if (e.key === "Enter") {
        // Enter commits whichever draft is active.
        dispatch({ type: "commitBoundary" });
        dispatch({ type: "commitDomain" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ── visuals scaled by view width ───────────────────────────────────────

  const pointRadius = view.width * 0.005;
  const lineStroke = view.width * 0.002;
  const snapRingRadius = view.width * 0.009;
  const snapRingStroke = view.width * 0.0012;
  const selectionHaloRadius = pointRadius * 2.4;
  const selectionHaloStroke = view.width * 0.0018;
  const normalTickLen = view.width * 0.015;

  // Rubber-band preview for line creation.
  const rubberBand = useMemo(() => {
    if (action !== "create" || itemMode !== "line") return null;
    if (!lineDraft || !snap) return null;
    const start = pointsById.get(lineDraft.startPointId);
    if (!start) return null;
    return { start: { x: start.x, y: start.y }, end: snap.snapped };
  }, [action, itemMode, lineDraft, snap, pointsById]);

  // Boundary-draft membership lookup (fast `has` for line rendering).
  const boundaryDraftSet = useMemo(
    () => new Set(boundaryDraft),
    [boundaryDraft],
  );

  // Lines belonging to any boundary currently in the domain draft.
  const domainDraftLines = useMemo(() => {
    const draftIds = new Set(domainDraft);
    const lineIds = new Set<string>();
    for (const b of model.boundaries) {
      if (!draftIds.has(b.id)) continue;
      for (const seg of b.segments) lineIds.add(seg.lineId);
    }
    return lineIds;
  }, [domainDraft, model.boundaries]);

  // Lines belonging to any committed boundary (rendered in red).
  const linesInBoundary = useMemo(() => {
    const ids = new Set<string>();
    for (const b of model.boundaries) {
      for (const seg of b.segments) ids.add(seg.lineId);
    }
    return ids;
  }, [model.boundaries]);

  // SVG path "d" attribute, one subpath per boundary per domain.
  // Each boundary contributes a closed loop of its segments' start vertices.
  // Multiple boundaries within a domain use even-odd fill to make holes work
  // (first boundary = exterior; subsequent = holes — by convention).
  const domainsPathData = useMemo(() => {
    const boundariesById = new Map(model.boundaries.map((b) => [b.id, b]));
    const out: string[] = [];
    for (const domain of model.domains) {
      for (const bid of domain.boundaryIds) {
        const boundary = boundariesById.get(bid);
        if (!boundary || boundary.segments.length < 3) continue;
        let sub = "";
        for (let i = 0; i < boundary.segments.length; i++) {
          const seg = boundary.segments[i]!;
          const line = model.lines.find((l) => l.id === seg.lineId);
          if (!line) {
            sub = "";
            break;
          }
          const startPointId =
            seg.direction === 1 ? line.startId : line.endId;
          const p = pointsById.get(startPointId);
          if (!p) {
            sub = "";
            break;
          }
          sub += `${i === 0 ? "M" : "L"} ${p.x} ${p.y} `;
        }
        if (sub) out.push(sub + "Z");
      }
    }
    return out.join(" ");
  }, [model.domains, model.boundaries, model.lines, pointsById]);

  // Does the current boundary-draft form a closed loop?
  const boundaryDraftClosed = useMemo(() => {
    if (itemMode !== "boundary" || action !== "create") return false;
    if (boundaryDraft.length === 0) return false;
    return findClosedLoop(boundaryDraft, model) !== null;
  }, [itemMode, action, boundaryDraft, model]);

  // ── cursor style cue ───────────────────────────────────────────────────

  const cursorClass =
    dragSession !== null ? "cad-canvas--grabbing"
    : action === "delete" ? "cad-canvas--delete"
    : action === "select" ? "cad-canvas--select"
    : "cad-canvas--create";

  // ── status text ────────────────────────────────────────────────────────

  const statusBits: string[] = [];
  statusBits.push(`${itemMode} · ${action}`);
  if (cursorWorld) {
    statusBits.push(`x ${cursorWorld.x.toFixed(3)} y ${cursorWorld.y.toFixed(3)}`);
  }
  statusBits.push(`grid ${gridStep}`);
  if (lineDraft) statusBits.push("line: place end (Esc to cancel)");
  if (dragSession) {
    const n = dragSession.originalPositions.size;
    statusBits.push(`dragging ${n} point${n === 1 ? "" : "s"} (release to drop)`);
  }
  if (boundaryDraft.length > 0)
    statusBits.push(`boundary draft: ${boundaryDraft.length} line(s)`);
  if (domainDraft.length > 0)
    statusBits.push(`domain draft: ${domainDraft.length} bdy`);
  statusBits.push(
    `pts ${model.points.length}  lns ${model.lines.length}  bds ${model.boundaries.length}  doms ${model.domains.length}`,
  );

  // ── render ─────────────────────────────────────────────────────────────

  return (
    <div className="cad-layout">
      <Toolbar
        itemMode={itemMode}
        action={action}
        onItemMode={(m) => dispatch({ type: "setItemMode", itemMode: m })}
        onAction={(a) => dispatch({ type: "setAction", action: a })}
      />
      <div className="cad-main">
        <div className="cad-canvas-host">
          <svg
            ref={svgRef}
            className={`cad-canvas ${cursorClass}`}
            viewBox={viewBoxAttr(view)}
            preserveAspectRatio="xMidYMid meet"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseLeave}
            data-tool={`${itemMode}-${action}`}
          >
            <g transform="scale(1, -1)">
              <Grid view={view} step={gridStep} />

              {/* Domain fills — drawn under lines and points. */}
              {domainsPathData && (
                <path
                  d={domainsPathData}
                  fill="var(--boundary)"
                  fillRule="evenodd"
                  fillOpacity={0.18}
                  pointerEvents="none"
                />
              )}

              {/* Straight lines + outward-normal ticks.
                  The tick at the midpoint is rotated 90° CW from the
                  start→end direction, i.e. (dy, -dx)/|d|. For a boundary
                  traversed CCW (the usual exterior convention) this is the
                  outward direction. Inner-hole loops drawn CW will need
                  flipping later; revisit when boundary topology informs
                  the renderer. */}
              <g pointerEvents="none">
                {model.lines.map((l) => {
                  const start = pointsById.get(l.startId);
                  const end = pointsById.get(l.endId);
                  if (!start || !end) return null;
                  const isSelected =
                    selection?.kind === "line" && selection.id === l.id;
                  const inBoundaryDraft = boundaryDraftSet.has(l.id);
                  const inDomainDraft = domainDraftLines.has(l.id);
                  const inBoundary = linesInBoundary.has(l.id);
                  const highlighted =
                    isSelected || inBoundaryDraft || inDomainDraft;
                  const stroke = highlighted
                    ? "var(--accent)"
                    : inBoundary
                      ? "var(--boundary)"
                      : "currentColor";

                  const dx = end.x - start.x;
                  const dy = end.y - start.y;
                  const len = Math.hypot(dx, dy);
                  const mx = (start.x + end.x) / 2;
                  const my = (start.y + end.y) / 2;
                  const showTick = len > normalTickLen * 1.2;
                  const tickEnd = showTick
                    ? {
                        x: mx + (dy / len) * normalTickLen,
                        y: my + (-dx / len) * normalTickLen,
                      }
                    : null;

                  return (
                    <g key={l.id}>
                      <line
                        x1={start.x}
                        y1={start.y}
                        x2={end.x}
                        y2={end.y}
                        stroke={stroke}
                        strokeWidth={
                          highlighted ? lineStroke * 1.8 : lineStroke
                        }
                        strokeLinecap="round"
                      />
                      {tickEnd && (
                        <line
                          x1={mx}
                          y1={my}
                          x2={tickEnd.x}
                          y2={tickEnd.y}
                          stroke={stroke}
                          strokeWidth={lineStroke * 0.8}
                          strokeLinecap="round"
                          opacity={0.75}
                        />
                      )}
                    </g>
                  );
                })}
              </g>

              {/* Points. */}
              <g pointerEvents="none">
                {model.points.map((p) => {
                  const isSelected =
                    selection?.kind === "point" && selection.id === p.id;
                  return (
                    <g key={p.id}>
                      {isSelected && (
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r={selectionHaloRadius}
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth={selectionHaloStroke}
                        />
                      )}
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={pointRadius}
                        fill="currentColor"
                      />
                    </g>
                  );
                })}
              </g>

              {/* Rubber-band preview (line create). */}
              {rubberBand && (
                <line
                  x1={rubberBand.start.x}
                  y1={rubberBand.start.y}
                  x2={rubberBand.end.x}
                  y2={rubberBand.end.y}
                  stroke="currentColor"
                  strokeWidth={lineStroke}
                  strokeDasharray={`${lineStroke * 4} ${lineStroke * 3}`}
                  opacity={0.5}
                  pointerEvents="none"
                />
              )}

              {/* Snap indicator. */}
              {snap && action === "create" && (
                <circle
                  cx={snap.snapped.x}
                  cy={snap.snapped.y}
                  r={snapRingRadius}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth={snapRingStroke}
                  opacity={snap.existingPointId ? 1 : 0.75}
                  pointerEvents="none"
                />
              )}
            </g>
          </svg>
          {itemMode === "boundary" && action === "create" && (
            <div
              className={`cad-banner ${boundaryDraftClosed ? "cad-banner--ready" : ""}`}
            >
              <span>
                {boundaryDraft.length === 0
                  ? "Click lines to add them to a new boundary."
                  : `${boundaryDraft.length} line${boundaryDraft.length === 1 ? "" : "s"} selected — ${
                      boundaryDraftClosed
                        ? "forms a closed loop."
                        : "not yet a closed loop."
                    }`}
              </span>
              <div className="cad-banner-actions">
                <button
                  type="button"
                  className="cad-banner-btn cad-banner-btn--primary"
                  disabled={!boundaryDraftClosed}
                  onClick={() => dispatch({ type: "commitBoundary" })}
                  title="Enter"
                >
                  Create boundary
                </button>
                <button
                  type="button"
                  className="cad-banner-btn"
                  disabled={boundaryDraft.length === 0}
                  onClick={() => dispatch({ type: "cancel" })}
                  title="Esc"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {itemMode === "domain" && action === "create" && (
            <div
              className={`cad-banner ${domainDraft.length > 0 ? "cad-banner--ready" : ""}`}
            >
              <span>
                {model.boundaries.length === 0
                  ? "No boundaries to pick from. Create one first."
                  : domainDraft.length === 0
                    ? "Tick boundaries in the panel, or click a boundary line on the canvas."
                    : `${domainDraft.length} boundar${
                        domainDraft.length === 1 ? "y" : "ies"
                      } selected.`}
              </span>
              <div className="cad-banner-actions">
                <button
                  type="button"
                  className="cad-banner-btn cad-banner-btn--primary"
                  disabled={domainDraft.length === 0}
                  onClick={() => dispatch({ type: "commitDomain" })}
                  title="Enter"
                >
                  Create domain
                </button>
                <button
                  type="button"
                  className="cad-banner-btn"
                  disabled={domainDraft.length === 0}
                  onClick={() => dispatch({ type: "cancel" })}
                  title="Esc"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          <div className="cad-canvas-status">{statusBits.join("  ·  ")}</div>
        </div>
        <InfoPanel
          model={model}
          selection={selection}
          itemMode={itemMode}
          action={action}
          domainDraft={domainDraft}
          onDispatch={dispatch}
        />
      </div>
    </div>
  );
}
