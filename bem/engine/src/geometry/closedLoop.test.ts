import { describe, expect, it } from "vitest";
import { findAllClosedLoops, findClosedLoop } from "./closedLoop.js";
import type { CadModel, Line, LineBcs } from "./types.js";

const BCS: LineBcs = {
  dx: { kind: "unknown" },
  dy: { kind: "unknown" },
  tx: { kind: "unknown" },
  ty: { kind: "unknown" },
};

function L(id: string, startId: string, endId: string): Line {
  return {
    id,
    startId,
    endId,
    nElements: 1,
    localNodes: [-2 / 3, 0, 2 / 3],
    bcs: BCS,
  };
}

function model(lines: Line[]): Pick<CadModel, "lines"> {
  return { lines };
}

describe("findClosedLoop", () => {
  it("empty selection → null", () => {
    expect(findClosedLoop([], model([]))).toBeNull();
  });

  it("single line → null (no closure)", () => {
    const m = model([L("l1", "a", "b")]);
    expect(findClosedLoop(["l1"], m)).toBeNull();
  });

  it("unknown line id → null", () => {
    expect(findClosedLoop(["nope"], model([]))).toBeNull();
  });

  it("triangle (3 lines, 3 vertices) → 3-segment loop", () => {
    const m = model([
      L("l1", "a", "b"),
      L("l2", "b", "c"),
      L("l3", "c", "a"),
    ]);
    const loop = findClosedLoop(["l1", "l2", "l3"], m);
    expect(loop).not.toBeNull();
    expect(loop!).toHaveLength(3);
    // Walk starts on l1 in direction +1, so vertices visited are a→b→c→a.
    expect(loop![0]).toEqual({ lineId: "l1", direction: 1 });
    expect(loop![1]).toEqual({ lineId: "l2", direction: 1 });
    expect(loop![2]).toEqual({ lineId: "l3", direction: 1 });
  });

  it("triangle with one line drawn backwards → direction flips", () => {
    // l3 was authored c→a in the canonical case; here we author it a→c, so the
    // traversal needs direction -1 to walk c→a.
    const m = model([
      L("l1", "a", "b"),
      L("l2", "b", "c"),
      L("l3", "a", "c"),
    ]);
    const loop = findClosedLoop(["l1", "l2", "l3"], m);
    expect(loop).not.toBeNull();
    expect(loop![2]).toEqual({ lineId: "l3", direction: -1 });
  });

  it("square (4 lines, 4 vertices) → 4-segment loop", () => {
    const m = model([
      L("l1", "a", "b"),
      L("l2", "b", "c"),
      L("l3", "c", "d"),
      L("l4", "d", "a"),
    ]);
    const loop = findClosedLoop(["l1", "l2", "l3", "l4"], m);
    expect(loop).toHaveLength(4);
  });

  it("order-independent: square selected in any order still loops", () => {
    const m = model([
      L("l1", "a", "b"),
      L("l2", "b", "c"),
      L("l3", "c", "d"),
      L("l4", "d", "a"),
    ]);
    const loop = findClosedLoop(["l3", "l1", "l4", "l2"], m);
    expect(loop).not.toBeNull();
    expect(loop!).toHaveLength(4);
  });

  it("open path (3 lines, 4 vertices) → null", () => {
    // a—l1—b—l2—c—l3—d : endpoints a and d have degree 1.
    const m = model([
      L("l1", "a", "b"),
      L("l2", "b", "c"),
      L("l3", "c", "d"),
    ]);
    expect(findClosedLoop(["l1", "l2", "l3"], m)).toBeNull();
  });

  it("two disjoint triangles → null (walk only covers one)", () => {
    const m = model([
      // Triangle 1
      L("l1", "a", "b"),
      L("l2", "b", "c"),
      L("l3", "c", "a"),
      // Triangle 2
      L("l4", "x", "y"),
      L("l5", "y", "z"),
      L("l6", "z", "x"),
    ]);
    expect(
      findClosedLoop(["l1", "l2", "l3", "l4", "l5", "l6"], m),
    ).toBeNull();
  });

  it("figure-8 (shared vertex has degree 4) → null", () => {
    const m = model([
      // Triangle 1 sharing vertex 's'
      L("l1", "s", "b"),
      L("l2", "b", "c"),
      L("l3", "c", "s"),
      // Triangle 2 sharing vertex 's'
      L("l4", "s", "y"),
      L("l5", "y", "z"),
      L("l6", "z", "s"),
    ]);
    expect(
      findClosedLoop(["l1", "l2", "l3", "l4", "l5", "l6"], m),
    ).toBeNull();
  });

  it("subset of a square (3 of 4 lines) → null", () => {
    const m = model([
      L("l1", "a", "b"),
      L("l2", "b", "c"),
      L("l3", "c", "d"),
      L("l4", "d", "a"),
    ]);
    expect(findClosedLoop(["l1", "l2", "l3"], m)).toBeNull();
  });
});

describe("findAllClosedLoops", () => {
  it("two disjoint triangles → two loops", () => {
    const m = model([
      L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "a"),
      L("l4", "x", "y"), L("l5", "y", "z"), L("l6", "z", "x"),
    ]);
    const loops = findAllClosedLoops(
      ["l1", "l2", "l3", "l4", "l5", "l6"],
      m,
    );
    expect(loops).not.toBeNull();
    expect(loops!).toHaveLength(2);
    expect(loops![0]!).toHaveLength(3);
    expect(loops![1]!).toHaveLength(3);
  });

  it("single triangle → one loop", () => {
    const m = model([
      L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "a"),
    ]);
    const loops = findAllClosedLoops(["l1", "l2", "l3"], m);
    expect(loops).not.toBeNull();
    expect(loops!).toHaveLength(1);
  });

  it("figure-8 (shared vertex degree 4) → null", () => {
    const m = model([
      L("l1", "s", "b"), L("l2", "b", "c"), L("l3", "c", "s"),
      L("l4", "s", "y"), L("l5", "y", "z"), L("l6", "z", "s"),
    ]);
    expect(
      findAllClosedLoops(["l1", "l2", "l3", "l4", "l5", "l6"], m),
    ).toBeNull();
  });

  it("open path mixed with closed loop → null", () => {
    const m = model([
      L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "a"),
      L("l4", "x", "y"),
    ]);
    expect(findAllClosedLoops(["l1", "l2", "l3", "l4"], m)).toBeNull();
  });
});
