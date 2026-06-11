// Walk every boundary and sample the Kelvin kernels U* and T* densely
// along its arc, from a fixed collocation point s. Produces the data
// behind the "look at the integrand around the whole boundary" view:
// for each (collocation axis a, field axis β), a continuous curve
// K_{a,β}(s, x(arc)) over arc length, with the elements, nodes and
// adaptive Gauss points all marked in arc space.
//
// Singular self-collocation (s coincides with a mesh node) shows up
// naturally as a log r / 1/r spike in the curve at the matching arc.
// The Gauss rule reported for elements that contain s is the Telles
// rule the assembler actually uses; for all other elements it's a
// plain Gauss-Legendre rule.
//
// Geometry / normal / arc-length conventions match the assembler:
//   - element anchors define the quadratic geometry x(η)
//   - n is right-of-(dx/dη) at every sample (same as integrateOverElement)
//   - arc accumulates in the BOUNDARY WALK direction, which for
//     `traverseReversed: true` elements is η = +1 → η = -1.

import type { Boundary, Vec2 } from "../geometry/types.js";
import { shapeFunctions, STANDARD_NODES } from "../elements/shapeFunctions.js";
import { shapeFunctionDerivatives } from "../elements/shapeFunctions.js";
import type { MeshElement } from "../elements/discretise.js";
import {
  kelvinKernels,
  effectiveNu,
  shearModulus,
  type MaterialProperties,
} from "./kernels.js";
import { cachedGaussLegendre } from "../numerics/gaussLegendre.js";
import { tellesTransform } from "../numerics/telles.js";

const ANCHORS = STANDARD_NODES.continuous;
const POS_EPS = 1e-9 * 10;

/** One sample of U* and T* at a point along the boundary. */
export interface KernelSample {
  readonly arc: number;
  /** U*[a][β], a = collocation axis (0=x, 1=y), β = field axis. */
  readonly U: readonly [readonly [number, number], readonly [number, number]];
  /** T*[a][β]. */
  readonly T: readonly [readonly [number, number], readonly [number, number]];
}

/** One element's slice of the boundary walk. */
export interface ElementOnBoundary {
  readonly elementKey: string;
  readonly arcStart: number;
  readonly arcEnd: number;
  /** Three mesh nodes, with their arc position. Order is the boundary
   *  walk order (so node 0 is the boundary-walk-first node). */
  readonly nodes: readonly { readonly arc: number; readonly x: number; readonly y: number }[];
  /** Densely sampled kernel values along this element in boundary-
   *  walk order. samples[0].arc === arcStart; samples[last].arc ===
   *  arcEnd. */
  readonly samples: readonly KernelSample[];
  /** Converged Gauss rule for the assembler's integration of this
   *  element from s. For non-singular pairs it's plain Gauss-Legendre
   *  in η-space; for singular pairs it's the Telles rule (nodes in
   *  original η space, clustered around η̄). The reported `order` is
   *  the rule the existing adaptive integrator settles on. */
  readonly gauss: {
    readonly arcs: readonly number[];
    readonly etas: readonly number[];
    readonly order: number;
    readonly isTelles: boolean;
  };
}

export interface BoundaryWalk {
  readonly boundaryId: string;
  readonly name: string;
  /** Global arc offset where this boundary's walk starts. Successive
   *  boundaries are stacked end-to-end on the global arc axis. */
  readonly arcStart: number;
  readonly arcLength: number;
  readonly elements: readonly ElementOnBoundary[];
}

export interface BoundaryKernelTraces {
  readonly boundaries: readonly BoundaryWalk[];
  /** Every boundary location where the collocation point s coincides
   *  with a mesh node, in global arc coordinates. Usually 0 or 1; >1
   *  is possible at a shared corner between boundaries. */
  readonly collocationArcs: readonly { readonly boundaryId: string; readonly arc: number }[];
  /** Sum of all boundary arc lengths. */
  readonly totalArc: number;
}

/**
 * Walk every boundary and densely sample U* and T* from `s` along its
 * arc. The output is laid out to feed directly into a plot whose
 * x-axis is global arc length and whose curves are the 4 tensor
 * components of each kernel.
 */
