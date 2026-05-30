import { describe, expect, it } from "vitest";
import { gaussLegendre } from "./gaussLegendre.js";
import { tellesRule } from "./telles.js";

describe("Telles transformation", () => {
  // Integrand with a known log singularity at η = ηBar:
  //   f(η) = ln |η − ηBar|
  // Analytical: ∫_{-1}^{+1} ln|η − ηBar| dη
  //           = (1 − ηBar)·ln(1 − ηBar) + (1 + ηBar)·ln(1 + ηBar) − 2
  function analytical(etaBar: number): number {
    const a = 1 - etaBar;
    const b = 1 + etaBar;
    // Handle ηBar = ±1 — one log term goes to 0·(-Inf), limit is 0.
    const aTerm = a === 0 ? 0 : a * Math.log(a);
    const bTerm = b === 0 ? 0 : b * Math.log(b);
    return aTerm + bTerm - 2;
  }

  function integrateLog(rule: { nodes: readonly number[]; weights: readonly number[] }, etaBar: number): number {
    let s = 0;
    for (let q = 0; q < rule.nodes.length; q++) {
      const eta = rule.nodes[q]!;
      const arg = Math.abs(eta - etaBar);
      // Skip if exactly on the singularity (shouldn't happen with Telles).
      if (arg === 0) continue;
      s += rule.weights[q]! * Math.log(arg);
    }
    return s;
  }

  it("beats plain Gauss-Legendre on the log integral with an ENDPOINT singularity (BEM continuous-scheme corner case)", () => {
    // Corner case: singularity sits exactly at an element endpoint.
    // This is the dominant BEM scenario — the self-collocation point
    // is at η = ±1 (continuous) or η = ±2/3 (discontinuous, also
    // close to an endpoint). Telles is designed for this; plain GL
    // crawls because every point sits the "wrong" side of the log.
    const etaBar = 1;
    const exact = analytical(etaBar); // = -2·ln(2) ≈ -1.3863
    const plain = integrateLog(gaussLegendre(10), etaBar);
    const telles = integrateLog(tellesRule(10, etaBar), etaBar);
    const plainErr = Math.abs(plain - exact);
    const tellesErr = Math.abs(telles - exact);
    expect(tellesErr).toBeLessThan(plainErr / 100);
    expect(tellesErr).toBeLessThan(1e-4);
  });

  it("converges quickly when refined (endpoint case)", () => {
    const etaBar = 1;
    const exact = analytical(etaBar);
    const e8 = Math.abs(integrateLog(tellesRule(8, etaBar), etaBar) - exact);
    const e16 = Math.abs(integrateLog(tellesRule(16, etaBar), etaBar) - exact);
    // Telles convergence is geometric in n for endpoint log
    // singularities — doubling n should give >10× error reduction.
    expect(e16).toBeLessThan(e8 / 10);
  });

  it("handles ηBar at an endpoint (±1)", () => {
    for (const etaBar of [-1, +1]) {
      const exact = analytical(etaBar);
      const telles = integrateLog(tellesRule(10, etaBar), etaBar);
      expect(telles).toBeCloseTo(exact, 4);
    }
  });

  it("preserves the integral of a smooth (non-singular) function", () => {
    // Telles is exact for cubics by construction (it's a cubic map of
    // a polynomial-exact rule). Test that ∫ cos(η) dη ≈ 2·sin(1) survives.
    const exact = 2 * Math.sin(1);
    const telles = (() => {
      const r = tellesRule(10, 0.5);
      let s = 0;
      for (let q = 0; q < r.nodes.length; q++) {
        s += r.weights[q]! * Math.cos(r.nodes[q]!);
      }
      return s;
    })();
    expect(telles).toBeCloseTo(exact, 6);
  });
});
