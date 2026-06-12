// Results panel.
//
// Lives on the right of the main canvas. Picks the interior field that
// the contour fills colour by, and shows a legend bar with the symmetric
// diverging scale plus the actual data range.
//
// Fields are grouped: displacement (ux, uy) — primary BEM solve output;
// Cartesian stress (σxx, σyy, τxy) — from the stress Somigliana identity
// at every triangulation vertex; derived stress scalars (σvm, σ1, σ2,
// τmax) — algebra on the Cartesian components, evaluated per vertex.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  bandEdgeValues,
  bandEdgeValuesSequential,
  divergingGradientCss,
  divergingUxColor,
  sequentialGradientCss,
  sequentialUxColor,
} from "./colorScale.js";

export type InteriorField =
  | "ux"
  | "uy"
  | "sxx"
  | "syy"
  | "sxy"
  | "svm"
  | "s1"
  | "s2"
  | "tmax"
  | "scf";

/** Fields that are ≥ 0 by definition (sums-of-squares, magnitudes).
 *  These use a sequential 0→max colour scale instead of the diverging
 *  ±range scale used for fields that can swing either way. */
export function isPositiveOnlyField(field: InteriorField): boolean {
  return field === "svm" || field === "tmax" || field === "scf";
}

export interface FieldStats {
  /** Actual minimum value across the triangulation. */
  readonly min: number;
  /** Actual maximum value across the triangulation. */
  readonly max: number;
  /** max(|min|, |max|) — the symmetric range used by the colour scale. */
  readonly range: number;
}

/** Profile of the active interior field along one or more selected
 *  boundary lines, parameterised by arc length. Adjacent lines are
 *  concatenated in selection order — the x-axis advances continuously
 *  with a vertical separator at each line boundary. */
export interface EdgeProfile {
  readonly field: InteriorField;
  readonly totalArc: number;
  /** Dense curve samples, one inner array per selected line so the
   *  rendered path doesn't connect across discontinuities. */
  readonly curveByLine: readonly (readonly {
    readonly lineId: string;
    readonly arc: number;
    readonly value: number;
    /** World position of this sample — used by the canvas to render
     *  a hover-tracking marker in sync with the plot's crosshair. */
    readonly x: number;
    readonly y: number;
  }[])[];
  /** Element nodes — 3 per element, drawn as dots. */
  readonly nodes: readonly {
    readonly arc: number;
    readonly value: number;
    readonly lineId: string;
  }[];
  readonly segments: readonly {
    readonly lineId: string;
    readonly startArc: number;
    readonly endArc: number;
    readonly startPoint: { readonly x: number; readonly y: number };
    readonly endPoint: { readonly x: number; readonly y: number };
  }[];
}

interface FieldOption {
  readonly id: InteriorField;
  readonly label: string;
  readonly tooltip: string;
}

interface FieldGroup {
  readonly title: string;
  readonly fields: readonly FieldOption[];
}

const GROUPS: readonly FieldGroup[] = [
  {
    title: "Displacement",
    fields: [
      { id: "ux", label: "ux", tooltip: "x-displacement" },
      { id: "uy", label: "uy", tooltip: "y-displacement" },
    ],
  },
  {
    title: "Cartesian stress",
    fields: [
      { id: "sxx", label: "σxx", tooltip: "Normal stress σ_xx" },
      { id: "syy", label: "σyy", tooltip: "Normal stress σ_yy" },
      { id: "sxy", label: "τxy", tooltip: "Shear stress σ_xy = τ_xy" },
    ],
  },
  {
    title: "Derived stress",
    fields: [
      { id: "svm", label: "σvm", tooltip: "von Mises equivalent stress" },
      { id: "s1", label: "σ1", tooltip: "Major principal stress" },
      { id: "s2", label: "σ2", tooltip: "Minor principal stress" },
      { id: "tmax", label: "τmax", tooltip: "Max in-plane shear" },
      {
        id: "scf",
        label: "Kt",
        tooltip:
          "Stress concentration factor: σvm / σref, where σref = max |applied traction| across BCs",
      },
    ],
  },
];

