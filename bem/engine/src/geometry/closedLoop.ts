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

export function findClosedLoop(
  selectedLineIds: readonly Id[],
  model: Pick<CadModel, "lines">,
): readonly BoundarySegment[] | null {
  if (selectedLineIds.length === 0) return null;

  const lineById = new Map<Id, Line>(model.lines.map((l) => [l.id, l]));
  const lines: Line[] = [];
  for (const id of selectedLineIds) {
    const l = lineById.get(id);
    if (!l) return null;
    lines.push(l);
  }

  // Vertex adjacency, restricted to the selection.
  const adj = new Map<Id, VertexNeighbour[]>();
  for (const l of lines) {
    pushAdj(adj, l.startId, { lineId: l.id, otherVertex: l.endId });
    pushAdj(adj, l.endId, { lineId: l.id, otherVertex: l.startId });
  }

  // Every vertex must have degree exactly 2.
  for (const neighbours of adj.values()) {
    if (neighbours.length !== 2) return null;
  }

  // Traverse.
  const first = lines[0];
  if (!first) return null;
  const segments: BoundarySegment[] = [
    { lineId: first.id, direction: 1 },
  ];
  const visited = new Set<Id>([first.id]);
  const startVertex = first.startId;
  let currentVertex = first.endId;

  while (segments.length < lines.length) {
    const neighbours = adj.get(currentVertex);
    if (!neighbours) return null;
    const next = neighbours.find((n) => !visited.has(n.lineId));
    if (!next) return null;
    const nextLine = lineById.get(next.lineId);
    if (!nextLine) return null;
    const direction: 1 | -1 =
      nextLine.startId === currentVertex ? 1 : -1;
    segments.push({ lineId: next.lineId, direction });
    visited.add(next.lineId);
    currentVertex = next.otherVertex;
  }

  // The walk must close back to the starting vertex.
  if (currentVertex !== startVertex) return null;

  return segments;
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
