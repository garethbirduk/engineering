import { describe, expect, it } from "vitest";
import { gaussLegendre, integrate } from "./gaussLegendre.js";

const TOL = 1e-12;

function expectClose(a: number, b: number, tol = TOL): void {
  expect(Math.abs(a - b)).toBeLessThan(tol);
}

describe("gaussLegendre — known rules", () => {
  it("n = 1: node 0, weight 2", () => {
    const r = gaussLegendre(1);
    expect(r.nodes).toEqual([0]);
    expect(r.weights).toEqual([2]);
  });

  it("n = 2: nodes ±1/√3, weights 1, 1", () => {
    const r = gaussLegendre(2);
    const x = 1 / Math.sqrt(3);
    expectClose(r.nodes[0]!, -x);
    expectClose(r.nodes[1]!, +x);
    expectClose(r.weights[0]!, 1);
    expectClose(r.weights[1]!, 1);
  });

  it("n = 3: nodes 0, ±√(3/5), weights 8/9, 5/9", () => {
    const r = gaussLegendre(3);
    const x = Math.sqrt(3 / 5);
    expectClose(r.nodes[0]!, -x);
    expectClose(r.nodes[1]!, 0);
    expectClose(r.nodes[2]!, +x);
    expectClose(r.weights[0]!, 5 / 9);
    expectClose(r.weights[1]!, 8 / 9);
    expectClose(r.weights[2]!, 5 / 9);
  });

  it("nodes and weights are symmetric about 0", () => {
    for (const n of [4, 5, 7, 10, 16]) {
      const r = gaussLegendre(n);
      for (let i = 0; i < n; i++) {
        expectClose(r.nodes[i]!, -r.nodes[n - 1 - i]!);
        expectClose(r.weights[i]!, r.weights[n - 1 - i]!);
      }
    }
  });

  it("weights sum to 2 (integrates the constant 1)", () => {
    for (const n of [1, 2, 5, 10, 25]) {
      const r = gaussLegendre(n);
      const s = r.weights.reduce((acc, w) => acc + w, 0);
      expectClose(s, 2);
    }
  });
});

describe("integrate — polynomial exactness", () => {
  // Gauss-Legendre with n points integrates polynomials of degree ≤ 2n−1 exactly.
  // ∫_{-1}^{1} x^k dx = 0 for k odd, 2/(k+1) for k even.
  it.each([
    [0, 1, 2],
    [1, 1, 0],
    [2, 2, 2 / 3],
    [3, 2, 0],
    [4, 3, 2 / 5],
    [5, 3, 0],
    [6, 4, 2 / 7],
    [7, 4, 0],
    [10, 6, 2 / 11],
  ])("∫ x^%i dx with n=%i = %f", (k, n, expected) => {
    const result = integrate((x) => Math.pow(x, k), n);
    expectClose(result, expected);
  });

  it("integrates a non-polynomial (cos) to expected precision", () => {
    // ∫_{-1}^{1} cos x dx = 2 sin 1
    const expected = 2 * Math.sin(1);
    // With n = 10 we expect double precision.
    const result = integrate(Math.cos, 10);
    expectClose(result, expected, 1e-13);
  });
});

describe("gaussLegendre — input validation", () => {
  it.each([0, -1, 1.5, NaN])("rejects n = %s", (n) => {
    expect(() => gaussLegendre(n)).toThrow();
  });
});
