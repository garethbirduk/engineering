// Telles (1987) cubic polynomial coordinate transformation for
// weakly-singular Gauss-Legendre integration.
//
// Reference: Telles JCF, "A self-adaptive co-ordinate transformation
// for efficient numerical evaluation of general boundary element
// integrals", IJNME 24 (1987).
//
// Given an integrand with a weak (log r, 1/√r) singularity at
// η = ηBar ∈ [-1, +1], the standard fix is to redistribute Gauss
// points toward ηBar via a cubic map γ(ξ) whose Jacobian vanishes
// cubically at the singularity. The new quadrature
//
//     ∫_{-1}^{+1} f(η) dη  ≈  Σ_q  f( γ(ξ_q) ) · J(ξ_q) · w_q
//
// then converges with a regular-order rule (typically 6–10 points)
// even though the integrand has a singularity in the original η frame.
//
// Strong (Cauchy, 1/r) singularities are *not* handled by Telles —
// for the diagonal H block we still use the rigid-body trick from
// assemble.ts. Telles is what fixes the G block (and the off-diagonal
// H block of the singular element).
//
// Ported from BE-SBFEM/Telles.m (Bird PhD code).

import { gaussLegendre, type GaussRule } from "./gaussLegendre.js";

/** A Telles-transformed quadrature rule: same length as the input
 *  Gauss rule, with the points shifted toward `etaBar` and weights
 *  pre-multiplied by the Telles Jacobian. */
export interface TellesRule {
  /** Transformed integration coordinates γ(ξ_q) ∈ [-1, +1]. */
  readonly nodes: readonly number[];
  /** Effective weights w_q · J(ξ_q) — drop them into the same loop
   *  body you'd use for plain Gauss-Legendre. */
  readonly weights: readonly number[];
}

/**
 * Build a Telles-transformed quadrature rule of `n` points clustered
 * around `etaBar ∈ [-1, +1]`. The returned rule is consumed exactly
 * like a `GaussRule` — sum f(node_q) · weight_q over q.
 */
export function tellesRule(n: number, etaBar: number): TellesRule {
  const base: GaussRule = gaussLegendre(n);
  return tellesTransform(base, etaBar);
}

/**
 * Transform an existing Gauss-Legendre rule by Telles' cubic map
 * concentrating points around `etaBar`. Useful when you've already
 * built the base rule for some other purpose.
 */
export function tellesTransform(
  base: GaussRule,
  etaBar: number,
): TellesRule {
  // Clamp ηBar to [-1, +1] — caller normally passes one of the
  // element's node η coords so this is just defensive.
  const e = Math.max(-1, Math.min(1, etaBar));

  // γ̄ — the "preimage of the singularity" in the transformed
  // coordinate; chosen so γ(γ̄) = ηBar. The standard Telles formula:
  //   η* = η̄² − 1
  //   F  = sgn(η̄·η* + |η*|) · |η̄·η* + |η*||^{1/3}
  //   G  = sgn(η̄·η* − |η*|) · |η̄·η* − |η*||^{1/3}
  //   γ̄  = F + G + η̄
  const etaStar = e * e - 1;
  const absEtaStar = Math.abs(etaStar);
  const Fraw = e * etaStar + absEtaStar;
  const Graw = e * etaStar - absEtaStar;
  const F = Math.sign(Fraw) * Math.pow(Math.abs(Fraw), 1 / 3);
  const G = Math.sign(Graw) * Math.pow(Math.abs(Graw), 1 / 3);
  const gammaBar = F + G + e;

  // Per the Telles transformation:
  //   η(γ) = [ (γ − γ̄)³ + γ̄·(γ̄² + 3) ] / (1 + 3·γ̄²)
  //   J(γ) = dη/dγ = 3·(γ − γ̄)² / (1 + 3·γ̄²)
  // (the (γ − γ̄)² term in the Jacobian is the "JT correction" — the
  // original 1987 paper has a typo here; see notes in BE-SBFEM/Telles.m).
  const denom = 1 + 3 * gammaBar * gammaBar;
  const B = gammaBar * (gammaBar * gammaBar + 3);

  const nodes: number[] = new Array(base.nodes.length);
  const weights: number[] = new Array(base.nodes.length);
  for (let q = 0; q < base.nodes.length; q++) {
    const gamma = base.nodes[q]!;
    const dg = gamma - gammaBar;
    const A = dg * dg * dg;
    const J = (3 * dg * dg) / denom;
    nodes[q] = (A + B) / denom;
    weights[q] = base.weights[q]! * J;
  }
  return { nodes, weights };
}
