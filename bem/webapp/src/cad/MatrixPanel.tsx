// BEM system-matrix view.
//
// Now embedded into the Inspector (LHS panel) — toggled via the
// Matrix toolbar button — so the panel itself is resizable: drag the
// inspector wider to see the schematic at a larger scale and the
// highlight stripes more clearly.
//
// Layout matches Gareth's reference image:
//
//     [   H   ] · [u] = [   G   ] · [t]
//
// Strict accurate scale: H, G are squares (2N × 2N); u, t vectors are
// (2N × 1) so their width = squareWidth / (2N). For tall meshes the
// vectors are correspondingly thin — that's the truth of the system.
//
// When the user selects one or more lines, every DOF row belonging
// to the elements of those lines gets a yellow stripe on H, G, u and
// t; the same DOFs as COLUMNS get yellow stripes on H and G. So a
// single-line selection lights up the cross-shape from the reanalysis
// diagram, just keyed on the SELECTED line's DOFs rather than the
// CACHE-MISS DOFs.

import { useState } from "react";
import type { SolveStats } from "@bem/engine";

interface MatrixViewProps {
  readonly solveStats: SolveStats | null;
  /** DOFs from the current line selection. Rendered yellow when no
   *  hover is active. */
  readonly highlightedDofs: ReadonlySet<number>;
  /** DOFs from the element currently under the cursor (6 per element).
   *  When non-empty, REPLACES the yellow line highlight with orange
   *  so the user sees just the element's scope while hovering. */
  readonly hoveredDofs: ReadonlySet<number>;
  /** Called when the user hovers the schematic. `row` is the DOF
   *  index under the cursor's vertical position (shared across H, u,
   *  G, t — they're the same equation row). `col` is the DOF index
   *  under the cursor's horizontal position only when the cursor is
   *  inside H or G — null when over u, t, the = sign, or outside.
   *  Drives the reverse-direction canvas highlight (one node ring
   *  for the row, another for the col when distinct). */
  readonly onHoverMatrixDof: (
    row: number | null,
    col: number | null,
  ) => void;
}

export function MatrixView({
  solveStats,
  highlightedDofs,
  hoveredDofs,
  onHoverMatrixDof,
}: MatrixViewProps) {
  return (
    <div className="matrix-view" aria-label="System matrix">
      <div className="matrix-view-title">System matrix</div>
      {solveStats && solveStats.assemble.nodeCount > 0 ? (
        <MatrixSchematic
          stats={solveStats}
          highlightedDofs={highlightedDofs}
          hoveredDofs={hoveredDofs}
          onHoverMatrixDof={onHoverMatrixDof}
        />
      ) : (
        <p className="matrix-view-empty">
          Add a domain with boundary conditions to assemble the system.
        </p>
      )}
    </div>
  );
}

