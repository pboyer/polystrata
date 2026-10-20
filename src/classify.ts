import type { ConsolidatedComplex } from "./consolidate.js";
import { denormalizePoint, signedLoopArea } from "./tolerance.js";
import type { PlanarTopology } from "./topology.js";
import type {
  KernelResult,
  Loop2D,
  Point2D,
  PolygonWithHoles2D,
  WindingRule,
} from "./types.js";

export type WindingPredicate = (windings: ReadonlyArray<number>) => boolean;

export interface CycleDiagnostic {
  cycleId: number;
  samplePoint: Point2D;
  windings: number[];
  keep: boolean;
}

function raySegmentHitDistance(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r0: number,
): number {
  const sx = bx - ax;
  const sy = by - ay;
  const lenSSq = sx * sx + sy * sy;
  if (lenSSq === 0) return Infinity;

  const denom = dx * sy - dy * sx;
  if (denom * denom > 1e-28 * lenSSq) {
    const qpx = ax - ox;
    const qpy = ay - oy;
    const invDenom = 1 / denom;
    const t = (qpx * sy - qpy * sx) * invDenom;
    if (t <= 0) return Infinity;
    const u = (qpx * dy - qpy * dx) * invDenom;
    if (u < -1e-3 || u > 1.001) return Infinity;
    const lenS = Math.sqrt(lenSSq);
    const tMin = Math.max(1e-3 * r0, 1e-12 * lenS);
    const uSlack = Math.min(1e-3, Math.max(1e-8, r0 / lenS));
    if (t > tMin && u >= -uSlack && u <= 1 + uSlack) {
      return t;
    }
  }
  return Infinity;
}

function pointToSegmentDistanceSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ex = px - ax;
    const ey = py - ay;
    return ex * ex + ey * ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  return ex * ex + ey * ey;
}

let sampleOutX = 0;
let sampleOutY = 0;

/**
 * Pick a guaranteed interior sample point for the region on the left of cycle `cId`
 * using the Left-Normal Ray-Cast strategy pruned by SoA edge AABBs.
 * Writes coordinates to `sampleOutX, sampleOutY`.
 */
