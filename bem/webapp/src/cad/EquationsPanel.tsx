// Per-pair view of the BEM system. For one collocation node and the
// CURRENTLY SELECTED source elements (from the standard line /
// boundary selection), show one pair of 2×6 H and G submatrices per
// element.
//
// Rows ⇄ collocation DOFs (sx, sy).
// Cols ⇄ element field DOFs (node0_x, node0_y, node1_x, node1_y,
//                             node2_x, node2_y).
//
// Numbers come straight from `integrateOverElement(s, element,
// material, singularLocalIdx)`. Singular detection is by world
// position — if any element node coincides with the collocation
// point, that's the local η on which Telles concentrates Gauss
// points. The rigid-body H_ii correction is NOT applied here: this
// view is about the raw kernel integration the assembler does per
// pair, before the row-sum diagonal fixup.

import { useEffect, useMemo, useState } from "react";
import {
  integrateOverElement,
  traceBoundaryKernels,
  traceCellIntegrand,
  type Boundary,
  type IntegrandTrace,
  type MaterialProperties,
  type MeshElement,
  type Vec2,
} from "@bem/engine";
import { BoundaryKernelPanel } from "./BoundaryKernelPanel.js";

export interface EquationsPick {
  readonly nodeIdx: number | null;
}

interface EquationsPanelProps {
  readonly pick: EquationsPick;
  readonly nodePositions: readonly Vec2[];
  readonly meshElements: readonly MeshElement[];
  readonly boundaries: readonly Boundary[];
  readonly material: MaterialProperties;
  readonly selectedElementKeys: ReadonlySet<string>;
  readonly onClear: () => void;
}

/** A cell click — kernel + (row, col) within ONE specific element's
 *  2×6 H or G submatrix. The element key disambiguates between
 *  multiple submatrices on screen at once. */
interface ScopedCellSelector {
  readonly elementKey: string;
  readonly kernel: "H" | "G";
  readonly row: 0 | 1;
  readonly col: 0 | 1 | 2 | 3 | 4 | 5;
}

const POS_EPS = 1e-9;

function findSingularLocalIdx(
  s: Vec2,
  element: MeshElement,
): 0 | 1 | 2 | null {
  for (let k = 0; k < 3; k++) {
    const n = element.nodes[k]!;
    if (Math.hypot(n.x - s.x, n.y - s.y) < POS_EPS * 10) return k as 0 | 1 | 2;
  }
  return null;
}

function elementByKey(
  mesh: readonly MeshElement[],
  key: string,
): MeshElement | undefined {
  const [lineId, idxStr] = key.split("|");
  const idx = Number(idxStr);
  return mesh.find((el) => el.lineId === lineId && el.indexInLine === idx);
}

