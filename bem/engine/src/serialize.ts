// CadModel ↔ JSON. A small versioned wrapper lets us evolve the schema in
// the future without silently loading mismatched files.
//
// Format on disk:
//   {
//     "version": 1,
//     "model": { points, lines, boundaries, domains }
//   }
//
// Read back via `deserialize`, which throws on bad/unsupported input. The
// caller decides whether to alert or fall back.

import type { CadModel } from "./geometry/types.js";

export const CURRENT_SCHEMA_VERSION = 1;

export interface SerializedModel {
  readonly version: number;
  readonly model: CadModel;
}

export function serialize(model: CadModel): string {
  const wrapped: SerializedModel = {
    version: CURRENT_SCHEMA_VERSION,
    model,
  };
  return JSON.stringify(wrapped, null, 2);
}

export function deserialize(json: string): CadModel {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`Not valid JSON: ${(e as Error).message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("Expected an object at the root");
  }
  if (parsed["version"] !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version ${String(parsed["version"])} (expected ${CURRENT_SCHEMA_VERSION})`,
    );
  }
  const m = parsed["model"];
  if (!isModelShape(m)) {
    throw new Error(
      "Model is missing required arrays (points, lines, boundaries, domains)",
    );
  }
  return m;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isModelShape(v: unknown): v is CadModel {
  if (!isRecord(v)) return false;
  return (
    Array.isArray(v["points"]) &&
    Array.isArray(v["lines"]) &&
    Array.isArray(v["boundaries"]) &&
    Array.isArray(v["domains"])
  );
}
