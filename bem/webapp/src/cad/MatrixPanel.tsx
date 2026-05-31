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
}

export function MatrixView({
  solveStats,
  highlightedDofs,
  hoveredDofs,
}: MatrixViewProps) {
  return (
    <div className="matrix-view" aria-label="System matrix">
      <div className="matrix-view-title">System matrix</div>
      {solveStats && solveStats.assemble.nodeCount > 0 ? (
        <MatrixSchematic
          stats={solveStats}
          highlightedDofs={highlightedDofs}
          hoveredDofs={hoveredDofs}
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
}: {
  readonly stats: SolveStats;
  readonly highlightedDofs: ReadonlySet<number>;
  readonly hoveredDofs: ReadonlySet<number>;
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
  const STROKE = "rgb(0, 0, 0)";

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
