// Integrate U* and T* over a single source element against one
// collocation point. Returns the 2×6 G and H blocks (2 collocation DOFs
// × 6 element DOFs = 3 nodes × 2 axes).
//
// Geometry side uses the 3 ANCHOR positions with the continuous shape
// function basis {-1, 0, +1}.  Field side uses the 3 NODE values with
// the element's chosen localNodes basis.
//
// Quadrature strategy (ports the structure of Bird's BEMIntegration.m):
//   - Adaptive Gauss-point count: start from a small rule, grow until
//     the H and G blocks settle to a relative tolerance. Cheap, smooth
//     integrands stop fast (4–6 pts); near-singular pairs need more.
//   - Singular pairs (collocation point at one of the element's own
//     nodes): apply the Telles (1987) cubic transformation so a regular
//     Gauss-Legendre rule converges on the log r singularity in U*.
//     The 1/r singularity in T* is dealt with at assembly time by the
//     rigid-body trick — the H block produced here for the singular
//     pair is only consumed for its off-diagonal row-sum contribution.
//
// Notes on the choice of bounds:
//   - REGULAR rule grows 4 → 24. Sufficient for any source/element pair
//     not on the element. The convergence test stops as soon as both
//     blocks have stabilised.
//   - SINGULAR Telles rule grows 8 → 24. The Telles cubic concentrates
//     points near ηBar, so 10–12 is usually plenty.

import {
  cachedGaussLegendre,
  type GaussRule,
} from "../numerics/gaussLegendre.js";
import { tellesTransform, type TellesRule } from "../numerics/telles.js";
import {
  shapeFunctions,
  STANDARD_NODES,
} from "../elements/shapeFunctions.js";
import type { MeshElement } from "../elements/discretise.js";
import type { Vec2 } from "../geometry/types.js";
import {
  kelvinKernels,
  type MaterialProperties,
  effectiveNu,
  shearModulus,
} from "./kernels.js";

const ANCHORS = STANDARD_NODES.continuous;

/** Adaptive integration controls. */
const REGULAR_N_MIN = 4;
const REGULAR_N_STEP = 2;
const REGULAR_N_MAX = 24;
const SINGULAR_N_MIN = 8;
const SINGULAR_N_STEP = 2;
const SINGULAR_N_MAX = 24;
/** Relative tolerance for "both H and G blocks have settled". Measured
 *  as max|ΔBlock| / max|Block| between successive refinements. */
const CONVERGENCE_TOL = 1e-6;

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
 * Integrate U* and T* over `element` against collocation point `s`.
 * `singularNodeIdx` is the local node index (0, 1, or 2) of the
 * collocation point on THIS element, or null when the collocation
 * point is not one of this element's own nodes (regular integration).
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
    return adaptiveIntegrate(
      s,
      element,
      G,
      nu,
      (n) => cachedGaussLegendre(n),
      REGULAR_N_MIN,
      REGULAR_N_STEP,
      REGULAR_N_MAX,
    );
  }

  // Singular: Telles around the singular η on this element. The base
  // rule is rebuilt at each adaptive order, then transformed.
  const etaBar = element.localNodes[singularNodeIdx]!;
  return adaptiveIntegrate(
    s,
    element,
    G,
    nu,
    (n) => tellesTransform(cachedGaussLegendre(n), etaBar),
    SINGULAR_N_MIN,
    SINGULAR_N_STEP,
    SINGULAR_N_MAX,
  );
}

/** Loop the quadrature order upward until both H and G stabilise. */
function adaptiveIntegrate(
  s: Vec2,
  element: MeshElement,
  G: number,
  nu: number,
  buildRule: (n: number) => GaussRule | TellesRule,
  nMin: number,
  nStep: number,
  nMax: number,
): ElementBlocks {
  let prev: ElementBlocks | null = null;
  let curr: ElementBlocks = integrateWithRule(
    s,
    element,
    G,
    nu,
    buildRule(nMin),
  );
  for (let n = nMin + nStep; n <= nMax; n += nStep) {
    prev = curr;
    curr = integrateWithRule(s, element, G, nu, buildRule(n));
    if (blocksConverged(prev, curr, CONVERGENCE_TOL)) return curr;
  }
  return curr;
}

/** Returns true when |Δ| / max|·| ≤ tol for both H and G across every
 *  entry of the 2×6 blocks. */
function blocksConverged(
  a: ElementBlocks,
  b: ElementBlocks,
  tol: number,
): boolean {
  return blockConverged(a.G, b.G, tol) && blockConverged(a.H, b.H, tol);
}

function blockConverged(a: Block2x6, b: Block2x6, tol: number): boolean {
  let maxAbs = 0;
  let maxDelta = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 6; j++) {
      const av = Math.abs(b[i]![j]!);
      if (av > maxAbs) maxAbs = av;
      const d = Math.abs(b[i]![j]! - a[i]![j]!);
      if (d > maxDelta) maxDelta = d;
    }
  }
  // A truly-zero block (e.g. by symmetry) is always "converged".
  if (maxAbs === 0) return true;
  return maxDelta <= tol * maxAbs;
}

function integrateWithRule(
  s: Vec2,
  element: MeshElement,
  G: number,
  nu: number,
  rule: GaussRule | TellesRule,
): ElementBlocks {
  const gBlock = zeros2x6();
  const hBlock = zeros2x6();
  const a0 = element.anchors[0];
  const a1 = element.anchors[1];
  const a2 = element.anchors[2];

  // STANDARD_NODES.continuous is a tuple [number, number, number];
  // capture it once here for use as the geometry basis.
  const dNg0 = shapeFunctionDerivativesContinuous;

  for (let q = 0; q < rule.nodes.length; q++) {
    const eta = rule.nodes[q]!;
    const w = rule.weights[q]!;

    // Geometry side — anchors + continuous basis.
    const Ng = shapeFunctions(eta, ANCHORS);
    const dNg = dNg0(eta);
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

    const k = kelvinKernels(s, xField, n, G, nu);
    const weight = w * J;

    for (let nodeK = 0; nodeK < 3; nodeK++) {
      const Nk = Nf[nodeK]! * weight;
      const col0 = 2 * nodeK;
      const col1 = 2 * nodeK + 1;
      gBlock[0]![col0]! += k.U[0][0] * Nk;
      gBlock[0]![col1]! += k.U[0][1] * Nk;
      gBlock[1]![col0]! += k.U[1][0] * Nk;
      gBlock[1]![col1]! += k.U[1][1] * Nk;
      hBlock[0]![col0]! += k.T[0][0] * Nk;
      hBlock[0]![col1]! += k.T[0][1] * Nk;
      hBlock[1]![col0]! += k.T[1][0] * Nk;
      hBlock[1]![col1]! += k.T[1][1] * Nk;
    }
  }

  return { G: gBlock, H: hBlock };
}

// Cached derivative evaluator on the continuous {-1, 0, +1} basis —
// the geometry side never changes basis so we don't need to pay the
// shape-function-derivative dispatch per Gauss point. Kept local;
// `shapeFunctionDerivatives` lives in elements/.
import { shapeFunctionDerivatives } from "../elements/shapeFunctions.js";
const shapeFunctionDerivativesContinuous = (eta: number) =>
  shapeFunctionDerivatives(eta, ANCHORS);
