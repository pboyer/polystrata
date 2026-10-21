import { describe, expect, it } from "vitest";
import {
  difference,
  heal,
  intersect,
  type KernelResult,
  type Loop2D,
  type Point2D,
  type Segment2D,
  signedLoopArea,
  union,
  xor,
} from "../src/index.js";

/** Deterministic PRNG (xorshift32) for reproducible fuzz testing. */
class Prng {
  private state: number;
  constructor(seed = 0x12345678) {
    this.state = seed | 0 || 1;
  }
  nextU32(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return x >>> 0;
  }
  nextFloat(): number {
    return this.nextU32() / 0x100000000;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
}

function totalSignedArea(res: KernelResult): number {
  let area = 0;
  for (const loop of res.loops) {
    area += signedLoopArea(loop);
  }
  return area;
}

function pointToSegmentDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function rawLoopWindingNumber(p: Point2D, loop: Loop2D): number {
  let theta = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % n]!;
    const ax = a.x - p.x;
    const ay = a.y - p.y;
    const bx = b.x - p.x;
    const by = b.y - p.y;
    theta += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
  }
  return theta / (2 * Math.PI);
}

function resultWindingNumber(p: Point2D, res: KernelResult): number {
  let w = 0;
  for (const loop of res.loops) {
    w += rawLoopWindingNumber(p, loop);
  }
  return w;
}

function minDistanceToLoops(p: Point2D, loops: Loop2D[]): number {
  let minD = Infinity;
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const d = pointToSegmentDist(p, loop[i]!, loop[(i + 1) % n]!);
      if (d < minD) minD = d;
    }
  }
  return minD;
}

function assertManifoldAndCrossingFree(res: KernelResult, tol = 1e-7): void {
  const segments: Segment2D[] = [];
  const vertexDegree = new Map<string, { inDeg: number; outDeg: number }>();
  const keyOf = (p: Point2D) => `${p.x.toFixed(7)},${p.y.toFixed(7)}`;

  for (const loop of res.loops) {
    expect(loop.length).toBeGreaterThanOrEqual(3);
    const n = loop.length;
    const loopVertSet = new Set<string>();
    for (let i = 0; i < n; i++) {
      const p0 = loop[i]!;
      const p1 = loop[(i + 1) % n]!;
      expect(Number.isFinite(p0.x)).toBe(true);
      expect(Number.isFinite(p0.y)).toBe(true);
      const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      expect(segLen).toBeGreaterThan(0);
      segments.push({ p0, p1 });

      const k0 = keyOf(p0);
      const k1 = keyOf(p1);
      // Every decomposed loop must be strictly simple (no repeated vertices within a single loop)
      expect(loopVertSet.has(k0)).toBe(false);
      loopVertSet.add(k0);

      const d0 = vertexDegree.get(k0) ?? { inDeg: 0, outDeg: 0 };
      d0.outDeg++;
      vertexDegree.set(k0, d0);

      const d1 = vertexDegree.get(k1) ?? { inDeg: 0, outDeg: 0 };
      d1.inDeg++;
      vertexDegree.set(k1, d1);
    }
  }

  // 1. Algebraic chain complex check (d1 * b1 == 0): every vertex has inDeg === outDeg
  for (const deg of vertexDegree.values()) {
    expect(deg.inDeg).toBe(deg.outDeg);
  }

  // 2. No two output segments cross in their strict interiors
  for (let i = 0; i < segments.length; i++) {
    const s1 = segments[i]!;
    for (let j = i + 1; j < segments.length; j++) {
      const s2 = segments[j]!;
      const rx = s1.p1.x - s1.p0.x;
      const ry = s1.p1.y - s1.p0.y;
      const sx = s2.p1.x - s2.p0.x;
      const sy = s2.p1.y - s2.p0.y;
      const denom = rx * sy - ry * sx;
      const lenScale = Math.hypot(rx, ry) * Math.hypot(sx, sy);
      if (lenScale === 0 || Math.abs(denom) <= 1e-11 * lenScale) continue;
      const qpx = s2.p0.x - s1.p0.x;
      const qpy = s2.p0.y - s1.p0.y;
      const t = (qpx * sy - qpy * sx) / denom;
      const u = (qpx * ry - qpy * rx) / denom;
      if (t > 1e-5 && t < 1 - 1e-5 && u > 1e-5 && u < 1 - 1e-5) {
        const ix = s1.p0.x + t * rx;
        const iy = s1.p0.y + t * ry;
        const dEndpoint = Math.min(
          Math.hypot(ix - s1.p0.x, iy - s1.p0.y),
          Math.hypot(ix - s1.p1.x, iy - s1.p1.y),
          Math.hypot(ix - s2.p0.x, iy - s2.p0.y),
          Math.hypot(ix - s2.p1.x, iy - s2.p1.y),
        );
        expect(dEndpoint).toBeLessThanOrEqual(tol);
      }
    }
  }
}

function randomPolygon(rng: Prng, cx: number, cy: number, radius: number, nVerts: number): Loop2D {
  const pts: Loop2D = [];
  for (let i = 0; i < nVerts; i++) {
    // Allow angle jitter to occasionally create self-intersections, spikes, or collinear edges
    const baseAngle = (2 * Math.PI * i) / nVerts;
    const angle = baseAngle + rng.range(-0.6, 0.6);
    const r = radius * rng.range(0.15, 1.2);
    pts.push({
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    });
  }
  return pts;
}

