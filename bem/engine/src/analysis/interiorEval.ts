// Somigliana identity for interior points.
//
// For p strictly inside the domain (not on Γ):
//   u_i(p) = ∫_Γ U*_ij(p, q) t_j(q) dΓ(q)
//          - ∫_Γ T*_ij(p, q) u_j(q) dΓ(q)
//
// No free-term c_ij(p) — p is interior, c_ij is identically δ_ij.
// We evaluate the two integrals exactly the same way as the boundary
// assembly does — looping every element, Gauss-Legendre integrating
// the kernels against the element's solved nodal (u, t).
//
// Cost per interior point ≈ one row of H+G during boundary assembly:
// O(N_el × N_gauss) kernel calls. Cheap relative to the boundary
// solve, so contour maps with thousands of sample points are fine.

import { gaussLegendre } from "../numerics/gaussLegendre.js";
import {
  shapeFunctions,
  STANDARD_NODES,
} from "../elements/shapeFunctions.js";
import {
  shapeFunctionDerivatives,
} from "../elements/shapeFunctions.js";
import type { MeshElement } from "../elements/discretise.js";
import type { Vec2 } from "../geometry/types.js";
import {
  effectiveNu,
  kelvinKernels,
  shearModulus,
  type MaterialProperties,
} from "./kernels.js";

const ANCHORS = STANDARD_NODES.continuous;
const INTERIOR_RULE = gaussLegendre(10);

/**
 * Displacement at an interior point p, computed from the SOLVED boundary
 * field on `mesh` (each MeshNode must have its DOFs filled — i.e. solve()
 * has already run).
 *
 * No singularity handling: the caller must keep `p` away from the
 * boundary (typically the triangulation guarantees this since interior
 * post-mesh nodes are well inside the domain).
 */
export function interiorDisplacement(
  p: Vec2,
  mesh: readonly MeshElement[],
  material: MaterialProperties,
): Vec2 {
  const nu = effectiveNu(material);
  const G = shearModulus(material);

  let ux = 0;
  let uy = 0;

  for (const el of mesh) {
    const a0 = el.anchors[0];
    const a1 = el.anchors[1];
    const a2 = el.anchors[2];
    const n0 = el.nodes[0];
    const n1 = el.nodes[1];
    const n2 = el.nodes[2];

    for (let q = 0; q < INTERIOR_RULE.nodes.length; q++) {
      const eta = INTERIOR_RULE.nodes[q]!;
      const w = INTERIOR_RULE.weights[q]!;

      // Geometry side at this Gauss point: anchors + continuous basis.
      const Ng = shapeFunctions(eta, ANCHORS);
      const dNg = shapeFunctionDerivatives(eta, ANCHORS);
      const xField: Vec2 = {
        x: Ng[0] * a0.x + Ng[1] * a1.x + Ng[2] * a2.x,
        y: Ng[0] * a0.y + Ng[1] * a1.y + Ng[2] * a2.y,
      };
      const dxde_x = dNg[0] * a0.x + dNg[1] * a1.x + dNg[2] * a2.x;
      const dxde_y = dNg[0] * a0.y + dNg[1] * a1.y + dNg[2] * a2.y;
      const J = Math.hypot(dxde_x, dxde_y);
      const n: Vec2 = J > 0 ? { x: dxde_y / J, y: -dxde_x / J } : { x: 0, y: 0 };

      // Field-interpolation side: nodes + element's localNodes basis.
      const Nf = shapeFunctions(eta, el.localNodes);
      const ufx = Nf[0] * n0.ux + Nf[1] * n1.ux + Nf[2] * n2.ux;
      const ufy = Nf[0] * n0.uy + Nf[1] * n1.uy + Nf[2] * n2.uy;
      const tfx = Nf[0] * n0.tx + Nf[1] * n1.tx + Nf[2] * n2.tx;
      const tfy = Nf[0] * n0.ty + Nf[1] * n1.ty + Nf[2] * n2.ty;

      // Evaluate the two kernels at this point pair.
      const k = kelvinKernels(p, xField, n, G, nu);
      const Jw = J * w;

      // u_i = ∫ U*_ij t_j dΓ - ∫ T*_ij u_j dΓ
      // Each integral is split into 2x2 i,j contributions.
      ux += (k.U[0][0] * tfx + k.U[0][1] * tfy) * Jw;
      ux -= (k.T[0][0] * ufx + k.T[0][1] * ufy) * Jw;
      uy += (k.U[1][0] * tfx + k.U[1][1] * tfy) * Jw;
      uy -= (k.T[1][0] * ufx + k.T[1][1] * ufy) * Jw;
    }
  }

  return { x: ux, y: uy };
}
