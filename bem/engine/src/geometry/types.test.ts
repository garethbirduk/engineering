import { describe, expect, it } from "vitest";
import type { BcAssignment, CadModel, Line, Point } from "./types.js";
import { ENGINE_VERSION } from "../index.js";

describe("geometry types — smoke", () => {
  it("can construct a minimal CadModel with the layered shape", () => {
    const p1: Point = { id: "p1", x: 0, y: 0 };
    const p2: Point = { id: "p2", x: 1, y: 0 };
    const line: Line = { id: "l1", startId: "p1", endId: "p2" };
    const bc: BcAssignment = {
      lineId: "l1",
      x: { kind: "displacement", value: 0 },
    };
    const model: CadModel = {
      points: [p1, p2],
      lines: [line],
      boundaries: [],
      domains: [],
      bcs: [bc],
    };
    expect(model.points).toHaveLength(2);
    expect(model.lines[0]?.arcCentreId).toBeUndefined();
    expect(model.bcs[0]?.x?.kind).toBe("displacement");
  });

  it("exposes a version", () => {
    expect(ENGINE_VERSION).toBe("0.0.1");
  });
});
