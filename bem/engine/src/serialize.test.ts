import { describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, deserialize, serialize } from "./serialize.js";
import type { CadModel } from "./geometry/types.js";

const emptyModel: CadModel = {
  points: [],
  lines: [],
  boundaries: [],
  domains: [],
};

describe("serialize / deserialize", () => {
  it("round-trips an empty model", () => {
    const json = serialize(emptyModel);
    expect(deserialize(json)).toEqual(emptyModel);
  });

  it("round-trips a populated model", () => {
    const model: CadModel = {
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
            dx: { kind: "unknown" },
            dy: { kind: "known", value: 0 },
            tx: { kind: "unknown" },
            ty: { kind: "unknown" },
          },
        },
      ],
      boundaries: [],
      domains: [],
    };
    expect(deserialize(serialize(model))).toEqual(model);
  });

  it("emits the schema version in the JSON", () => {
    const json = serialize(emptyModel);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("rejects non-JSON", () => {
    expect(() => deserialize("not json")).toThrow(/Not valid JSON/);
  });

  it("rejects an unsupported schema version", () => {
    const bad = JSON.stringify({ version: 999, model: emptyModel });
    expect(() => deserialize(bad)).toThrow(/Unsupported schema version/);
  });

  it("rejects a model with missing arrays", () => {
    const bad = JSON.stringify({
      version: CURRENT_SCHEMA_VERSION,
      model: { points: [] },
    });
    expect(() => deserialize(bad)).toThrow(/missing required arrays/);
  });

  it("rejects a top-level array", () => {
    expect(() => deserialize("[]")).toThrow(/Expected an object/);
  });
});
