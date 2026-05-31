// Real direct-BEM solver for 2D plane elasticity.
//
// Pipeline (walking-skeleton stage of the strategy in
// BEM-SOLVER-STRATEGY.md — no caching yet):
//   1. Assemble H and G across all (collocation node, source element)
//      pairs via isoparametric Gauss-Legendre integration of the Kelvin
//      kernels (kernels.ts + elementIntegration.ts + assemble.ts).
//   2. Apply the rigid-body trick for the diagonal H block — done
//      during assembly.
//   3. Partition: for each DOF, exactly one of u or t is known (from
//      the BC fanned out at discretise time); the other is the unknown.
//      Build A x = b where columns from known-u DOFs come from -G,
//      columns from known-t DOFs come from H, and b accumulates the
//      known-DOF contributions.
//   4. Solve A x = b with ml-matrix's LU.
//   5. Backfill the mesh: each node's NaN DOFs replaced with the
//      solved values; known DOFs preserved verbatim.

import { Matrix, solve as solveLinear } from "ml-matrix";
import type { MeshElement, MeshNode } from "../elements/discretise.js";
import {
  assembleHG,
  type AssembleStats,
  type BlockCache,
} from "./assemble.js";
import {
  DEFAULT_MATERIAL,
  shearModulus,
  type MaterialProperties,
} from "./kernels.js";

export { DEFAULT_MATERIAL, type MaterialProperties };

/** Work-done summary for a single solve. `assemble` mirrors
 *  AssembleStats; `unknownDofs` is the size of the linear system the
 *  LU solver actually saw (rough proxy for LU cost ≈ N³/3). */
export interface SolveStats {
  readonly assemble: AssembleStats;
  readonly unknownDofs: number;
}

/**
 * Resolve every NaN DOF on the mesh into a number, returning a NEW mesh
 * (input is not mutated). For each DOF (i, α) exactly one of u or t is
 * already known (from the BC fanned out at discretise time); the other
 * is the unknown the solver computes.
 *
 * If the system is singular (e.g. no displacement BCs anywhere → rigid-
 * body modes unconstrained, or pathologically conditioned) we catch the
 * solve failure and return the input mesh unchanged — the visualisation
 * layer just won't show results.
 */
