import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, deserialize, serialize } from "./serialize.js";
import type { CadModel } from "./geometry/types.js";

const emptyModel: CadModel = {
  points: [],
  lines: [],
  boundaries: [],
  domains: [],
  bcs: [],
};

describe("serialize / deserialize (v2)", () => {
  it("round-trips an empty model", () => {
    expect(deserialize(serialize(emptyModel))).toEqual(emptyModel);
  });

  it("round-trips a model with arcs and BCs", () => {
    const model: CadModel = {
      points: [
        { id: "p1", x: 0, y: 0 },
        { id: "p2", x: 4, y: 0 },
        { id: "c1", x: 2, y: -2 },
      ],
      lines: [
        { id: "l1", startId: "p1", endId: "p2", arcCentreId: "c1" },
      ],
      boundaries: [],
      domains: [],
      bcs: [
        {
          lineId: "l1",
          x: { kind: "displacement", value: 0 },
          y: { kind: "traction", value: -5 },
        },
      ],
    };
    expect(deserialize(serialize(model))).toEqual(model);
  });

  it("emits the current schema version", () => {
    const parsed = JSON.parse(serialize(emptyModel));
    expect(parsed.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("rejects unsupported versions", () => {
    const bad = JSON.stringify({ version: 999, model: emptyModel });
    expect(() => deserialize(bad)).toThrow(/Unsupported schema version/);
  });

  it("rejects a model missing required arrays", () => {
    const bad = JSON.stringify({
      version: CURRENT_SCHEMA_VERSION,
      model: { points: [], lines: [], boundaries: [], domains: [] }, // no bcs
    });
    expect(() => deserialize(bad)).toThrow(/missing required arrays/);
  });

  it("rejects non-JSON", () => {
    expect(() => deserialize("not json")).toThrow(/Not valid JSON/);
  });
});

describe("v1 → v2 migration", () => {
  it("strips discretisation off lines and pulls bcs into top level", () => {
    const v1 = JSON.stringify({
      version: 1,
      model: {
        points: [
          { id: "p1", x: 0, y: 0 },
          { id: "p2", x: 4, y: 0 },
        ],
        lines: [
          {
            id: "l1",
            startId: "p1",
            endId: "p2",
            nElements: 1,
            localNodes: [-2 / 3, 0, 2 / 3],
            bcs: {
              dx: { kind: "known", value: 0 },
              dy: { kind: "unknown" },
              tx: { kind: "unknown" },
              ty: { kind: "known", value: -3 },
            },
          },
        ],
        boundaries: [],
        domains: [],
      },
    });
    const m = deserialize(v1);
    expect(m.lines).toEqual([{ id: "l1", startId: "p1", endId: "p2" }]);
    expect(m.bcs).toEqual([
      {
        lineId: "l1",
        x: { kind: "displacement", value: 0 },
        y: { kind: "traction", value: -3 },
      },
    ]);
  });

  it("treats zero traction in v1 as the default (no entry)", () => {
    const v1 = JSON.stringify({
      version: 1,
      model: {
        points: [],
        lines: [
          {
            id: "l1",
            startId: "p1",
            endId: "p2",
            nElements: 1,
            localNodes: [-2 / 3, 0, 2 / 3],
            bcs: {
              dx: { kind: "unknown" },
              dy: { kind: "unknown" },
              tx: { kind: "known", value: 0 },
              ty: { kind: "known", value: 0 },
            },
          },
        ],
        boundaries: [],
        domains: [],
      },
    });
    const m = deserialize(v1);
    expect(m.bcs).toEqual([]);
  });

  it("preserves arc centre during migration", () => {
    const v1 = JSON.stringify({
      version: 1,
      model: {
        points: [],
        lines: [
          {
            id: "l1",
            startId: "p1",
            endId: "p2",
            arcCentreId: "c1",
            nElements: 1,
            localNodes: [-2 / 3, 0, 2 / 3],
            bcs: {
              dx: { kind: "unknown" },
              dy: { kind: "unknown" },
              tx: { kind: "unknown" },
              ty: { kind: "unknown" },
            },
          },
        ],
        boundaries: [],
        domains: [],
      },
    });
    const m = deserialize(v1);
    expect(m.lines[0]).toEqual({
      id: "l1",
      startId: "p1",
      endId: "p2",
      arcCentreId: "c1",
    });
  });
});