function pickCycleSamplePoint(
  cId: number,
  complex: ConsolidatedComplex,
  activeEdgeIds: ReadonlyArray<number>,
): void {
  const { arena, r0 } = complex;
  const vx = arena.vx;
  const vy = arena.vy;
  const ev0 = arena.ev0;
  const ev1 = arena.ev1;
  const eMinX = arena.eMinX;
  const eMinY = arena.eMinY;
  const eMaxX = arena.eMaxX;
  const eMaxY = arena.eMaxY;
  const heCycle = arena.heCycle;
  const cycleHalfEdgesCsr = arena.cycleHalfEdgesCsr;

  const start = arena.cycleStart[cId]!;
  const count = arena.cycleLen[cId]!;

  let bestHe0 = -1;
  let bestLenSq0 = -1;
  let bestBound0 = false;

  for (let i = 0; i < count; i++) {
    const heId = cycleHalfEdgesCsr[start + i]!;
    const eId = heId >> 1;
    const orig = (heId & 1) === 0 ? ev0[eId]! : ev1[eId]!;
    const targ = (heId & 1) === 0 ? ev1[eId]! : ev0[eId]!;
    const dx = vx[targ]! - vx[orig]!;
    const dy = vy[targ]! - vy[orig]!;
    const lenSq = dx * dx + dy * dy;
    if (lenSq <= 0) continue;
    const isBound = heCycle[heId ^ 1] !== cId;

    if (
      bestHe0 === -1 ||
      (isBound && !bestBound0) ||
      (isBound === bestBound0 && lenSq > bestLenSq0)
    ) {
      bestHe0 = heId;
      bestLenSq0 = lenSq;
      bestBound0 = isBound;
    }
  }

  sampleOutX = 0;
  sampleOutY = 0;
  if (bestHe0 === -1 || bestLenSq0 <= 0) return;

  const len = Math.sqrt(bestLenSq0);
  const candEdgeId = bestHe0 >> 1;
  const orig = (bestHe0 & 1) === 0 ? ev0[candEdgeId]! : ev1[candEdgeId]!;
  const targ = (bestHe0 & 1) === 0 ? ev1[candEdgeId]! : ev0[candEdgeId]!;
  const x0 = vx[orig]!;
  const y0 = vy[orig]!;
  const x1 = vx[targ]!;
  const y1 = vy[targ]!;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const mx = 0.5 * (x0 + x1);
  const my = 0.5 * (y0 + y1);
  const nx = -dy / len;
  const ny = dx / len;

  const maxRayT = 0.5 * len;
  const endX = mx + maxRayT * nx;
  const endY = my + maxRayT * ny;
  const rayMinX = (mx < endX ? mx : endX) - r0;
  const rayMinY = (my < endY ? my : endY) - r0;
  const rayMaxX = (mx > endX ? mx : endX) + r0;
  const rayMaxY = (my > endY ? my : endY) + r0;

  let minHitT = Infinity;
  const numActive = activeEdgeIds.length;
  for (let i = 0; i < numActive; i++) {
    const eId = activeEdgeIds[i]!;
    if (eId === candEdgeId) continue;
    if (
      eMaxX[eId]! < rayMinX ||
      eMinX[eId]! > rayMaxX ||
      eMaxY[eId]! < rayMinY ||
      eMinY[eId]! > rayMaxY
    ) {
      continue;
    }
    const u = ev0[eId]!;
    const v = ev1[eId]!;
    const t = raySegmentHitDistance(mx, my, nx, ny, vx[u]!, vy[u]!, vx[v]!, vy[v]!, r0);
    if (t < minHitT) {
      minHitT = t;
    }
  }

  const offset = Number.isFinite(minHitT)
    ? Math.min(0.5 * minHitT, 0.25 * len)
    : 0.2 * len;

  sampleOutX = mx + offset * nx;
  sampleOutY = my + offset * ny;
}

/**
 * Exact subtended-angle winding fallback when a sample point lies within `r0` of an edge
 * or when the input contains unclosed filaments.
 */
function evaluateWindingNumbersSubtendedAngle(
  px: number,
  py: number,
  complex: ConsolidatedComplex,
  activeEdgeIds: ReadonlyArray<number>,
  outWindings: number[],
): void {
  const { arena, bodyCount } = complex;
  const vx = arena.vx;
  const vy = arena.vy;
  const ev0 = arena.ev0;
  const ev1 = arena.ev1;
  const eDeltaW = arena.eDeltaW;

  for (let b = 0; b < bodyCount; b++) {
    outWindings[b] = 0;
  }

  for (let i = 0; i < activeEdgeIds.length; i++) {
    const eId = activeEdgeIds[i]!;
    const u = ev0[eId]!;
    const v = ev1[eId]!;
    const ax = vx[u]! - px;
    const ay = vy[u]! - py;
    const bx = vx[v]! - px;
    const by = vy[v]! - py;
    const dTheta = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    if (dTheta === 0) continue;

    const base = eId * bodyCount;
    for (let b = 0; b < bodyCount; b++) {
      const dw = eDeltaW[base + b]!;
      if (dw !== 0) {
        outWindings[b]! += dw * dTheta;
      }
    }
  }

  const invTwoPi = 1 / (2 * Math.PI);
  for (let b = 0; b < bodyCount; b++) {
    outWindings[b] = outWindings[b]! * invTwoPi;
  }
}

/**
 * Evaluate generalized winding numbers for all bodies at sample point `(px, py)`
 * using an AABB-pruned +X horizontal ray-cast, falling back to exact
 * subtended angle integration only if `(px, py)` is within `r0` of an active edge.
 */
