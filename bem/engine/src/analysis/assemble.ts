// Global assembly of H and G from a 2D mesh.
//
// Every UNIQUE node (deduplicated by world position within a small
// tolerance) becomes one row+column block of size 2×2 in H and G.
// Shared continuous nodes between adjacent elements collapse to a
// single global row.
//
// The output matrices are 2N × 2N where N is the unique-node count.
//
// Diagonal H block is filled by the rigid-body trick:
//   H_ii = -Σ_{j≠i} H_ij
// (sums over all OFF-DIAGONAL 2×2 blocks in row i), so H_ii includes
// the free-term c_ij contribution implicitly. This avoids ever
// evaluating the strongly singular T* directly at the collocation
// point. (See Brebbia & Dominguez §4.3, Aliabadi §2.5.)

import { Matrix } from "ml-matrix";
import type { MeshElement, MeshNode } from "../elements/discretise.js";
import { integrateOverElement } from "./elementIntegration.js";
import type { MaterialProperties } from "./kernels.js";

/** Tolerance for deduplicating mesh nodes by world position. */
const POS_EPS = 1e-9;

export interface AssembledSystem {
  readonly H: Matrix; // 2N × 2N
  readonly G: Matrix; // 2N × 2N
  /** Global index (0..N-1) for each unique nodal position. */
  readonly nodeIndexByKey: ReadonlyMap<string, number>;
  /** Reverse: index → representative node (for reading back values). */
  readonly nodesByIndex: readonly MeshNode[];
  /** Per (element, local-node-index): which global node it maps to. */
  readonly elementNodeIndex: ReadonlyMap<MeshElement, readonly [number, number, number]>;
}

/** Position-based dedup key. Nodes within POS_EPS of each other share an index. */
function posKey(n: MeshNode): string {
  // Quantize to multiples of POS_EPS to make keys hashable.
  const qx = Math.round(n.x / POS_EPS);
  const qy = Math.round(n.y / POS_EPS);
  return `${qx}|${qy}`;
}

/**
 * Merge a coincident node's DOFs into an existing representative. Each
 * line that meets at a shared (continuous) corner contributes its own
 * BC fan-out; without merging we'd silently drop the second visitor's
 * constraints.
 *
 * Per-axis rules (independent x and y), applied in two layers:
 *
 * Within-kind merge (`mergeDof`):
 *   - NaN ∪ known → known.
 *   - Equal values → keep.
 *   - Two displacements disagree → user error. Warn and take the
 *     smaller-|·| (zero, if present, is almost always the anchor the
 *     user intended).
 *   - Two tractions where one is zero → take the non-zero. The zero
 *     side is almost always the "default free" the fan-out filled in
 *     for an unspecified axis; the non-zero side is the explicit
 *     applied load the user typed in.
 *   - Two non-zero tractions that disagree → genuine corner-traction
 *     discontinuity (different outward normals on the two faces). A
 *     single nodal DOF can't represent it. Warn loudly and take the
 *     larger magnitude so the solve still runs. Proper fix: switch
 *     the two adjacent lines to the discontinuous mesh scheme so the
 *     corner is no longer a collocation point.
 *
 * Per-axis cleanup: if both u and t end up known for the same axis,
 * displacement wins (it's physically continuous; the traction would
 * have been absorbed as a reaction at the pinned point anyway). The
 * dropped t becomes the corner reaction the solver computes.
 */
function mergeNodes(a: MeshNode, b: MeshNode): MeshNode {
  let ux = mergeDof(a.ux, b.ux, "u");
  let uy = mergeDof(a.uy, b.uy, "u");
  let tx = mergeDof(a.tx, b.tx, "t");
  let ty = mergeDof(a.ty, b.ty, "t");
  if (!Number.isNaN(ux) && !Number.isNaN(tx)) tx = NaN;
  if (!Number.isNaN(uy) && !Number.isNaN(ty)) ty = NaN;
  return { x: a.x, y: a.y, ux, uy, tx, ty };
}

function mergeDof(a: number, b: number, kind: "u" | "t"): number {
  if (Number.isNaN(a)) return b;
  if (Number.isNaN(b)) return a;
  // Both known.
  if (Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))) {
    return a;
  }
  if (kind === "t") {
    // Default-free (zero) loses to an explicit applied load. Covers
    // uniaxial / biaxial / any-face-loaded-with-adjacent-free.
    if (a === 0) return b;
    if (b === 0) return a;
    // Both non-zero — genuine corner-traction discontinuity. Single
    // nodal DOF can't represent it; pick the larger magnitude so the
    // solve at least proceeds, and tell the user how to resolve it.
    const pick = Math.abs(a) >= Math.abs(b) ? a : b;
    // eslint-disable-next-line no-console
    console.warn(
      `BEM: corner-traction discontinuity — got ${a} and ${b}, using ${pick}. ` +
        `Switch the two adjacent lines to the discontinuous mesh scheme to resolve.`,
    );
    return pick;
  }
  // Two displacements disagree — user error. Smaller-|·| wins (an
  // anchor is almost always what was meant).
  const pick = Math.abs(a) <= Math.abs(b) ? a : b;
  // eslint-disable-next-line no-console
  console.warn(
    `BEM: corner-displacement conflict — got ${a} and ${b}, using ${pick}. ` +
      `Two adjacent lines impose different displacements at this corner.`,
  );
  return pick;
}