interface ResultsPanelProps {
  /** Currently-active interior field, or null when no contour is shown. */
  readonly activeField: InteriorField | null;
  /** Stats for the currently-active field (null when no contour). */
  readonly stats: FieldStats | null;
  /** True when results CAN be shown (solve produced output and the
   *  triangulation exists). When false, all field buttons are disabled. */
  readonly canShowResults: boolean;
  /** Profile of the active field along the source the user picked:
   *  one or more selected boundary lines (default) or a slice line
   *  drawn across the domain (when slice mode supplies one). Null
   *  when nothing's selected or sliced. */
  readonly edgeProfile: EdgeProfile | null;
  /** True when `edgeProfile` came from the slice tool — changes the
   *  section label so the user can tell which source is plotted. */
  readonly isSlice?: boolean;
  /** Fires whenever the user's crosshair lands on (or leaves) a
   *  curve sample. The canvas uses this to render a white marker at
   *  the matching world position, so the user can see where the
   *  hovered graph value lives in the model. */
  readonly onHoverWorld?:
    | ((world: { x: number; y: number } | null) => void)
    | undefined;
  /** Click handler. Pass the same field again to toggle off. */
  readonly onSelectField: (field: InteriorField | null) => void;
}

function fmtSci(x: number): string {
  if (x === 0) return "0";
  const s = x.toExponential(2);
  return x > 0 ? `+${s}` : s;
}

