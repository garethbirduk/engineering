// CadModel ↔ JSON. Versioned wrapper plus a small migration ladder so
// older saved files keep loading.
//
// Format on disk:
//   { "version": N, "model": { points, lines, boundaries, domains, bcs, meshing } }
//
// Versions:
//   1 — initial. Line had { bcs, nElements, localNodes }. No top-level bcs.
//   2 — Line is pure geometry. Top-level bcs[] sparse array with new
//       DirectionBc shape ({ kind: "displacement" | "traction", value }).
//   3 — current. Adds top-level meshing[] sparse array — per-line overrides
//       of element count and local node η coords. Missing = use defaults.

import type {
  BcAssignment,
  CadModel,
  DirectionBc,
  Line,
} from "./geometry/types.js";

export const CURRENT_SCHEMA_VERSION = 3;

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
  const v = parsed["version"];
  if (v === 1) {
    return migrateV2ToV3(migrateV1(parsed["model"]));
  }
  if (v === 2) {
    return migrateV2ToV3(extractV2Model(parsed["model"]));
  }
  if (v !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schema version ${String(v)} (expected ${CURRENT_SCHEMA_VERSION}, 2, or 1)`,
    );
  }
  const m = parsed["model"];
  if (!isModelShape(m)) {
    throw new Error(
      "Model is missing required arrays (points, lines, boundaries, domains, bcs, meshing)",
    );
  }
  return m;
}

// ── migrations ────────────────────────────────────────────────────────────

/**
 * v1 → v2: strip `bcs`, `nElements`, `localNodes` off each Line. Pull any
 * known displacement/traction BCs into a top-level sparse `bcs[]`. Old
 * format was per-line `{ dx, dy, tx, ty }` where each is
 * `{ kind: "unknown" } | { kind: "known", value }`. New format is per-line
 * `{ x?: DirectionBc, y?: DirectionBc }`, where unset = traction zero
 * (free surface — the BEM default).
 */
function migrateV1(v1Model: unknown): CadModel {
  if (!isRecord(v1Model)) {
    throw new Error("v1 model is not an object");
  }
  if (
    !Array.isArray(v1Model["points"]) ||
    !Array.isArray(v1Model["lines"]) ||
    !Array.isArray(v1Model["boundaries"]) ||
    !Array.isArray(v1Model["domains"])
  ) {
    throw new Error("v1 model missing required arrays");
  }
  const bcs: BcAssignment[] = [];
  const lines: Line[] = [];
  for (const raw of v1Model["lines"] as unknown[]) {
    if (!isRecord(raw)) continue;
    const line: Line = {
      id: String(raw["id"]),
      startId: String(raw["startId"]),
      endId: String(raw["endId"]),
      ...(typeof raw["arcCentreId"] === "string"
        ? { arcCentreId: raw["arcCentreId"] }
        : {}),
    };
    lines.push(line);

    const oldBcs = raw["bcs"];
    if (isRecord(oldBcs)) {
      const x = pickDirectionBc(oldBcs["dx"], oldBcs["tx"]);
      const y = pickDirectionBc(oldBcs["dy"], oldBcs["ty"]);
      if (x !== undefined || y !== undefined) {
        bcs.push({
          lineId: line.id,
          ...(x !== undefined ? { x } : {}),
          ...(y !== undefined ? { y } : {}),
        });
      }
    }
  }
  return {
    points: v1Model["points"] as CadModel["points"],
    lines,
    boundaries: v1Model["boundaries"] as CadModel["boundaries"],
    domains: v1Model["domains"] as CadModel["domains"],
    bcs,
    meshing: [],
  };
}

/** v2 → v3: tack on an empty `meshing` array (all lines use defaults). */
function migrateV2ToV3(model: CadModel): CadModel {
  if (Array.isArray((model as { meshing?: unknown }).meshing)) return model;
  return { ...model, meshing: [] };
}

/**
 * Parse a v2 model payload and return it shaped as a CadModel (without the
 * v3-required `meshing` field — added by `migrateV2ToV3`).
 */
function extractV2Model(m: unknown): CadModel {
  if (!isRecord(m)) throw new Error("v2 model is not an object");
  if (
    !Array.isArray(m["points"]) ||
    !Array.isArray(m["lines"]) ||
    !Array.isArray(m["boundaries"]) ||
    !Array.isArray(m["domains"]) ||
    !Array.isArray(m["bcs"])
  ) {
    throw new Error(
      "v2 model is missing required arrays (points, lines, boundaries, domains, bcs)",
    );
  }
  return {
    points: m["points"] as CadModel["points"],
    lines: m["lines"] as CadModel["lines"],
    boundaries: m["boundaries"] as CadModel["boundaries"],
    domains: m["domains"] as CadModel["domains"],
    bcs: m["bcs"] as CadModel["bcs"],
    meshing: [],
  };
}

function pickDirectionBc(
  displacement: unknown,
  traction: unknown,
): DirectionBc | undefined {
  // Displacement wins if both happen to be set "known" (shouldn't happen
  // physically, but we have to pick).
  if (isRecord(displacement) && displacement["kind"] === "known") {
    const v = displacement["value"];
    if (typeof v === "number") {
      return { kind: "displacement", value: v };
    }
  }
  if (isRecord(traction) && traction["kind"] === "known") {
    const v = traction["value"];
    if (typeof v === "number" && v !== 0) {
      // Skip zero traction — it's the default.
      return { kind: "traction", value: v };
    }
  }
  return undefined;
}

// ── validators ────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isModelShape(v: unknown): v is CadModel {
  if (!isRecord(v)) return false;
  return (
    Array.isArray(v["points"]) &&
    Array.isArray(v["lines"]) &&
    Array.isArray(v["boundaries"]) &&
    Array.isArray(v["domains"]) &&
    Array.isArray(v["bcs"]) &&
    Array.isArray(v["meshing"])
  );
}
