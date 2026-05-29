// 6-node quadratic triangle (T6) shape functions in area / barycentric
// coordinates  L1, L2, L3  with  L1 + L2 + L3 = 1.
//
// Node numbering convention used here:
//   1, 2, 3        – the three triangle vertices
//   4              – midpoint of edge (1, 2)
//   5              – midpoint of edge (2, 3)
//   6              – midpoint of edge (3, 1)
//
// Quadratic basis (Cook §6, Zienkiewicz §5):
//   N1 = L1 (2 L1 - 1)
//   N2 = L2 (2 L2 - 1)
//   N3 = L3 (2 L3 - 1)
//   N4 = 4 L1 L2
//   N5 = 4 L2 L3
//   N6 = 4 L3 L1
//
// Each N_k is 1 at its own node and 0 at the other five.

export type Sextet = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * Six T6 shape function values at barycentric (L1, L2, L3). L3 is
 * derived as 1 − L1 − L2 if not supplied. No bounds checking — caller
 * is responsible for keeping (L1, L2, L3) within the unit triangle.
 */
export function shapeFunctionsT6(
  L1: number,
  L2: number,
  L3: number = 1 - L1 - L2,
): Sextet {
  return [
    L1 * (2 * L1 - 1),
    L2 * (2 * L2 - 1),
    L3 * (2 * L3 - 1),
    4 * L1 * L2,
    4 * L2 * L3,
    4 * L3 * L1,
  ];
}

/**
 * Interpolate a scalar field over a T6 element from its 6 nodal values
 * at the requested barycentric position.
 */
export function interpolateT6(
  values: Sextet,
  L1: number,
  L2: number,
  L3: number = 1 - L1 - L2,
): number {
  const N = shapeFunctionsT6(L1, L2, L3);
  return (
    values[0] * N[0] +
    values[1] * N[1] +
    values[2] * N[2] +
    values[3] * N[3] +
    values[4] * N[4] +
    values[5] * N[5]
  );
}