export function traceBoundaryKernels(
  s: Vec2,
  mesh: readonly MeshElement[],
  boundaries: readonly Boundary[],
  material: MaterialProperties,
  options: { samplesPerElement?: number } = {},
): BoundaryKernelTraces {
  const samplesPerElement = Math.max(8, options.samplesPerElement ?? 40);
  const nu = effectiveNu(material);
  const Gmod = shearModulus(material);

  // Index mesh by lineId so we can pull elements out segment by segment.
  // Each line's elements are in line-native order (η: -1 → +1). For a
  // direction = -1 segment we'll iterate them backwards.
  const elementsByLineId = new Map<string, MeshElement[]>();
  for (const el of mesh) {
    const arr = elementsByLineId.get(el.lineId);
    if (arr) arr.push(el);
    else elementsByLineId.set(el.lineId, [el]);
  }
  // Native order = ascending indexInLine.
  for (const arr of elementsByLineId.values()) {
    arr.sort((a, b) => a.indexInLine - b.indexInLine);
  }

  const out: BoundaryWalk[] = [];
  const collocationArcs: { boundaryId: string; arc: number }[] = [];
  let globalArc = 0;

  for (const boundary of boundaries) {
    const arcStart = globalArc;
    const elements: ElementOnBoundary[] = [];

    for (const segment of boundary.segments) {
      const lineElems = elementsByLineId.get(segment.lineId);
      if (!lineElems) continue;
      const reverse = segment.direction === -1;
      // Walk elements in boundary-walk order.
      for (
        let i = reverse ? lineElems.length - 1 : 0;
        reverse ? i >= 0 : i < lineElems.length;
        reverse ? i-- : i++
      ) {
        const el = lineElems[i]!;
        const traced = traceElement(
          el,
          reverse,
          s,
          Gmod,
          nu,
          samplesPerElement,
          globalArc,
        );
        elements.push(traced);
        // Note any element node that lies on the collocation point.
        for (let k = 0; k < 3; k++) {
          const n = traced.nodes[k]!;
          if (Math.hypot(n.x - s.x, n.y - s.y) < POS_EPS) {
            // Only record once per boundary visit (corners would otherwise
            // double-emit since two adjacent elements share that node).
            const last = collocationArcs[collocationArcs.length - 1];
            if (
              !last ||
              last.boundaryId !== boundary.id ||
              Math.abs(last.arc - n.arc) > POS_EPS
            ) {
              collocationArcs.push({ boundaryId: boundary.id, arc: n.arc });
            }
          }
        }
        globalArc = traced.arcEnd;
      }
    }

    const arcLength = globalArc - arcStart;
    // Skip boundaries that contributed nothing (no segments, missing
    // lines, or the segments referenced lines whose mesh is empty).
    // They're typically stale entries left over from editing and
    // would otherwise eat x-axis space with empty gap-padded slots.
    if (elements.length === 0 || arcLength === 0) continue;
    out.push({
      boundaryId: boundary.id,
      name: boundary.name,
      arcStart,
      arcLength,
      elements,
    });
  }

  return {
    boundaries: out,
    collocationArcs,
    totalArc: globalArc,
  };
}

/**
 * Densely sample one element's contribution to U* and T*. `arcStart`
 * is where the element begins on the global arc axis. `reverse =
 * true` means the boundary walk goes from η=+1 to η=-1 in the
 * element's native frame.
 */
