// Generalised quadratic Lagrange shape functions over η ∈ [-1, +1].
//
// Thesis Eq 2.42 (Bird 2012):
//   N_k(η) = A_k · (η² − B_k·η + C_k)
// with the product/sum over the other two nodes j ≠ k:
//   A_k = ∏ 1/(η_k − η_j)
//   B_k = Σ η_j
//   C_k = ∏ η_j
//
// This is mathematically equivalent to the standard 3-node Lagrange basis but
// expressed so the same code handles continuous {-1, 0, +1}, discontinuous
// {-2/3, 0, +2/3}, and either semi-discontinuous variant uniformly.

/** Local η coordinates of the three element nodes. */
export type LocalNodes = readonly [number, number, number];

/** Triple of values, one per node. */
export type NodeTriple = readonly [number, number, number];

/** Standard nodal configurations used in the thesis. */
export const STANDARD_NODES = {
  continuous: [-1, 0, 1] as const satisfies LocalNodes,
  discontinuous: [-2 / 3, 0, 2 / 3] as const satisfies LocalNodes,
  semiDiscontinuous1: [-2 / 3, 0, 1] as const satisfies LocalNodes,
  semiDiscontinuous2: [-1, 0, 2 / 3] as const satisfies LocalNodes,
} as const;

/** Shape function values N₁(η), N₂(η), N₃(η). */
export function shapeFunctions(eta: number, nodes: LocalNodes): NodeTriple {
  const n0 = nodes[0];
  const n1 = nodes[1];
  const n2 = nodes[2];

  // For each k, compute A_k (∏ 1/(η_k − η_j)), B_k (Σ η_j), C_k (∏ η_j) over j ≠ k.
  // Unrolled three ways to keep the hot path branch-free.
  const a0 = 1 / ((n0 - n1) * (n0 - n2));
  const b0 = n1 + n2;
  const c0 = n1 * n2;

  const a1 = 1 / ((n1 - n0) * (n1 - n2));
  const b1 = n0 + n2;
  const c1 = n0 * n2;

  const a2 = 1 / ((n2 - n0) * (n2 - n1));
  const b2 = n0 + n1;
  const c2 = n0 * n1;

  const eta2 = eta * eta;
  return [
    a0 * (eta2 - b0 * eta + c0),
    a1 * (eta2 - b1 * eta + c1),
    a2 * (eta2 - b2 * eta + c2),
  ];
}

/** First derivatives dN_k/dη evaluated at η. */
export function shapeFunctionDerivatives(
  eta: number,
  nodes: LocalNodes,
): NodeTriple {
  const n0 = nodes[0];
  const n1 = nodes[1];
  const n2 = nodes[2];

  const a0 = 1 / ((n0 - n1) * (n0 - n2));
  const b0 = n1 + n2;

  const a1 = 1 / ((n1 - n0) * (n1 - n2));
  const b1 = n0 + n2;

  const a2 = 1 / ((n2 - n0) * (n2 - n1));
  const b2 = n0 + n1;

  return [
    a0 * (2 * eta - b0),
    a1 * (2 * eta - b1),
    a2 * (2 * eta - b2),
  ];
}