function evaluateWindingNumbers(
  px: number,
  py: number,
  complex: ConsolidatedComplex,
  activeEdgeIds: ReadonlyArray<number>,
  outWindings: number[],
): void {
  const { arena, r0, bodyCount } = complex;
  const vx = arena.vx;
  const vy = arena.vy;
  const ev0 = arena.ev0;
  const ev1 = arena.ev1;
  const eMaxX = arena.eMaxX;
  const eDeltaW = arena.eDeltaW;
  const r0Sq = r0 * r0;
  const minXBound = px - r0;

  for (let b = 0; b < bodyCount; b++) {
    outWindings[b] = 0;
  }

  const numActive = activeEdgeIds.length;
  for (let i = 0; i < numActive; i++) {
    const eId = activeEdgeIds[i]!;
    if (eMaxX[eId]! < minXBound) continue;
    const u = ev0[eId]!;
    const v = ev1[eId]!;
    const y0 = vy[u]!;
    const y1 = vy[v]!;

    const upward = y0 <= py && y1 > py;
    const downward = y1 <= py && y0 > py;
    if (!upward && !downward) continue;

    const x0 = vx[u]!;
    const x1 = vx[v]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const det = dx * (py - y0) - dy * (px - x0);
    const lenSq = dx * dx + dy * dy;

    if (det * det <= r0Sq * lenSq) {
      evaluateWindingNumbersSubtendedAngle(px, py, complex, activeEdgeIds, outWindings);
      return;
    }

    const base = eId * bodyCount;
    if (upward) {
      if (det > 0) {
        for (let b = 0; b < bodyCount; b++) {
          outWindings[b]! += eDeltaW[base + b]!;
        }
      }
    } else {
      if (det < 0) {
        for (let b = 0; b < bodyCount; b++) {
          outWindings[b]! -= eDeltaW[base + b]!;
        }
      }
    }
  }
}

export function applyWindingRule(w: number, rule: WindingRule): boolean {
  switch (rule) {
    case "nonZero":
      return Math.abs(w) >= 0.5;
    case "positive":
      return w >= 0.5;
    case "evenOdd":
      return Math.abs(Math.round(w)) % 2 === 1;
  }
}

let cleanedLoopArea = 0;

/**
 * Clean zero-length steps, 180-degree fold-back spikes, and collinear degree-2 vertices
 * in-place on `vIds` using `vx, vy` TypedArrays before allocating world `Point2D` objects.
 * Writes signed area into `cleanedLoopArea`.
 */
function buildAndCleanWorldLoop(
  vIds: number[],
  vx: Float64Array,
  vy: Float64Array,
  r0: number,
  simplifyCollinear: boolean,
  cx: number,
  cy: number,
): Loop2D | null {
  if (vIds.length < 3) return null;

  const collinearTol = Math.max(r0, 1e-11);
  const collinearTolSq = collinearTol * collinearTol;
  const r0Sq = r0 * r0;

  let changed = true;
  while (changed && vIds.length >= 3) {
    changed = false;
    let writeIdx = 0;
    const n = vIds.length;
    for (let i = 0; i < n; i++) {
      const prevV = writeIdx > 0 ? vIds[writeIdx - 1]! : vIds[(i + n - 1) % n]!;
      const currV = vIds[i]!;
      const nextV = vIds[(i + 1) % n]!;

      const px = vx[prevV]!;
      const py = vy[prevV]!;
      const qx = vx[currV]!;
      const qy = vy[currV]!;
      const rx = vx[nextV]!;
      const ry = vy[nextV]!;

      const ux = qx - px;
      const uy = qy - py;
      const vx0 = rx - qx;
      const vy0 = ry - qy;
      const lenUSq = ux * ux + uy * uy;
      const lenVSq = vx0 * vx0 + vy0 * vy0;

      if (lenUSq <= r0Sq || lenVSq <= r0Sq) {
        changed = true;
        continue;
      }

      const wx = rx - px;
      const wy = ry - py;
      const lenWSq = wx * wx + wy * wy;

      if (lenWSq <= r0Sq) {
        changed = true;
        continue;
      }

      const cross = ux * vy0 - uy * vx0;
      const crossSq = cross * cross;
      const dot = ux * vx0 + uy * vy0;

      const minUVSq = lenUSq < lenVSq ? lenUSq : lenVSq;
      if (dot < 0 && crossSq <= collinearTolSq * minUVSq) {
        changed = true;
        continue;
      }

      if (simplifyCollinear && dot > 0 && crossSq <= collinearTolSq * lenWSq) {
        changed = true;
        continue;
      }

      vIds[writeIdx++] = currV;
    }
    vIds.length = writeIdx;
  }

  const m = vIds.length;
  if (m < 3) return null;

  let area2 = 0;
  for (let i = 0; i < m; i++) {
    const u = vIds[i]!;
    const v = vIds[i + 1 === m ? 0 : i + 1]!;
    area2 += vx[u]! * vy[v]! - vx[v]! * vy[u]!;
  }
  const area = 0.5 * area2;
  if (Math.abs(area) <= r0Sq) return null;

  cleanedLoopArea = area;
  const pts: Point2D[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const v = vIds[i]!;
    pts[i] = { x: vx[v]! + cx, y: vy[v]! + cy };
  }
  return pts;
}

