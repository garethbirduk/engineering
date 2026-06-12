// Multi-domain BEM solver — couples two or more subdomains across shared
// interfaces per Bird's thesis §2.7.
//
// Each subdomain k provides its own mesh + material. World-position
// coincidence between subdomain k1 and k2 marks "interface" nodes; at
// every such node the BEM unknowns are coupled by
//
//   u_I^(k1) = u_I^(k2) = u_I            (displacement continuity)
//   t_I^(k1) = -t_I^(k2) = t_I           (traction equilibrium —
//                                         opposite outward normals)
//
// Assembly strategy is the block pattern from the MATLAB code:
//
//   1. Run assembleHG(...) per subdomain → H_k, G_k, node lists.
//   2. Walk the per-subdomain node lists, mapping each node to a global
//      index by world position. Nodes seen in >1 subdomain are
//      interface nodes.
//   3. Stack each subdomain's 2*N_k rows into the global system. For
//      each (row, local-column) pair, route the H_k and G_k entries
//      into the appropriate global columns:
//        non-interface node: standard BC partition (one column per axis
//          — H column if u was unknown, -G column if t was unknown);
//          known-side contribution accumulates into RHS as usual.
//        interface node: BOTH u and t unknown. Two global columns per
//          axis. H entries sum across subdomains into the shared u_I
//          column. G entries enter the shared t_I column with the
//          subdomain's sign — +1 for the first subdomain that owns the
//          node (side A), -1 for the second (side B) — implementing the
//          t_I^(B) = -t_I substitution.
//   4. LU solve the combined system.
//   5. Distribute solved DOFs back into each subdomain's mesh, applying
//      the side-B sign flip on the t component so each side's physical
//      traction reads correctly.
//
// IMPORTANT: integrateOverElement honours `traverseReversed` and flips
// the outward normal accordingly, so each subdomain's interface
// elements already carry the right outward normal. No matrix-column-
// reversal trick (as in the MATLAB code) is needed in this pipeline.

import { Matrix, solve as solveLinear } from "ml-matrix";
import type { MeshElement, MeshNode } from "../elements/discretise.js";
import type { Vec2 } from "../geometry/types.js";
import {
  assembleHG,
  pruneStaleCacheEntries,
  type AssembleStats,
  type BlockCache,
} from "./assemble.js";
import { shearModulus, type MaterialProperties } from "./kernels.js";
import type { SolveStats } from "./solve.js";

export interface SubdomainInput {
  readonly mesh: readonly MeshElement[];
  readonly material: MaterialProperties;
}

/**
 * Solve a multi-domain BEM problem with coupled interfaces. Each
 * subdomain provides its own mesh and material; shared boundaries are
 * detected by world-position coincidence of mesh nodes between
 * subdomains.
 *
 * Returns one solved mesh per subdomain in the input order. Subdomain
 * meshes with no remaining unknowns (e.g. a single-DOF degenerate
 * region) come back unchanged.
 *
 * If the coupled system is singular (no displacement BCs anywhere,
 * pathologically conditioned, etc.) the input meshes are returned
 * unchanged — same fail-safe as the single-domain `solve`.
 */
