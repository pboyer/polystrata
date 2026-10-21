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

export class Prng {
  private state: number;
  constructor(seed = 195939070) {
    this.state = seed | 0 || 1;
  }
  setSeed(seed: number): void {
    this.state = seed | 0 || 1;
  }
  getSeed(): number {
    return this.state >>> 0;
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

export interface WindingOracleProbe {
  pt: Point2D;
  inA: boolean;
  inB: boolean;
  passed: boolean;
}

export interface FuzzTrialRecord {
  trialNumber: number;
  seedBefore: number;
  polyA: Loop2D;
  polyB: Loop2D;
  resUnion: KernelResult;
  resIntersect: KernelResult;
  resDifference: KernelResult;
  resXor: KernelResult;
  manifoldPassed: boolean;
  crossingPassed: boolean;
  areaPassed: boolean;
  windingPassed: boolean;
  allPassed: boolean;
  areaError: number;
  elapsedMs: number;
  probes: WindingOracleProbe[];
}

export interface FuzzCumulativeStats {
  trials: number;
  totalBooleanOps: number;
  manifoldPass: number;
  crossingPass: number;
  areaPass: number;
  windingChecks: number;
  windingPass: number;
  totalElapsedMs: number;
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

export function rawLoopWindingNumber(p: Point2D, loop: ReadonlyArray<Point2D>): number {
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

function minDistanceToLoops(p: Point2D, loops: ReadonlyArray<Loop2D>): number {
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

function checkManifoldAndCrossingFree(
  res: KernelResult,
  tol = 1e-6,
): { manifoldOk: boolean; crossingOk: boolean } {
  const segments: Segment2D[] = [];
  const vertexDegree = new Map<string, { inDeg: number; outDeg: number }>();
  const keyOf = (p: Point2D) => `${p.x.toFixed(7)},${p.y.toFixed(7)}`;

  let manifoldOk = true;
  for (const loop of res.loops) {
    if (loop.length < 3) {
      manifoldOk = false;
      continue;
    }
    const n = loop.length;
    const loopVerts = new Set<string>();
    for (let i = 0; i < n; i++) {
      const p0 = loop[i]!;
      const p1 = loop[(i + 1) % n]!;
      if (!Number.isFinite(p0.x) || !Number.isFinite(p0.y)) {
        manifoldOk = false;
      }
      const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      if (segLen <= 0) {
        manifoldOk = false;
      }
      segments.push({ p0, p1 });

      const k0 = keyOf(p0);
      const k1 = keyOf(p1);
      if (loopVerts.has(k0)) {
        manifoldOk = false;
      }
      loopVerts.add(k0);

      const d0 = vertexDegree.get(k0) ?? { inDeg: 0, outDeg: 0 };
      d0.outDeg++;
      vertexDegree.set(k0, d0);

      const d1 = vertexDegree.get(k1) ?? { inDeg: 0, outDeg: 0 };
      d1.inDeg++;
      vertexDegree.set(k1, d1);
    }
  }

  for (const deg of vertexDegree.values()) {
    if (deg.inDeg !== deg.outDeg) {
      manifoldOk = false;
      break;
    }
  }

  let crossingOk = true;
  for (let i = 0; i < segments.length && crossingOk; i++) {
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
        if (dEndpoint > tol) {
          crossingOk = false;
          break;
        }
      }
    }
  }

  return { manifoldOk, crossingOk };
}

function randomDegeneratePolygon(
  rng: Prng,
  cx: number,
  cy: number,
  radius: number,
  nVerts: number,
): Loop2D {
  const pts: Loop2D = [];
  for (let i = 0; i < nVerts; i++) {
    const baseAngle = (2 * Math.PI * i) / nVerts;
    const angle = baseAngle + rng.range(-0.6, 0.6);
    const r = radius * rng.range(0.18, 1.22);
    pts.push({
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    });
  }
  return pts;
}

export function runSingleFuzzTrial(
  rng: Prng,
  trialNumber: number,
  maxVerts: number,
  degeneracyRatePct: number,
): FuzzTrialRecord {
  const seedBefore = rng.getSeed();
  const nA = rng.int(3, Math.max(4, maxVerts));
  const nB = rng.int(3, Math.max(4, maxVerts));

  const polyA = randomDegeneratePolygon(
    rng,
    rng.range(-10, 10),
    rng.range(-10, 10),
    rng.range(8, 26),
    nA,
  );
  const polyB = randomDegeneratePolygon(
    rng,
    rng.range(-10, 10),
    rng.range(-10, 10),
    rng.range(8, 26),
    nB,
  );

  // Inject adversarial degeneracies according to degeneracyRatePct
  if (rng.range(0, 100) < degeneracyRatePct && polyB.length >= 3) {
    // 1. Nearly coincident vertex between A and B
    polyB[0] = {
      x: polyA[0]!.x + rng.range(-1e-10, 1e-10),
      y: polyA[0]!.y + rng.range(-1e-10, 1e-10),
    };
  }
  if (rng.range(0, 100) < degeneracyRatePct && polyA.length >= 4) {
    // 2. Collinear or near-collinear midpoint along edge 0->1
    const p0 = polyA[0]!;
    const p1 = polyA[1]!;
    polyA.splice(1, 0, {
      x: 0.5 * (p0.x + p1.x) + rng.range(-1e-10, 1e-10),
      y: 0.5 * (p0.y + p1.y) + rng.range(-1e-10, 1e-10),
    });
  }

  const t0 = performance.now();
  const healedA = heal(polyA, { windingRule: "positive" });
  const healedB = heal(polyB, { windingRule: "positive" });
  const resUnion = union(polyA, polyB);
  const resIntersect = intersect(polyA, polyB);
  const resDifference = difference(polyA, polyB);
  const resXor = xor(polyA, polyB);
  const elapsedMs = performance.now() - t0;

  const checks = [
    checkManifoldAndCrossingFree(healedA),
    checkManifoldAndCrossingFree(healedB),
    checkManifoldAndCrossingFree(resUnion),
    checkManifoldAndCrossingFree(resIntersect),
    checkManifoldAndCrossingFree(resDifference),
    checkManifoldAndCrossingFree(resXor),
  ];

  const manifoldPassed = checks.every((c) => c.manifoldOk);
  const crossingPassed = checks.every((c) => c.crossingOk);

  const areaA = totalSignedArea(healedA);
  const areaB = totalSignedArea(healedB);
  const areaU = totalSignedArea(resUnion);
  const areaI = totalSignedArea(resIntersect);
  const areaD = totalSignedArea(resDifference);
  const areaX = totalSignedArea(resXor);

  const err1 = Math.abs(areaU + areaI - (areaA + areaB));
  const err2 = Math.abs(areaD + areaI - areaA);
  const err3 = Math.abs(areaX + 2 * areaI - (areaA + areaB));
  const areaError = Math.max(err1, err2, err3);
  const areaPassed = areaError < 1e-2;

  const allLoops = [polyA, polyB, ...resUnion.loops, ...resIntersect.loops, ...resDifference.loops];
  const probes: WindingOracleProbe[] = [];
  let windingPassed = true;

  for (let s = 0; s < 16; s++) {
    const pt: Point2D = { x: rng.range(-32, 32), y: rng.range(-32, 32) };
    if (minDistanceToLoops(pt, allLoops) < 1e-2) continue;

    const inA = rawLoopWindingNumber(pt, polyA) >= 0.5;
    const inB = rawLoopWindingNumber(pt, polyB) >= 0.5;

    const inU = resultWindingNumber(pt, resUnion) >= 0.5;
    const inI = resultWindingNumber(pt, resIntersect) >= 0.5;
    const inD = resultWindingNumber(pt, resDifference) >= 0.5;
    const inX = resultWindingNumber(pt, resXor) >= 0.5;

    const ok =
      inU === (inA || inB) &&
      inI === (inA && inB) &&
      inD === (inA && !inB) &&
      inX === (inA !== inB);

    if (!ok) windingPassed = false;
    probes.push({ pt, inA, inB, passed: ok });
  }

  return {
    trialNumber,
    seedBefore,
    polyA,
    polyB,
    resUnion,
    resIntersect,
    resDifference,
    resXor,
    manifoldPassed,
    crossingPassed,
    areaPassed,
    windingPassed,
    allPassed: manifoldPassed && crossingPassed && areaPassed && windingPassed,
    areaError,
    elapsedMs,
    probes,
  };
}
