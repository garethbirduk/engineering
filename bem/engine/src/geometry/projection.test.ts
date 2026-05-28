import { describe, expect, it } from "vitest";
import { projectOntoSegment } from "./projection.js";

const close = (a: number, b: number) =>
  expect(Math.abs(a - b)).toBeLessThan(1e-12);

describe("projectOntoSegment", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 4, y: 0 };

  it("midpoint of segment when the point is directly above the midpoint", () => {
    const r = projectOntoSegment({ x: 2, y: 5 }, a, b);
    close(r.x, 2);
    close(r.y, 0);
  });

  it("returns endpoint a if the point is before a", () => {
    const r = projectOntoSegment({ x: -3, y: 2 }, a, b);
    close(r.x, 0);
    close(r.y, 0);
  });

  it("returns endpoint b if the point is past b", () => {
    const r = projectOntoSegment({ x: 100, y: -2 }, a, b);
    close(r.x, 4);
    close(r.y, 0);
  });

  it("returns the input itself if it sits on the segment", () => {
    const r = projectOntoSegment({ x: 1.7, y: 0 }, a, b);
    close(r.x, 1.7);
    close(r.y, 0);
  });

  it("works on a diagonal segment", () => {
    const r = projectOntoSegment({ x: 0, y: 2 }, { x: 0, y: 0 }, { x: 2, y: 2 });
    close(r.x, 1);
    close(r.y, 1);
  });

  it("degenerate segment returns the single point", () => {
    const r = projectOntoSegment({ x: 5, y: 5 }, { x: 1, y: 1 }, { x: 1, y: 1 });
    close(r.x, 1);
    close(r.y, 1);
  });
});