/** Format a kernel value for the table — keep enough precision to
 *  distinguish neighbouring entries, but stay compact. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e4 || abs < 1e-3) return v.toExponential(3);
  return v.toPrecision(5);
}

export function EquationsPanel({
  pick,
  nodePositions,
  meshElements,
  boundaries,
  material,
  selectedElementKeys,
  onClear,
}: EquationsPanelProps) {
  const node =
    pick.nodeIdx !== null ? nodePositions[pick.nodeIdx] ?? null : null;

  // Source elements come from the standard line / boundary selection
  // now, expanded out to per-element keys by CadCanvas. Preserve
  // mesh-walk order so the panel reads in boundary-traversal order.
  const selectedElements = useMemo(
    () =>
      meshElements.filter((el) =>
        selectedElementKeys.has(`${el.lineId}|${el.indexInLine}`),
      ),
    [meshElements, selectedElementKeys],
  );

  // 1-based D/B/L/E addresses for every mesh element, matching the
  // canvas Labels overlay so the user reads the same name in both
  // places.
  const addressByKey = useMemo(
    () => buildAddressByKey(meshElements, boundaries),
    [meshElements, boundaries],
  );

  // Selected cell for the drill-down integrand plot — element-scoped
  // now since multiple submatrices may be on screen at once. Click
  // any cell to plot; click again to dismiss.
  const [selectedCell, setSelectedCell] =
    useState<ScopedCellSelector | null>(null);
  useEffect(() => {
    setSelectedCell(null);
  }, [pick.nodeIdx]);
  // If the previously-selected cell's element drops out of the
  // selection (user deselected its line), drop the cell too.
  useEffect(() => {
    setSelectedCell((prev) =>
      prev && selectedElementKeys.has(prev.elementKey) ? prev : null,
    );
  }, [selectedElementKeys]);
  const toggleCell = (next: ScopedCellSelector) =>
    setSelectedCell((prev) =>
      prev &&
      prev.elementKey === next.elementKey &&
      prev.kernel === next.kernel &&
      prev.row === next.row &&
      prev.col === next.col
        ? null
        : next,
    );

  const trace = useMemo<IntegrandTrace | null>(() => {
    if (!node || !selectedCell) return null;
    const element = elementByKey(meshElements, selectedCell.elementKey);
    if (!element) return null;
    const singular = findSingularLocalIdx(node, element);
    return traceCellIntegrand(node, element, material, singular, {
      kernel: selectedCell.kernel,
      row: selectedCell.row,
      col: selectedCell.col,
    });
  }, [node, meshElements, material, selectedCell]);

  // "Whole Γ" view: as soon as a collocation node is picked, sample
  // U* and T* densely along every boundary from s.
  const boundaryTrace = useMemo(() => {
    if (!node) return null;
    return traceBoundaryKernels(node, meshElements, boundaries, material);
  }, [node, meshElements, boundaries, material]);

  return (
    <div className="cad-bc-section">
      <div className="cad-bc-title">
        Equations
        {pick.nodeIdx !== null && (
          <button
            type="button"
            className="cad-bc-reset"
            onClick={onClear}
            title="Unpin the collocation node"
          >
            reset
          </button>
        )}
      </div>

      <PickRow
        label="Collocation node"
        value={
          pick.nodeIdx !== null && node
            ? `#${pick.nodeIdx}  (${node.x.toFixed(3)}, ${node.y.toFixed(3)})`
            : null
        }
        hint="click a mesh node"
      />
      <PickRow
        label="Source element(s)"
        value={
          selectedElements.length === 0
            ? null
            : selectedElements.length === 1
              ? addressByKey.get(elementKeyOf(selectedElements[0]!))!
              : `${selectedElements.length} elements`
        }
        hint="select line(s) or boundary(ies)"
      />

      {boundaryTrace && (
        <BoundaryKernelPanel
          trace={boundaryTrace}
          selectedElementKeys={selectedElementKeys}
        />
      )}

      {node && selectedElements.length > 0 && (
        <ElementSubmatrices
          collocation={node}
          elements={selectedElements}
          material={material}
          addressByKey={addressByKey}
          selectedCell={selectedCell}
          onSelectCell={toggleCell}
        />
      )}

      {trace && selectedCell && (
        <IntegrandPlot
          cell={{
            kernel: selectedCell.kernel,
            row: selectedCell.row,
            col: selectedCell.col,
          }}
          trace={trace}
        />
      )}

      {node && selectedElements.length === 0 && (
        <p className="cad-info-empty" style={{ marginTop: 8 }}>
          Select one or more lines / boundaries on the canvas to see
          their per-element H and G submatrices for this node.
        </p>
      )}
      {!node && (
        <p className="cad-info-empty" style={{ marginTop: 8 }}>
          Pick a mesh node on the canvas. The graphs and submatrices
          appear once a collocation point is set.
        </p>
      )}
    </div>
  );
}

function elementKeyOf(el: MeshElement): string {
  return `${el.lineId}|${el.indexInLine}`;
}

/** Compute 1-based B/L/E labels for every mesh element, matching the
 *  canvas Labels overlay convention. */
function buildAddressByKey(
  mesh: readonly MeshElement[],
  boundaries: readonly Boundary[],
): Map<string, string> {
  const lineToBoundary = new Map<
    string,
    { boundaryIdx: number; lineIdxInBoundary: number }
  >();
  boundaries.forEach((b, bIdx) => {
    b.segments.forEach((seg, sIdx) => {
      if (!lineToBoundary.has(seg.lineId)) {
        lineToBoundary.set(seg.lineId, {
          boundaryIdx: bIdx + 1,
          lineIdxInBoundary: sIdx + 1,
        });
      }
    });
  });
  const out = new Map<string, string>();
  for (const el of mesh) {
    const bm = lineToBoundary.get(el.lineId);
    const parts: string[] = [];
    if (bm) {
      parts.push(`B${bm.boundaryIdx}`, `L${bm.lineIdxInBoundary}`);
    } else {
      parts.push("L?");
    }
    parts.push(`E${el.indexInLine + 1}`);
    out.set(elementKeyOf(el), parts.join(" "));
  }
  return out;
}