function pointInPolygonLoop(px: number, py: number, ring: ReadonlyArray<Point2D>): boolean {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = ring[i]!;
    const pj = ring[j]!;
    const intersect =
      pi.y > py !== pj.y > py &&
      px < ((pj.x - pi.x) * (py - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pickHoleParentTestPoint(holeLoop: Loop2D, r0: number): Point2D {
  let bestIdx = 0;
  let bestLenSq = -1;
  const n = holeLoop.length;
  for (let i = 0; i < n; i++) {
    const p0 = holeLoop[i]!;
    const p1 = holeLoop[(i + 1) % n]!;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq > bestLenSq) {
      bestLenSq = lenSq;
      bestIdx = i;
    }
  }

  const p0 = holeLoop[bestIdx]!;
  const p1 = holeLoop[(bestIdx + 1) % n]!;
  if (bestLenSq <= 0) return p0;

  const bestLen = Math.sqrt(bestLenSq);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const mx = 0.5 * (p0.x + p1.x);
  const my = 0.5 * (p0.y + p1.y);
  const offset = Math.min(r0 * 2, 0.1 * bestLen);

  return {
    x: mx + offset * (-dy / bestLen),
    y: my + offset * (dx / bestLen),
  };
}

const holeLoopsScratch: Loop2D[] = [];
const holeAreasScratch: number[] = [];
const shellAreasScratch: number[] = [];

export function assignHolesToPolygons(
  polygons: PolygonWithHoles2D[],
  shellAreas: number[],
  holeLoops: Loop2D[],
  holeAreas: number[],
  r0: number,
): void {
  const numShells = polygons.length;
  const numHoles = holeLoops.length;
  if (numHoles === 0 || numShells === 0) return;

  if (numShells === 1) {
    const targetHoles = polygons[0]!.holes;
    for (let i = 0; i < numHoles; i++) {
      targetHoles.push(holeLoops[i]!);
    }
    return;
  }

  // Sort shells ascending by area so each hole matches its smallest enclosing shell
  const order = new Int32Array(numShells);
  const minXArr = new Float64Array(numShells);
  const minYArr = new Float64Array(numShells);
  const maxXArr = new Float64Array(numShells);
  const maxYArr = new Float64Array(numShells);

  for (let i = 0; i < numShells; i++) {
    order[i] = i;
    const ring = polygons[i]!.outer;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k]!;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    minXArr[i] = minX;
    minYArr[i] = minY;
    maxXArr[i] = maxX;
    maxYArr[i] = maxY;
  }

  order.sort((a, b) => shellAreas[a]! - shellAreas[b]!);

  for (let i = 0; i < numHoles; i++) {
    const hLoop = holeLoops[i]!;
    const hArea = holeAreas[i]!;
    const testPt = pickHoleParentTestPoint(hLoop, r0);
    const tx = testPt.x;
    const ty = testPt.y;
    for (let j = 0; j < numShells; j++) {
      const sIdx = order[j]!;
      if (shellAreas[sIdx]! <= hArea) continue;
      if (tx < minXArr[sIdx]! || tx > maxXArr[sIdx]! || ty < minYArr[sIdx]! || ty > maxYArr[sIdx]!) {
        continue;
      }
      if (pointInPolygonLoop(tx, ty, polygons[sIdx]!.outer)) {
        polygons[sIdx]!.holes.push(hLoop);
        break;
      }
    }
  }
}

const pinchStackScratch: number[] = [];

/**
 * Decompose a traced sequence of vertex IDs into strictly simple closed loops
 * by pinching off any sub-cycle whenever a vertex ID is revisited.
 */
function decomposePinchedVertexWalk(
  walkVertexIds: ReadonlyArray<number>,
  indexInStack: Int32Array,
  outSimpleVertexLoops: number[][],
): void {
  if (walkVertexIds.length < 3) return;
  pinchStackScratch.length = 0;

  for (let i = 0; i < walkVertexIds.length; i++) {
    const vId = walkVertexIds[i]!;
    const prevIdx = indexInStack[vId]!;
    if (prevIdx !== -1) {
      const subLoop = pinchStackScratch.slice(prevIdx);
      if (subLoop.length >= 3) {
        outSimpleVertexLoops.push(subLoop);
      }
      for (let k = prevIdx + 1; k < pinchStackScratch.length; k++) {
        indexInStack[pinchStackScratch[k]!] = -1;
      }
      pinchStackScratch.length = prevIdx + 1;
    } else {
      indexInStack[vId] = pinchStackScratch.length;
      pinchStackScratch.push(vId);
    }
  }

  for (let i = 0; i < pinchStackScratch.length; i++) {
    indexInStack[pinchStackScratch[i]!] = -1;
  }

  if (pinchStackScratch.length >= 3) {
    outSimpleVertexLoops.push(pinchStackScratch);
  }
}

const activeEdgeIdsScratch: number[] = [];
const activeSpokesScratch: number[] = [];
const simpleVertexLoopsScratch: number[][] = [];
const windingScratch: number[] = [];

/**
 * Stage 4: Classify planar regions by winding predicate via O(C + E) Dual-Graph BFS,
 * extract boundary half-edges via `leftKeep !== rightKeep`, relink alternating spokes,
 * decompose pinch vertices, and assemble closed output loops and polygons.
 */
export function classifyAndExtract(
  complex: ConsolidatedComplex,
  topology: PlanarTopology,
  predicate: WindingPredicate,
  cx: number,
  cy: number,
  simplifyCollinear = true,
  outDiagnostics?: CycleDiagnostic[],
): KernelResult {
  const { arena, vertexCount, edgeCount, r0, bodyCount } = complex;
  const { halfEdgeCount, cycleCount } = topology;

  if (edgeCount === 0 || cycleCount === 0) {
    return { polygons: [], loops: [] };
  }

  const vx = arena.vx;
  const vy = arena.vy;
  const vAlive = arena.vAlive;
  const vSpokeOffset = arena.vSpokeOffset;
  const vSpokeCount = arena.vSpokeCount;
  const spokesCsr = arena.spokesCsr;

  const ev0 = arena.ev0;
  const ev1 = arena.ev1;
  const eAlive = arena.eAlive;
  const eDeltaW = arena.eDeltaW;

  const heNext = arena.heNext;
  const heCycle = arena.heCycle;
  const heInOutput = arena.heInOutput;
  const heVisited = arena.heVisited;

  const cycleStart = arena.cycleStart;
  const cycleLen = arena.cycleLen;
  const cycleHalfEdgesCsr = arena.cycleHalfEdgesCsr;
  const cycleKeep = arena.cycleKeep;
  const cycleVisited = arena.cycleVisited;
  const cycleWindings = arena.cycleWindings;

  activeEdgeIdsScratch.length = 0;

  const neededNetW = vertexCount * bodyCount;
  if (arena.vertexNetWinding.length < neededNetW) {
    arena.vertexNetWinding = new Int32Array(Math.max(1024, neededNetW * 2));
  }
  const vertexNetWinding = arena.vertexNetWinding;
  vertexNetWinding.fill(0, 0, neededNetW);

  for (let i = 0; i < edgeCount; i++) {
    if (!eAlive[i]) continue;
    activeEdgeIdsScratch.push(i);
    const u = ev0[i]!;
    const v = ev1[i]!;
    const base0 = u * bodyCount;
    const base1 = v * bodyCount;
    const eBase = i * bodyCount;
    for (let b = 0; b < bodyCount; b++) {
      const dw = eDeltaW[eBase + b]!;
      vertexNetWinding[base0 + b]! -= dw;
      vertexNetWinding[base1 + b]! += dw;
    }
  }

  if (activeEdgeIdsScratch.length === 0) {
    return { polygons: [], loops: [] };
  }

  let isClosedChain = true;
  for (let i = 0; i < neededNetW; i++) {
    if (vertexNetWinding[i] !== 0) {
      isClosedChain = false;
      break;
    }
  }

  windingScratch.length = bodyCount;
  for (let b = 0; b < bodyCount; b++) windingScratch[b] = 0;

  // 1. Classify each half-edge cycle's region on its left
  if (isClosedChain && outDiagnostics === undefined) {
    cycleVisited.fill(0, 0, cycleCount);
    const bfsQueue = arena.bfsQueue;

    for (let startCid = 0; startCid < cycleCount; startCid++) {
      if (cycleVisited[startCid]) continue;

      pickCycleSamplePoint(startCid, complex, activeEdgeIdsScratch);
      evaluateWindingNumbers(
        sampleOutX,
        sampleOutY,
        complex,
        activeEdgeIdsScratch,
        windingScratch,
      );

      cycleVisited[startCid] = 1;
      const baseStart = startCid * bodyCount;
      for (let b = 0; b < bodyCount; b++) {
        const wInt = Math.round(windingScratch[b]!);
        cycleWindings[baseStart + b] = wInt;
        windingScratch[b] = wInt;
      }
      cycleKeep[startCid] = predicate(windingScratch) ? 1 : 0;

      bfsQueue.length = 0;
      bfsQueue.push(startCid);
      let head = 0;

      while (head < bfsQueue.length) {
        const currCid = bfsQueue[head++]!;
        const currBase = currCid * bodyCount;
        const cStart = cycleStart[currCid]!;
        const cLen = cycleLen[currCid]!;

        for (let i = 0; i < cLen; i++) {
          const heId = cycleHalfEdgesCsr[cStart + i]!;
          const nextCid = heCycle[heId ^ 1]!;
          if (nextCid === -1 || cycleVisited[nextCid]) continue;

          cycleVisited[nextCid] = 1;
          const eBase = (heId >> 1) * bodyCount;
          const stepSign = (heId & 1) === 0 ? -1 : 1;
          const nextBase = nextCid * bodyCount;

          for (let b = 0; b < bodyCount; b++) {
            const nw = cycleWindings[currBase + b]! + stepSign * eDeltaW[eBase + b]!;
            cycleWindings[nextBase + b] = nw;
            windingScratch[b] = nw;
          }
          cycleKeep[nextCid] = predicate(windingScratch) ? 1 : 0;
          bfsQueue.push(nextCid);
        }
      }
    }
  } else {
    for (let cId = 0; cId < cycleCount; cId++) {
      pickCycleSamplePoint(cId, complex, activeEdgeIdsScratch);
      if (isClosedChain) {
        evaluateWindingNumbers(
          sampleOutX,
          sampleOutY,
          complex,
          activeEdgeIdsScratch,
          windingScratch,
        );
      } else {
        evaluateWindingNumbersSubtendedAngle(
          sampleOutX,
          sampleOutY,
          complex,
          activeEdgeIdsScratch,
          windingScratch,
        );
      }
      const keep = predicate(windingScratch);
      cycleKeep[cId] = keep ? 1 : 0;
      if (outDiagnostics !== undefined) {
        outDiagnostics.push({
          cycleId: cId,
          samplePoint: denormalizePoint({ x: sampleOutX, y: sampleOutY }, cx, cy),
          windings: windingScratch.map((w) => Math.round(w * 100) / 100),
          keep,
        });
      }
    }
  }

  // 2. Algebraic boundary extraction: keep half-edge iff leftKeep && !rightKeep
  for (let i = 0; i < activeEdgeIdsScratch.length; i++) {
    const eId = activeEdgeIdsScratch[i]!;
    const heFwd = eId << 1;
    const heRev = heFwd + 1;
    const leftKeep = cycleKeep[heCycle[heFwd]!] === 1;
    const rightKeep = cycleKeep[heCycle[heRev]!] === 1;

    heInOutput[heFwd] = leftKeep && !rightKeep ? 1 : 0;
    heInOutput[heRev] = !leftKeep && rightKeep ? 1 : 0;
    heNext[heFwd] = -1;
    heNext[heRev] = -1;
  }

  // 3. Relink `heNext` strictly among surviving `heInOutput` spokes around each vertex
  for (let vId = 0; vId < vertexCount; vId++) {
    const k = vSpokeCount[vId]!;
    if (!vAlive[vId] || k === 0) continue;
    const offset = vSpokeOffset[vId]!;

    activeSpokesScratch.length = 0;
    for (let i = 0; i < k; i++) {
      const outHe = spokesCsr[offset + i]!;
      const inHe = outHe ^ 1;
      if (heInOutput[outHe]) {
        activeSpokesScratch.push(outHe);
      } else if (heInOutput[inHe]) {
        activeSpokesScratch.push(inHe);
      }
    }

    const m = activeSpokesScratch.length;
    if (m === 0) continue;

    for (let i = 0; i < m; i++) {
      const heId = activeSpokesScratch[i]!;
      const eId = heId >> 1;
      const target = (heId & 1) === 0 ? ev1[eId]! : ev0[eId]!;
      if (target === vId) {
        heNext[heId] = activeSpokesScratch[i === 0 ? m - 1 : i - 1]!;
      }
    }
  }

  // 4. Trace closed boundary loops from surviving half-edges and decompose any pinch vertices
  heVisited.fill(0, 0, halfEdgeCount);
  const indexInStack = arena.indexInStack;
  const walkVertexIds = arena.walkVertexIds;
  const rawLoops: Loop2D[] = [];
  const polygons: PolygonWithHoles2D[] = [];
  shellAreasScratch.length = 0;
  holeLoopsScratch.length = 0;
  holeAreasScratch.length = 0;

  for (let heId = 0; heId < halfEdgeCount; heId++) {
    if (!heInOutput[heId] || heVisited[heId]) continue;

    walkVertexIds.length = 0;
    let curr = heId;
    while (curr !== -1 && !heVisited[curr]) {
      heVisited[curr] = 1;
      const eId = curr >> 1;
      const origin = (curr & 1) === 0 ? ev0[eId]! : ev1[eId]!;
      walkVertexIds.push(origin);
      curr = heNext[curr]!;
    }

    if (walkVertexIds.length < 3) continue;
    simpleVertexLoopsScratch.length = 0;
    decomposePinchedVertexWalk(walkVertexIds, indexInStack, simpleVertexLoopsScratch);

    for (let s = 0; s < simpleVertexLoopsScratch.length; s++) {
      const vIds = simpleVertexLoopsScratch[s]!;
      const worldLoop = buildAndCleanWorldLoop(
        vIds,
        vx,
        vy,
        r0,
        simplifyCollinear,
        cx,
        cy,
      );
      if (worldLoop !== null) {
        rawLoops.push(worldLoop);
        if (cleanedLoopArea > 0) {
          polygons.push({ outer: worldLoop, holes: [] });
          shellAreasScratch.push(cleanedLoopArea);
        } else {
          holeLoopsScratch.push(worldLoop);
          holeAreasScratch.push(-cleanedLoopArea);
        }
      }
    }
  }

  if (holeLoopsScratch.length > 0) {
    assignHolesToPolygons(
      polygons,
      shellAreasScratch,
      holeLoopsScratch,
      holeAreasScratch,
      r0,
    );
  }

  return {
    polygons,
    loops: rawLoops,
  };
}