export function solveMultiDomain(
  subdomains: readonly SubdomainInput[],
  cache?: BlockCache,
  statsOut?: { value?: SolveStats },
): MeshElement[][] {
  if (subdomains.length === 0) {
    if (statsOut) statsOut.value = emptyStats();
    return [];
  }

  // ── Phase 1: per-subdomain assembly ─────────────────────────────────
  // assembleHG normally prunes cache entries it didn't touch in the
  // call — which would mean each subdomain's assemble drops every
  // other subdomain's entries. Pass a shared `usedKeys` sink so each
  // subdomain ACCUMULATES touched keys instead, then prune once after
  // all subdomains are done. Without this, a re-solve of a well-zoned
  // model reports 0% cache hits because the previous solve's entries
  // got swept away during the last subdomain's assemble.
  const usedKeys = cache ? new Set<string>() : undefined;
  const systems = subdomains.map((s) =>
    assembleHG(s.mesh, s.material, cache, usedKeys),
  );
  if (cache && usedKeys) pruneStaleCacheEntries(cache, usedKeys);

  // ── Phase 2: build a global node mapping by world position ──────────
  const POS_EPS = 1e-6;
  const posKey = (n: { x: number; y: number }) =>
    `${Math.round(n.x / POS_EPS)},${Math.round(n.y / POS_EPS)}`;

  const globalIndexByKey = new Map<string, number>();
  const globalNodes: MeshNode[] = [];
  // localToGlobal[k][localIdx] → global index
  const localToGlobal: number[][] = [];
  // nodeOwners[gi] = list of (subdomain, localIdx) tuples
  const nodeOwners: { subdomain: number; localIdx: number }[][] = [];

  for (let k = 0; k < systems.length; k++) {
    const sys = systems[k]!;
    const map: number[] = [];
    for (let li = 0; li < sys.nodesByIndex.length; li++) {
      const n = sys.nodesByIndex[li]!;
      const key = posKey(n);
      let gi = globalIndexByKey.get(key);
      if (gi === undefined) {
        gi = globalNodes.length;
        globalIndexByKey.set(key, gi);
        globalNodes.push(n);
        nodeOwners.push([]);
      }
      map.push(gi);
      nodeOwners[gi]!.push({ subdomain: k, localIdx: li });
    }
    localToGlobal.push(map);
  }

  // ── Phase 3: classify interface nodes ───────────────────────────────
  // Interface = node touched by >1 subdomain. firstSubdomain[gi] is the
  // "side A" used by the t-coupling sign convention.
  const isInterface: boolean[] = new Array(globalNodes.length).fill(false);
  const firstSubdomain: number[] = new Array(globalNodes.length).fill(-1);
  for (let gi = 0; gi < nodeOwners.length; gi++) {
    const owners = nodeOwners[gi]!;
    firstSubdomain[gi] = owners[0]?.subdomain ?? -1;
    if (owners.length >= 2) isInterface[gi] = true;
  }

  // ── Phase 4: column layout ──────────────────────────────────────────
  //
  //   non-interface node: 1 column per axis (the unknown one). The
  //     column is "u" if u is unknown, "t" otherwise. The other column
  //     index is -1 (unused — the known DOF contributes only to RHS).
  //   interface node:     2 columns per axis (u_I and t_I, both unknown).
  //
  // colU[gi][a] / colT[gi][a] is -1 when that DOF doesn't have a column.
  const colU: [number, number][] = new Array(globalNodes.length);
  const colT: [number, number][] = new Array(globalNodes.length);
  let nextCol = 0;
  for (let gi = 0; gi < globalNodes.length; gi++) {
    if (isInterface[gi]) {
      colU[gi] = [nextCol, nextCol + 1];
      nextCol += 2;
      colT[gi] = [nextCol, nextCol + 1];
      nextCol += 2;
      continue;
    }
    // Non-interface — use the first owner's node BC to decide which
    // axis is u-unknown vs t-unknown.
    const owner = nodeOwners[gi]![0]!;
    const node = systems[owner.subdomain]!.nodesByIndex[owner.localIdx]!;
    const cU: [number, number] = [-1, -1];
    const cT: [number, number] = [-1, -1];
    for (let a = 0; a < 2; a++) {
      const u = a === 0 ? node.ux : node.uy;
      const t = a === 0 ? node.tx : node.ty;
      const uKnown = !Number.isNaN(u);
      const tKnown = !Number.isNaN(t);
      if (uKnown === tKnown) continue; // degenerate axis, contributes nothing
      if (uKnown) {
        cT[a] = nextCol++; // t is the unknown
      } else {
        cU[a] = nextCol++;
      }
    }
    colU[gi] = cU;
    colT[gi] = cT;
  }
  const totalCols = nextCol;

  // ── Phase 5: row layout — stack each subdomain's collocation rows ───
  let totalRows = 0;
  const rowOffsets: number[] = [];
  for (const sys of systems) {
    rowOffsets.push(totalRows);
    totalRows += 2 * sys.nodesByIndex.length;
  }

  // Column-scaling factor for G entries. Same trick as the single-
  // domain `solve`: scale every traction column by psi so the LU sees
  // H (O(1)) and G·psi (O(L)) at comparable magnitudes, then divide
  // recovered tractions by psi at backfill. Uses the first subdomain's
  // shear modulus as the global scale — slight conditioning hit when
  // subdomains' moduli differ but uniformly correct in exact arithmetic.
  const psi = shearModulus(subdomains[0]!.material);

  // ── Phase 6: assemble A, b ──────────────────────────────────────────
  //
  // For each row r in subdomain k (collocation rows), and each local
  // node n in subdomain k (the columns of H_k, G_k):
  //
  //   gi = local→global node mapping; a = axis.
  //
  //   If gi is non-interface:
  //     - u is known: b -= H_k[r,*] · u; A[r, col_t(gi,a)] -= G_k[r,*]
  //     - t is known: b += G_k[r,*] · t; A[r, col_u(gi,a)] += H_k[r,*]
  //   If gi is interface:
  //     - u_I col gets H_k[r,*] added unconditionally.
  //     - t_I col gets G_k[r,*] added with sign:
  //         side A: -G_k  (this subdomain's t equals +t_I)
  //         side B: +G_k  (this subdomain's t equals -t_I, so substitution
  //                        flips the sign of -G_k)
  const A = Matrix.zeros(totalRows, totalCols);
  const b = Matrix.zeros(totalRows, 1);

  for (let k = 0; k < systems.length; k++) {
    const sys = systems[k]!;
    const N_k = sys.nodesByIndex.length;
    const rowOff = rowOffsets[k]!;
    const map = localToGlobal[k]!;
    for (let r = 0; r < 2 * N_k; r++) {
      const globalRow = rowOff + r;
      for (let n = 0; n < N_k; n++) {
        const gi = map[n]!;
        for (let a = 0; a < 2; a++) {
          const localCol = 2 * n + a;
          const hVal = sys.H.get(r, localCol);
          const gVal = sys.G.get(r, localCol);
          if (isInterface[gi]) {
            const uCol = colU[gi]![a]!;
            const tCol = colT[gi]![a]!;
            A.set(globalRow, uCol, A.get(globalRow, uCol) + hVal);
            const side = k === firstSubdomain[gi] ? 1 : -1;
            // u_B = u_I; t_B = -t_I → B's −G·t_B term = +G·t_I.
            // Express uniformly: contribute (-side * gVal * psi) to
            // t_I col so the unknown column scale matches the rest of
            // the system.
            A.set(
              globalRow,
              tCol,
              A.get(globalRow, tCol) + -side * gVal * psi,
            );
          } else {
            const node = sys.nodesByIndex[n]!;
            const u = a === 0 ? node.ux : node.uy;
            const t = a === 0 ? node.tx : node.ty;
            const uKnown = !Number.isNaN(u);
            const tKnown = !Number.isNaN(t);
            if (uKnown === tKnown) continue;
            if (uKnown) {
              b.set(globalRow, 0, b.get(globalRow, 0) - hVal * u);
              const tCol = colT[gi]![a]!;
              if (tCol >= 0)
                A.set(globalRow, tCol, A.get(globalRow, tCol) + -gVal * psi);
            } else {
              b.set(globalRow, 0, b.get(globalRow, 0) + gVal * t);
              const uCol = colU[gi]![a]!;
              if (uCol >= 0)
                A.set(globalRow, uCol, A.get(globalRow, uCol) + hVal);
            }
          }
        }
      }
    }
  }

  // ── Phase 7: solve ──────────────────────────────────────────────────
  // System must be square — totalRows === totalCols if every subdomain
  // is well-posed (each row equation contributes either a known→RHS or
  // an unknown→LHS column; the rigid-body trick plus interface coupling
  // balance the count). A mismatch indicates upstream BC setup is off.
  if (totalRows !== totalCols) {
    if (statsOut) statsOut.value = emptyStats();
    return subdomains.map((s) => s.mesh.map((el) => ({ ...el })));
  }
  let x: Matrix;
  try {
    x = solveLinear(A, b);
  } catch {
    if (statsOut) statsOut.value = emptyStats();
    return subdomains.map((s) => s.mesh.map((el) => ({ ...el })));
  }

  // ── Phase 8: backfill into each subdomain's mesh ────────────────────
  const result: MeshElement[][] = [];
  let totalUnknownDofs = 0;
  const aggDofsByLineId = new Map<string, ReadonlySet<number>>();
  const aggDofsByElement = new Map<string, ReadonlySet<number>>();
  const aggElementsByNodeIndex = new Map<number, ReadonlySet<string>>();
  const aggNodePositions: Vec2[] = [];
  let aggHits = 0;
  let aggMisses = 0;
  let aggGaussEvals = 0;
  let aggNodeCount = 0;
  let aggElementCount = 0;

  for (let k = 0; k < systems.length; k++) {
    const sys = systems[k]!;
    const N_k = sys.nodesByIndex.length;
    const map = localToGlobal[k]!;

    aggHits += sys.stats.hits;
    aggMisses += sys.stats.misses;
    aggGaussEvals += sys.stats.gaussEvals;
    aggNodeCount += sys.stats.nodeCount;
    aggElementCount += sys.stats.elementCount;

    type Sol = { ux: number; uy: number; tx: number; ty: number };
    const perNode: Sol[] = new Array(N_k);
    for (let li = 0; li < N_k; li++) {
      const origNode = sys.nodesByIndex[li]!;
      const sol: Sol = {
        ux: origNode.ux,
        uy: origNode.uy,
        tx: origNode.tx,
        ty: origNode.ty,
      };
      const gi = map[li]!;
      const side = k === firstSubdomain[gi] ? 1 : -1;
      for (let a = 0; a < 2; a++) {
        if (isInterface[gi]) {
          const uVal = x.get(colU[gi]![a]!, 0);
          // x stores t' = t / psi; multiply back by psi to recover
          // the physical traction. Sign convention then applies.
          const tVal = x.get(colT[gi]![a]!, 0) * psi;
          if (a === 0) {
            sol.ux = uVal;
            // t_I^(A) = +t_I; t_I^(B) = -t_I.
            sol.tx = tVal * side;
          } else {
            sol.uy = uVal;
            sol.ty = tVal * side;
          }
          totalUnknownDofs += k === firstSubdomain[gi] ? 2 : 0;
        } else {
          const u = a === 0 ? origNode.ux : origNode.uy;
          const t = a === 0 ? origNode.tx : origNode.ty;
          const uKnown = !Number.isNaN(u);
          const tKnown = !Number.isNaN(t);
          if (uKnown === tKnown) continue;
          if (uKnown) {
            const tCol = colT[gi]![a]!;
            if (tCol >= 0) {
              // Same psi un-scaling for non-interface t unknowns.
              const tVal = x.get(tCol, 0) * psi;
              if (a === 0) sol.tx = tVal;
              else sol.ty = tVal;
              totalUnknownDofs++;
            }
          } else {
            const uCol = colU[gi]![a]!;
            if (uCol >= 0) {
              const uVal = x.get(uCol, 0);
              if (a === 0) sol.ux = uVal;
              else sol.uy = uVal;
              totalUnknownDofs++;
            }
          }
        }
      }
      perNode[li] = sol;
    }

    const inputMesh = subdomains[k]!.mesh;
    const solved = inputMesh.map((el) => {
      const idxs = sys.elementNodeIndex.get(el);
      if (!idxs) return { ...el };
      return {
        ...el,
        nodes: [
          applySol(el.nodes[0]!, perNode[idxs[0]]!),
          applySol(el.nodes[1]!, perNode[idxs[1]]!),
          applySol(el.nodes[2]!, perNode[idxs[2]]!),
        ] as const,
      };
    });
    result.push(solved);

    // Stats accumulation (line/element id maps just concatenate; node
    // index in this aggregated view is per-subdomain because the matrix
    // view isn't yet wired for multi-subdomain — TODO).
    for (const el of inputMesh) {
      const idxs = sys.elementNodeIndex.get(el);
      if (!idxs) continue;
      const elKey = `${el.lineId}|${el.indexInLine}`;
      let lineDofs = aggDofsByLineId.get(el.lineId);
      let elDofs = aggDofsByElement.get(elKey);
      const lineSet = lineDofs ? new Set(lineDofs) : new Set<number>();
      const elSet = elDofs ? new Set(elDofs) : new Set<number>();
      for (let kk = 0; kk < 3; kk++) {
        const gi = map[idxs[kk]!]!;
        lineSet.add(2 * gi);
        lineSet.add(2 * gi + 1);
        elSet.add(2 * gi);
        elSet.add(2 * gi + 1);
        let nodeSet = aggElementsByNodeIndex.get(gi);
        const nodeMutable = nodeSet ? new Set(nodeSet) : new Set<string>();
        nodeMutable.add(elKey);
        aggElementsByNodeIndex.set(gi, nodeMutable);
      }
      aggDofsByLineId.set(el.lineId, lineSet);
      aggDofsByElement.set(elKey, elSet);
    }
  }
  // Node positions array indexed by global index.
  for (const n of globalNodes) aggNodePositions.push({ x: n.x, y: n.y });

  if (statsOut) {
    statsOut.value = {
      assemble: {
        hits: aggHits,
        misses: aggMisses,
        gaussEvals: aggGaussEvals,
        nodeCount: aggNodeCount,
        elementCount: aggElementCount,
      },
      unknownDofs: totalUnknownDofs,
      dofsByLineId: aggDofsByLineId,
      dofsByElement: aggDofsByElement,
      nodePositions: aggNodePositions,
      elementsByNodeIndex: aggElementsByNodeIndex,
    };
  }

  return result;
}

function applySol(
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

function emptyStats(): SolveStats {
  const empty: AssembleStats = {
    hits: 0,
    misses: 0,
    gaussEvals: 0,
    nodeCount: 0,
    elementCount: 0,
  };
  return {
    assemble: empty,
    unknownDofs: 0,
    dofsByLineId: new Map(),
    dofsByElement: new Map(),
    nodePositions: [],
    elementsByNodeIndex: new Map(),
  };
}
