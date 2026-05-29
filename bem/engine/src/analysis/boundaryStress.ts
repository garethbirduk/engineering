// Boundary stress recovery — gives the full Cartesian stress tensor at
// a point ON a BEM element, without going through the singular D* / S*
// interior-stress integrals.
//
// Reconstruction at a boundary point with outward unit normal n̂ and unit
// tangent t̂:
//
//   σ_nn = t · n̂        (from the applied / solved traction)
//   σ_ns = t · t̂
//   ε_ss = du_s/ds      (gradient of the tangential displacement along
//                         the boundary — comes straight from the field
//                         shape functions on this element)
//   σ_ss = (Hooke)  →  closed form below per plane kind
//
// then transformed back into the (x, y) frame.
//
// This is the standard direct-BEM boundary stress recovery; see e.g.
// Brebbia / Aliabadi. It's exact for the quadratic shape functions used
// by this engine — no near-boundary numerical noise.

import {
  shapeFunctions,
  shapeFunctionDerivatives,
  STANDARD_NODES,
} from "../elements/shapeFunctions.js";
import type { MeshElement } from "../elements/discretise.js";
import type { MaterialProperties } from "../material.js";
import type { StressTriple } from "./stressKernels.js";

const ANCHORS = STANDARD_NODES.continuous;

/**
 * Cartesian (σxx, σyy, σxy) at the boundary point on `el` at local
 * coordinate `eta ∈ [-1, +1]`. Assumes `el.nodes` already carry solved
 * (u, t) DOFs (i.e. `solve()` has run).
 */
export function boundaryStress(
  el: MeshElement,
  eta: number,
  material: MaterialProperties,
): StressTriple {
  // Geometry side — anchors + continuous quadratic basis.
  const Ng = shapeFunctions(eta, ANCHORS);
  void Ng; // position not needed for the stress itself
  const dNg = shapeFunctionDerivatives(eta, ANCHORS);
  const a0 = el.anchors[0];
  const a1 = el.anchors[1];
  const a2 = el.anchors[2];
  const dxde_x = dNg[0] * a0.x + dNg[1] * a1.x + dNg[2] * a2.x;
  const dxde_y = dNg[0] * a0.y + dNg[1] * a1.y + dNg[2] * a2.y;
  const J = Math.hypot(dxde_x, dxde_y);
  if (J === 0) return { sxx: 0, syy: 0, sxy: 0 };
  // Tangent (unit) and outward normal (right-of-tangent in our
  // convention) at the boundary point.
  const tx = dxde_x / J;
  const ty = dxde_y / J;
  const nx = ty;
  const ny = -tx;

  // Field side — element's localNodes basis interpolating its 3 nodal
  // DOFs (u, t).
  const Nf = shapeFunctions(eta, el.localNodes);
  const dNf = shapeFunctionDerivatives(eta, el.localNodes);
  const n0 = el.nodes[0];
  const n1 = el.nodes[1];
  const n2 = el.nodes[2];
  const ux = Nf[0] * n0.ux + Nf[1] * n1.ux + Nf[2] * n2.ux;
  void ux;
  const uy = Nf[0] * n0.uy + Nf[1] * n1.uy + Nf[2] * n2.uy;
  void uy;
  const dux_deta = dNf[0] * n0.ux + dNf[1] * n1.ux + dNf[2] * n2.ux;
  const duy_deta = dNf[0] * n0.uy + dNf[1] * n1.uy + dNf[2] * n2.uy;
  const tfx = Nf[0] * n0.tx + Nf[1] * n1.tx + Nf[2] * n2.tx;
  const tfy = Nf[0] * n0.ty + Nf[1] * n1.ty + Nf[2] * n2.ty;

  // Tangential displacement gradient → tangential strain ε_ss.
  const dus_deta = dux_deta * tx + duy_deta * ty;
  const eps_ss = dus_deta / J;

  // Tractions projected into the (n, s) frame.
  const sigma_nn = tfx * nx + tfy * ny;
  const sigma_ns = tfx * tx + tfy * ty;

  // Tangential stress from Hooke's law, choice of plane kind.
  const E = material.E;
  const nu = material.nu;
  let sigma_ss: number;
  if (material.planeKind === "stress") {
    // Plane stress: σ_zz = 0  ⇒  σ_ss = E ε_ss + ν σ_nn
    sigma_ss = E * eps_ss + nu * sigma_nn;
  } else {
    // Plane strain: σ_zz = ν(σ_nn + σ_ss)
    sigma_ss = (E * eps_ss) / (1 - nu * nu) + (nu * sigma_nn) / (1 - nu);
  }

  // Rotate σ in (n, s) frame back into (x, y).
  //   σ_xy = R^T · σ_ns · R, R = [n̂; t̂]
  const sxx =
    nx * nx * sigma_nn + 2 * nx * tx * sigma_ns + tx * tx * sigma_ss;
  const syy =
    ny * ny * sigma_nn + 2 * ny * ty * sigma_ns + ty * ty * sigma_ss;
  const sxy =
    nx * ny * sigma_nn +
    (nx * ty + ny * tx) * sigma_ns +
    tx * ty * sigma_ss;

  return { sxx, syy, sxy };
}