describe("2D Straight-Line B-Rep Kernel - Automated Fuzz & Property Suite", () => {
  it("fuzzes 1,000 random degenerate polygon pairs across Union, Intersect, Difference, XOR, and Heal", () => {
    const rng = new Prng(0xbadcafe);
    const numTrials = 1000;

    for (let trial = 0; trial < numTrials; trial++) {
      const nA = rng.int(3, 9);
      const nB = rng.int(3, 9);
      const polyA = randomPolygon(rng, rng.range(-10, 10), rng.range(-10, 10), rng.range(5, 25), nA);
      const polyB = randomPolygon(rng, rng.range(-10, 10), rng.range(-10, 10), rng.range(5, 25), nB);

      // Inject adversarial degeneracies on 30% of trials (shared vertices, collinear overlaps, micro-slivers)
      if (trial % 3 === 0 && polyB.length >= 3) {
        polyB[0] = { x: polyA[0]!.x + rng.range(-1e-10, 1e-10), y: polyA[0]!.y + rng.range(-1e-10, 1e-10) };
      }
      if (trial % 5 === 0 && polyA.length >= 4) {
        // Insert a collinear or near-collinear midpoint
        const p0 = polyA[0]!;
        const p1 = polyA[1]!;
        polyA.splice(1, 0, {
          x: 0.5 * (p0.x + p1.x) + rng.range(-1e-10, 1e-10),
          y: 0.5 * (p0.y + p1.y) + rng.range(-1e-10, 1e-10),
        });
      }

      const healedA = heal(polyA, { windingRule: "positive" });
      const healedB = heal(polyB, { windingRule: "positive" });
      const resUnion = union(polyA, polyB);
      const resInter = intersect(polyA, polyB);
      const resDiff = difference(polyA, polyB);
      const resXor = xor(polyA, polyB);

      // 1. Manifold & crossing-free invariants on all operations
      assertManifoldAndCrossingFree(healedA);
      assertManifoldAndCrossingFree(healedB);
      assertManifoldAndCrossingFree(resUnion);
      assertManifoldAndCrossingFree(resInter);
      assertManifoldAndCrossingFree(resDiff);
      assertManifoldAndCrossingFree(resXor);

      // 2. Boolean area identities:
      // Area(A | B) + Area(A & B) == Area(Heal(A)) + Area(Heal(B))
      // Area(A - B) + Area(A & B) == Area(Heal(A))
      // Area(A ^ B) + 2 * Area(A & B) == Area(Heal(A)) + Area(Heal(B))
      const areaA = totalSignedArea(healedA);
      const areaB = totalSignedArea(healedB);
      const areaU = totalSignedArea(resUnion);
      const areaI = totalSignedArea(resInter);
      const areaD = totalSignedArea(resDiff);
      const areaX = totalSignedArea(resXor);

      expect(areaU + areaI).toBeCloseTo(areaA + areaB, 3);
      expect(areaD + areaI).toBeCloseTo(areaA, 3);
      expect(areaX + 2 * areaI).toBeCloseTo(areaA + areaB, 3);

      // 3. Point-in-polygon winding oracle at random sample points on every 20th trial
      if (trial % 20 === 0) {
        const allInputLoops = [polyA, polyB, ...resUnion.loops, ...resInter.loops, ...resDiff.loops];
        for (let s = 0; s < 15; s++) {
          const pt: Point2D = { x: rng.range(-35, 35), y: rng.range(-35, 35) };
          if (minDistanceToLoops(pt, allInputLoops) < 1e-3) continue;

          const inA = rawLoopWindingNumber(pt, polyA) >= 0.5;
          const inB = rawLoopWindingNumber(pt, polyB) >= 0.5;

          const inUnion = resultWindingNumber(pt, resUnion) >= 0.5;
          const inInter = resultWindingNumber(pt, resInter) >= 0.5;
          const inDiff = resultWindingNumber(pt, resDiff) >= 0.5;
          const inXor = resultWindingNumber(pt, resXor) >= 0.5;

          expect(inUnion).toBe(inA || inB);
          expect(inInter).toBe(inA && inB);
          expect(inDiff).toBe(inA && !inB);
          expect(inXor).toBe(inA !== inB);
        }
      }
    }
  });

  it("survives starburst torture tests (60 segments intersecting near the origin)", () => {
    const rng = new Prng(0xfeedface);
    const segments: Segment2D[] = [];
    // 30 thin radial wedges meeting with micro-offsets around (0, 0)
    const count = 20;
    for (let i = 0; i < count; i++) {
      const a0 = (2 * Math.PI * i) / count;
      const a1 = a0 + 0.08;
      const ox = rng.range(-1e-6, 1e-6);
      const oy = rng.range(-1e-6, 1e-6);
      const r = 50;
      const p0 = { x: ox, y: oy };
      const p1 = { x: r * Math.cos(a0), y: r * Math.sin(a0) };
      const p2 = { x: r * Math.cos(a1), y: r * Math.sin(a1) };
      segments.push({ p0, p1 }, { p0: p1, p1: p2 }, { p0: p2, p1: p0 });
    }

    const res = heal(segments, { snapTolerance: 1e-5 });
    assertManifoldAndCrossingFree(res, 1e-4);
    expect(totalSignedArea(res)).toBeGreaterThan(100);
  });
});