function MatrixSchematic({
  stats,
  highlightedDofs,
  hoveredDofs,
  onHoverMatrixDof,
}: {
  readonly stats: SolveStats;
  readonly highlightedDofs: ReadonlySet<number>;
  readonly hoveredDofs: ReadonlySet<number>;
  readonly onHoverMatrixDof: (
    row: number | null,
    col: number | null,
  ) => void;
}) {
  const N = stats.assemble.nodeCount;
  const size = 2 * N; // matrix side length in DOFs

  // SVG layout — base viewBox, CSS scales width to fill container.
  // Component widths are picked so that:
  //   vecW / squareW = 1 / size   (accurate scale of (2N × 1) vs (2N × 2N))
  // The total horizontal budget = 2·squareW + 2·vecW + 4·gap + eqGap = innerW.
  // Solving for squareW:
  //   squareW = (innerW − 4·gap − eqGap) / (2 + 2/size)
  const VBW = 400;
  const PAD = 8;
  const innerW = VBW - 2 * PAD;
  const gap = 4;
  const eqGap = 16;
  const squareW = (innerW - 4 * gap - eqGap) / (2 + 2 / size);
  const vecW = squareW / size;
  const squareH = squareW;
  const VBH = squareH + 2 * PAD + 14; // +14 for u/t labels under vectors

  const hX = PAD;
  const uX = hX + squareW + gap;
  const eqX = uX + vecW + gap;
  const gX = eqX + eqGap + gap;
  const tX = gX + squareW + gap;
  const matY = PAD;

  const COLOR_H = "rgb(245, 158, 11)"; // orange
  const COLOR_U = "rgb(34, 197, 94)"; // green
  const COLOR_G = "rgb(59, 130, 246)"; // blue
  const COLOR_T = "rgb(239, 68, 68)"; // red
  const COLOR_HIGHLIGHT = "rgba(255, 235, 59, 0.78)"; // semi-translucent yellow
  const COLOR_HOVER = "rgba(249, 115, 22, 0.85)"; // semi-translucent orange
  // Matrix-on-matrix hover — the single row/col under the cursor.
  // Slightly darker yellow with a 1px outline so it reads even when
  // it overlays the broader selection-yellow stripes.
  const COLOR_MATRIX_HOVER_FILL = "rgba(250, 204, 21, 0.95)";
  const COLOR_MATRIX_HOVER_STROKE = "rgba(120, 90, 0, 0.7)";
  const STROKE = "rgb(0, 0, 0)";
  // Local hover tracking:
  //   row     = DOF index from cursor Y (shared by H, u, G, t)
  //   col     = DOF index from cursor X within H or G's rect (null
  //             when over u, t, the equals sign, or outside)
  //   colSide = which matrix the column highlight belongs on
  const [matrixHover, setMatrixHover] = useState<{
    row: number | null;
    col: number | null;
    colSide: "H" | "G" | null;
  }>({ row: null, col: null, colSide: null });

  // When the user is hovering a specific mesh element, its 6 DOFs
  // REPLACE the line-selection yellow with orange. That way the user
  // sees the narrower (element-level) scope while hovering and the
  // broader (line-level) scope while not.
  const showHover = hoveredDofs.size > 0;
  const activeDofs = showHover ? hoveredDofs : highlightedDofs;
  const activeFill = showHover ? COLOR_HOVER : COLOR_HIGHLIGHT;

  // Build merged DOF runs so adjacent highlighted DOFs render as one
  // tall stripe instead of many sliver ones — keeps the SVG small AND
  // avoids sub-pixel gaps between stripes.
  const runs = mergeRuns(activeDofs, size);

  // Per-DOF pixel size on each axis.
  const dofRow = squareH / size;
  const dofCol = squareW / size;

  return (
    <div className="matrix-schematic">
      <svg
        viewBox={`0 0 ${VBW} ${VBH}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Hu = Gt — H and G are ${size}×${size}, u and t are ${size}×1`}
        shapeRendering="crispEdges"
        onMouseMove={(e) => {
          // SVG viewBox coords from screen px via bounding rect.
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;
          const xInVB = ((e.clientX - rect.left) / rect.width) * VBW;
          const yInVB = ((e.clientY - rect.top) / rect.height) * VBH;
          const inBand = yInVB >= matY && yInVB <= matY + squareH;
          const row = inBand
            ? Math.max(
                0,
                Math.min(size - 1, Math.floor(((yInVB - matY) / squareH) * size)),
              )
            : null;
          // Column applies only when the cursor is inside H or G.
          let col: number | null = null;
          let colSide: "H" | "G" | null = null;
          if (inBand) {
            if (xInVB >= hX && xInVB <= hX + squareW) {
              col = Math.max(
                0,
                Math.min(
                  size - 1,
                  Math.floor(((xInVB - hX) / squareW) * size),
                ),
              );
              colSide = "H";
            } else if (xInVB >= gX && xInVB <= gX + squareW) {
              col = Math.max(
                0,
                Math.min(
                  size - 1,
                  Math.floor(((xInVB - gX) / squareW) * size),
                ),
              );
              colSide = "G";
            }
          }
          if (
            matrixHover.row !== row ||
            matrixHover.col !== col ||
            matrixHover.colSide !== colSide
          ) {
            setMatrixHover({ row, col, colSide });
          }
          onHoverMatrixDof(row, col);
        }}
        onMouseLeave={() => {
          if (
            matrixHover.row !== null ||
            matrixHover.col !== null
          ) {
            setMatrixHover({ row: null, col: null, colSide: null });
          }
          onHoverMatrixDof(null, null);
        }}
      >
        {/* H — orange square */}
        <rect
          x={hX}
          y={matY}
          width={squareW}
          height={squareH}
          fill={COLOR_H}
          stroke={STROKE}
          strokeWidth={0.5}
        />
        {/* H highlighted rows + columns */}
        {runs.map((r, i) => (
          <rect
            key={`hr${i}`}
            x={hX}
            y={matY + r.start * dofRow}
            width={squareW}
            height={r.length * dofRow}
            fill={activeFill}
          />
        ))}
        {runs.map((r, i) => (
          <rect
            key={`hc${i}`}
            x={hX + r.start * dofCol}
            y={matY}
            width={r.length * dofCol}
            height={squareH}
            fill={activeFill}
          />
        ))}

        {/* u — green vector */}
        <rect
          x={uX}
          y={matY}
          width={vecW}
          height={squareH}
          fill={COLOR_U}
          stroke={STROKE}
          strokeWidth={0.5}
        />
        {runs.map((r, i) => (
          <rect
            key={`ur${i}`}
            x={uX}
            y={matY + r.start * dofRow}
            width={vecW}
            height={r.length * dofRow}
            fill={activeFill}
          />
        ))}
        <text
          x={uX + vecW / 2}
          y={matY + squareH + 10}
          textAnchor="middle"
          fontSize={9}
          fill="rgba(0,0,0,0.7)"
        >
          u
        </text>

        {/* equals sign */}
        <g
          stroke={STROKE}
          strokeWidth={1.5}
          shapeRendering="auto"
        >
          <line
            x1={eqX + 2}
            x2={eqX + eqGap - 2}
            y1={matY + squareH / 2 - 4}
            y2={matY + squareH / 2 - 4}
          />
          <line
            x1={eqX + 2}
            x2={eqX + eqGap - 2}
            y1={matY + squareH / 2 + 4}
            y2={matY + squareH / 2 + 4}
          />
        </g>

        {/* G — blue square */}
        <rect
          x={gX}
          y={matY}
          width={squareW}
          height={squareH}
          fill={COLOR_G}
          stroke={STROKE}
          strokeWidth={0.5}
        />
        {runs.map((r, i) => (
          <rect
            key={`gr${i}`}
            x={gX}
            y={matY + r.start * dofRow}
            width={squareW}
            height={r.length * dofRow}
            fill={activeFill}
          />
        ))}
        {runs.map((r, i) => (
          <rect
            key={`gc${i}`}
            x={gX + r.start * dofCol}
            y={matY}
            width={r.length * dofCol}
            height={squareH}
            fill={activeFill}
          />
        ))}

        {/* t — red vector */}
        <rect
          x={tX}
          y={matY}
          width={vecW}
          height={squareH}
          fill={COLOR_T}
          stroke={STROKE}
          strokeWidth={0.5}
        />
        {runs.map((r, i) => (
          <rect
            key={`tr${i}`}
            x={tX}
            y={matY + r.start * dofRow}
            width={vecW}
            height={r.length * dofRow}
            fill={activeFill}
          />
        ))}
        <text
          x={tX + vecW / 2}
          y={matY + squareH + 10}
          textAnchor="middle"
          fontSize={9}
          fill="rgba(0,0,0,0.7)"
        >
          t
        </text>

        {/* Matrix-on-matrix hover. Row follows cursor Y (shared across
            all four — they're the same equation row). Column follows
            cursor X only inside H or G — vectors have no columns.
            Drawn last so it overlays the broader selection / element
            stripes underneath. */}
        {(matrixHover.row !== null || matrixHover.col !== null) && (() => {
          const fill = COLOR_MATRIX_HOVER_FILL;
          const stroke = COLOR_MATRIX_HOVER_STROKE;
          const y =
            matrixHover.row !== null
              ? matY + matrixHover.row * dofRow
              : 0;
          const colX =
            matrixHover.col !== null
              ? (matrixHover.colSide === "H" ? hX : gX) +
                matrixHover.col * dofCol
              : 0;
          return (
            <g pointerEvents="none">
              {matrixHover.row !== null && (
                <>
                  <rect x={hX} y={y} width={squareW} height={dofRow} fill={fill} />
                  <rect x={uX} y={y} width={vecW} height={dofRow} fill={fill} />
                  <rect x={gX} y={y} width={squareW} height={dofRow} fill={fill} />
                  <rect x={tX} y={y} width={vecW} height={dofRow} fill={fill} />
                  {/* Outline on H, G rows so the thin stripe reads
                      against the selection/element backdrop. */}
                  <rect
                    x={hX}
                    y={y}
                    width={squareW}
                    height={dofRow}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={0.4}
                  />
                  <rect
                    x={gX}
                    y={y}
                    width={squareW}
                    height={dofRow}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={0.4}
                  />
                </>
              )}
              {matrixHover.col !== null && matrixHover.colSide === "H" && (
                <>
                  <rect
                    x={colX}
                    y={matY}
                    width={dofCol}
                    height={squareH}
                    fill={fill}
                  />
                  <rect
                    x={colX}
                    y={matY}
                    width={dofCol}
                    height={squareH}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={0.4}
                  />
                </>
              )}
              {matrixHover.col !== null && matrixHover.colSide === "G" && (
                <>
                  <rect
                    x={colX}
                    y={matY}
                    width={dofCol}
                    height={squareH}
                    fill={fill}
                  />
                  <rect
                    x={colX}
                    y={matY}
                    width={dofCol}
                    height={squareH}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={0.4}
                  />
                </>
              )}
            </g>
          );
        })()}
      </svg>
      <dl className="matrix-schematic-meta">
        <dt>Mesh nodes</dt>
        <dd>{N}</dd>
        <dt>Matrix size</dt>
        <dd>
          {size} × {size}
        </dd>
        <dt>Element pairs</dt>
        <dd>{(stats.assemble.hits + stats.assemble.misses).toLocaleString()}</dd>
        <dt>Unknown DOFs</dt>
        <dd>{stats.unknownDofs}</dd>
        {activeDofs.size > 0 && (
          <>
            <dt>{showHover ? "Hover DOFs" : "Selection DOFs"}</dt>
            <dd>{activeDofs.size}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/** Collapse a Set of DOF indices into a list of contiguous runs.
 *  Returns sorted runs of {start, length}. Used so adjacent
 *  highlighted DOFs render as one tall stripe rather than N sub-
 *  pixel-tall stripes (which then leak sub-pixel gaps). */
function mergeRuns(
  dofs: ReadonlySet<number>,
  size: number,
): readonly { start: number; length: number }[] {
  if (dofs.size === 0) return [];
  const sorted: number[] = [];
  for (const d of dofs) if (d >= 0 && d < size) sorted.push(d);
  sorted.sort((a, b) => a - b);
  const runs: { start: number; length: number }[] = [];
  let runStart = sorted[0]!;
  let runEnd = runStart;
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]!;
    if (d === runEnd + 1) {
      runEnd = d;
    } else {
      runs.push({ start: runStart, length: runEnd - runStart + 1 });
      runStart = d;
      runEnd = d;
    }
  }
  runs.push({ start: runStart, length: runEnd - runStart + 1 });
  return runs;
}