function ElementSubmatrices({
  collocation,
  elements,
  material,
  addressByKey,
  selectedCell,
  onSelectCell,
}: {
  collocation: Vec2;
  elements: readonly MeshElement[];
  material: MaterialProperties;
  addressByKey: ReadonlyMap<string, string>;
  selectedCell: ScopedCellSelector | null;
  onSelectCell: (next: ScopedCellSelector) => void;
}) {
  return (
    <>
      {elements.map((element) => {
        const key = elementKeyOf(element);
        const singular = findSingularLocalIdx(collocation, element);
        const blocks = integrateOverElement(
          collocation,
          element,
          material,
          singular,
        );
        const address = addressByKey.get(key) ?? key;
        return (
          <div key={key} style={{ marginTop: 12 }}>
            <div
              style={{
                fontWeight: 600,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "0.85em",
                opacity: 0.85,
                marginBottom: 2,
              }}
            >
              ▾ {address}
            </div>
            <BlockTable
              elementKey={key}
              title="H"
              block={blocks.H}
              element={element}
              selectedCell={selectedCell}
              onSelectCell={onSelectCell}
              singularNote={
                singular !== null
                  ? "self-element pair — diagonal H_ii is replaced by the rigid-body trick at assembly; the row shown here is the raw T* integral before that fixup."
                  : null
              }
            />
            <BlockTable
              elementKey={key}
              title="G"
              block={blocks.G}
              element={element}
              selectedCell={selectedCell}
              onSelectCell={onSelectCell}
            />
          </div>
        );
      })}
    </>
  );
}

function PickRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint: string;
}) {
  return (
    <div className="cad-bc-row" style={{ alignItems: "baseline" }}>
      <span className="cad-bc-axis" style={{ minWidth: 130, textAlign: "left" }}>
        {label}
      </span>
      <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
        {value ?? <em style={{ opacity: 0.55 }}>— {hint} —</em>}
      </span>
    </div>
  );
}

