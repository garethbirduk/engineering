import { describe, expect, it } from "vitest";
import { loopOrientation } from "./orientation.js";
import type { BoundarySegment, CadModel, Line, LineBcs, Point } from "./types.js";

const BCS: LineBcs = {
  dx: { kind: "unknown" },
  dy: { kind: "unknown" },
  tx: { kind: "unknown" },
  ty: { kind: "unknown" },
};

function P(id: string, x: number, y: number): Point {
  return { id, x, y };
}

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

function S(lineId: string, direction: 1 | -1 = 1): BoundarySegment {
  return { lineId, direction };
}

describe("loopOrientation", () => {
  it("CCW triangle returns 'ccw'", () => {
    const model: Pick<CadModel, "lines" | "points"> = {
      points: [P("a", 0, 0), P("b", 4, 0), P("c", 2, 3)],
      lines: [L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "a")],
    };
    expect(loopOrientation([S("l1"), S("l2"), S("l3")], model)).toBe("ccw");
  });

  it("CW triangle (same loop reversed) returns 'cw'", () => {
    const model: Pick<CadModel, "lines" | "points"> = {
      points: [P("a", 0, 0), P("b", 4, 0), P("c", 2, 3)],
      lines: [L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "a")],
    };
    // Traverse a→c→b→a using reversed segments.
    expect(
      loopOrientation([S("l3", -1), S("l2", -1), S("l1", -1)], model),
    ).toBe("cw");
  });

  it("mixed segment directions still classifies correctly", () => {
    // CCW square but with l4 authored as a→d (so traversed -1 means d→a).
    const model: Pick<CadModel, "lines" | "points"> = {
      points: [P("a", 0, 0), P("b", 2, 0), P("c", 2, 2), P("d", 0, 2)],
      lines: [
        L("l1", "a", "b"),
        L("l2", "b", "c"),
        L("l3", "c", "d"),
        L("l4", "a", "d"),
      ],
    };
    expect(
      loopOrientation([S("l1"), S("l2"), S("l3"), S("l4", -1)], model),
    ).toBe("ccw");
  });

  it("collinear points → degenerate", () => {
    const model: Pick<CadModel, "lines" | "points"> = {
      points: [P("a", 0, 0), P("b", 1, 0), P("c", 2, 0)],
      lines: [L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "a")],
    };
    expect(loopOrientation([S("l1"), S("l2"), S("l3")], model)).toBe(
      "degenerate",
    );
  });

  it("too few segments → degenerate", () => {
    const model: Pick<CadModel, "lines" | "points"> = {
      points: [P("a", 0, 0), P("b", 1, 1)],
      lines: [L("l1", "a", "b")],
    };
    expect(loopOrientation([S("l1")], model)).toBe("degenerate");
  });

  it("missing line id → degenerate", () => {
    const model: Pick<CadModel, "lines" | "points"> = {
      points: [],
      lines: [],
    };
    expect(loopOrientation([S("nope"), S("nope2"), S("nope3")], model)).toBe(
      "degenerate",
    );
  });
});
