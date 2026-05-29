// Placeholder synchronous solver.
//
// API: solve(mesh, material) → solvedMesh
// Same signature the real BEM kernel will take. Today's implementation
// produces a plausible-shaped deformation so the visualisation pipeline
// can be built and exercised before the real kernel lands.
//
// Approach: for any node whose displacement DOF is unknown (NaN), set
// it to a strain-like value (distance from the "constrained centroid"
// along that axis times max applied traction / E). For any node whose
// traction DOF is unknown, set it to zero (real solver computes the
// reaction). This isn't physically correct — it's just enough motion
// for the deformed-shape overlay to mean something visually.

import type { MeshElement, MeshNode } from "../elements/discretise.js";

/** Material properties for 2D linear elastic analysis. */
export interface MaterialProperties {
  /** Young's modulus in Pa. */
  readonly E: number;
  /** Poisson's ratio (dimensionless). */
  readonly nu: number;
}

/** Default: mild steel. */
export const DEFAULT_MATERIAL: MaterialProperties = {
  E: 200e9,
  nu: 0.3,
};

/**
 * Resolve every NaN DOF on the mesh into a number, returning a NEW mesh
 * (input is not mutated — input nodes are referentially preserved when
 * possible; output replaces the nodes that needed solving). Real BEM
 * lands behind this same signature later.
 */
export function solve(
  mesh: readonly MeshElement[],
  material: MaterialProperties = DEFAULT_MATERIAL,
): MeshElement[] {
  if (mesh.length === 0) return [];

  // Pass 1: gather stats over all nodes.
  let xConstrainedSum = 0;
  let xConstrainedCount = 0;
  let yConstrainedSum = 0;
  let yConstrainedCount = 0;
  let maxTx = 0;
  let maxTy = 0;
  for (const el of mesh) {
    for (const n of el.nodes) {
      if (!Number.isNaN(n.ux)) {
        xConstrainedSum += n.x;
        xConstrainedCount++;
      }
      if (!Number.isNaN(n.uy)) {
        yConstrainedSum += n.y;
        yConstrainedCount++;
      }
      if (!Number.isNaN(n.tx)) maxTx = Math.max(maxTx, Math.abs(n.tx));
      if (!Number.isNaN(n.ty)) maxTy = Math.max(maxTy, Math.abs(n.ty));
    }
  }
  // Fallback when there are no constrained displacement DOFs at all
  // (degenerate case — the real solver would refuse, we just keep the
  // motion measurable).
  let xC = xConstrainedCount > 0 ? xConstrainedSum / xConstrainedCount : 0;
  let yC = yConstrainedCount > 0 ? yConstrainedSum / yConstrainedCount : 0;

  // Sign of net traction (right edge pulling right → +ux on free nodes).
  // We use the max-magnitude traction direction as a proxy for net force.
  let netTxSign = 0;
  let netTySign = 0;
  for (const el of mesh) {
    for (const n of el.nodes) {
      if (!Number.isNaN(n.tx) && Math.abs(n.tx) === maxTx) {
        netTxSign = Math.sign(n.tx);
      }
      if (!Number.isNaN(n.ty) && Math.abs(n.ty) === maxTy) {
        netTySign = Math.sign(n.ty);
      }
    }
  }

  const strainX = (maxTx / material.E) * netTxSign;
  const strainY = (maxTy / material.E) * netTySign;

  return mesh.map((el) => ({
    ...el,
    nodes: [
      fillNaNs(el.nodes[0]!, xC, yC, strainX, strainY),
      fillNaNs(el.nodes[1]!, xC, yC, strainX, strainY),
      fillNaNs(el.nodes[2]!, xC, yC, strainX, strainY),
    ] as const,
  }));
}

function fillNaNs(
  n: MeshNode,
  xC: number,
  yC: number,
  strainX: number,
  strainY: number,
): MeshNode {
  const ux = Number.isNaN(n.ux) ? (n.x - xC) * strainX : n.ux;
  const uy = Number.isNaN(n.uy) ? (n.y - yC) * strainY : n.uy;
  const tx = Number.isNaN(n.tx) ? 0 : n.tx;
  const ty = Number.isNaN(n.ty) ? 0 : n.ty;
  if (ux === n.ux && uy === n.uy && tx === n.tx && ty === n.ty) return n;
  return { x: n.x, y: n.y, ux, uy, tx, ty };
}
