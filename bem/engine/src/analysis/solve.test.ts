import { describe, expect, it } from "vitest";
import { discretiseLines } from "../elements/discretise.js";
import { solve } from "./solve.js";

describe("solve (BEM)", () => {
  it("leaves a no-NaN mesh untouched values-wise (every DOF known a priori)", () => {
    // Closed square with BOTH axes constrained on every edge → every DOF
    // is "known" → no unknowns → no system to solve.
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
        { id: "p3", x: 1, y: 1 },
        { id: "p4", x: 0, y: 1 },
      ],
      lines: [
        { id: "l1", startId: "p1", endId: "p2" },
        { id: "l2", startId: "p2", endId: "p3" },
        { id: "l3", startId: "p3", endId: "p4" },
        { id: "l4", startId: "p4", endId: "p1" },
      ],
      bcs: [
        {
          lineId: "l1",
          x: { kind: "displacement" as const, value: 0 },
          y: { kind: "displacement" as const, value: 0 },
        },
        {
          lineId: "l2",
          x: { kind: "displacement" as const, value: 0 },
          y: { kind: "displacement" as const, value: 0 },
        },
        {
          lineId: "l3",
          x: { kind: "displacement" as const, value: 0 },
          y: { kind: "displacement" as const, value: 0 },
        },
        {
          lineId: "l4",
          x: { kind: "displacement" as const, value: 0 },
          y: { kind: "displacement" as const, value: 0 },
        },
      ],
    };
    const mesh = discretiseLines(model);
    const solved = solve(mesh);
    expect(solved).toHaveLength(mesh.length);
    for (const el of solved) {
      for (const n of el.nodes) {
        expect(Number.isNaN(n.ux)).toBe(false);
        expect(Number.isNaN(n.uy)).toBe(false);
        expect(Number.isNaN(n.tx)).toBe(false);
        expect(Number.isNaN(n.ty)).toBe(false);
      }
    }
  });

  it("does not mutate the input mesh", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
        { id: "p3", x: 1, y: 1 },
        { id: "p4", x: 0, y: 1 },
      ],
      lines: [
        { id: "l1", startId: "p1", endId: "p2" },
        { id: "l2", startId: "p2", endId: "p3" },
        { id: "l3", startId: "p3", endId: "p4" },
        { id: "l4", startId: "p4", endId: "p1" },
      ],
    };
    const mesh = discretiseLines(model);
    const nodeBefore = mesh[0]!.nodes[0]!;
    // Free-surface default: tx, ty known (=0); ux, uy NaN.
    expect(Number.isNaN(nodeBefore.ux)).toBe(true);
    solve(mesh);
    // Input still has NaN — solve returned a new mesh.
    expect(Number.isNaN(mesh[0]!.nodes[0]!.ux)).toBe(true);
  });

  it("uniaxial tension on a 6×4 plate — right edge stretches by ≈ σL/E", () => {
    // Plate 6 wide × 4 tall, left edge fixed in x, bottom edge fixed in
    // y, right edge pulled with 100 MPa traction in +x, top edge free.
    // Plane stress, E = 200 GPa, ν = 0.3. Analytical:
    //   ε_x = σ / E   → ux at right edge = (100e6 / 200e9) × 6 = 3e-3 m
    //   ε_y = -ν σ / E → uy at top edge = -(0.3 × 100e6 / 200e9) × 4 = -6e-4 m
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 6, y: 0 },
        { id: "p3", x: 6, y: 4 },
        { id: "p4", x: 0, y: 4 },
      ],
      lines: [
        { id: "lB", startId: "p1", endId: "p2" },
        { id: "lR", startId: "p2", endId: "p3" },
        { id: "lT", startId: "p3", endId: "p4" },
        { id: "lL", startId: "p4", endId: "p1" },
      ],
      bcs: [
        // Left: fixed in x; y free (uy unknown, ty=0 free).
        { lineId: "lL", x: { kind: "displacement" as const, value: 0 } },
        // Bottom: fixed in y; x free.
        { lineId: "lB", y: { kind: "displacement" as const, value: 0 } },
        // Right: 100 MPa pulling in +x; y free.
        {
          lineId: "lR",
          x: { kind: "traction" as const, value: 100, prefix: 6 },
        },
        // Top: free (default tx=ty=0).
      ],
      meshing: [
        { lineId: "lL", elementsPerLine: 4 },
        { lineId: "lB", elementsPerLine: 6 },
        { lineId: "lR", elementsPerLine: 4 },
        { lineId: "lT", elementsPerLine: 6 },
      ],
    };
    const mesh = discretiseLines(model);
    const solved = solve(mesh);

    // Pluck the right-edge nodes (x ≈ 6) and verify ux ≈ 3e-3 m.
    const rightNodes: number[] = [];
    for (const el of solved) {
      if (el.lineId !== "lR") continue;
      for (const n of el.nodes) {
        if (Math.abs(n.x - 6) < 1e-6) rightNodes.push(n.ux);
      }
    }
    expect(rightNodes.length).toBeGreaterThan(0);
    const meanUxRight =
      rightNodes.reduce((a, b) => a + b, 0) / rightNodes.length;
    // Plane-stress uniaxial analytical: ux = σL/E = 3e-3. Tight tol —
    // BEM with 4-6 elements per edge converges well for this problem.
    expect(meanUxRight).toBeCloseTo(3e-3, 4);

    // Top-edge nodes should have uy ≈ -6e-4 (Poisson contraction).
    const topNodes: number[] = [];
    for (const el of solved) {
      if (el.lineId !== "lT") continue;
      for (const n of el.nodes) {
        if (Math.abs(n.y - 4) < 1e-6) topNodes.push(n.uy);
      }
    }
    expect(topNodes.length).toBeGreaterThan(0);
    const meanUyTop = topNodes.reduce((a, b) => a + b, 0) / topNodes.length;
    expect(meanUyTop).toBeCloseTo(-6e-4, 5);
  });
});
