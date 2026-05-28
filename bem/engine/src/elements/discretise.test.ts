import { describe, expect, it } from "vitest";
import { discretiseLines } from "./discretise.js";

describe("discretiseLines", () => {
  it("straight line: 2 quadratic elements with 3 nodes at ±2/3, 0 give uniform spacing", () => {
    // Line length 12 → 6 nodes uniformly at 1, 3, 5, 7, 9, 11.
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 12, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
    };
    const els = discretiseLines(model);
    expect(els).toHaveLength(2);

    expect(els[0]!.lineId).toBe("l1");
    expect(els[0]!.indexInLine).toBe(0);
    expect(els[0]!.tStart).toBe(0);
    expect(els[0]!.tEnd).toBe(0.5);
    expect(els[0]!.nodes[0]).toEqual({ x: 1, y: 0 });
    expect(els[0]!.nodes[1]).toEqual({ x: 3, y: 0 });
    expect(els[0]!.nodes[2]).toEqual({ x: 5, y: 0 });

    expect(els[1]!.nodes[0]).toEqual({ x: 7, y: 0 });
    expect(els[1]!.nodes[1]).toEqual({ x: 9, y: 0 });
    expect(els[1]!.nodes[2]).toEqual({ x: 11, y: 0 });

    // Uniform spacing including across element boundary.
    const xs = [
      els[0]!.nodes[0]!.x,
      els[0]!.nodes[1]!.x,
      els[0]!.nodes[2]!.x,
      els[1]!.nodes[0]!.x,
      els[1]!.nodes[1]!.x,
      els[1]!.nodes[2]!.x,
    ];
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBeCloseTo(2);
    }
  });

  it("skips lines whose referenced points don't exist", () => {
    const model = {
      points: [{ id: "p1", x: 0, y: 0 }],
      lines: [{ id: "l1", startId: "p1", endId: "missing" }],
    };
    expect(discretiseLines(model)).toEqual([]);
  });

  it("honours custom elementsPerLine + localNodes", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
    };
    const els = discretiseLines(model, {
      elementsPerLine: 1,
      localNodes: [-1, 0, 1],
    });
    expect(els).toHaveLength(1);
    expect(els[0]!.nodes[0]).toEqual({ x: 0, y: 0 });
    expect(els[0]!.nodes[1]).toEqual({ x: 0.5, y: 0 });
    expect(els[0]!.nodes[2]).toEqual({ x: 1, y: 0 });
  });

  it("per-line override in model.meshing wins over global opts", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
        { id: "p3", x: 1, y: 1 },
        { id: "p4", x: 0, y: 1 },
      ],
      lines: [
        { id: "l1", startId: "p1", endId: "p2" },
        { id: "l2", startId: "p3", endId: "p4" },
      ],
      meshing: [
        // l1 keeps defaults; l2 gets 1 element with continuous nodes.
        { lineId: "l2", elementsPerLine: 1, localNodes: [-1, 0, 1] as const },
      ],
    };
    const els = discretiseLines(model);
    const l1Els = els.filter((e) => e.lineId === "l1");
    const l2Els = els.filter((e) => e.lineId === "l2");
    expect(l1Els).toHaveLength(2);
    expect(l1Els[0]!.localNodes).toEqual([-2 / 3, 0, 2 / 3]);
    expect(l2Els).toHaveLength(1);
    expect(l2Els[0]!.localNodes).toEqual([-1, 0, 1]);
    // l2's continuous nodes hit the line endpoints (±1 mapped to t=0, t=1).
    expect(l2Els[0]!.nodes[0]).toEqual({ x: 1, y: 1 });
    expect(l2Els[0]!.nodes[2]).toEqual({ x: 0, y: 1 });
  });

  it("MeshElement carries nodeTs that match the localNodes", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
    };
    const els = discretiseLines(model);
    // Element 0 covers [0, 0.5]; nodes at η = -2/3, 0, +2/3.
    // η = -2/3 → local 1/6 → t = 1/12; η = 0 → t = 0.25; η = 2/3 → t = 5/12.
    expect(els[0]!.nodeTs[0]).toBeCloseTo(1 / 12);
    expect(els[0]!.nodeTs[1]).toBeCloseTo(0.25);
    expect(els[0]!.nodeTs[2]).toBeCloseTo(5 / 12);
  });

  it("arc: nodes sit on the arc, not the chord", () => {
    // Quarter-circle arc radius √2 from (1, 0) to (0, 1) around (0, 0).
    // Midpoint of the arc (t = 0.5) should be at (cos 45°, sin 45°).
    const model = {
      points: [
        { id: "p1", x: 1, y: 0 },
        { id: "p2", x: 0, y: 1 },
        { id: "c", x: 0, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2", arcCentreId: "c" }],
    };
    const els = discretiseLines(model);
    expect(els).toHaveLength(2);
    // Every node must lie on the unit circle of radius 1.
    for (const el of els) {
      for (const n of el.nodes) {
        expect(Math.hypot(n.x, n.y)).toBeCloseTo(1);
      }
    }
    // Element 1's η = 0 node sits at t = 0.25 along the arc — that's an
    // angle of 22.5° from p1.
    const ang = Math.PI / 8;
    expect(els[0]!.nodes[1]!.x).toBeCloseTo(Math.cos(ang));
    expect(els[0]!.nodes[1]!.y).toBeCloseTo(Math.sin(ang));
  });
});
