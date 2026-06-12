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
import {
  integrateOverElement,
  type ElementBlocks,
  type IntegrationStats,
} from "./elementIntegration.js";
import type { MaterialProperties } from "./kernels.js";

/** Tolerance for deduplicating mesh nodes by world position. */
const POS_EPS = 1e-9;
/** Tolerance for hashing element/material content into cache keys —
 *  loose enough to absorb float-equality noise from re-derived
 *  positions, tight enough that a real edit changes the key. */
const KEY_EPS = 1e-12;

// ─────────────────────────────────────────────────────────────────────
// Reanalysis cache — element-level
// ─────────────────────────────────────────────────────────────────────
//
// Each (collocation_position, field_element, material) tuple maps to a
// 2×6 H block and 2×6 G block. The block depends only on those three
// inputs (kernels are functions of geometry + material; BCs and solved
// DOFs are not in here). So between successive assembleHG calls — as
// long as a triple repeats — we can skip integrateOverElement and
// scatter the cached block straight into the global H, G.
//
// Typical interactive edit (one Point dragged on a many-element model):
//   - Elements whose anchors reference the moved Point are "dirty" —
//     their content key changes, so any pair involving them misses.
//   - Every other element-pair is clean → cache hit → no integration.
//
// The cache is mutated in place by assembleHG. Caller owns its lifetime
// (typically a React useRef in the webapp, a module variable in tests).
// Stale entries (positions no longer used by any element) accumulate
// until cleared; a sweep step prunes them at end of each assemble.

/** Cached H + G 2×6 blocks for a single (collocation, field-el, mat) triple. */
export type CachedPairBlocks = ElementBlocks;

/** Caller-owned reanalysis cache. Hand the same instance to successive
 *  `assembleHG` calls to keep its hits. */
export type BlockCache = Map<string, CachedPairBlocks>;

/** Build a fresh empty cache. Cheap; mostly for clarity at call sites. */
export function createBlockCache(): BlockCache {
  return new Map();
}

/**
 * Drop every cache entry whose key isn't in `usedKeys`. Multi-domain
 * assemble callers use this after running `assembleHG` for each
 * subdomain with a shared `usedKeysOut` set — pruning once at the
 * end avoids the "each subdomain's assemble drops the previous
 * subdomain's entries" trap.
 */
export function pruneStaleCacheEntries(
  cache: BlockCache,
  usedKeys: ReadonlySet<string>,
): void {
  for (const k of cache.keys()) {
    if (!usedKeys.has(k)) cache.delete(k);
  }
}

/** Stable content key for a single MeshElement — anchors + localNodes
 *  rounded to a tight tolerance so float-equality noise on re-derived
 *  positions doesn't trip the cache. Also includes `traverseReversed`
 *  because that flag flips the outward normal sign in
 *  `integrateOverElement` (the T* kernel is linear in n, so a
 *  reversed-flag copy of the same geometric element produces a
 *  sign-flipped H block — caching them under the same key would
 *  silently give one of them the wrong H values). */
function elementContentKey(el: MeshElement): string {
  const q = (x: number) => Math.round(x / KEY_EPS);
  const a0 = el.anchors[0];
  const a1 = el.anchors[1];
  const a2 = el.anchors[2];
  const ln = el.localNodes;
  const r = el.traverseReversed === true ? "R" : "F";
  return (
    `${q(a0.x)},${q(a0.y)}|${q(a1.x)},${q(a1.y)}|${q(a2.x)},${q(a2.y)}|` +
    `${q(ln[0])},${q(ln[1])},${q(ln[2])}|${r}`
  );
}

/** Stable content key for a material — every kernel call's outcome
 *  depends on (E, ν, planeKind). */
function materialContentKey(material: MaterialProperties): string {
  return `${material.E}|${material.nu}|${material.planeKind}`;
}

/** Stable content key for a collocation point position. */
function positionKey(p: { readonly x: number; readonly y: number }): string {
  const q = (x: number) => Math.round(x / KEY_EPS);
  return `${q(p.x)},${q(p.y)}`;
}

/** Full cache key for a (collocation, field-el, material) triple. */
function pairKey(
  s: { readonly x: number; readonly y: number },
  field: MeshElement,
  matKey: string,
): string {
  return `${positionKey(s)}::${elementContentKey(field)}::${matKey}`;
}

export interface AssembledSystem {
  readonly H: Matrix; // 2N × 2N
  readonly G: Matrix; // 2N × 2N
  /** Global index (0..N-1) for each unique nodal position. */
  readonly nodeIndexByKey: ReadonlyMap<string, number>;
  /** Reverse: index → representative node (for reading back values). */
  readonly nodesByIndex: readonly MeshNode[];
  /** Per (element, local-node-index): which global node it maps to. */
  readonly elementNodeIndex: ReadonlyMap<MeshElement, readonly [number, number, number]>;
  /** Work-done summary for this assemble call. */
  readonly stats: AssembleStats;
}

