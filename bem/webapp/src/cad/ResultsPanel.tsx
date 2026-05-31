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
  | "tmax";

/** Fields that are ≥ 0 by definition (sums-of-squares, magnitudes).
 *  These use a sequential 0→max colour scale instead of the diverging
 *  ±range scale used for fields that can swing either way. */
export function isPositiveOnlyField(field: InteriorField): boolean {
  return field === "svm" || field === "tmax";
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
  /** Profile of the active field along selected boundary line(s). Null
   *  when nothing's selected, no field is active, or the solver hasn't
   *  produced output. */
  readonly edgeProfile: EdgeProfile | null;
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
            Along selected edge{edgeProfile && edgeProfile.segments.length > 1 ? "s" : ""}{" "}
            ({activeLabel})
          </div>
          {edgeProfile ? (
            <EdgeProfilePlot profile={edgeProfile} />
          ) : (
            <div className="results-hint">
              Select one or more boundary lines to plot {activeLabel} along
              their arc length.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EdgeProfilePlot({ profile }: { readonly profile: EdgeProfile }) {
  // Data range — auto-fit, with a small symmetric pad so the curve
  // doesn't hug the top/bottom edges.
  let dMin = Infinity;
  let dMax = -Infinity;
  for (const line of profile.curveByLine) {
    for (const p of line) {
      if (Number.isFinite(p.value)) {
        if (p.value < dMin) dMin = p.value;
        if (p.value > dMax) dMax = p.value;
      }
    }
  }
  for (const n of profile.nodes) {
    if (Number.isFinite(n.value)) {
      if (n.value < dMin) dMin = n.value;
      if (n.value > dMax) dMax = n.value;
    }
  }
  if (!Number.isFinite(dMin) || !Number.isFinite(dMax)) {
    return <div className="results-hint">No samples yet.</div>;
  }
  if (dMin === dMax) {
    // Pad a constant field so it doesn't degenerate to a single line.
    const pad = Math.abs(dMin) > 0 ? Math.abs(dMin) * 0.1 : 1;
    dMin -= pad;
    dMax += pad;
  } else {
    const pad = (dMax - dMin) * 0.08;
    dMin -= pad;
    dMax += pad;
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

  // y-axis tick values: min, mid, max plus 0 if it lies within range.
  const yTicks: number[] = [dMin, dMax];
  const mid = (dMin + dMax) / 2;
  yTicks.push(mid);
  if (dMin < 0 && dMax > 0) yTicks.push(0);
  yTicks.sort((a, b) => a - b);

  // y = 0 axis if it crosses the plot.
  const showZero = dMin < 0 && dMax > 0;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="results-edge-plot"
      aria-label={`${profile.field} along selected edges`}
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
        {edges.map((v, i) => (
          <span key={i} className="results-scale-label">
            {fmtSci(v)}
          </span>
        ))}
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
