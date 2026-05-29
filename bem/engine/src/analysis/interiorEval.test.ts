import { describe, expect, it } from "vitest";
import { discretiseLines } from "../elements/discretise.js";
import { solve } from "./solve.js";
import { interiorDisplacement } from "./interiorEval.js";

describe("interiorDisplacement (Somigliana)", () => {
  it("interior point of a uniaxially loaded plate matches the analytical ε_x · x", () => {
    // 6×4 plate, plane stress, left edge ux=0, bottom uy=0, right edge
    // tx=100 MPa. Analytical strain field: ε_x = σ/E = 5e-4, so the
    // interior displacement at any point (x, y) is
    //   u_x(x, y) = ε_x · x  =  5e-4 · x
    //   u_y(x, y) = -ν ε_x · y  =  -1.5e-4 · y
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
        { lineId: "lL", x: { kind: "displacement" as const, value: 0 } },
        { lineId: "lB", y: { kind: "displacement" as const, value: 0 } },
        {
          lineId: "lR",
          x: { kind: "traction" as const, value: 100, prefix: 6 },
        },
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
    // Pick a point comfortably inside the plate (not near any boundary).
    const p = { x: 3, y: 2 };
    const u = interiorDisplacement(p, solved, {
      E: 200e9,
      nu: 0.3,
      planeKind: "stress",
    });
    // Analytical: u_x = 5e-4 · 3 = 1.5e-3, u_y = -1.5e-4 · 2 = -3e-4
    expect(u.x).toBeCloseTo(1.5e-3, 5);
    expect(u.y).toBeCloseTo(-3e-4, 6);
  });
});