/** Counters describing how much integration work assembleHG just did.
 *  All values are exact, not estimates — they're literal counts of
 *  loop iterations and cache lookups. Useful for showing reanalysis
 *  savings ("X G-evals this solve vs Y if uncached"). */
export interface AssembleStats {
  /** (collocation, field-element) pairs that hit the cache. */
  readonly hits: number;
  /** (collocation, field-element) pairs that missed and ran integration. */
  readonly misses: number;
  /** Total Gauss-point evaluations done across every miss this call.
   *  Dominant cost of the assemble step (each eval = one kernel + one
   *  2×6 scatter contribution). 0 when everything hit the cache. */
  readonly gaussEvals: number;
  /** Unique mesh nodes after dedup. H and G are (2 × nodeCount) ×
   *  (2 × nodeCount) matrices. */
  readonly nodeCount: number;
  /** Element count this mesh. hits + misses = nodeCount × elementCount. */
  readonly elementCount: number;
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
    // Walk node indices in boundary-traversal order so the FIRST node
    // along the boundary walk gets the smallest fresh global index.
    // For native (direction = +1) elements that's [0,1,2]; for reversed
    // elements (segment direction = -1) that's [2,1,0]. The element's
    // own data (anchors, localNodes, nodes[]) is unchanged either way —
    // only the assignment ORDER differs, which is what fixes the row
    // order in H/G/u/t to follow the boundary.
    const reversed = el.traverseReversed === true;
    for (let step = 0; step < 3; step++) {
      const k = reversed ? 2 - step : step;
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
 *
 * If a `cache` is passed, the per-pair (collocation, field-element)
 * 2×6 integration blocks are looked up before calling integrateOver-
 * Element. Hits skip integration entirely; misses populate the cache
 * for the next call. Stale entries (positions / elements no longer
 * present in this mesh) are pruned at the end of the call so the
 * cache stays bounded.
 *
 * The rigid-body trick still runs from scratch every call — it's a
 * row-sum over all current off-diagonal H entries, and global node
 * indices can shift between calls, so there's nothing to reuse there.
 * Cost is O(N²) sums of scalars, dwarfed by the integration we just
 * skipped.
 */
export function assembleHG(
  mesh: readonly MeshElement[],
  material: MaterialProperties,
  cache?: BlockCache,
  /**
   * Optional external sink for cache keys touched during this call.
   * When provided, assembleHG appends every (collocation, field-el,
   * material) key it looks up to this set AND SKIPS the end-of-call
   * cache pruning step. The caller becomes responsible for pruning
   * later — used by `solveMultiDomain` to accumulate touched keys
   * across all subdomain assembles, then prune once at the end so
   * one subdomain's entries don't get dropped by the next
   * subdomain's pruning sweep.
   */
  usedKeysOut?: Set<string>,
): AssembledSystem {
  const registry = buildNodeRegistry(mesh);
  const N = registry.nodesByIndex.length;
  const size = 2 * N;
  const H = Matrix.zeros(size, size);
  const G = Matrix.zeros(size, size);

  const matKey = materialContentKey(material);
  const externalSink = usedKeysOut !== undefined;
  const usedKeys = externalSink
    ? usedKeysOut
    : cache
      ? new Set<string>()
      : null;
  const integStats: IntegrationStats = { gaussEvals: 0 };
  let hits = 0;
  let misses = 0;

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

      // Cache lookup. The singular flag isn't part of the key because
      // it's a deterministic function of the (position, element)
      // content: same position + same element → same singular outcome.
      let blocks: ElementBlocks;
      if (cache) {
        const key = pairKey(s, el, matKey);
        usedKeys!.add(key);
        const hit = cache.get(key);
        if (hit) {
          blocks = hit;
          hits++;
        } else {
          blocks = integrateOverElement(
            s,
            el,
            material,
            singularLocalIdx,
            integStats,
          );
          cache.set(key, blocks);
          misses++;
        }
      } else {
        blocks = integrateOverElement(
          s,
          el,
          material,
          singularLocalIdx,
          integStats,
        );
        misses++;
      }

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

  // Prune stale cache entries — any key we didn't touch this call is
  // no longer reachable from the current mesh (element moved or got
  // deleted), so keeping it just leaks memory. Skipped when the caller
  // supplied an external usedKeysOut — multi-domain assembles want to
  // accumulate touched keys across multiple subdomain calls and prune
  // once at the end via `pruneStaleCacheEntries`.
  if (cache && usedKeys && !externalSink) {
    for (const k of cache.keys()) {
      if (!usedKeys.has(k)) cache.delete(k);
    }
  }

  return {
    H,
    G,
    nodeIndexByKey: registry.nodeIndexByKey,
    nodesByIndex: registry.nodesByIndex,
    elementNodeIndex: registry.elementNodeIndex,
    stats: {
      hits,
      misses,
      gaussEvals: integStats.gaussEvals,
      nodeCount: N,
      elementCount: mesh.length,
    },
  };
}