function BlockTable({
  elementKey,
  title,
  block,
  element,
  selectedCell,
  onSelectCell,
  singularNote,
}: {
  elementKey: string;
  title: "H" | "G";
  block: readonly (readonly number[])[];
  element: MeshElement;
  selectedCell: ScopedCellSelector | null;
  onSelectCell: (next: ScopedCellSelector) => void;
  singularNote?: string | null;
}) {
  // Column labels: n0_x, n0_y, n1_x, n1_y, n2_x, n2_y, with each n_k's
  // η coord underneath so the user can see the local node layout
  // (e.g. -2/3, 0, +2/3).
  const etas = element.localNodes;
  return (
    <div style={{ marginTop: 10 }}>
      <div
        style={{
          fontWeight: 600,
          fontFamily: "var(--font-mono, monospace)",
          marginBottom: 4,
        }}
      >
        {title}  (2 × 6)
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="cad-eq-table">
          <thead>
            <tr>
              <th></th>
              {[0, 1, 2].flatMap((k) => [
                <th key={`k${k}x`}>
                  n{k}<sub>x</sub>
                  <div style={{ fontSize: "0.8em", opacity: 0.6 }}>
                    η={fmtEta(etas[k]!)}
                  </div>
                </th>,
                <th key={`k${k}y`}>
                  n{k}<sub>y</sub>
                </th>,
              ])}
            </tr>
          </thead>
          <tbody>
            {(["s_x", "s_y"] as const).map((rowLabel, r) => {
              const row = r as 0 | 1;
              return (
                <tr key={rowLabel}>
                  <th scope="row">{rowLabel}</th>
                  {block[r]!.map((v, c) => {
                    const col = c as 0 | 1 | 2 | 3 | 4 | 5;
                    const isSelected =
                      selectedCell?.elementKey === elementKey &&
                      selectedCell.kernel === title &&
                      selectedCell.row === row &&
                      selectedCell.col === col;
                    return (
                      <td
                        key={c}
                        className={
                          "cad-eq-cell" +
                          (isSelected ? " cad-eq-cell--selected" : "")
                        }
                        onClick={() =>
                          onSelectCell({ elementKey, kernel: title, row, col })
                        }
                        title={`Click to plot the integrand for ${title}[${rowLabel}, n${col >> 1}_${col & 1 ? "y" : "x"}]`}
                      >
                        {fmt(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {singularNote && (
        <p style={{ fontSize: "0.8em", opacity: 0.7, marginTop: 4 }}>
          {singularNote}
        </p>
      )}
    </div>
  );
}

function fmtEta(eta: number): string {
  if (Number.isInteger(eta)) return eta.toString();
  return parseFloat(eta.toFixed(4)).toString();
}

// ─────────────────────────────────────────────────────────────────────
// IntegrandPlot — the actual integrand curve behind one cell
// ─────────────────────────────────────────────────────────────────────

const PLOT_W = 380;
const PLOT_H = 180;
const PLOT_PAD_L = 36;
const PLOT_PAD_R = 8;
const PLOT_PAD_T = 8;
const PLOT_PAD_B = 22;

function IntegrandPlot({
  cell,
  trace,
}: {
  cell: { kernel: "H" | "G"; row: 0 | 1; col: 0 | 1 | 2 | 3 | 4 | 5 };
  trace: IntegrandTrace;
}) {
  const { etas, fs, gauss, cellValue } = trace;

  // Symmetric y-axis around 0 so positive / negative lobes are both
  // visible. The Gauss-point partials can spike larger than the dense
  // sampling for near-singular pairs; include them in the y range so
  // every dot is at least on-axis.
  let yMin = 0;
  let yMax = 0;
  for (const v of fs) {
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  for (const v of gauss.fs) {
    if (v < yMin) yMin = v;
    if (v > yMax) yMax = v;
  }
  if (yMin === 0 && yMax === 0) yMax = 1; // degenerate flat-zero
  const yAbs = Math.max(Math.abs(yMin), Math.abs(yMax));
  const yLo = -yAbs;
  const yHi = +yAbs;

  const innerW = PLOT_W - PLOT_PAD_L - PLOT_PAD_R;
  const innerH = PLOT_H - PLOT_PAD_T - PLOT_PAD_B;
  const xPx = (eta: number) =>
    PLOT_PAD_L + ((eta - -1) / 2) * innerW;
  const yPx = (v: number) =>
    PLOT_PAD_T + ((yHi - v) / (yHi - yLo)) * innerH;

  // Polyline path for the curve, plus an area-under-curve fill closed
  // to y=0.
  const linePath = etas
    .map((e, i) => `${i === 0 ? "M" : "L"} ${xPx(e)} ${yPx(fs[i]!)}`)
    .join(" ");
  // Area path: split positive / negative chunks so we can shade them
  // in different tints (visually shows positive contributions vs
  // negative contributions). Simpler: one path closed to y=0 with a
  // single tint.
  const areaPath =
    `M ${xPx(-1)} ${yPx(0)} ` +
    etas.map((e, i) => `L ${xPx(e)} ${yPx(fs[i]!)}`).join(" ") +
    ` L ${xPx(+1)} ${yPx(0)} Z`;

  // Gauss dot radii sized by |partial| / maxPartial. r ∈ [1.5, 6].
  const maxPartial = Math.max(
    1e-300,
    ...gauss.partials.map((p) => Math.abs(p)),
  );

  const fmtSci = (v: number) => {
    if (!Number.isFinite(v)) return "—";
    if (v === 0) return "0";
    const abs = Math.abs(v);
    if (abs >= 1e4 || abs < 1e-3) return v.toExponential(3);
    return v.toPrecision(5);
  };

  const colLabel = (() => {
    const k = cell.col >> 1;
    const beta = cell.col & 1 ? "y" : "x";
    return `n${k}_${beta}`;
  })();
  const rowLabel = `s_${cell.row === 0 ? "x" : "y"}`;
  const title = `${cell.kernel}[${rowLabel}, ${colLabel}]`;

  return (
    <div style={{ marginTop: 16 }}>
      <div
        style={{
          fontWeight: 600,
          fontFamily: "var(--font-mono, monospace)",
          marginBottom: 4,
        }}
      >
        Integrand · {title}
      </div>
      <div style={{ fontSize: "0.78em", opacity: 0.75, marginBottom: 6 }}>
        {`∫ N${cell.col >> 1}(η) · ${cell.kernel === "H" ? "T" : "U"}*_{${cell.row === 0 ? "x" : "y"},${cell.col & 1 ? "y" : "x"}} · J(η) dη  =  ${fmtSci(cellValue)}`}
        <span style={{ opacity: 0.55, marginLeft: 8 }}>
          ({gauss.isTelles ? `Telles · n=${gauss.order}` : `Gauss · n=${gauss.order}`})
        </span>
      </div>
      <svg
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Integrand plot for ${title}`}
        style={{ width: "100%", maxWidth: PLOT_W, display: "block" }}
      >
        {/* Frame */}
        <rect
          x={PLOT_PAD_L}
          y={PLOT_PAD_T}
          width={innerW}
          height={innerH}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.5}
          opacity={0.3}
        />
        {/* y=0 axis */}
        <line
          x1={PLOT_PAD_L}
          y1={yPx(0)}
          x2={PLOT_PAD_L + innerW}
          y2={yPx(0)}
          stroke="currentColor"
          strokeWidth={0.6}
          opacity={0.45}
        />
        {/* x=0 (η = 0) reference */}
        <line
          x1={xPx(0)}
          y1={PLOT_PAD_T}
          x2={xPx(0)}
          y2={PLOT_PAD_T + innerH}
          stroke="currentColor"
          strokeWidth={0.4}
          opacity={0.18}
          strokeDasharray="2 2"
        />
        {/* Vertical guides at the element's three local nodes */}
        {/* (caller-provided element not threaded here; would need an
            extra prop — skip for now to keep this self-contained.) */}
        {/* Area under curve */}
        <path
          d={areaPath}
          fill="rgb(249, 115, 22)"
          fillOpacity={0.18}
          stroke="none"
        />
        {/* The integrand curve */}
        <path
          d={linePath}
          fill="none"
          stroke="rgb(249, 115, 22)"
          strokeWidth={1.3}
          strokeLinejoin="round"
        />
        {/* Gauss-point dots, sized by |partial| / maxPartial. */}
        {gauss.nodes.map((eta, q) => {
          const f = gauss.fs[q]!;
          const partial = gauss.partials[q]!;
          const r = 1.5 + 4.5 * Math.sqrt(Math.abs(partial) / maxPartial);
          return (
            <g key={q}>
              <line
                x1={xPx(eta)}
                y1={yPx(0)}
                x2={xPx(eta)}
                y2={yPx(f)}
                stroke="rgb(120, 53, 15)"
                strokeWidth={0.5}
                opacity={0.55}
              />
              <circle
                cx={xPx(eta)}
                cy={yPx(f)}
                r={r}
                fill="rgb(120, 53, 15)"
                stroke="canvas"
                strokeWidth={0.6}
              >
                <title>{`η = ${eta.toFixed(4)}\nf(η) = ${fmtSci(f)}\nw·f = ${fmtSci(partial)}`}</title>
              </circle>
            </g>
          );
        })}
        {/* X-axis labels */}
        <text
          x={xPx(-1)}
          y={PLOT_H - 6}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.6}
        >
          η = −1
        </text>
        <text
          x={xPx(0)}
          y={PLOT_H - 6}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.6}
        >
          0
        </text>
        <text
          x={xPx(+1)}
          y={PLOT_H - 6}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          opacity={0.6}
        >
          +1
        </text>
        {/* Y-axis tick labels (±max, 0). */}
        <text
          x={PLOT_PAD_L - 3}
          y={yPx(yHi) + 3}
          textAnchor="end"
          fontSize={9}
          fill="currentColor"
          opacity={0.6}
        >
          {fmtSci(yHi)}
        </text>
        <text
          x={PLOT_PAD_L - 3}
          y={yPx(0) + 3}
          textAnchor="end"
          fontSize={9}
          fill="currentColor"
          opacity={0.6}
        >
          0
        </text>
        <text
          x={PLOT_PAD_L - 3}
          y={yPx(yLo) + 3}
          textAnchor="end"
          fontSize={9}
          fill="currentColor"
          opacity={0.6}
        >
          {fmtSci(yLo)}
        </text>
      </svg>
      <div style={{ fontSize: "0.72em", opacity: 0.55, marginTop: 4 }}>
        Orange curve = integrand f(η); orange fill = signed area = cell value.
        Brown dots = Gauss points (sized by |w · f|);
        the vertical sticks show where the rule samples f.
        {gauss.isTelles
          ? " Telles concentrates points near the singular node so a regular Gauss rule converges on the log-r spike."
          : ""}
      </div>
    </div>
  );
}
