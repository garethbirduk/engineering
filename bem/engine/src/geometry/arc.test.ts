import { describe, expect, it } from "vitest";
import {
  arcCentreFor90Degrees,
  arcPoint,
  arcRadius,
  arcSvgPathD,
  cursorOnArc,
  mirrorAcrossChord,
} from "./arc.js";

const close = (a: number, b: number, eps = 1e-9) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe("arcCentreFor90Degrees", () => {
  it("horizontal chord → centre directly below midpoint", () => {
    // start (0,0), end (4,0). Right-of-direction normal = (0,-1).
    // Midpoint (2,0). Centre at (2, -2).
    const c = arcCentreFor90Degrees({ x: 0, y: 0 }, { x: 4, y: 0 });
    close(c.x, 2);
    close(c.y, -2);
  });

  it("vertical chord → centre to the right of midpoint", () => {
    // start (0,0), end (0,4). Right-of-direction = (4,0)/4 → (1, 0).
    // Midpoint (0,2). Centre at (2, 2).
    const c = arcCentreFor90Degrees({ x: 0, y: 0 }, { x: 0, y: 4 });
    close(c.x, 2);
    close(c.y, 2);
  });

  it("|centre - start| equals |centre - end| (consistent radius)", () => {
    const s = { x: 1, y: 1 };
    const e = { x: 5, y: 4 };
    const c = arcCentreFor90Degrees(s, e);
    close(
      Math.hypot(c.x - s.x, c.y - s.y),
      Math.hypot(c.x - e.x, c.y - e.y),
    );
  });

  it("angle at centre subtended by chord is 90°", () => {
    const s = { x: 0, y: 0 };
    const e = { x: 6, y: 0 };
    const c = arcCentreFor90Degrees(s, e);
    const v1 = { x: s.x - c.x, y: s.y - c.y };
    const v2 = { x: e.x - c.x, y: e.y - c.y };
    const dot = v1.x * v2.x + v1.y * v2.y;
    close(dot, 0); // perpendicular
  });
});

describe("mirrorAcrossChord", () => {
  it("mirroring across a horizontal chord flips y", () => {
    const p = mirrorAcrossChord({ x: 1, y: 3 }, { x: 0, y: 0 }, { x: 5, y: 0 });
    close(p.x, 1);
    close(p.y, -3);
  });

  it("point on the chord stays put", () => {
    const p = mirrorAcrossChord({ x: 2, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 });
    close(p.x, 2);
    close(p.y, 0);
  });

  it("mirroring twice returns to original", () => {
    const orig = { x: 1.7, y: 2.3 };
    const a = { x: 0, y: 0 };
    const b = { x: 4, y: 1 };
    const m1 = mirrorAcrossChord(orig, a, b);
    const m2 = mirrorAcrossChord(m1, a, b);
    close(m2.x, orig.x);
    close(m2.y, orig.y);
  });
});

describe("arcRadius + arcPoint", () => {
  it("midpoint of arc lies on the circle", () => {
    const s = { x: 0, y: 0 };
    const e = { x: 4, y: 0 };
    const c = arcCentreFor90Degrees(s, e);
    const r = arcRadius(c, s);
    const mid = arcPoint(s, e, c, 0.5);
    close(Math.hypot(mid.x - c.x, mid.y - c.y), r);
  });

  it("midpoint of a 90° arc with centre below sits ABOVE the chord", () => {
    // start (0,0), end (4,0), centre (2,-2). Arc bulges up. Midpoint should
    // have y > 0.
    const s = { x: 0, y: 0 };
    const e = { x: 4, y: 0 };
    const c = arcCentreFor90Degrees(s, e);
    const mid = arcPoint(s, e, c, 0.5);
    expect(mid.y).toBeGreaterThan(0);
  });

  it("t=0 returns start, t=1 returns end (approximately)", () => {
    const s = { x: 0, y: 0 };
    const e = { x: 4, y: 0 };
    const c = arcCentreFor90Degrees(s, e);
    const p0 = arcPoint(s, e, c, 0);
    const p1 = arcPoint(s, e, c, 1);
    close(p0.x, s.x, 1e-9);
    close(p0.y, s.y, 1e-9);
    close(p1.x, e.x, 1e-9);
    close(p1.y, e.y, 1e-9);
  });
});

describe("arcSvgPathD", () => {
  it("emits a valid M ... A ... command", () => {
    const d = arcSvgPathD({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: -2 });
    expect(d).toMatch(/^M 0 0 A [\d.]+ [\d.]+ 0 0 [01] 4 0$/);
  });
});

describe("cursorOnArc", () => {
  const s = { x: 0, y: 0 };
  const e = { x: 4, y: 0 };
  const c = arcCentreFor90Degrees(s, e);

  it("point exactly on the arc midpoint → hit", () => {
    const mid = arcPoint(s, e, c, 0.5);
    expect(cursorOnArc(mid, s, e, c, 0.001)).toBe(true);
  });

  it("point on the chord midpoint (off the arc) → miss", () => {
    expect(cursorOnArc({ x: 2, y: 0 }, s, e, c, 0.1)).toBe(false);
  });

  it("point at a start endpoint → hit", () => {
    expect(cursorOnArc(s, s, e, c, 0.001)).toBe(true);
  });

  it("point on the same circle but outside the arc sweep → miss", () => {
    // centre (2,-2), radius 2√2. The opposite end of the circle from the
    // arc midpoint is far below; not within the short-arc sweep.
    const opposite = { x: 2, y: -2 - 2 * Math.sqrt(2) };
    expect(cursorOnArc(opposite, s, e, c, 0.001)).toBe(false);
  });
});
