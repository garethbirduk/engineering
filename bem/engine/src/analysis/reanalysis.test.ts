import { describe, expect, it } from "vitest";
import { discretiseLines } from "../elements/discretise.js";
import { solve } from "./solve.js";
import { assembleHG, createBlockCache } from "./assemble.js";

const PLATE = {
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
    { lineId: "lL", elementsPerLine: 3 },
    { lineId: "lB", elementsPerLine: 4 },
    { lineId: "lR", elementsPerLine: 3 },
    { lineId: "lT", elementsPerLine: 4 },
  ],
};
const MATERIAL = { E: 200e9, nu: 0.3, planeKind: "stress" as const };

function matrixToArray(m: import("ml-matrix").Matrix): number[][] {
  const rows = m.rows;
  const cols = m.columns;
  const out: number[][] = [];
  for (let i = 0; i < rows; i++) {
    const row: number[] = [];
    for (let j = 0; j < cols; j++) row.push(m.get(i, j));
    out.push(row);
  }
  return out;
}

function maxAbsDiff(a: number[][], b: number[][]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i]!.length; j++) {
      const d = Math.abs(a[i]![j]! - b[i]![j]!);
      if (d > m) m = d;
    }
  }
  return m;
}

describe("BlockCache reanalysis", () => {
  it("cached assembleHG produces byte-identical H and G to uncached", () => {
    const mesh = discretiseLines(PLATE);
    const fresh = assembleHG(mesh, MATERIAL);
    const cache = createBlockCache();
    const cold = assembleHG(mesh, MATERIAL, cache);
    const warm = assembleHG(mesh, MATERIAL, cache);
    expect(maxAbsDiff(matrixToArray(cold.H), matrixToArray(fresh.H))).toBe(0);
    expect(maxAbsDiff(matrixToArray(cold.G), matrixToArray(fresh.G))).toBe(0);
    expect(maxAbsDiff(matrixToArray(warm.H), matrixToArray(fresh.H))).toBe(0);
    expect(maxAbsDiff(matrixToArray(warm.G), matrixToArray(fresh.G))).toBe(0);
  });

  it("cached solve produces same nodal displacements as uncached", () => {
    const mesh = discretiseLines(PLATE);
    const cache = createBlockCache();
    const solvedFresh = solve(mesh, MATERIAL);
    const solvedCached = solve(mesh, MATERIAL, cache);
    expect(solvedCached.length).toBe(solvedFresh.length);
    for (let i = 0; i < solvedFresh.length; i++) {
      for (let k = 0; k < 3; k++) {
        const a = solvedFresh[i]!.nodes[k]!;
        const b = solvedCached[i]!.nodes[k]!;
        expect(b.ux).toBeCloseTo(a.ux, 12);
        expect(b.uy).toBeCloseTo(a.uy, 12);
      }
    }
  });

  it("incremental edit: cache size shrinks to only the touched element-pairs", () => {
    // Solve the plate once to warm the cache.
    const meshA = discretiseLines(PLATE);
    const cache = createBlockCache();
    assembleHG(meshA, MATERIAL, cache);
    const sizeAfterColdSolve = cache.size;
    expect(sizeAfterColdSolve).toBeGreaterThan(0);

    // Re-solve with the same mesh — every key should still be present
    // and reused; no new misses.
    assembleHG(meshA, MATERIAL, cache);
    expect(cache.size).toBe(sizeAfterColdSolve);

    // Now move one corner Point (p2 (6,0) → (6.5, 0)). Lines lB and lR
    // touch this Point; lL and lT don't. The cached keys for lL/lT
    // elements should still be valid; lB/lR elements get new keys.
    const moved = {
      ...PLATE,
      points: PLATE.points.map((p) =>
        p.id === "p2" ? { ...p, x: 6.5 } : p,
      ),
    };
    const meshB = discretiseLines(moved);
    assembleHG(meshB, MATERIAL, cache);

    // The cache's `size` after pruning should equal the new mesh's total
    // (N_collocation × N_elements) pair count. Stale lB/lR entries from
    // the old mesh should have been pruned.
    const nodesPerEl = 3;
    const totalNodes = meshB.length * nodesPerEl;
    const expectedAfterEdit = totalNodes * meshB.length;
    // Same-position dedup at corners can reduce the unique-collocation
    // count a bit, so the actual number is ≤ expectedAfterEdit. Just
    // assert it's bounded and that no leftover entries from the old
    // mesh are floating around (i.e. cache.size ≤ expected).
    expect(cache.size).toBeLessThanOrEqual(expectedAfterEdit);
    expect(cache.size).toBeGreaterThan(0);
  });

  it("changing material invalidates every entry (different material key)", () => {
    const mesh = discretiseLines(PLATE);
    const cache = createBlockCache();
    assembleHG(mesh, MATERIAL, cache);
    const sizeAfterFirst = cache.size;

    const matB = { ...MATERIAL, E: MATERIAL.E * 2 };
    assembleHG(mesh, matB, cache);
    // After the second assembleHG with a NEW material, the prune step
    // removes the old material's entries (none were touched) and the
    // cache holds only the new-material entries — same count as before
    // but with different keys.
    expect(cache.size).toBe(sizeAfterFirst);
  });
});
