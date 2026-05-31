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
    // Use closeTo (not toEqual) because isoparametric interpolation rounds
    // in the last bit; values are within 1e-10 of the analytic positions.
    const expectNode = (n: { x: number; y: number }, x: number, y: number) => {
      expect(n.x).toBeCloseTo(x, 10);
      expect(n.y).toBeCloseTo(y, 10);
    };
    expectNode(els[0]!.nodes[0]!, 1, 0);
    expectNode(els[0]!.nodes[1]!, 3, 0);
    expectNode(els[0]!.nodes[2]!, 5, 0);

    expectNode(els[1]!.nodes[0]!, 7, 0);
    expectNode(els[1]!.nodes[1]!, 9, 0);
    expectNode(els[1]!.nodes[2]!, 11, 0);

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
    expect(els[0]!.nodes[0]).toMatchObject({ x: 0, y: 0 });
    expect(els[0]!.nodes[1]).toMatchObject({ x: 0.5, y: 0 });
    expect(els[0]!.nodes[2]).toMatchObject({ x: 1, y: 0 });
  });

  it("per-element override wins over the line-level base", () => {
    // 3 elements on a unit line. Middle element gets continuous nodes;
    // first and third use base (default discontinuous).
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 3, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
      meshing: [
        {
          lineId: "l1",
          elementsPerLine: 3,
          elementLocalNodes: { "1": [-1, 0, 1] as const },
        },
      ],
    };
    const els = discretiseLines(model);
    expect(els).toHaveLength(3);
    expect(els[0]!.localNodes).toEqual([-2 / 3, 0, 2 / 3]); // base
    expect(els[1]!.localNodes).toEqual([-1, 0, 1]);          // override
    expect(els[2]!.localNodes).toEqual([-2 / 3, 0, 2 / 3]); // base
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
    expect(l2Els[0]!.nodes[0]).toMatchObject({ x: 1, y: 1 });
    expect(l2Els[0]!.nodes[2]).toMatchObject({ x: 0, y: 1 });
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

  it("arc: nodes are isoparametric — η=0 anchor on the arc, ±2/3 nodes on the quadratic interpolant", () => {
    // Quarter-circle radius 1 from (1, 0) to (0, 1) around (0, 0).
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

    // The η = 0 output node coincides with the middle anchor, which sits
    // exactly on the arc at element-local η = 0 → line-t = 0.25.
    const ang = Math.PI / 8;
    expect(els[0]!.nodes[1]!.x).toBeCloseTo(Math.cos(ang));
    expect(els[0]!.nodes[1]!.y).toBeCloseTo(Math.sin(ang));

    // The η = ±2/3 nodes are on the quadratic interpolant through the 3
    // anchors — close to but not exactly on the true arc. Verify they're
    // close (within ~1% of the unit-circle radius).
    for (const el of els) {
      for (const n of el.nodes) {
        const r = Math.hypot(n.x, n.y);
        expect(Math.abs(r - 1)).toBeLessThan(0.01);
      }
    }

    // Explicit check: for element 1 at η = -2/3, anchor-shape-function
    // interpolation yields x ≈ 0.9903, y ≈ 0.1340. The true arc point at
    // line-t = 1/12 is (cos(π/24), sin(π/24)) ≈ (0.9914, 0.1305) — close
    // but not identical (this *is* the visible O(h³) approximation error).
    expect(els[0]!.nodes[0]!.x).toBeCloseTo(0.9903, 3);
    expect(els[0]!.nodes[0]!.y).toBeCloseTo(0.1340, 3);
  });

  it("free surface default: every node has tx=ty=0 (known) and ux=uy=NaN (unknown)", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
    };
    const els = discretiseLines(model);
    for (const el of els) {
      for (const n of el.nodes) {
        expect(n.tx).toBe(0);
        expect(n.ty).toBe(0);
        expect(Number.isNaN(n.ux)).toBe(true);
        expect(Number.isNaN(n.uy)).toBe(true);
      }
    }
  });

  it("displacement BC at line level fans out to every node on every element", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
      bcs: [
        {
          lineId: "l1",
          // ux = 0 m (displacement BC, no prefix → default m for displacement → 0 * 1e-3 = 0 m)
          x: { kind: "displacement" as const, value: 0 },
        },
      ],
    };
    const els = discretiseLines(model);
    for (const el of els) {
      for (const n of el.nodes) {
        // x-axis: displacement constrained → ux known, tx unknown
        expect(n.ux).toBe(0);
        expect(Number.isNaN(n.tx)).toBe(true);
        // y-axis: free surface default (no entry for y) → ty=0 known, uy NaN
        expect(n.ty).toBe(0);
        expect(Number.isNaN(n.uy)).toBe(true);
      }
    }
  });

  it("traction BC with SI prefix converts to SI base units", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
      bcs: [
        {
          lineId: "l1",
          // 100 MPa = 100e6 Pa; explicit prefix = 6.
          x: { kind: "traction" as const, value: 100, prefix: 6 },
        },
      ],
    };
    const els = discretiseLines(model);
    for (const el of els) {
      for (const n of el.nodes) {
        expect(n.tx).toBe(100e6);
        expect(Number.isNaN(n.ux)).toBe(true);
        // y-axis: free surface
        expect(n.ty).toBe(0);
        expect(Number.isNaN(n.uy)).toBe(true);
      }
    }
  });

  it("mixed BC: displacement in x, traction in y", () => {
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
      bcs: [
        {
          lineId: "l1",
          x: { kind: "displacement" as const, value: 0 },
          y: { kind: "traction" as const, value: -50, prefix: 6 },
        },
      ],
    };
    const els = discretiseLines(model);
    const n = els[0]!.nodes[0]!;
    expect(n.ux).toBe(0);
    expect(Number.isNaN(n.tx)).toBe(true);
    expect(n.ty).toBe(-50e6);
    expect(Number.isNaN(n.uy)).toBe(true);
  });

  it("boundary segments drive mesh order — outer square walked CCW emits a contiguous element sequence", () => {
    // Four sides of a unit square as separate lines, declared in NON-CCW
    // JSON order (left, top, right, bottom). The boundary lists them in
    // CCW traversal order (left → bottom → right → top). With the
    // boundary-driven ordering, the mesh array's elements must walk the
    // boundary continuously (each element's end ≈ next element's start),
    // even though model.lines is in a different order.
    const model = {
      points: [
        { id: "BL", x: 0, y: 0 },
        { id: "BR", x: 1, y: 0 },
        { id: "TR", x: 1, y: 1 },
        { id: "TL", x: 0, y: 1 },
      ],
      lines: [
        { id: "left", startId: "TL", endId: "BL" },
        { id: "top", startId: "TR", endId: "TL" },
        { id: "right", startId: "BR", endId: "TR" },
        { id: "bottom", startId: "BL", endId: "BR" },
      ],
      boundaries: [
        {
          id: "outer",
          name: "outer",
          segments: [
            { lineId: "left", direction: 1 as const },
            { lineId: "bottom", direction: 1 as const },
            { lineId: "right", direction: 1 as const },
            { lineId: "top", direction: 1 as const },
          ],
        },
      ],
    };
    const els = discretiseLines(model, { elementsPerLine: 1 });
    // 4 lines × 1 element = 4 elements in CCW boundary order.
    expect(els.map((e) => e.lineId)).toEqual([
      "left",
      "bottom",
      "right",
      "top",
    ]);
    // The walk is continuous: each element's geometric end is the next
    // element's geometric start (up to floating-point), closing the loop.
    for (let i = 0; i < els.length; i++) {
      const cur = els[i]!;
      const next = els[(i + 1) % els.length]!;
      expect(cur.end.x).toBeCloseTo(next.start.x);
      expect(cur.end.y).toBeCloseTo(next.start.y);
    }
  });

  it("boundary segment direction = -1 reverses element order and tags traverseReversed", () => {
    // Three elements on a line. Boundary walks it backwards. The mesh
    // array must emit elements [2, 1, 0] in that order, each tagged so
    // the assembler walks node indices [2,1,0] for fresh-index
    // assignment (giving the boundary-walk-first node the smallest
    // global index).
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 3, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2" }],
      boundaries: [
        {
          id: "bnd",
          name: "bnd",
          segments: [{ lineId: "l1", direction: -1 as const }],
        },
      ],
    };
    const els = discretiseLines(model, { elementsPerLine: 3 });
    // Mesh ARRAY order is reversed (boundary-walk order).
    expect(els.map((e) => e.indexInLine)).toEqual([2, 1, 0]);
    expect(els.every((e) => e.traverseReversed === true)).toBe(true);
    // But each element's own data (anchors, nodes, localNodes) is
    // unchanged — anchors[0] still sits at the smaller-t (native) end.
    // First emitted element is indexInLine=2 → t ∈ [2/3, 1].
    expect(els[0]!.tStart).toBeCloseTo(2 / 3);
    expect(els[0]!.tEnd).toBeCloseTo(1);
  });

  it("lines without any boundary segment fall through in JSON order at the end", () => {
    // Mixed: l1 is in a boundary, l2 isn't. l2 should still be
    // discretised — it just appears after the boundary-driven elements.
    const model = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 1, y: 0 },
        { id: "p3", x: 2, y: 0 },
        { id: "p4", x: 3, y: 0 },
      ],
      lines: [
        { id: "l1", startId: "p1", endId: "p2" },
        { id: "l2", startId: "p3", endId: "p4" },
      ],
      boundaries: [
        {
          id: "bnd",
          name: "bnd",
          segments: [{ lineId: "l1", direction: 1 as const }],
        },
      ],
    };
    const els = discretiseLines(model, { elementsPerLine: 1 });
    expect(els.map((e) => e.lineId)).toEqual(["l1", "l2"]);
  });

  it("arc with continuous nodes: all 3 nodes per element are exactly on the arc", () => {
    // When the output nodes coincide with the geometry anchors (η = -1, 0, +1),
    // shape-function interpolation reproduces them exactly — all nodes on arc.
    const model = {
      points: [
        { id: "p1", x: 1, y: 0 },
        { id: "p2", x: 0, y: 1 },
        { id: "c", x: 0, y: 0 },
      ],
      lines: [{ id: "l1", startId: "p1", endId: "p2", arcCentreId: "c" }],
      meshing: [
        { lineId: "l1", localNodes: [-1, 0, 1] as const },
      ],
    };
    const els = discretiseLines(model);
    for (const el of els) {
      for (const n of el.nodes) {
        expect(Math.hypot(n.x, n.y)).toBeCloseTo(1);
      }
    }
  });
});
