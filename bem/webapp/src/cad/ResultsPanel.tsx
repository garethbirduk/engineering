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
  divergingGradientCss,
  divergingUxColor,
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

export interface FieldStats {
  /** Actual minimum value across the triangulation. */
  readonly min: number;
  /** Actual maximum value across the triangulation. */
  readonly max: number;
  /** max(|min|, |max|) — the symmetric range used by the colour scale. */
  readonly range: number;
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
          <ScaleLegend stats={stats} />
        ) : (
          <div className="results-hint">
            {canShowResults
              ? "Select a field above to view the contour."
              : "No results yet — set boundary conditions and let the solver run."}
          </div>
        )}
      </div>
    </div>
  );
}

function ScaleLegend({ stats }: { readonly stats: FieldStats }) {
  // One label per band edge — these are the exact values at which the
  // canvas colour jumps from one contour to the next.
  const edges = bandEdgeValues(stats.range);
  return (
    <div className="results-scale">
      <div
        className="results-scale-bar"
        style={{ background: divergingGradientCss() }}
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
            style={{ background: divergingUxColor(1) }}
          />
          data max: <strong>{fmtSci(stats.max)}</strong>
        </div>
        <div>
          <span
            className="results-scale-swatch"
            style={{ background: divergingUxColor(-1) }}
          />
          data min: <strong>{fmtSci(stats.min)}</strong>
        </div>
      </div>
    </div>
  );
}
