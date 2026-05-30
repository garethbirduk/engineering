// Gauss-Legendre quadrature on [-1, +1].
//
// Roots and weights computed by Newton iteration on the Legendre polynomial,
// using the recurrence  j·P_j(x) = (2j-1)·x·P_{j-1}(x) − (j-1)·P_{j-2}(x).
// Ported from MATLAB GaussData.m (Bird). Works for both even and odd n.
//
// Exact for polynomials of degree ≤ 2n − 1.

// Tightened to ~machine epsilon. The MATLAB original used 3e-11, but the
// outermost roots sit very close to ±1, where the weight formula
// w = 2 / ((1 − z²) · P_n'(z)²) divides by a near-zero (1 − z²) and amplifies
// any residual root error. Newton converges quadratically, so a tighter
// tolerance adds at most one or two iterations.
const NEWTON_TOL = 1e-15;
const MAX_NEWTON_ITERS = 50;

export interface GaussRule {
  readonly nodes: readonly number[];
  readonly weights: readonly number[];
}

// Process-lifetime cache of fixed-order rules. Adaptive integration
// asks for the same handful of orders thousands of times per solve —
// we only ever want to compute each one once.
const RULE_CACHE = new Map<number, GaussRule>();

/** Cached variant of `gaussLegendre`. Returns the same rule object on
 *  repeated calls for the same `n`. */
export function cachedGaussLegendre(n: number): GaussRule {
  const hit = RULE_CACHE.get(n);
  if (hit) return hit;
  const rule = gaussLegendre(n);
  RULE_CACHE.set(n, rule);
  return rule;
}

/** Build the n-point Gauss-Legendre rule on [-1, +1]. */
export function gaussLegendre(n: number): GaussRule {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`gaussLegendre: n must be a positive integer, got ${n}`);
  }

  const xs = new Array<number>(n).fill(0);
  const ws = new Array<number>(n).fill(0);

  // Roots are symmetric about 0; only compute the half on [0, +1) then mirror.
  const half = Math.floor((n + 1) / 2);

  for (let i = 1; i <= half; i++) {
    // Initial guess for the i-th root of P_n.
    let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let zPrev = z + 1;
    let pp = 0;

    let iter = 0;
    while (Math.abs(z - zPrev) > NEWTON_TOL) {
      // Evaluate P_n(z) and its derivative via the standard recurrence.
      let p1 = 1;
      let p2 = 0;
      for (let j = 1; j <= n; j++) {
        const p3 = p2;
        p2 = p1;
        p1 = ((2 * j - 1) * z * p2 - (j - 1) * p3) / j;
      }
      // pp = P_n'(z); derived from (z² − 1)·P_n' = n·(z·P_n − P_{n−1}).
      pp = (n * (z * p1 - p2)) / (z * z - 1);
      zPrev = z;
      z = zPrev - p1 / pp;
      if (++iter > MAX_NEWTON_ITERS) {
        throw new Error(
          `gaussLegendre: Newton failed to converge for n=${n}, root index ${i}`,
        );
      }
    }

    // Symmetric pair (indices are 0-based here).
    const left = i - 1;
    const right = n - i;
    xs[left] = -z;
    xs[right] = z;
    const w = 2 / ((1 - z * z) * pp * pp);
    ws[left] = w;
    ws[right] = w;
  }

  return { nodes: xs, weights: ws };
}

/**
 * Integrate `f` over [-1, +1] with the n-point Gauss-Legendre rule.
 * Tiny convenience wrapper used by tests; production assembly will build the
 * rule once per integration and inline the loop.
 */
export function integrate(
  f: (eta: number) => number,
  n: number,
): number {
  const rule = gaussLegendre(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += rule.weights[i]! * f(rule.nodes[i]!);
  }
  return s;
}
