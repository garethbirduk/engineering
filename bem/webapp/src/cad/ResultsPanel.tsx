// Results panel.
//
// Lives on the right of the main canvas. Picks the interior field that
// the contour fills colour by, and shows a legend bar with the symmetric
// diverging scale plus the actual data range.
//
// Field list is extensible: ux, uy today; σxx, σyy, τxy once stresses
// are wired up.

import { divergingGradientCss, divergingUxColor } from "./colorScale.js";

export type InteriorField = "ux" | "uy";

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
  readonly disabled?: boolean;
}

const FIELDS: readonly FieldOption[] = [
  { id: "ux", label: "ux", tooltip: "x-displacement" },
  { id: "uy", label: "uy", tooltip: "y-displacement" },
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
  return (
    <div className="results-panel">
      <h3 className="results-panel-title">Results</h3>

      <div className="results-section">
        <div className="results-section-label">Interior field</div>
        <div className="results-buttons" role="group" aria-label="Interior field">
          {FIELDS.map((f) => {
            const isActive = activeField === f.id;
            return (
              <button
                key={f.id}
                type="button"
                className={`results-btn ${isActive ? "results-btn--active" : ""}`}
                aria-pressed={isActive}
                disabled={!canShowResults || f.disabled}
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

      <div className="results-section">
        <div className="results-section-label">
          Scale {activeField ? `(${activeField})` : ""}
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

      <div className="results-footer-hint">
        Stress fields will appear here once the stress recovery step is
        wired up.
      </div>
    </div>
  );
}

function ScaleLegend({ stats }: { readonly stats: FieldStats }) {
  const R = stats.range;
  const stopLabels = [+R, +R / 2, 0, -R / 2, -R].map(fmtSci);
  return (
    <div className="results-scale">
      <div
        className="results-scale-bar"
        style={{ background: divergingGradientCss() }}
        aria-hidden="true"
      />
      <div className="results-scale-labels">
        {stopLabels.map((label, i) => (
          <span key={i} className="results-scale-label">
            {label}
          </span>
        ))}
      </div>
      <div className="results-scale-meta">
        <div>
          <span className="results-scale-swatch" style={{ background: divergingUxColor(1) }} />
          data max: <strong>{fmtSci(stats.max)}</strong>
        </div>
        <div>
          <span className="results-scale-swatch" style={{ background: divergingUxColor(-1) }} />
          data min: <strong>{fmtSci(stats.min)}</strong>
        </div>
      </div>
    </div>
  );
}
