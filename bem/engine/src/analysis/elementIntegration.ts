// Integrate U* and T* over a single source element against one
// collocation point. Returns the 2×6 G and H blocks (2 collocation DOFs
// × 6 element DOFs = 3 nodes × 2 axes).
//
// Geometry side uses the 3 ANCHOR positions with the continuous shape
// function basis {-1, 0, +1}.  Field side uses the 3 NODE values with
// the element's chosen localNodes basis (which may be discontinuous).
//
// Singularity handling: when the collocation point coincides with one
// of the element's own nodes, the kernels blow up at the corresponding
// η_c. We split [-1, +1] at η_c and use regular Gauss-Legendre on each
// subinterval. The log singularity in U* is integrable; high-order
// Gauss converges to it. The 1/r singularity in T* is dealt with at
// assembly time via the rigid-body trick (diagonal H from row sum).

import { gaussLegendre } from "../numerics/gaussLegendre.js";
import { shapeFunctions, shapeFunctionDerivatives, STANDARD_NODES } from "../elements/shapeFunctions.js";
import type { MeshElement } from "../elements/discretise.js";
import type { Vec2 } from "../geometry/types.js";
import { kelvinKernels, type MaterialProperties, effectiveNu, shearModulus } from "./kernels.js";

const ANCHORS = STANDARD_NODES.continuous;

const REGULAR_RULE = gaussLegendre(10);
const SINGULAR_RULE = gaussLegendre(16);

/** 2×6 block (2 DOFs of collocation × 6 element DOFs). */
export type Block2x6 = number[][];

export interface ElementBlocks {
  /** G block: contribution to the integral involving U* (tractions). */
  readonly G: Block2x6;
  /** H block: contribution involving T* (displacements). For singular
   *  (self-collocation) the diagonal correction is applied separately
   *  at assembly via the rigid-body trick. */
  readonly H: Block2x6;
}

/** Build an empty 2×6 zero block. */
function zeros2x6(): Block2x6 {
  return [
    [0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0],
  ];
}

/**
 * Integrate the kernels U* and T* over `element` against the collocation
 * point `s`. Returns the 2×6 G and H blocks contributing to the global
 * system rows of the collocation point.
 *
 * `singularNodeIdx` is the local node index (0, 1, or 2) of the
 * collocation point on THIS element, or null when the collocation point
 * is not one of this element's own nodes (regular integration).
 */
export function integrateOverElement(
  s: Vec2,
  element: MeshElement,
  material: MaterialProperties,
  singularNodeIdx: 0 | 1 | 2 | null,
): ElementBlocks {
  const nu = effectiveNu(material);
  const G = shearModulus(material);

  if (singularNodeIdx === null) {
    return integrateRange(s, element, G, nu, -1, 1, REGULAR_RULE);
  }

  // Singular: split at the collocation point's η on this element and
  // integrate each subdomain with a higher-order rule. The log
  // singularity in U* is integrable; the 1/r in T* would diverge but
  // the diagonal H entries are overwritten by the rigid-body trick at
  // assembly time, so the H block produced here for the singular pair
  // is *only* used for its off-diagonal contribution to the row sum.
  const etaC = element.localNodes[singularNodeIdx]!;
  if (etaC <= -1 + 1e-9 || etaC >= 1 - 1e-9) {
    return integrateRange(s, element, G, nu, -1, 1, SINGULAR_RULE);
  }
  const a = integrateRange(s, element, G, nu, -1, etaC, SINGULAR_RULE);
  const b = integrateRange(s, element, G, nu, etaC, 1, SINGULAR_RULE);
  return addBlocks(a, b);
}

function integrateRange(
  s: Vec2,
  element: MeshElement,
  G: number,
  nu: number,
  etaA: number,
  etaB: number,
  rule: ReturnType<typeof gaussLegendre>,
): ElementBlocks {
  const gBlock = zeros2x6();
  const hBlock = zeros2x6();
  const halfSpan = (etaB - etaA) / 2;
  const midSpan = (etaA + etaB) / 2;
  const a0 = element.anchors[0];
  const a1 = element.anchors[1];
  const a2 = element.anchors[2];

  for (let q = 0; q < rule.nodes.length; q++) {
    // Map quadrature node from [-1, +1] (rule's natural domain) into
    // the subinterval [etaA, etaB].
    const xi = rule.nodes[q]!;
    const w = rule.weights[q]!;
    const eta = midSpan + halfSpan * xi;

    // Geometry side — anchors + continuous basis.
    const Ng = shapeFunctions(eta, ANCHORS);
    const dNg = shapeFunctionDerivatives(eta, ANCHORS);
    const xField = {
      x: Ng[0] * a0.x + Ng[1] * a1.x + Ng[2] * a2.x,
      y: Ng[0] * a0.y + Ng[1] * a1.y + Ng[2] * a2.y,
    };
    const dxde_x = dNg[0] * a0.x + dNg[1] * a1.x + dNg[2] * a2.x;
    const dxde_y = dNg[0] * a0.y + dNg[1] * a1.y + dNg[2] * a2.y;
    const J = Math.hypot(dxde_x, dxde_y);
    // Outward normal: right-of-tangent (matches the editor convention).
    const n: Vec2 = J > 0 ? { x: dxde_y / J, y: -dxde_x / J } : { x: 0, y: 0 };

    // Field-interpolation side — nodes + element's localNodes basis.
    const Nf = shapeFunctions(eta, element.localNodes);

    // Evaluate kernels at this Gauss point.
    const k = kelvinKernels(s, xField, n, G, nu);

    // Subinterval mapping: dη = halfSpan · dξ.
    const weight = w * J * halfSpan;

    // Accumulate 2×6 blocks. Block layout:
    //   row i ∈ {0, 1}  → collocation DOF (x, y)
    //   col 2k + j      → field node k ∈ {0, 1, 2}, DOF j ∈ {0=x, 1=y}
    for (let nodeK = 0; nodeK < 3; nodeK++) {
      const Nk = Nf[nodeK]! * weight;
      const col0 = 2 * nodeK;
      const col1 = 2 * nodeK + 1;
      // G accumulates U* · N_k · J · w
      gBlock[0]![col0]! += k.U[0][0] * Nk;
      gBlock[0]![col1]! += k.U[0][1] * Nk;
      gBlock[1]![col0]! += k.U[1][0] * Nk;
      gBlock[1]![col1]! += k.U[1][1] * Nk;
      // H accumulates T* · N_k · J · w
      hBlock[0]![col0]! += k.T[0][0] * Nk;
      hBlock[0]![col1]! += k.T[0][1] * Nk;
      hBlock[1]![col0]! += k.T[1][0] * Nk;
      hBlock[1]![col1]! += k.T[1][1] * Nk;
    }
  }

  return { G: gBlock, H: hBlock };
}

function addBlocks(a: ElementBlocks, b: ElementBlocks): ElementBlocks {
  const G = zeros2x6();
  const H = zeros2x6();
  for (let i = 0; i < 2; i++) {
    const gRow = G[i]!;
    const hRow = H[i]!;
    const aG = a.G[i]!;
    const bG = b.G[i]!;
    const aH = a.H[i]!;
    const bH = b.H[i]!;
    for (let j = 0; j < 6; j++) {
      gRow[j] = aG[j]! + bG[j]!;
      hRow[j] = aH[j]! + bH[j]!;
    }
  }
  return { G, H };
}
