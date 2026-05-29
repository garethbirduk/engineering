// 2D direct-BEM stress fundamental solutions.
//
// Companion to kernels.ts (displacement kernels U*, T*). These are the
// stress equivalents D* and S* — obtained by differentiating U* / T*
// with respect to the source point and applying Hooke's law:
//
//   σ_ij(s) = ∫_Γ D*_kij(s,q) t_k(q) dΓ - ∫_Γ S*_kij(s,q) u_k(q) dΓ
//
// Plane-strain forms (Aliabadi 2002 §2.5, eqs 2.51 / 2.52):
//
//   D*_kij = 1 / (4π (1-ν) r) · {
//             (1-2ν) [ δ_kj r,i + δ_ki r,j - δ_ij r,k ]
//             + 2 r,i r,j r,k
//           }
//
//   S*_kij = G / (2π (1-ν) r²) · {
//             2 (∂r/∂n) [ (1-2ν) δ_ij r,k + ν (δ_ik r,j + δ_jk r,i) - 4 r,i r,j r,k ]
//             + 2ν (n_i r,j r,k + n_j r,i r,k)
//             + (1-2ν) (2 n_k r,i r,j + δ_ik n_j + δ_jk n_i)
//             - (1-4ν) δ_ij n_k
//           }
//
// Plane-stress is handled at the caller via `effectiveNu` (ν → ν/(1+ν))
// — the same substitution used by the displacement kernels.
//
// Singularity: at r = 0 these blow up as 1/r (D*) and 1/r² (S*). Callers
// must keep s away from Γ (interior post-process points are fine; we
// don't evaluate at BEM nodes themselves).

import type { Vec2 } from "../geometry/types.js";

/** σ tensor in 2D: three independent components (σ_xy = σ_yx). */
export interface StressTriple {
  readonly sxx: number;
  readonly syy: number;
  readonly sxy: number;
}

/**
 * Kelvin stress kernels at field point `f` (normal `n`) viewed from
 * collocation point `s`. Indexed by the LOAD direction k ∈ {x, y}:
 *   - D{x,y}: stress at s from a unit traction component t_k at f.
 *   - S{x,y}: stress at s from a unit displacement component u_k at f.
 */
export interface KelvinStressKernels {
  readonly Dx: StressTriple;
  readonly Dy: StressTriple;
  readonly Sx: StressTriple;
  readonly Sy: StressTriple;
}

export function kelvinStressKernels(
  s: Vec2,
  f: Vec2,
  n: Vec2,
  G: number,
  nu: number,
): KelvinStressKernels {
  const rx = f.x - s.x;
  const ry = f.y - s.y;
  const r2 = rx * rx + ry * ry;
  const r = Math.sqrt(r2);
  const drx = rx / r;
  const dry = ry / r;
  const drdn = drx * n.x + dry * n.y;

  const oneMinusNu = 1 - nu;
  const oneMinus2Nu = 1 - 2 * nu;
  const oneMinus4Nu = 1 - 4 * nu;

  const Dcoef = 1 / (4 * Math.PI * oneMinusNu * r);
  const Scoef = G / (2 * Math.PI * oneMinusNu * r2);

  // D*_kij — unrolled. See header for the index expansion.
  const Dx_xx = Dcoef * (oneMinus2Nu * drx + 2 * drx * drx * drx);
  const Dx_yy = Dcoef * drx * (-oneMinus2Nu + 2 * dry * dry);
  const Dx_xy = Dcoef * dry * (oneMinus2Nu + 2 * drx * drx);

  const Dy_xx = Dcoef * dry * (-oneMinus2Nu + 2 * drx * drx);
  const Dy_yy = Dcoef * (oneMinus2Nu * dry + 2 * dry * dry * dry);
  const Dy_xy = Dcoef * drx * (oneMinus2Nu + 2 * dry * dry);

  // S*_kij — done via a small helper to avoid arithmetic mistakes.
  // r-components indexed as (0=x, 1=y); pick the right one at runtime.
  const rOf = (idx: 0 | 1): number => (idx === 0 ? drx : dry);
  const nOf = (idx: 0 | 1): number => (idx === 0 ? n.x : n.y);
  const delta = (a: 0 | 1, b: 0 | 1): number => (a === b ? 1 : 0);

  const sComponent = (k: 0 | 1, i: 0 | 1, j: 0 | 1): number => {
    const ri = rOf(i);
    const rj = rOf(j);
    const rk = rOf(k);
    const ni = nOf(i);
    const nj = nOf(j);
    const nk = nOf(k);
    const dij = delta(i, j);
    const dik = delta(i, k);
    const djk = delta(j, k);

    const t1 =
      2 *
      drdn *
      (oneMinus2Nu * dij * rk + nu * (dik * rj + djk * ri) - 4 * ri * rj * rk);
    const t2 = 2 * nu * (ni * rj * rk + nj * ri * rk);
    const t3 = oneMinus2Nu * (2 * nk * ri * rj + dik * nj + djk * ni);
    const t4 = -oneMinus4Nu * dij * nk;

    return Scoef * (t1 + t2 + t3 + t4);
  };

  return {
    Dx: { sxx: Dx_xx, syy: Dx_yy, sxy: Dx_xy },
    Dy: { sxx: Dy_xx, syy: Dy_yy, sxy: Dy_xy },
    Sx: {
      sxx: sComponent(0, 0, 0),
      syy: sComponent(0, 1, 1),
      sxy: sComponent(0, 0, 1),
    },
    Sy: {
      sxx: sComponent(1, 0, 0),
      syy: sComponent(1, 1, 1),
      sxy: sComponent(1, 0, 1),
    },
  };
}
