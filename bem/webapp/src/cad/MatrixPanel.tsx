// Matrix-visualisation panel.
//
// Sits between the Inspector (LHS) and the canvas. Renders the BEM
// system schematic:
//
//     [   H   ] · [u] = [   G   ] · [t]
//
//   H, G  →  (2 · nodeCount) × (2 · nodeCount) dense matrices
//   u, t  →  (2 · nodeCount) × 1 vectors
//
// Colour key (from the user's reference image):
//   H = orange, u = green, G = blue, t = red.
//
// v1 just shows the equation with current dimensions. Next iteration
// overlays yellow stripes marking the rows + columns that the
// reanalysis cache had to recompute for the latest solve — the
// reanalysis-savings story made visible.

import type { SolveStats } from "@bem/engine";

interface MatrixPanelProps {
  readonly solveStats: SolveStats | null;
}

export function MatrixPanel({ solveStats }: MatrixPanelProps) {
  return (
    <aside className="matrix-panel" aria-label="System matrix">
      <header className="matrix-panel-header">
        <h3>System matrix</h3>
      </header>
      <div className="matrix-panel-body">
        {solveStats && solveStats.assemble.nodeCount > 0 ? (
          <MatrixSchematic stats={solveStats} />
        ) : (
          <p className="matrix-panel-empty">
            Add a domain with boundary conditions to assemble the system.
          </p>
        )}
      </div>
    </aside>
  );
}

function MatrixSchematic({ stats }: { readonly stats: SolveStats }) {
  const N = stats.assemble.nodeCount;
  const size = 2 * N; // matrix side length in DOFs

  // SVG layout — fit horizontally inside the panel.
  // We render H · u = G · t in one row, scaled to fill the available
  // width. Heights are derived from a fixed aspect (squares are square).
  const W = 280;
  const PAD = 10;
  const innerW = W - 2 * PAD;

  // Width budget: 2 squares + 2 vectors + 1 "=" + 4 inter-gaps.
  // Vectors are 1/N as wide as the square; clamp so they remain visible.
  const eqGap = 14;
  const gap = 4;
  const vecMin = 6;
  // Solve squareW from: 2·squareW + 2·max(vecMin, squareW/12) + eqGap + 4·gap = innerW
  // For sane sizes use a fixed vector width.
  const vecW = 10;
  const squareW = (innerW - 2 * vecW - eqGap - 4 * gap) / 2;
  const H = Math.max(60, Math.round(squareW)); // height = square side
  const squareSide = H;

  // Lay out X positions left → right.
  const hX = PAD;
  const uX = hX + squareSide + gap;
  const eqX = uX + vecW + gap;
  const gX = eqX + eqGap + gap;
  const tX = gX + squareSide + gap;
  const totalH = squareSide + 2 * PAD + 18; // +18 for size label

  const COLOR_H = "rgb(245, 158, 11)";
  const COLOR_U = "rgb(34, 197, 94)";
  const COLOR_G = "rgb(59, 130, 246)";
  const COLOR_T = "rgb(239, 68, 68)";
  const STROKE = "rgb(0, 0, 0)";

  return (
    <div className="matrix-schematic">
      <svg
        viewBox={`0 0 ${W} ${totalH}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Hu = Gt — H and G are ${size} by ${size}, u and t are ${size} by 1`}
      >
        {/* H — orange square */}
        <rect
          x={hX}
          y={PAD}
          width={squareSide}
          height={squareSide}
          fill={COLOR_H}
          stroke={STROKE}
          strokeWidth={0.6}
        />
        <text
          x={hX + squareSide / 2}
          y={PAD + squareSide / 2 + 4}
          textAnchor="middle"
          fontSize={Math.round(squareSide * 0.18)}
          fontWeight={600}
          fill="rgba(0,0,0,0.75)"
        >
          H
        </text>

        {/* u — green vector */}
        <rect
          x={uX}
          y={PAD}
          width={vecW}
          height={squareSide}
          fill={COLOR_U}
          stroke={STROKE}
          strokeWidth={0.6}
        />
        <text
          x={uX + vecW / 2}
          y={PAD + squareSide + 12}
          textAnchor="middle"
          fontSize={10}
          fill="rgba(0,0,0,0.7)"
        >
          u
        </text>

        {/* equals sign */}
        <line
          x1={eqX + 2}
          x2={eqX + eqGap - 2}
          y1={PAD + squareSide / 2 - 4}
          y2={PAD + squareSide / 2 - 4}
          stroke={STROKE}
          strokeWidth={1.8}
        />
        <line
          x1={eqX + 2}
          x2={eqX + eqGap - 2}
          y1={PAD + squareSide / 2 + 4}
          y2={PAD + squareSide / 2 + 4}
          stroke={STROKE}
          strokeWidth={1.8}
        />

        {/* G — blue square */}
        <rect
          x={gX}
          y={PAD}
          width={squareSide}
          height={squareSide}
          fill={COLOR_G}
          stroke={STROKE}
          strokeWidth={0.6}
        />
        <text
          x={gX + squareSide / 2}
          y={PAD + squareSide / 2 + 4}
          textAnchor="middle"
          fontSize={Math.round(squareSide * 0.18)}
          fontWeight={600}
          fill="rgba(255,255,255,0.92)"
        >
          G
        </text>

        {/* t — red vector */}
        <rect
          x={tX}
          y={PAD}
          width={vecW}
          height={squareSide}
          fill={COLOR_T}
          stroke={STROKE}
          strokeWidth={0.6}
        />
        <text
          x={tX + vecW / 2}
          y={PAD + squareSide + 12}
          textAnchor="middle"
          fontSize={10}
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
      </dl>
    </div>
  );
}