export function solve(
  mesh: readonly MeshElement[],
  material: MaterialProperties = DEFAULT_MATERIAL,
  cache?: BlockCache,
  statsOut?: { value?: SolveStats },
): MeshElement[] {
  if (mesh.length === 0) {
    if (statsOut) {
      statsOut.value = {
        assemble: {
          hits: 0,
          misses: 0,
          gaussEvals: 0,
          nodeCount: 0,
          elementCount: 0,
        },
        unknownDofs: 0,
      };
    }
    return [];
  }

  const sys = assembleHG(mesh, material, cache);
  const N = sys.nodesByIndex.length;
  const size = 2 * N;

  // ── Equation scaling (psi) ────────────────────────────────────────
  // U* ~ 1/G_mod and T* ~ 1/r, so H entries are O(1) while G entries
  // scale like O(L / G_mod). For typical metal (G_mod ~ 1e11 Pa) the
  // two column groups in A differ by ~10 orders of magnitude, killing
  // the LU conditioning. Bird's MATLAB (BEMSolution.m) multiplies the
  // G columns by a scale factor `psi` before solve and divides the
  // recovered tractions by `psi` after; pick psi = G_mod so the G
  // columns become O(L), much closer to H. Has zero effect on the
  // answer in exact arithmetic, just buys the LU more dynamic range.
  const psi = shearModulus(material);

  // Build the LHS A (size × size) and RHS b (size × 1) one DOF at a time.
  // For each (i, α) DOF, exactly one of u_iα and t_iα is known (NaN
  // marks the unknown). The known value contributes to b; the unknown
  // gets its column lifted from either H or -G into A.
  const A = Matrix.zeros(size, size);
  const b = Matrix.zeros(size, 1);

  for (let i = 0; i < N; i++) {
    const node = sys.nodesByIndex[i]!;
    for (let alpha = 0; alpha < 2; alpha++) {
      const col = 2 * i + alpha;
      const u = alpha === 0 ? node.ux : node.uy;
      const t = alpha === 0 ? node.tx : node.ty;
      const uKnown = !Number.isNaN(u);
      const tKnown = !Number.isNaN(t);
      // Exactly one should be known. Degenerate cases (both NaN or both
      // numeric) get skipped — column stays zero → singular row.
      if (uKnown === tKnown) continue;

      if (uKnown) {
        // u known → unknown is t'. A column = -psi · G column.
        // The unknown solved for is t' = t / psi; we multiply by psi
        // at backfill below to recover the physical traction.
        // b -= H col * u (known u is unchanged by the scaling).
        for (let row = 0; row < size; row++) {
          A.set(row, col, -psi * sys.G.get(row, col));
          b.set(row, 0, b.get(row, 0) - sys.H.get(row, col) * u);
        }
      } else {
        // t known → unknown is u. A column = +H column.
        // b += G col * t (known t enters at full magnitude).
        for (let row = 0; row < size; row++) {
          A.set(row, col, sys.H.get(row, col));
          b.set(row, 0, b.get(row, 0) + sys.G.get(row, col) * t);
        }
      }
    }
  }

  // Solve. ml-matrix's solve uses LU under the hood for square systems.
  let x: Matrix;
  try {
    x = solveLinear(A, b);
  } catch {
    // Singular / unsolvable — return the input mesh untouched so the
    // viz layer just shows no displacement overlay.
    if (statsOut) {
      statsOut.value = { assemble: sys.stats, unknownDofs: 0 };
    }
    return mesh.map((el) => ({ ...el }));
  }

  // Count the unknown DOFs that actually drove the LU — roughly N for
  // the linear system size, but only the columns with a known/unknown
  // pair contribute (degenerate DOFs get skipped). Useful for showing
  // LU cost ≈ unknownDofs³/3 separately from the assemble stats.
  let unknownDofs = 0;
  for (let i = 0; i < N; i++) {
    const node = sys.nodesByIndex[i]!;
    for (let alpha = 0; alpha < 2; alpha++) {
      const u = alpha === 0 ? node.ux : node.uy;
      const t = alpha === 0 ? node.tx : node.ty;
      if (!Number.isNaN(u) !== !Number.isNaN(t)) unknownDofs++;
    }
  }
  if (statsOut) {
    statsOut.value = { assemble: sys.stats, unknownDofs };
  }

  // Backfill per-node solved DOFs into a flat array indexed by global node.
  type SolvedDofs = { ux: number; uy: number; tx: number; ty: number };
  const perNode: SolvedDofs[] = new Array(N);
  for (let i = 0; i < N; i++) {
    const node = sys.nodesByIndex[i]!;
    const sol: SolvedDofs = {
      ux: node.ux,
      uy: node.uy,
      tx: node.tx,
      ty: node.ty,
    };
    for (let alpha = 0; alpha < 2; alpha++) {
      const col = 2 * i + alpha;
      const u = alpha === 0 ? node.ux : node.uy;
      const t = alpha === 0 ? node.tx : node.ty;
      const uKnown = !Number.isNaN(u);
      const tKnown = !Number.isNaN(t);
      if (uKnown === tKnown) continue;
      const xVal = x.get(col, 0);
      // Traction columns were scaled by `psi` in A; the corresponding
      // unknown solved here is t' = t / psi, so multiply by psi to get
      // the physical traction. Displacement unknowns are unscaled.
      if (alpha === 0) {
        if (uKnown) sol.tx = xVal * psi;
        else sol.ux = xVal;
      } else {
        if (uKnown) sol.ty = xVal * psi;
        else sol.uy = xVal;
      }
    }
    perNode[i] = sol;
  }

  // Build the solved mesh: copy each element, replace its 3 nodes with
  // fresh MeshNodes carrying the solved DOFs (at the global index).
  return mesh.map((el) => {
    const idxs = sys.elementNodeIndex.get(el)!;
    return {
      ...el,
      nodes: [
        applySolution(el.nodes[0]!, perNode[idxs[0]]!),
        applySolution(el.nodes[1]!, perNode[idxs[1]]!),
        applySolution(el.nodes[2]!, perNode[idxs[2]]!),
      ] as const,
    };
  });
}

function applySolution(
  orig: MeshNode,
  sol: { ux: number; uy: number; tx: number; ty: number },
): MeshNode {
  return {
    x: orig.x,
    y: orig.y,
    ux: sol.ux,
    uy: sol.uy,
    tx: sol.tx,
    ty: sol.ty,
  };
}