function traceElement(
  element: MeshElement,
  reverse: boolean,
  s: Vec2,
  Gmod: number,
  nu: number,
  samplesPerElement: number,
  arcStart: number,
): ElementOnBoundary {
  const a0 = element.anchors[0];
  const a1 = element.anchors[1];
  const a2 = element.anchors[2];

  // 1) Compute the etas to sample, in boundary-walk order.
  //    reverse=false: η runs -1 → +1
  //    reverse=true:  η runs +1 → -1
  const etasOrdered: number[] = [];
  for (let i = 0; i < samplesPerElement; i++) {
    const t = i / (samplesPerElement - 1);
    const eta = reverse ? +1 - 2 * t : -1 + 2 * t;
    etasOrdered.push(eta);
  }

  // 2) Cumulative arc + kernel sample.
  const samples: KernelSample[] = [];
  let prevX = 0;
  let prevY = 0;
  let arc = arcStart;
  for (let i = 0; i < etasOrdered.length; i++) {
    const eta = etasOrdered[i]!;
    const Ng = shapeFunctions(eta, ANCHORS);
    const dNg = shapeFunctionDerivatives(eta, ANCHORS);
    const x = Ng[0] * a0.x + Ng[1] * a1.x + Ng[2] * a2.x;
    const y = Ng[0] * a0.y + Ng[1] * a1.y + Ng[2] * a2.y;
    const dxde_x = dNg[0] * a0.x + dNg[1] * a1.x + dNg[2] * a2.x;
    const dxde_y = dNg[0] * a0.y + dNg[1] * a1.y + dNg[2] * a2.y;
    const J = Math.hypot(dxde_x, dxde_y);
    const n: Vec2 =
      J > 0 ? { x: dxde_y / J, y: -dxde_x / J } : { x: 0, y: 0 };

    if (i > 0) {
      arc += Math.hypot(x - prevX, y - prevY);
    }
    prevX = x;
    prevY = y;

    const k = kelvinKernels(s, { x, y }, n, Gmod, nu);
    samples.push({
      arc,
      U: [
        [k.U[0][0], k.U[0][1]],
        [k.U[1][0], k.U[1][1]],
      ] as const,
      T: [
        [k.T[0][0], k.T[0][1]],
        [k.T[1][0], k.T[1][1]],
      ] as const,
    });
  }
  const arcEnd = arc;

  // 3) Node arc positions. For each node, locate its η via element.localNodes
  //    and interpolate the arc from the sample table.
  const nodes: { arc: number; x: number; y: number }[] = [];
  for (let k = 0; k < 3; k++) {
    const eta = element.localNodes[k]!;
    const nodeArc = etaToArc(eta, etasOrdered, samples);
    const Ng = shapeFunctions(eta, ANCHORS);
    const x = Ng[0] * a0.x + Ng[1] * a1.x + Ng[2] * a2.x;
    const y = Ng[0] * a0.y + Ng[1] * a1.y + Ng[2] * a2.y;
    nodes.push({ arc: nodeArc, x, y });
  }
  // Reorder nodes to boundary-walk order. element.nodes / element.localNodes
  // are in native order; the walk visits them in reverse order when
  // `reverse` is true.
  const nodesWalk = reverse ? [nodes[2]!, nodes[1]!, nodes[0]!] : nodes;

  // 4) Gauss points. Detect singular by world-position match between s
  //    and any element node. Replay the adaptive convergence to learn
  //    the order the assembler uses.
  let singularLocalIdx: 0 | 1 | 2 | null = null;
  for (let k = 0; k < 3; k++) {
    const n = element.nodes[k]!;
    if (Math.hypot(n.x - s.x, n.y - s.y) < POS_EPS) {
      singularLocalIdx = k as 0 | 1 | 2;
      break;
    }
  }
  const gauss = pickGaussRule(s, element, Gmod, nu, singularLocalIdx);
  const gaussArcs: number[] = [];
  for (const eta of gauss.etas) {
    gaussArcs.push(etaToArc(eta, etasOrdered, samples));
  }

  return {
    elementKey: `${element.lineId}|${element.indexInLine}`,
    arcStart,
    arcEnd,
    nodes: nodesWalk,
    samples,
    gauss: {
      arcs: gaussArcs,
      etas: gauss.etas,
      order: gauss.order,
      isTelles: singularLocalIdx !== null,
    },
  };
}

/** Linearly interpolate the arc position of a given η from the sampled
 *  (eta, arc) sequence. Works for both forward (-1→+1) and reverse
 *  (+1→-1) walks. */
function etaToArc(
  eta: number,
  etasOrdered: readonly number[],
  samples: readonly KernelSample[],
): number {
  // Find the first index where the sequence brackets eta.
  // Sequence is monotonic in either direction.
  const ascending = etasOrdered[etasOrdered.length - 1]! > etasOrdered[0]!;
  for (let i = 1; i < etasOrdered.length; i++) {
    const e0 = etasOrdered[i - 1]!;
    const e1 = etasOrdered[i]!;
    const within = ascending ? eta >= e0 && eta <= e1 : eta <= e0 && eta >= e1;
    if (within) {
      const a0 = samples[i - 1]!.arc;
      const a1 = samples[i]!.arc;
      const t = (eta - e0) / (e1 - e0);
      return a0 + t * (a1 - a0);
    }
  }
  // Out of range (numerical drift): clamp.
  if ((ascending && eta <= etasOrdered[0]!) || (!ascending && eta >= etasOrdered[0]!)) {
    return samples[0]!.arc;
  }
  return samples[samples.length - 1]!.arc;
}

