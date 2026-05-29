// 2D direct-BEM fundamental solutions (Kelvin).
//
// Source point  s  — collocation point (where we evaluate the integral
// equation).  Field point  f  — point on the boundary element where
// the kernel is evaluated under the integrand.  n  — outward unit
// normal at f.
//
// Plane-strain forms (Aliabadi 2002 §2; Brebbia eq 5.27):
//   U*_ij = 1 / (8π G (1-ν)) · [ (3-4ν) δ_ij ln(1/r) + r,i r,j ]
//   T*_ij = -1 / (4π (1-ν) r) · {
//             [ (1-2ν) δ_ij + 2 r,i r,j ] · ∂r/∂n
//             - (1-2ν) · ( n_i r,j - n_j r,i )
//           }
// where  r_i = f_i - s_i,  r = |r|,  r,i = r_i / r,
//        ∂r/∂n = r,k · n_k.
//
// Plane-stress reduces to plane-strain by the substitution
//   ν → ν' = ν / (1+ν)
// (same E).  The caller picks `effectiveNu` accordingly.

import type { Vec2 } from "../geometry/types.js";

/** A 2×2 block.  Indexed [i][j] = response in direction i to load in direction j. */
export type Mat2x2 = readonly [
  readonly [number, number],
  readonly [number, number],
];

export interface KelvinKernels {
  readonly U: Mat2x2;
  readonly T: Mat2x2;
}

/**
 * Material properties for 2D linear elasticity.
 *
 * `planeKind` chooses how the out-of-plane assumption maps Poisson:
 *   "strain" → ν' = ν (long body, no out-of-plane strain)
 *   "stress" → ν' = ν / (1+ν) (thin sheet, no out-of-plane stress)
 */
export interface MaterialProperties {
  readonly E: number;
  readonly nu: number;
  readonly planeKind: "strain" | "stress";
}

/** Default: mild steel, plane stress (sensible for a 2D sketch). */
export const DEFAULT_MATERIAL: MaterialProperties = {
  E: 200e9,
  nu: 0.3,
  planeKind: "stress",
};

/** Effective Poisson ratio in the plane-strain kernel formulas. */
export function effectiveNu(material: MaterialProperties): number {
  return material.planeKind === "strain"
    ? material.nu
    : material.nu / (1 + material.nu);
}

/** Shear modulus G = E / (2(1+ν)). */
export function shearModulus(material: MaterialProperties): number {
  return material.E / (2 * (1 + material.nu));
}

/**
 * Evaluate U* and T* at field point `f` with outward normal `n`,
 * collocation point `s`. Caller pre-computes G and effective ν.
 *
 * Throws nothing — at r = 0 (singular), returns Infinity/NaN values.
 * Callers must handle singular pairs separately (rigid-body trick for
 * H_diag, special quadrature for G_diag).
 */
export function kelvinKernels(
  s: Vec2,
  f: Vec2,
  n: Vec2,
  G: number,
  nu: number,
): KelvinKernels {
  const rx = f.x - s.x;
  const ry = f.y - s.y;
  const r2 = rx * rx + ry * ry;
  const r = Math.sqrt(r2);
  const drx = rx / r;
  const dry = ry / r;
  const drdn = drx * n.x + dry * n.y;

  const oneMinusNu = 1 - nu;
  const oneMinus2Nu = 1 - 2 * nu;
  const threeMinus4Nu = 3 - 4 * nu;

  const Ucoef = 1 / (8 * Math.PI * G * oneMinusNu);
  const lnInvR = -Math.log(r);

  const Uxx = Ucoef * (threeMinus4Nu * lnInvR + drx * drx);
  const Uyy = Ucoef * (threeMinus4Nu * lnInvR + dry * dry);
  const Uxy = Ucoef * (drx * dry);
  // U* is symmetric: U_xy = U_yx.

  const Tcoef = -1 / (4 * Math.PI * oneMinusNu * r);

  const dxxBracket = oneMinus2Nu + 2 * drx * drx;
  const dyyBracket = oneMinus2Nu + 2 * dry * dry;
  const dxyBracket = 2 * drx * dry;

  // T* is NOT symmetric in general. Sign convention cross-checked vs
  // Brebbia 1984 §5.7 and BE-SBFEM/BEMIntegration.m (Bird MATLAB):
  //   T_lk = -1/(4π(1-ν)r) · { (∂r/∂n)·[(1-2ν)δ_lk + 2 r,l r,k]
  //                             + (1-2ν)·(n_l r,k - n_k r,l) }
  // So the off-diagonal cross term uses + not -.
  const Txx = Tcoef * (dxxBracket * drdn);
  const Tyy = Tcoef * (dyyBracket * drdn);
  const Txy =
    Tcoef * (dxyBracket * drdn + oneMinus2Nu * (n.x * dry - n.y * drx));
  const Tyx =
    Tcoef * (dxyBracket * drdn + oneMinus2Nu * (n.y * drx - n.x * dry));

  return {
    U: [
      [Uxx, Uxy],
      [Uxy, Uyy],
    ],
    T: [
      [Txx, Txy],
      [Tyx, Tyy],
    ],
  };
}