/**
 * Walk the mesh once to build the unique-node registry. Continuous
 * (shared) nodes between adjacent elements get a single global index;
 * discontinuous nodes each get their own. Coincident-node BCs are
 * MERGED so a corner where two lines specify complementary constraints
 * retains both.
 */
function buildNodeRegistry(mesh: readonly MeshElement[]): {
  nodeIndexByKey: Map<string, number>;
  nodesByIndex: MeshNode[];
  elementNodeIndex: Map<MeshElement, [number, number, number]>;
} {
  const nodeIndexByKey = new Map<string, number>();
  const nodesByIndex: MeshNode[] = [];
  const elementNodeIndex = new Map<MeshElement, [number, number, number]>();

  for (const el of mesh) {
    const idxs: [number, number, number] = [-1, -1, -1];
    for (let k = 0; k < 3; k++) {
      const node = el.nodes[k]!;
      const key = posKey(node);
      let idx = nodeIndexByKey.get(key);
      if (idx === undefined) {
        idx = nodesByIndex.length;
        nodeIndexByKey.set(key, idx);
        nodesByIndex.push(node);
      } else {
        // Coincident node — merge its DOFs into the existing rep.
        nodesByIndex[idx] = mergeNodes(nodesByIndex[idx]!, node);
      }
      idxs[k] = idx;
    }
    elementNodeIndex.set(el, idxs);
  }
  return { nodeIndexByKey, nodesByIndex, elementNodeIndex };
}

/**
 * Assemble H and G for the given mesh + material. Diagonal H blocks
 * filled by the rigid-body trick (so each row of H sums to zero in
 * the 2×2 block sense).
 */
export function assembleHG(
  mesh: readonly MeshElement[],
  material: MaterialProperties,
): AssembledSystem {
  const registry = buildNodeRegistry(mesh);
  const N = registry.nodesByIndex.length;
  const size = 2 * N;
  const H = Matrix.zeros(size, size);
  const G = Matrix.zeros(size, size);

  // For each collocation node i (global index ic), integrate over every
  // element j, accumulating into H and G at rows [2ic, 2ic+1] and
  // columns [2g, 2g+1] for each of element j's 3 global node indices g.
  for (let ic = 0; ic < N; ic++) {
    const collocationNode = registry.nodesByIndex[ic]!;
    const s = { x: collocationNode.x, y: collocationNode.y };

    for (const el of mesh) {
      const elNodeIdxs = registry.elementNodeIndex.get(el)!;

      // Singularity: collocation node is on this element if its global
      // index matches any of element's node indices.
      let singularLocalIdx: 0 | 1 | 2 | null = null;
      if (elNodeIdxs[0] === ic) singularLocalIdx = 0;
      else if (elNodeIdxs[1] === ic) singularLocalIdx = 1;
      else if (elNodeIdxs[2] === ic) singularLocalIdx = 2;

      const blocks = integrateOverElement(s, el, material, singularLocalIdx);

      // Scatter the 2×6 block into the global matrices.
      for (let nodeK = 0; nodeK < 3; nodeK++) {
        const gIdx = elNodeIdxs[nodeK]!;
        for (let r = 0; r < 2; r++) {
          const row = 2 * ic + r;
          for (let c = 0; c < 2; c++) {
            const col = 2 * gIdx + c;
            G.set(row, col, G.get(row, col) + blocks.G[r]![2 * nodeK + c]!);
            // Skip the singular self-element T* contribution that's
            // about to be overwritten by the rigid-body trick. We do
            // accumulate it for the row-sum, but it will be ignored
            // because we recompute the diagonal block below.
            H.set(row, col, H.get(row, col) + blocks.H[r]![2 * nodeK + c]!);
          }
        }
      }
    }

    // Rigid-body trick: overwrite the 2×2 diagonal block of row ic
    // with the negated sum of off-diagonal blocks. This sets c_ij
    // implicitly and avoids evaluating T* at r=0.
    for (let r = 0; r < 2; r++) {
      const row = 2 * ic + r;
      // Sum off-diagonal columns (those NOT in {2ic, 2ic+1}).
      let sum0 = 0;
      let sum1 = 0;
      for (let col = 0; col < size; col++) {
        if (col === 2 * ic || col === 2 * ic + 1) continue;
        const v = H.get(row, col);
        if (col % 2 === 0) sum0 += v;
        else sum1 += v;
      }
      H.set(row, 2 * ic, -sum0);
      H.set(row, 2 * ic + 1, -sum1);
    }
  }

  return {
    H,
    G,
    nodeIndexByKey: registry.nodeIndexByKey,
    nodesByIndex: registry.nodesByIndex,
    elementNodeIndex: registry.elementNodeIndex,
  };
}
