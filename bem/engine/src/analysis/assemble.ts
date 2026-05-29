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
 * Walk the mesh once to build the unique-node registry. Continuous
 * (shared) nodes between adjacent elements get a single global index;
 * discontinuous nodes each get their own.
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
