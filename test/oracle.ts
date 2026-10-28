import { orient2d } from "robust-predicates";
import type { Loop2D, Point2D } from "../src/index.js";

/**
 * Independent correctness oracle for Boolean outputs. Everything here uses exact orientation
 * predicates (Shewchuk's adaptive arithmetic) and never calls back into polystrata, so errors that
 * are consistent across operations (e.g. `heal` and `union` both dropping a region) are still caught.
 */

/** Exact sign: > 0 if `c` lies left of the directed line `a -> b` (counter-clockwise). */
export function orient(a: Point2D, b: Point2D, c: Point2D): number {
  // robust-predicates returns the clockwise-positive determinant.
  return -orient2d(a.x, a.y, b.x, b.y, c.x, c.y);
}

/** Exact winding number of `p` with respect to a set of oriented loops (Sunday's crossing rule). */
export function windingNumber(p: Point2D, loops: readonly Loop2D[]): number {
  let w = 0;
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % n]!;
      if (a.y <= p.y) {
        if (b.y > p.y && orient(a, b, p) > 0) w++;
      } else if (b.y <= p.y && orient(a, b, p) < 0) {
        w--;
      }
    }
  }
  return w;
}

function pointSegmentDistance(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distanceToLoops(p: Point2D, loops: readonly Loop2D[]): number {
  let d = Infinity;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      d = Math.min(d, pointSegmentDistance(p, loop[i]!, loop[(i + 1) % loop.length]!));
    }
  }
  return d;
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  diagonal: number;
}

export function boundsOf(loops: readonly Loop2D[]): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const loop of loops) {
    for (const p of loop) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x);
      y1 = Math.max(y1, p.y);
    }
  }
  return { x0, y0, x1, y1, diagonal: 2 * Math.hypot(0.5 * x1 - 0.5 * x0, 0.5 * y1 - 0.5 * y0) };
}

export interface ValidityReport {
  /** Pairs of output segments whose interiors cross properly (exact test, no tolerance). */
  crossings: number;
  /** Pairs of collinear output segments whose interiors overlap. */
  overlaps: number;
  /** Zero-length edges (repeated consecutive vertices). */
  degenerateEdges: number;
  nonFiniteVertices: number;
  /** Loops with fewer than 3 vertices. */
  shortLoops: number;
}

/** Strict planar validity of an output loop set, using exact predicates throughout. */
export function validateLoops(loops: readonly Loop2D[]): ValidityReport {
  interface Seg {
    a: Point2D;
    b: Point2D;
    x0: number;
    x1: number;
    y0: number;
    y1: number;
  }
  const report: ValidityReport = {
    crossings: 0,
    overlaps: 0,
    degenerateEdges: 0,
    nonFiniteVertices: 0,
    shortLoops: 0,
  };
  const segs: Seg[] = [];
  for (const loop of loops) {
    if (loop.length < 3) report.shortLoops++;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % loop.length]!;
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) {
        report.nonFiniteVertices++;
        continue;
      }
      if (a.x === b.x && a.y === b.y) {
        report.degenerateEdges++;
        continue;
      }
      segs.push({
        a,
        b,
        x0: Math.min(a.x, b.x),
        x1: Math.max(a.x, b.x),
        y0: Math.min(a.y, b.y),
        y1: Math.max(a.y, b.y),
      });
    }
  }

  segs.sort((s, t) => s.x0 - t.x0);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]!;
      if (t.x0 > s.x1) break;
      if (t.y0 > s.y1 || t.y1 < s.y0) continue;
      const o1 = Math.sign(orient(s.a, s.b, t.a));
      const o2 = Math.sign(orient(s.a, s.b, t.b));
      const o3 = Math.sign(orient(t.a, t.b, s.a));
      const o4 = Math.sign(orient(t.a, t.b, s.b));
      if (o1 * o2 < 0 && o3 * o4 < 0) {
        report.crossings++;
      } else if (o1 === 0 && o2 === 0) {
        const useX = Math.abs(s.b.x - s.a.x) >= Math.abs(s.b.y - s.a.y);
        const key = (p: Point2D) => (useX ? p.x : p.y);
        const lo = Math.max(Math.min(key(s.a), key(s.b)), Math.min(key(t.a), key(t.b)));
        const hi = Math.min(Math.max(key(s.a), key(s.b)), Math.max(key(t.a), key(t.b)));
        if (hi > lo) report.overlaps++;
      }
    }
  }
  return report;
}

export type BinaryOp = "union" | "intersect" | "difference" | "xor";

export const OP_PREDICATES: Record<BinaryOp, (inA: boolean, inB: boolean) => boolean> = {
  union: (a, b) => a || b,
  intersect: (a, b) => a && b,
  difference: (a, b) => a && !b,
  xor: (a, b) => a !== b,
};

export interface RegionReport {
  checked: number;
  /** Points classified differently from the exact winding of the raw inputs. */
  misclassified: number;
  /** Points where the output winding is neither 0 nor 1 (overlapping shells, inverted holes). */
  badWinding: number;
  example?: string;
}

/**
 * Compare output membership against the raw inputs (Positive fill rule) at `points`, skipping any
 * point within `guard` of an input or output boundary, where snapping is allowed to move things.
 */
export function checkRegions(
  op: BinaryOp,
  a: readonly Loop2D[],
  b: readonly Loop2D[],
  out: readonly Loop2D[],
  points: readonly Point2D[],
  guard: number,
): RegionReport {
  const report: RegionReport = { checked: 0, misclassified: 0, badWinding: 0 };
  for (const p of points) {
    if (
      distanceToLoops(p, a) < guard ||
      distanceToLoops(p, b) < guard ||
      distanceToLoops(p, out) < guard
    ) {
      continue;
    }
    report.checked++;
    const expected = OP_PREDICATES[op](windingNumber(p, a) > 0, windingNumber(p, b) > 0);
    const w = windingNumber(p, out);
    if (w !== 0 && w !== 1) report.badWinding++;
    if (w > 0 !== expected) {
      report.misclassified++;
      report.example ??= `(${p.x}, ${p.y}): expected ${expected ? "inside" : "outside"}, output winding ${w}`;
    }
  }
  return report;
}
