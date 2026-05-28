// Closed-loop detection over a subset of Lines in a CadModel.
//
// Given a set of Line ids that the user has selected, decide whether those
// lines form a single closed loop. If so, return the ordered traversal as
// BoundarySegment[] (each segment carrying its direction relative to the
// underlying Line's start→end). If not, return null.
//
// Algorithm:
//   1. Look up each selected line; fail if any id is unknown.
//   2. Build a vertex-adjacency map over the selected lines only.
//      Each vertex (Point id) must have degree exactly 2 — anything else
//      (degree 0 means orphan, 1 means open endpoint, ≥3 means branch) is
//      not a simple loop.
//   3. Walk: start from any line, pick an endpoint as the traversal start,
//      step through neighbour lines via shared vertices. If we visit every
//      selected line exactly once and return to the start vertex, it's a
//      loop.
//
// Multi-loop selections (e.g. two disjoint triangles) fail because the walk
// only covers one connected component, and the post-condition that
// segments.length === lines.length will not hold.

import type {
  BoundarySegment,
  CadModel,
  Id,
  Line,
} from "./types.js";

interface VertexNeighbour {
  readonly lineId: Id;
  readonly otherVertex: Id;
}

/**
 * Decompose `selectedLineIds` into one or more disjoint closed loops, in
 * traversal order. Returns null if any vertex's degree (within the selection)
 * isn't exactly 2, OR if a connected component doesn't actually close.
 *
 * Use this for "select exterior + hole + commit" workflows where multiple
 * boundaries need to be inferred from one selection.
 */
export function findAllClosedLoops(
  selectedLineIds: readonly Id[],
  model: Pick<CadModel, "lines">,
): readonly (readonly BoundarySegment[])[] | null {
  if (selectedLineIds.length === 0) return null;

  const lineById = new Map<Id, Line>(model.lines.map((l) => [l.id, l]));
  const lines: Line[] = [];
  for (const id of selectedLineIds) {
    const l = lineById.get(id);
    if (!l) return null;
    lines.push(l);
  }

  const adj = new Map<Id, VertexNeighbour[]>();
  for (const l of lines) {
    pushAdj(adj, l.startId, { lineId: l.id, otherVertex: l.endId });
    pushAdj(adj, l.endId, { lineId: l.id, otherVertex: l.startId });
  }
  for (const neighbours of adj.values()) {
    if (neighbours.length !== 2) return null;
  }

  const visited = new Set<Id>();
  const loops: BoundarySegment[][] = [];

  for (const startLine of lines) {
    if (visited.has(startLine.id)) continue;
    const segments: BoundarySegment[] = [
      { lineId: startLine.id, direction: 1 },
    ];
    visited.add(startLine.id);
    const startVertex = startLine.startId;
    let currentVertex = startLine.endId;

    while (true) {
      const neighbours = adj.get(currentVertex);
      if (!neighbours) return null;
      const next = neighbours.find((n) => !visited.has(n.lineId));
      if (!next) {
        // Closed back to the loop's start?
        if (currentVertex !== startVertex) return null;
        break;
      }
      const nextLine = lineById.get(next.lineId);
      if (!nextLine) return null;
      const direction: 1 | -1 =
        nextLine.startId === currentVertex ? 1 : -1;
      segments.push({ lineId: next.lineId, direction });
      visited.add(next.lineId);
      currentVertex = next.otherVertex;
    }
    loops.push(segments);
  }

  return loops.length > 0 ? loops : null;
}

/**
 * Decompose into exactly one closed loop; null if the selection has any
 * other topology (open path, multiple loops, branching).
 */
export function findClosedLoop(
  selectedLineIds: readonly Id[],
  model: Pick<CadModel, "lines">,
): readonly BoundarySegment[] | null {
  const all = findAllClosedLoops(selectedLineIds, model);
  if (!all || all.length !== 1) return null;
  return all[0] ?? null;
}

function pushAdj(
  adj: Map<Id, VertexNeighbour[]>,
  key: Id,
  value: VertexNeighbour,
): void {
  const existing = adj.get(key);
  if (existing) {
    existing.push(value);
  } else {
    adj.set(key, [value]);
  }
}
