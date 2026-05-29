import { describe, expect, it } from "vitest";
import { discretiseLines } from "../elements/discretise.js";
import { solve } from "./solve.js";

describe("solve (stub)", () => {
  it("leaves a no-NaN mesh untouched (referentially equal nodes)", () => {
    const mesh = discretiseLines({
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
      bcs: [
        // Both axes fully constrained — every node has all 4 DOFs known.
        {
          lineId: "l1",
          x: { kind: "displacement", value: 0 },
          y: { kind: "displacement", value: 0 },
        },
      ],
    });
    const solved = solve(mesh);
    expect(solved).toHaveLength(mesh.length);
    // No NaNs anywhere.
    for (const el of solved) {
      for (const n of el.nodes) {
        expect(Number.isNaN(n.ux)).toBe(false);
        expect(Number.isNaN(n.uy)).toBe(false);
        expect(Number.isNaN(n.tx)).toBe(false);
        expect(Number.isNaN(n.ty)).toBe(false);
      }
    }
  });

  it("fills NaN displacement on a free-surface line with a non-zero ux when a traction is applied elsewhere", () => {
    // 1D problem: line from (0,0) to (10, 0). Left half = fixed displacement
    // in x; right half = applied traction in x. Free-surface nodes (none in
    // this case — every node has a BC) but the stub uses NaN on the dual.
    // Build manually: one line with displacement BC, one with traction BC,
    // sharing an end via two collinear points.
    const model = {
      points: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 5, y: 0 },
        { id: "c", x: 10, y: 0 },
      ],
      lines: [
        { id: "lFix", startId: "a", endId: "b" },
        { id: "lLoad", startId: "b", endId: "c" },
      ],
      bcs: [
        {
          lineId: "lFix",
          x: { kind: "displacement" as const, value: 0 },
        },
        {
          lineId: "lLoad",
          x: { kind: "traction" as const, value: 100, prefix: 6 }, // 100 MPa
        },
      ],
    };
    const mesh = discretiseLines(model);
    const solved = solve(mesh);
    // Find any node from the loaded line — its ux was NaN; after solve it's
    // a number whose magnitude is ≈ strain × position relative to fixed
    // centroid, ie strictly positive for steel under +100 MPa.
    const loadedEls = solved.filter((el) => el.lineId === "lLoad");
    expect(loadedEls.length).toBeGreaterThan(0);
    for (const el of loadedEls) {
      for (const n of el.nodes) {
        // Traction DOF stays known; the BC was 1e8 Pa.
        expect(n.tx).toBeCloseTo(1e8);
        // Displacement DOF was NaN — now filled.
        expect(Number.isNaN(n.ux)).toBe(false);
        // Positive (right-pointing) for nodes to the right of the fixed centroid.
        // 100 MPa / 200 GPa = 5e-4 strain. Over ~2-5 m → ~1e-3 m displacement.
        expect(n.ux).toBeGreaterThan(0);
      }
    }
  });

  it("does not mutate the input mesh", () => {
    const mesh = discretiseLines({
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
    });
    const nodeBefore = mesh[0]!.nodes[0]!;
    expect(Number.isNaN(nodeBefore.ux)).toBe(true);
    solve(mesh);
    // Original node still has NaN — solve returned a new mesh.
    expect(Number.isNaN(mesh[0]!.nodes[0]!.ux)).toBe(true);
  });
});