// Replicates the adaptive convergence loop in elementIntegration.ts
// just to learn what `n` the assembler settles on. Keeps a local
// copy so we don't need to refactor elementIntegration to expose
// the order.
const REGULAR_N_MIN = 4;
const REGULAR_N_STEP = 2;
const REGULAR_N_MAX = 24;
const SINGULAR_N_MIN = 8;
const SINGULAR_N_STEP = 2;
const SINGULAR_N_MAX = 24;
const CONVERGENCE_TOL = 1e-6;

function pickGaussRule(
  s: Vec2,
  element: MeshElement,
  Gmod: number,
  nu: number,
  singularLocalIdx: 0 | 1 | 2 | null,
): { etas: number[]; order: number } {
  const isTelles = singularLocalIdx !== null;
  const buildRule = isTelles
    ? (n: number) =>
        tellesTransform(
          cachedGaussLegendre(n),
          element.localNodes[singularLocalIdx!]!,
        )
    : (n: number) => cachedGaussLegendre(n);
  const nMin = isTelles ? SINGULAR_N_MIN : REGULAR_N_MIN;
  const nStep = isTelles ? SINGULAR_N_STEP : REGULAR_N_STEP;
  const nMax = isTelles ? SINGULAR_N_MAX : REGULAR_N_MAX;

  let prev: number[][] | null = null;
  let curr = blocksFromRule(s, element, Gmod, nu, buildRule(nMin));
  let order = nMin;
  for (let n = nMin + nStep; n <= nMax; n += nStep) {
    prev = curr;
    curr = blocksFromRule(s, element, Gmod, nu, buildRule(n));
    order = n;
    if (converged(prev, curr, CONVERGENCE_TOL)) break;
  }
  return { etas: Array.from(buildRule(order).nodes), order };
}

function blocksFromRule(
  s: Vec2,
  element: MeshElement,
  Gmod: number,
  nu: number,
  rule: { nodes: readonly number[]; weights: readonly number[] },
): number[][] {
  const a0 = element.anchors[0];
  const a1 = element.anchors[1];
  const a2 = element.anchors[2];
  // 2 rows × 12 cols: [H 6 cols, G 6 cols]. Lumped together so a
  // single convergence test covers both kernels.
  const out: number[][] = [
    new Array(12).fill(0),
    new Array(12).fill(0),
  ];
  for (let q = 0; q < rule.nodes.length; q++) {
    const eta = rule.nodes[q]!;
    const w = rule.weights[q]!;
    const Ng = shapeFunctions(eta, ANCHORS);
    const dNg = shapeFunctionDerivatives(eta, ANCHORS);
    const xField = {
      x: Ng[0] * a0.x + Ng[1] * a1.x + Ng[2] * a2.x,
      y: Ng[0] * a0.y + Ng[1] * a1.y + Ng[2] * a2.y,
    };
    const dxde_x = dNg[0] * a0.x + dNg[1] * a1.x + dNg[2] * a2.x;
    const dxde_y = dNg[0] * a0.y + dNg[1] * a1.y + dNg[2] * a2.y;
    const J = Math.hypot(dxde_x, dxde_y);
    const n =
      J > 0 ? { x: dxde_y / J, y: -dxde_x / J } : { x: 0, y: 0 };
    const Nf = shapeFunctions(eta, element.localNodes);
    const k = kelvinKernels(s, xField, n, Gmod, nu);
    const weight = w * J;
    for (let nodeK = 0; nodeK < 3; nodeK++) {
      const Nk = Nf[nodeK]! * weight;
      const col0 = 2 * nodeK;
      const col1 = 2 * nodeK + 1;
      out[0]![col0]! += k.T[0][0] * Nk;
      out[0]![col1]! += k.T[0][1] * Nk;
      out[1]![col0]! += k.T[1][0] * Nk;
      out[1]![col1]! += k.T[1][1] * Nk;
      out[0]![6 + col0]! += k.U[0][0] * Nk;
      out[0]![6 + col1]! += k.U[0][1] * Nk;
      out[1]![6 + col0]! += k.U[1][0] * Nk;
      out[1]![6 + col1]! += k.U[1][1] * Nk;
    }
  }
  return out;
}

function converged(
  a: number[][],
  b: number[][],
  tol: number,
): boolean {
  let maxAbs = 0;
  let maxDelta = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 12; j++) {
      const v = Math.abs(b[i]![j]!);
      if (v > maxAbs) maxAbs = v;
      const d = Math.abs(b[i]![j]! - a[i]![j]!);
      if (d > maxDelta) maxDelta = d;
    }
  }
  if (maxAbs === 0) return true;
  return maxDelta <= tol * maxAbs;
}
