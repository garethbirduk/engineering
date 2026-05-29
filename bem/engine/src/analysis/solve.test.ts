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

  it("continuous-node corner BCs are MERGED, not first-wins (bottom uy=0 + right tx=100 → corner uy=0)", () => {
    // Bug repro: with localNodes = [-1, 0, +1] every edge's η=±1 node
    // sits AT a corner Point, so adjacent edges' corner mesh nodes
    // share a world position and get deduped to one global index.
    // Pre-fix, only the FIRST encountered side's DOFs were kept; the
    // bottom edge's uy=0 was silently dropped at (6, 0) when the right
    // edge was iterated first → corner uy ended up non-zero.
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 6, y: 0 },
        { id: "p3", x: 6, y: 4 },
        { id: "p4", x: 0, y: 4 },
      ],
      // Lines deliberately ordered so lR comes BEFORE lB (the order
      // that triggered the original bug — lR's corner node at (6, 0)
      // gets registered first, lB's overlapping node was dropped).
      lines: [
        { id: "lL", startId: "p4", endId: "p1" },
        { id: "lT", startId: "p3", endId: "p4" },
        { id: "lR", startId: "p2", endId: "p3" },
        { id: "lB", startId: "p1", endId: "p2" },
      ],
      bcs: [
        { lineId: "lL", x: { kind: "displacement" as const, value: 0 } },
        { lineId: "lB", y: { kind: "displacement" as const, value: 0 } },
        {
          lineId: "lR",
          x: { kind: "traction" as const, value: 100, prefix: 6 },
        },
      ],
      // Continuous nodes everywhere — corner η=±1 nodes coincide.
      meshing: [
        { lineId: "lL", localNodes: [-1, 0, 1] as const },
        { lineId: "lT", localNodes: [-1, 0, 1] as const },
        { lineId: "lR", localNodes: [-1, 0, 1] as const },
        { lineId: "lB", localNodes: [-1, 0, 1] as const },
      ],
    };
    const mesh = discretiseLines(model);
    const solved = solve(mesh);

    // Bottom-right corner (6, 0) must end up with uy = 0 (the merged
    // BC). Pre-fix this came back as ~5e-4 (non-zero, wrongly free).
    const cornerNodes: typeof mesh[number]["nodes"][number][] = [];
    for (const el of solved) {
      for (const n of el.nodes) {
        if (Math.abs(n.x - 6) < 1e-6 && Math.abs(n.y) < 1e-6) cornerNodes.push(n);
      }
    }
    expect(cornerNodes.length).toBeGreaterThan(0);
    for (const n of cornerNodes) {
      expect(n.uy).toBeCloseTo(0, 8);
    }
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
    // Pin material to the values the analytical solution was derived with.
    const solved = solve(mesh, { E: 200e9, nu: 0.3, planeKind: "stress" });

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

  it("corner BC merge — continuous scheme picks the non-zero traction at every corner of a biaxial plate", async () => {
    // Reproduces the plate-no-hole biaxial setup from
    // examples/plate no hole.json:
    //   left dx = 0
    //   bottom dy = 0
    //   right tx = 100 GPa
    //   top ty = 100 GPa
    // Continuous scheme (η = -1, 0, +1) on every line means every plate
    // corner is one shared collocation node. The merge has to keep the
    // applied load at each corner, not the "default-free zero" from the
    // adjacent face. This test asserts the MERGED nodal BCs directly via
    // assembleHG.
    //
    // Note: continuous scheme still has an inherent corner-traction-
    // discontinuity error in the final solve (both adjacent edge
    // integrations see the same nodal tractions, even though physically
    // they should see different vectors). The convergence test below
    // shows the discontinuous scheme — the recommended fix — converging
    // to the analytical answer.
    const { assembleHG } = await import("./assemble.js");
    const model = {
      points: [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 0, y: 8 },
        { id: "C", x: 8, y: 8 },
        { id: "D", x: 8, y: 0 },
      ],
      lines: [
        { id: "lL", startId: "B", endId: "A" }, // left, B→A
        { id: "lT", startId: "C", endId: "B" }, // top, C→B
        { id: "lR", startId: "D", endId: "C" }, // right, D→C
        { id: "lB", startId: "A", endId: "D" }, // bottom, A→D
      ],
      bcs: [
        { lineId: "lL", x: { kind: "displacement" as const, value: 0 } },
        { lineId: "lB", y: { kind: "displacement" as const, value: 0 } },
        {
          lineId: "lR",
          x: { kind: "traction" as const, value: 100, prefix: 9 },
        },
        {
          lineId: "lT",
          y: { kind: "traction" as const, value: 100, prefix: 9 },
        },
      ],
      meshing: [
        {
          lineId: "lL",
          elementsPerLine: 1,
          localNodes: [-1, 0, 1] as [number, number, number],
        },
        {
          lineId: "lT",
          elementsPerLine: 1,
          localNodes: [-1, 0, 1] as [number, number, number],
        },
        {
          lineId: "lR",
          elementsPerLine: 1,
          localNodes: [-1, 0, 1] as [number, number, number],
        },
        {
          lineId: "lB",
          elementsPerLine: 1,
          localNodes: [-1, 0, 1] as [number, number, number],
        },
      ],
    };
    const mesh = discretiseLines(model);
    const sys = assembleHG(mesh, {
      E: 207e9,
      nu: 0.3,
      planeKind: "stress",
    });

    const findCorner = (x: number, y: number) => {
      for (const n of sys.nodesByIndex) {
        if (Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6) return n;
      }
      throw new Error(`corner (${x}, ${y}) not found`);
    };

    const A = findCorner(0, 0); // bottom-left, both anchored
    const B = findCorner(0, 8); // top-left, left dx=0 + top ty=100
    const C = findCorner(8, 8); // top-right, right tx=100 + top ty=100
    const D = findCorner(8, 0); // bottom-right, right tx=100 + bottom dy=0

    // A: dx=0 from left + dy=0 from bottom; both tractions become reactions.
    expect(A.ux).toBe(0);
    expect(A.uy).toBe(0);
    expect(Number.isNaN(A.tx)).toBe(true);
    expect(Number.isNaN(A.ty)).toBe(true);

    // B: left's dx=0 wins for x; top's ty=100 GPa wins over left's default ty=0.
    expect(B.ux).toBe(0);
    expect(Number.isNaN(B.uy)).toBe(true);
    expect(Number.isNaN(B.tx)).toBe(true); // dropped (displacement-wins cleanup)
    expect(B.ty).toBeCloseTo(100e9, -7);

    // C: right's tx=100 GPa wins over top's default tx=0; top's ty=100 GPa
    // wins over right's default ty=0.
    expect(Number.isNaN(C.ux)).toBe(true);
    expect(Number.isNaN(C.uy)).toBe(true);
    expect(C.tx).toBeCloseTo(100e9, -7);
    expect(C.ty).toBeCloseTo(100e9, -7);

    // D: right's tx=100 GPa wins over bottom's default tx=0; bottom's dy=0
    // wins over right's default ty=0 (displacement-wins).
    expect(Number.isNaN(D.ux)).toBe(true);
    expect(D.uy).toBe(0);
    expect(D.tx).toBeCloseTo(100e9, -7);
    expect(Number.isNaN(D.ty)).toBe(true);
  });

  it("biaxial tension on an 8×8 plate, discontinuous scheme — analytical match", () => {
    // Same plate / loading as the merge test above, but with the
    // discontinuous scheme (the engine default, η = ±2/3, 0). Corners
    // are no longer collocation points so the corner-traction
    // discontinuity is sidestepped naturally and BEM converges cleanly
    // to the analytical answer.
    //
    // Plane stress, E = 207 GPa, ν = 0.3. Analytical biaxial:
    //   ε_xx = (σ_xx − ν σ_yy) / E = (100 − 30) / 207 GPa
    //   u_x at right (x=8) = ε_xx · 8 = 560/207 ≈ 2.7053
    //   u_y at top (y=8)  = same by symmetry
    const model = {
      points: [
        { id: "A", x: 0, y: 0 },
        { id: "B", x: 0, y: 8 },
        { id: "C", x: 8, y: 8 },
        { id: "D", x: 8, y: 0 },
      ],
      lines: [
        { id: "lL", startId: "B", endId: "A" }, // left, B→A
        { id: "lT", startId: "C", endId: "B" }, // top, C→B
        { id: "lR", startId: "D", endId: "C" }, // right, D→C
        { id: "lB", startId: "A", endId: "D" }, // bottom, A→D
      ],
      bcs: [
        { lineId: "lL", x: { kind: "displacement" as const, value: 0 } },
        { lineId: "lB", y: { kind: "displacement" as const, value: 0 } },
        {
          lineId: "lR",
          x: { kind: "traction" as const, value: 100, prefix: 9 },
        },
        {
          lineId: "lT",
          y: { kind: "traction" as const, value: 100, prefix: 9 },
        },
      ],
      meshing: [
        { lineId: "lL", elementsPerLine: 4 },
        { lineId: "lT", elementsPerLine: 4 },
        { lineId: "lR", elementsPerLine: 4 },
        { lineId: "lB", elementsPerLine: 4 },
      ],
    };
    const mesh = discretiseLines(model);
    const solved = solve(mesh, { E: 207e9, nu: 0.3, planeKind: "stress" });

    const expectedU = (8 * 70) / 207; // ≈ 2.7053

    // Pull the right-edge ux values — should all be ≈ expectedU, with
    // a tight range across the edge.
    const rightUx: number[] = [];
    for (const el of solved) {
      if (el.lineId !== "lR") continue;
      for (const n of el.nodes) {
        if (Math.abs(n.x - 8) < 1e-6) rightUx.push(n.ux);
      }
    }
    expect(rightUx.length).toBeGreaterThan(0);
    for (const ux of rightUx) {
      expect(ux).toBeCloseTo(expectedU, 2);
    }

    // Same check on the top edge — uy should be uniform ≈ expectedU.
    const topUy: number[] = [];
    for (const el of solved) {
      if (el.lineId !== "lT") continue;
      for (const n of el.nodes) {
        if (Math.abs(n.y - 8) < 1e-6) topUy.push(n.uy);
      }
    }
    expect(topUy.length).toBeGreaterThan(0);
    for (const uy of topUy) {
      expect(uy).toBeCloseTo(expectedU, 2);
    }
  });
});
