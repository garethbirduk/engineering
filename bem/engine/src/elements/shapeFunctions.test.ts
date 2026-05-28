import { describe, expect, it } from "vitest";
import {
  STANDARD_NODES,
  shapeFunctionDerivatives,
  shapeFunctions,
  type LocalNodes,
} from "./shapeFunctions.js";

const TOL = 1e-12;

function expectClose(a: number, b: number, tol = TOL): void {
  expect(Math.abs(a - b)).toBeLessThan(tol);
}

describe("shapeFunctions — algebraic properties", () => {
  const configs: { name: string; nodes: LocalNodes }[] = [
    { name: "continuous", nodes: STANDARD_NODES.continuous },
    { name: "discontinuous", nodes: STANDARD_NODES.discontinuous },
    { name: "semiDiscontinuous1", nodes: STANDARD_NODES.semiDiscontinuous1 },
    { name: "semiDiscontinuous2", nodes: STANDARD_NODES.semiDiscontinuous2 },
    { name: "irregular", nodes: [-0.7, 0.1, 0.92] },
  ];

  for (const { name, nodes } of configs) {
    describe(name, () => {
      it("Kronecker delta at nodes: N_k(η_j) = δ_kj", () => {
        for (let j = 0; j < 3; j++) {
          const eta = nodes[j];
          if (eta === undefined) throw new Error("unreachable");
          const N = shapeFunctions(eta, nodes);
          for (let k = 0; k < 3; k++) {
            expectClose(N[k]!, k === j ? 1 : 0);
          }
        }
      });

      it("partition of unity: ΣN_k(η) = 1 for any η", () => {
        for (const eta of [-1, -0.5, -0.123, 0, 0.4, 0.789, 1]) {
          const N = shapeFunctions(eta, nodes);
          expectClose(N[0] + N[1] + N[2], 1);
        }
      });

      it("derivatives sum to zero (translation invariance)", () => {
        for (const eta of [-1, -0.4, 0, 0.4, 1]) {
          const dN = shapeFunctionDerivatives(eta, nodes);
          expectClose(dN[0] + dN[1] + dN[2], 0);
        }
      });

      it("Σ η_k · dN_k/dη = 1 (linear field reproduced exactly)", () => {
        for (const eta of [-1, -0.3, 0, 0.7, 1]) {
          const dN = shapeFunctionDerivatives(eta, nodes);
          const sum = nodes[0] * dN[0] + nodes[1] * dN[1] + nodes[2] * dN[2];
          expectClose(sum, 1);
        }
      });
    });
  }
});

describe("shapeFunctions — known closed forms", () => {
  it("continuous {-1, 0, 1}: matches standard FEM quadratic basis", () => {
    // N_1 = η(η-1)/2, N_2 = 1 - η², N_3 = η(η+1)/2
    for (const eta of [-1, -0.5, 0, 0.25, 0.8, 1]) {
      const N = shapeFunctions(eta, STANDARD_NODES.continuous);
      expectClose(N[0], (eta * (eta - 1)) / 2);
      expectClose(N[1], 1 - eta * eta);
      expectClose(N[2], (eta * (eta + 1)) / 2);
    }
  });

  it("derivatives of continuous basis at η = 0", () => {
    // dN_1/dη = (2η-1)/2 → -1/2 at η=0
    // dN_2/dη = -2η      →  0   at η=0
    // dN_3/dη = (2η+1)/2 → +1/2 at η=0
    const dN = shapeFunctionDerivatives(0, STANDARD_NODES.continuous);
    expectClose(dN[0], -0.5);
    expectClose(dN[1], 0);
    expectClose(dN[2], 0.5);
  });
});