export function ResultsPanel({
  activeField,
  stats,
  canShowResults,
  edgeProfile,
  isSlice = false,
  onHoverWorld,
  onSelectField,
}: ResultsPanelProps) {
  const activeLabel = (() => {
    for (const g of GROUPS) {
      for (const f of g.fields) if (f.id === activeField) return f.label;
    }
    return "";
  })();
  return (
    <div className="results-panel">
      <h3 className="results-panel-title">Results</h3>

      {GROUPS.map((group) => (
        <div className="results-section" key={group.title}>
          <div className="results-section-label">{group.title}</div>
          <div
            className="results-buttons"
            role="group"
            aria-label={group.title}
          >
            {group.fields.map((f) => {
              const isActive = activeField === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`results-btn ${isActive ? "results-btn--active" : ""}`}
                  aria-pressed={isActive}
                  disabled={!canShowResults}
                  title={
                    canShowResults
                      ? `${f.tooltip} (click to toggle)`
                      : "Add geometry + boundary conditions to enable"
                  }
                  onClick={() => onSelectField(isActive ? null : f.id)}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="results-section">
        <div className="results-section-label">
          Scale {activeField ? `(${activeLabel})` : ""}
        </div>
        {activeField && stats ? (
          <ScaleLegend stats={stats} activeField={activeField} />
        ) : (
          <div className="results-hint">
            {canShowResults
              ? "Select a field above to view the contour."
              : "No results yet — set boundary conditions and let the solver run."}
          </div>
        )}
      </div>

      {activeField && (
        <div className="results-section">
          <div className="results-section-label">
            {isSlice
              ? `Along slice (${activeLabel})`
              : `Along selected edge${edgeProfile && edgeProfile.segments.length > 1 ? "s" : ""} (${activeLabel})`}
          </div>
          {edgeProfile ? (
            <EdgeProfilePlot
              profile={edgeProfile}
              onHoverWorld={onHoverWorld}
            />
          ) : (
            <div className="results-hint">
              Select one or more boundary lines (or draw a slice in Slice
              mode) to plot {activeLabel} along arc length.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EdgeProfilePlot({
  profile,
  onHoverWorld,
}: {
  readonly profile: EdgeProfile;
  readonly onHoverWorld?:
    | ((world: { x: number; y: number } | null) => void)
    | undefined;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverArc, setHoverArc] = useState<number | null>(null);

  // True data extremes (unpadded) — what the tick labels report so
  // the values read out of the plot match the contour's data max/min.
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const line of profile.curveByLine) {
    for (const p of line) {
      if (Number.isFinite(p.value)) {
        if (p.value < dataMin) dataMin = p.value;
        if (p.value > dataMax) dataMax = p.value;
      }
    }
  }
  for (const n of profile.nodes) {
    if (Number.isFinite(n.value)) {
      if (n.value < dataMin) dataMin = n.value;
      if (n.value > dataMax) dataMax = n.value;
    }
  }
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
    return <div className="results-hint">No samples yet.</div>;
  }
  // Axis range — small symmetric pad so the curve doesn't hug the
  // top/bottom edges. Padded range is only used for pixel mapping;
  // tick labels still report the true dataMin/dataMax.
  let dMin: number;
  let dMax: number;
  if (dataMin === dataMax) {
    const pad = Math.abs(dataMin) > 0 ? Math.abs(dataMin) * 0.1 : 1;
    dMin = dataMin - pad;
    dMax = dataMax + pad;
  } else {
    const pad = (dataMax - dataMin) * 0.08;
    dMin = dataMin - pad;
    dMax = dataMax + pad;
  }

  const W = 260;
  const H = 180;
  const padL = 44;
  const padR = 6;
  const padT = 10;
  const padB = 26;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const xMin = 0;
  const xMax = profile.totalArc > 0 ? profile.totalArc : 1;
  const xPx = (x: number) => padL + ((x - xMin) / (xMax - xMin)) * innerW;
  const yPx = (y: number) => padT + ((dMax - y) / (dMax - dMin)) * innerH;

  // Flat list of all curve samples, ordered by global arc length.
  // Used by the crosshair to snap to the nearest curve point under
  // the cursor's x position. Each sample carries the world position
  // it was taken at so the canvas can render a tracking marker.
  const flatSamples = useMemo(() => {
    const out: {
      arc: number;
      value: number;
      lineId: string;
      x: number;
      y: number;
    }[] = [];
    for (const line of profile.curveByLine) {
      for (const p of line) {
        if (Number.isFinite(p.value)) {
          out.push({
            arc: p.arc,
            value: p.value,
            lineId: p.lineId,
            x: p.x,
            y: p.y,
          });
        }
      }
    }
    return out;
  }, [profile]);

  // Snap the hovered arc to the nearest curve sample so the readout
  // value is exactly what the BEM solver produced (no interpolation
  // artefacts in the crosshair label).
  const hover = (() => {
    if (hoverArc === null || flatSamples.length === 0) return null;
    let best = flatSamples[0]!;
    let bestD = Math.abs(best.arc - hoverArc);
    for (let i = 1; i < flatSamples.length; i++) {
      const s = flatSamples[i]!;
      const d = Math.abs(s.arc - hoverArc);
      if (d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  })();

  // Notify the canvas of the matching world position so it can render
  // a tracking marker. Fires on every render where `hover` changes.
  const lastHoverWorldRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!onHoverWorld) return;
    const next = hover ? { x: hover.x, y: hover.y } : null;
    const prev = lastHoverWorldRef.current;
    const same =
      (prev === null && next === null) ||
      (prev !== null &&
        next !== null &&
        prev.x === next.x &&
        prev.y === next.y);
    if (!same) {
      lastHoverWorldRef.current = next;
      onHoverWorld(next);
    }
  });

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    // Convert client px → viewBox units (the SVG scales with
    // preserveAspectRatio="xMidYMid meet" so the displayed box may
    // not match the rect 1:1 in either dimension; use the smaller
    // scale axis to be safe).
    const sx = rect.width / W;
    const sy = rect.height / H;
    const s = Math.min(sx, sy);
    const offX = (rect.width - W * s) / 2;
    const offY = (rect.height - H * s) / 2;
    const xVB = (e.clientX - rect.left - offX) / s;
    const yVB = (e.clientY - rect.top - offY) / s;
    if (
      xVB < padL ||
      xVB > W - padR ||
      yVB < padT ||
      yVB > H - padB
    ) {
      setHoverArc(null);
      return;
    }
    const arc = xMin + ((xVB - padL) / innerW) * (xMax - xMin);
    setHoverArc(arc);
  };
  const onMouseLeave = () => setHoverArc(null);

  // y-axis tick values: true data min/max, mid of the data range,
  // plus 0 if it lies within range. Reporting unpadded values means
  // the visible max/min on the plot matches the contour's data max/min.
  const yTicks: number[] = [dataMin, dataMax];
  const mid = (dataMin + dataMax) / 2;
  yTicks.push(mid);
  if (dataMin < 0 && dataMax > 0) yTicks.push(0);
  yTicks.sort((a, b) => a - b);

  // y = 0 axis if it crosses the plot.
  const showZero = dataMin < 0 && dataMax > 0;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="results-edge-plot"
      aria-label={`${profile.field} along selected edges`}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      {/* axes */}
      <line
        x1={padL}
        y1={padT}
        x2={padL}
        y2={H - padB}
        stroke="currentColor"
        strokeWidth={0.6}
        opacity={0.6}
      />
      <line
        x1={padL}
        y1={H - padB}
        x2={W - padR}
        y2={H - padB}
        stroke="currentColor"
        strokeWidth={0.6}
        opacity={0.6}
      />
      {/* zero line */}
      {showZero && (
        <line
          x1={padL}
          y1={yPx(0)}
          x2={W - padR}
          y2={yPx(0)}
          stroke="currentColor"
          strokeWidth={0.5}
          opacity={0.25}
          strokeDasharray="2 2"
        />
      )}
      {/* segment separators (vertical lines at each line-end arc) */}
      {profile.segments.slice(0, -1).map((seg, i) => (
        <line
          key={`sep${i}`}
          x1={xPx(seg.endArc)}
          y1={padT}
          x2={xPx(seg.endArc)}
          y2={H - padB}
          stroke="currentColor"
          strokeWidth={0.5}
          opacity={0.2}
          strokeDasharray="3 2"
        />
      ))}
      {/* curve, one polyline per selected line */}
      {profile.curveByLine.map((line, li) => {
        if (line.length < 2) return null;
        const d = line
          .map((p, i) => `${i === 0 ? "M" : "L"} ${xPx(p.arc)} ${yPx(p.value)}`)
          .join(" ");
        return (
          <path
            key={`c${li}`}
            d={d}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      {/* nodal dots */}
      {profile.nodes.map((n, i) => (
        <circle
          key={`n${i}`}
          cx={xPx(n.arc)}
          cy={yPx(n.value)}
          r={2.6}
          fill="var(--bc-anchor)"
          stroke="canvas"
          strokeWidth={0.6}
        />
      ))}
      {/* y-axis tick labels */}
      {yTicks.map((v, i) => (
        <g key={`yt${i}`}>
          <line
            x1={padL - 3}
            y1={yPx(v)}
            x2={padL}
            y2={yPx(v)}
            stroke="currentColor"
            strokeWidth={0.6}
            opacity={0.6}
          />
          <text
            x={padL - 5}
            y={yPx(v) + 3}
            textAnchor="end"
            fontSize="8.5"
            fill="currentColor"
            opacity={0.7}
          >
            {fmtSci(v)}
          </text>
        </g>
      ))}
      {/* x-axis tick labels — start of every segment + final endpoint */}
      {[
        ...profile.segments.map((s, i) => ({ arc: s.startArc, idx: i, kind: "start" as const })),
        {
          arc: profile.segments[profile.segments.length - 1]!.endArc,
          idx: profile.segments.length,
          kind: "end" as const,
        },
      ].map((tick, i) => (
        <g key={`xt${i}`}>
          <line
            x1={xPx(tick.arc)}
            y1={H - padB}
            x2={xPx(tick.arc)}
            y2={H - padB + 3}
            stroke="currentColor"
            strokeWidth={0.6}
            opacity={0.6}
          />
          <text
            x={xPx(tick.arc)}
            y={H - padB + 11}
            textAnchor="middle"
            fontSize="8.5"
            fill="currentColor"
            opacity={0.7}
          >
            {tick.arc.toPrecision(3)}
          </text>
        </g>
      ))}
      {/* axis labels */}
      <text
        x={padL + innerW / 2}
        y={H - 4}
        textAnchor="middle"
        fontSize="8.5"
        fill="currentColor"
        opacity={0.55}
      >
        arc length
      </text>
      {/* crosshair — vertical + horizontal dashed lines through the
          snapped curve sample, with a (arc, value) readout above the
          intersection. Clamps the readout box to the plot area so it
          stays visible at all hover positions. */}
      {hover && (() => {
        const cx = xPx(hover.arc);
        const cy = yPx(hover.value);
        const label = `${hover.arc.toPrecision(3)}, ${fmtSci(hover.value)}`;
        const charW = 5.4;
        const boxW = label.length * charW + 8;
        const boxH = 14;
        // Default: above and slightly right of the dot. Flip below
        // when near the top of the plot, clamp horizontally.
        let bx = cx + 6;
        let by = cy - boxH - 6;
        if (by < padT) by = cy + 6;
        if (bx + boxW > W - padR) bx = cx - boxW - 6;
        if (bx < padL) bx = padL;
        return (
          <g pointerEvents="none">
            <line
              x1={cx}
              y1={padT}
              x2={cx}
              y2={H - padB}
              stroke="currentColor"
              strokeWidth={0.6}
              opacity={0.5}
              strokeDasharray="3 3"
            />
            <line
              x1={padL}
              y1={cy}
              x2={W - padR}
              y2={cy}
              stroke="currentColor"
              strokeWidth={0.6}
              opacity={0.5}
              strokeDasharray="3 3"
            />
            <circle
              cx={cx}
              cy={cy}
              r={3}
              fill="var(--accent)"
              stroke="canvas"
              strokeWidth={1}
            />
            <rect
              x={bx}
              y={by}
              width={boxW}
              height={boxH}
              rx={2}
              ry={2}
              fill="canvas"
              stroke="currentColor"
              strokeOpacity={0.5}
              strokeWidth={0.6}
            />
            <text
              x={bx + 4}
              y={by + 10}
              fontSize="9"
              fill="currentColor"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
            >
              {label}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}

function ScaleLegend({
  stats,
  activeField,
}: {
  readonly stats: FieldStats;
  readonly activeField: InteriorField;
}) {
  // Positive-only fields (σvm, τmax) use a 0→max sequential scale;
  // everything else uses the symmetric diverging scale.
  const positive = isPositiveOnlyField(activeField);
  // One label per band edge — these are the exact values at which the
  // canvas colour jumps from one contour to the next.
  const edges = positive
    ? bandEdgeValuesSequential(stats.range)
    : bandEdgeValues(stats.range);
  const gradient = positive ? sequentialGradientCss() : divergingGradientCss();
  const topSwatch = positive ? sequentialUxColor(1) : divergingUxColor(1);
  const bottomSwatch = positive ? sequentialUxColor(0) : divergingUxColor(-1);
  const bottomLabel = positive ? "data min" : "data min";
  return (
    <div className="results-scale">
      <div
        className="results-scale-bar"
        style={{ background: gradient }}
        aria-hidden="true"
      />
      <div className="results-scale-labels">
        {edges.map((v, i) => {
          // Each label sits at its band edge in the colour bar.
          // edges[0] = top edge of top band (data-side max);
          // edges[N] = bottom edge of bottom band (data-side min or 0).
          // Both extremes are explicit; intermediate labels mark every
          // band transition.
          const top = (i / (edges.length - 1)) * 100;
          return (
            <span
              key={i}
              className="results-scale-label"
              style={{ top: `${top}%` }}
            >
              {fmtSci(v)}
            </span>
          );
        })}
      </div>
      <div className="results-scale-meta">
        <div>
          <span
            className="results-scale-swatch"
            style={{ background: topSwatch }}
          />
          data max: <strong>{fmtSci(stats.max)}</strong>
        </div>
        <div>
          <span
            className="results-scale-swatch"
            style={{ background: bottomSwatch }}
          />
          {bottomLabel}: <strong>{fmtSci(stats.min)}</strong>
        </div>
      </div>
    </div>
  );
}
