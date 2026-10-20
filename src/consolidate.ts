import type { KernelArena } from "./arena.js";
import type { NormalizedContext } from "./tolerance.js";

export interface ConsolidatedComplex {
  arena: KernelArena;
  vertexCount: number;
  edgeCount: number;
  r0: number;
  rMax: number;
  cellSize: number;
  bodyCount: number;
}

function resolveCanonicalVertex(parents: Int32Array, v: number): number {
  let root = v;
  while (parents[root]! !== root) {
    root = parents[root]!;
  }
  let curr = v;
  while (curr !== root) {
    const nxt = parents[curr]!;
    parents[curr] = root;
    curr = nxt;
  }
  return root;
}

/**
 * Sqrt-free T-junction projection check: returns parameter `t` in (0, 1) if `(px, py)`
 * projects strictly onto the interior of `(ax, ay) -> (bx, by)` within `tol`, else `-1`.
 */
function projectPointToSegmentT(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  tol: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return -1;

  const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t <= 0 || t >= 1) return -1;

  const ex = px - (ax + t * dx);
  const ey = py - (ay + t * dy);
  if (ex * ex + ey * ey <= tol * tol) {
    return t;
  }
  return -1;
}

let hitS = 0;
let hitT = 0;
let hitX = 0;
let hitY = 0;

/**
 * Zero-allocation interior segment-segment intersection test.
 * Writes intersection results into module-level `hitS, hitT, hitX, hitY` on hit.
 */
function intersectSegmentsInteriorFast(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  r0: number,
): boolean {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return false;

  const qpx = cx - ax;
  const qpy = cy - ay;
  const invDenom = 1 / denom;
  const sRaw = (qpx * sy - qpy * sx) * invDenom;
  if (sRaw < -0.5 || sRaw > 1.5) return false;
  const tRaw = (qpx * ry - qpy * rx) * invDenom;
  if (tRaw < -0.5 || tRaw > 1.5) return false;

  const lenRSq = rx * rx + ry * ry;
  const lenSSq = sx * sx + sy * sy;
  const lenScaleSq = lenRSq * lenSSq;
  if (lenScaleSq === 0 || denom * denom <= 1e-30 * lenScaleSq) {
    return false;
  }

  if (sRaw > 0 && sRaw < 1 && tRaw > 0 && tRaw < 1) {
    hitS = sRaw;
    hitT = tRaw;
    hitX = ax + 0.5 * (sRaw * rx + (qpx + tRaw * sx));
    hitY = ay + 0.5 * (sRaw * ry + (qpy + tRaw * sy));
    return true;
  }

  const lenR = Math.sqrt(lenRSq);
  const lenS = Math.sqrt(lenSSq);
  const sSlack = r0 / lenR;
  const tSlack = r0 / lenS;
  if (
    sRaw > -sSlack &&
    sRaw < 1 + sSlack &&
    tRaw > -tSlack &&
    tRaw < 1 + tSlack
  ) {
    const s = sRaw < 1e-7 ? 1e-7 : sRaw > 1 - 1e-7 ? 1 - 1e-7 : sRaw;
    const t = tRaw < 1e-7 ? 1e-7 : tRaw > 1 - 1e-7 ? 1 - 1e-7 : tRaw;
    const px = ax + s * rx;
    const py = ay + s * ry;
    const qx = cx + t * sx;
    const qy = cy + t * sy;
    const ddx = px - qx;
    const ddy = py - qy;
    if (ddx * ddx + ddy * ddy <= r0 * r0) {
      hitS = s;
      hitT = t;
      hitX = 0.5 * (px + qx);
      hitY = 0.5 * (py + qy);
      return true;
    }
  }

  return false;
}

const qStackLo = new Int32Array(64);
const qStackHi = new Int32Array(64);

/**
 * Zero-allocation in-place iterative quicksort + insertion sort of `indices[0..count-1]`
 * ordered ascending by `keys[indices[i]]`.
 */
function sortIndicesByFloat(indices: Int32Array, keys: Float64Array, count: number): void {
  if (count <= 1) return;
  if (count <= 24) {
    for (let i = 1; i < count; i++) {
      const idx = indices[i]!;
      const k = keys[idx]!;
      let j = i - 1;
      while (j >= 0 && keys[indices[j]!]! > k) {
        indices[j + 1] = indices[j]!;
        j--;
      }
      indices[j + 1] = idx;
    }
    return;
  }

  qStackLo[0] = 0;
  qStackHi[0] = count - 1;
  let sp = 1;

  while (sp > 0) {
    sp--;
    const lo = qStackLo[sp]!;
    const hi = qStackHi[sp]!;
    if (hi - lo <= 20) {
      for (let i = lo + 1; i <= hi; i++) {
        const idx = indices[i]!;
        const k = keys[idx]!;
        let j = i - 1;
        while (j >= lo && keys[indices[j]!]! > k) {
          indices[j + 1] = indices[j]!;
          j--;
        }
        indices[j + 1] = idx;
      }
      continue;
    }

    const mid = (lo + hi) >> 1;
    const pivot = keys[indices[mid]!]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (keys[indices[i]!]! < pivot) i++;
      while (keys[indices[j]!]! > pivot) j--;
      if (i <= j) {
        const tmp = indices[i]!;
        indices[i] = indices[j]!;
        indices[j] = tmp;
        i++;
        j--;
      }
    }

    if (lo < j) {
      qStackLo[sp] = lo;
      qStackHi[sp] = j;
      sp++;
    }
    if (i < hi) {
      qStackLo[sp] = i;
      qStackHi[sp] = hi;
      sp++;
    }
  }
}

// Scratch buffers for sorting and deduplicating splits along a single edge
let splitSortCap = 128;
let splitSortT = new Float64Array(splitSortCap);
let splitSortV = new Int32Array(splitSortCap);
let splitChainV = new Int32Array(splitSortCap + 2);
let splitDeltaWScratch = new Int32Array(32);

function ensureSplitSortScratch(count: number): void {
  if (count <= splitSortCap) return;
  while (splitSortCap < count) splitSortCap <<= 1;
  splitSortT = new Float64Array(splitSortCap);
  splitSortV = new Int32Array(splitSortCap);
  splitChainV = new Int32Array(splitSortCap + 2);
}

function markVertexDirty(arena: KernelArena, vId: number): void {
  if (arena.inZeroVertexQueue[vId] === 0) {
    arena.inZeroVertexQueue[vId] = 1;
    arena.zeroVertexQueue.push(vId);
  }
  if (arena.inStepVertexQueue[vId] === 0) {
    arena.inStepVertexQueue[vId] = 1;
    arena.stepVertexQueue.push(vId);
  }
}

function markStepVertexDirty(arena: KernelArena, vId: number): void {
  if (arena.inStepVertexQueue[vId] === 0) {
    arena.inStepVertexQueue[vId] = 1;
    arena.stepVertexQueue.push(vId);
  }
}

function markEdgeDirty(arena: KernelArena, eId: number): void {
  if (arena.inZeroEdgeQueue[eId] === 0) {
    arena.inZeroEdgeQueue[eId] = 1;
    arena.zeroEdgeQueue.push(eId);
  }
  if (arena.inStepEdgeQueue[eId] === 0) {
    arena.inStepEdgeQueue[eId] = 1;
    arena.stepEdgeQueue.push(eId);
  }
}

function updateEdgeBounds(arena: KernelArena, eId: number): void {
  const u = arena.ev0[eId]!;
  const v = arena.ev1[eId]!;
  const x0 = arena.vx[u]!;
  const y0 = arena.vy[u]!;
  const x1 = arena.vx[v]!;
  const y1 = arena.vy[v]!;
  arena.eMinX[eId] = x0 < x1 ? x0 : x1;
  arena.eMinY[eId] = y0 < y1 ? y0 : y1;
  arena.eMaxX[eId] = x0 > x1 ? x0 : x1;
  arena.eMaxY[eId] = y0 > y1 ? y0 : y1;
}

function linkIncidentEdge(arena: KernelArena, vId: number, eId: number): void {
  const idx = arena.incCount;
  if (idx >= arena.incCap) {
    arena.ensureIncCapacity(idx + 1);
  }
  arena.incCount = idx + 1;
  arena.incEdge[idx] = eId;
  arena.incNext[idx] = arena.vFirstInc[vId]!;
  arena.vFirstInc[vId] = idx;
}

function createEdgeSingleBody(
  arena: KernelArena,
  v0: number,
  v1: number,
  bodyIndex: number,
  bodyCount: number,
): number {
  const id = arena.edgeCount;
  if (id >= arena.edgeCap || (id + 1) * bodyCount > arena.deltaWCap) {
    arena.ensureEdgeCapacity(id + 1, bodyCount);
  }
  arena.edgeCount = id + 1;
  arena.ev0[id] = v0;
  arena.ev1[id] = v1;
  arena.eAlive[id] = 1;
  arena.inZeroEdgeQueue[id] = 0;
  arena.inStepEdgeQueue[id] = 0;
  arena.edgeSplitHead[id] = -1;

  const eDeltaW = arena.eDeltaW;
  const base = id * bodyCount;
  for (let b = 0; b < bodyCount; b++) {
    eDeltaW[base + b] = 0;
  }
  eDeltaW[base + bodyIndex] = 1;

  updateEdgeBounds(arena, id);
  linkIncidentEdge(arena, v0, id);
  linkIncidentEdge(arena, v1, id);
  markEdgeDirty(arena, id);
  return id;
}

function createEdgeFromScratchDeltaW(
  arena: KernelArena,
  v0: number,
  v1: number,
  bodyCount: number,
  markStepDirty: boolean,
): number {
  const id = arena.edgeCount;
  if (id >= arena.edgeCap || (id + 1) * bodyCount > arena.deltaWCap) {
    arena.ensureEdgeCapacity(id + 1, bodyCount);
  }
  arena.edgeCount = id + 1;
  arena.ev0[id] = v0;
  arena.ev1[id] = v1;
  arena.eAlive[id] = 1;
  arena.inZeroEdgeQueue[id] = 0;
  arena.inStepEdgeQueue[id] = 0;
  arena.edgeSplitHead[id] = -1;

  const eDeltaW = arena.eDeltaW;
  const base = id * bodyCount;
  for (let b = 0; b < bodyCount; b++) {
    eDeltaW[base + b] = splitDeltaWScratch[b]!;
  }

  updateEdgeBounds(arena, id);
  linkIncidentEdge(arena, v0, id);
  linkIncidentEdge(arena, v1, id);
  if (markStepDirty) {
    markEdgeDirty(arena, id);
  } else if (arena.inZeroEdgeQueue[id] === 0) {
    arena.inZeroEdgeQueue[id] = 1;
    arena.zeroEdgeQueue.push(id);
  }
  return id;
}

function findOrCreateVertex(
  arena: KernelArena,
  x: number,
  y: number,
  initialVertexRadius: number,
  rMax: number,
  allowWeightedMove: boolean,
): number {
  const searchR = rMax + initialVertexRadius;
  const vertexGrid = arena.vertexGrid;
  const vertexQueryScratch = arena.vertexQueryScratch;
  vertexGrid.queryBox(x - searchR, y - searchR, x + searchR, y + searchR, vertexQueryScratch);

  const vParent = arena.vParent;
  const vAlive = arena.vAlive;
  const vx = arena.vx;
  const vy = arena.vy;
  const vr = arena.vr;
  const vWeight = arena.vWeight;

  let bestId = -1;
  let bestDistSq = Infinity;
  const rMaxSq = rMax * rMax;

  for (let i = 0; i < vertexQueryScratch.length; i++) {
    const candId = resolveCanonicalVertex(vParent, vertexQueryScratch[i]!);
    if (!vAlive[candId]) continue;
    const dx = x - vx[candId]!;
    const dy = y - vy[candId]!;
    const dSq = dx * dx + dy * dy;
    if (dSq > rMaxSq || dSq >= bestDistSq) continue;
    const radSum = vr[candId]! + initialVertexRadius;
    if (dSq <= radSum * radSum) {
      bestDistSq = dSq;
      bestId = candId;
    }
  }

  if (bestId !== -1) {
    if (bestDistSq === 0) {
      if (allowWeightedMove) {
        vWeight[bestId] = vWeight[bestId]! + 1;
      }
      return bestId;
    }
    if (allowWeightedMove) {
      const bestDist = Math.sqrt(bestDistSq);
      const w = vWeight[bestId]!;
      const totalW = w + 1;
      const nx = (vx[bestId]! * w + x) / totalW;
      const ny = (vy[bestId]! * w + y) / totalW;
      const curR = vr[bestId]!;
      const nr = Math.min(rMax, Math.max(curR, 0.5 * (bestDist + curR + initialVertexRadius)));
      vx[bestId] = nx;
      vy[bestId] = ny;
      vWeight[bestId] = totalW;
      vr[bestId] = nr;
      vertexGrid.insertPoint(nx, ny, nr, bestId);
      markVertexDirty(arena, bestId);
    } else {
      markStepVertexDirty(arena, bestId);
    }
    return bestId;
  }

  const id = arena.vertexCount;
  if (id >= arena.vertCap) {
    arena.ensureVertexCapacity(id + 1);
  }
  arena.vertexCount = id + 1;
  arena.vx[id] = x;
  arena.vy[id] = y;
  arena.vr[id] = initialVertexRadius;
  arena.vWeight[id] = 1;
  arena.vAlive[id] = 1;
  arena.vParent[id] = id;
  arena.vFirstInc[id] = -1;
  arena.inZeroVertexQueue[id] = 0;
  arena.inStepVertexQueue[id] = 0;

  vertexGrid.insertPoint(x, y, initialVertexRadius, id);
  if (allowWeightedMove) {
    markStepVertexDirty(arena, id);
  }
  return id;
}

function mergeVertexPair(
  arena: KernelArena,
  idA: number,
  idB: number,
  rMax: number,
): number {
  const vParent = arena.vParent;
  const ca = resolveCanonicalVertex(vParent, idA);
  const cb = resolveCanonicalVertex(vParent, idB);
  if (ca === cb) return ca;
  const keepId = ca < cb ? ca : cb;
  const dropId = ca < cb ? cb : ca;

  const vx = arena.vx;
  const vy = arena.vy;
  const vr = arena.vr;
  const vWeight = arena.vWeight;
  const vAlive = arena.vAlive;
  const vFirstInc = arena.vFirstInc;
  const incEdge = arena.incEdge;
  const incNext = arena.incNext;
  const eAlive = arena.eAlive;
  const ev0 = arena.ev0;
  const ev1 = arena.ev1;

  const kx = vx[keepId]!;
  const ky = vy[keepId]!;
  const dx = vx[dropId]!;
  const dy = vy[dropId]!;
  const d = Math.hypot(dx - kx, dy - ky);
  const kw = vWeight[keepId]!;
  const dw = vWeight[dropId]!;
  const totalW = kw + dw;
  const nkx = (kx * kw + dx * dw) / totalW;
  const nky = (ky * kw + dy * dw) / totalW;
  const kr = vr[keepId]!;
  const dr = vr[dropId]!;
  const nkr = Math.min(rMax, Math.max(kr, dr, 0.5 * (d + kr + dr)));

  vx[keepId] = nkx;
  vy[keepId] = nky;
  vWeight[keepId] = totalW;
  vr[keepId] = nkr;
  vAlive[dropId] = 0;
  vParent[dropId] = keepId;

  arena.vertexGrid.insertPoint(nkx, nky, nkr, keepId);
  markVertexDirty(arena, keepId);

  let curr = vFirstInc[dropId]!;
  vFirstInc[dropId] = -1;
  while (curr !== -1) {
    const nextNode = incNext[curr]!;
    const eId = incEdge[curr]!;
    if (eAlive[eId]) {
      incNext[curr] = vFirstInc[keepId]!;
      vFirstInc[keepId] = curr;
    }
    curr = nextNode;
  }

  let prev = -1;
  let node = vFirstInc[keepId]!;
  while (node !== -1) {
    const nextNode = incNext[node]!;
    const eId = incEdge[node]!;
    if (!eAlive[eId]) {
      if (prev === -1) vFirstInc[keepId] = nextNode;
      else incNext[prev] = nextNode;
      node = nextNode;
      continue;
    }
    const c0 = resolveCanonicalVertex(vParent, ev0[eId]!);
    const c1 = resolveCanonicalVertex(vParent, ev1[eId]!);
    ev0[eId] = c0;
    ev1[eId] = c1;
    if (c0 === c1) {
      eAlive[eId] = 0;
      if (prev === -1) vFirstInc[keepId] = nextNode;
      else incNext[prev] = nextNode;
      node = nextNode;
      continue;
    }
    prev = node;
    updateEdgeBounds(arena, eId);
    markEdgeDirty(arena, eId);
    node = nextNode;
  }

  return keepId;
}

function tryMergeCoincidentWithIncident(
  arena: KernelArena,
  eId: number,
  bodyCount: number,
): boolean {
  const eAlive = arena.eAlive;
  if (!eAlive[eId]) return false;
  const ev0 = arena.ev0;
  const ev1 = arena.ev1;
  const vParent = arena.vParent;
  const incEdge = arena.incEdge;
  const incNext = arena.incNext;
  const eDeltaW = arena.eDeltaW;

  const v0 = ev0[eId]!;
  const v1 = ev1[eId]!;
  let node = arena.vFirstInc[v0]!;
  let merged = false;

  while (node !== -1) {
    const otherId = incEdge[node]!;
    node = incNext[node]!;
    if (otherId === eId || !eAlive[otherId]) continue;

    const ov0 = resolveCanonicalVertex(vParent, ev0[otherId]!);
    const ov1 = resolveCanonicalVertex(vParent, ev1[otherId]!);
    ev0[otherId] = ov0;
    ev1[otherId] = ov1;
    if (ov0 === ov1) {
      eAlive[otherId] = 0;
      merged = true;
      continue;
    }

    const samePair = (ov0 === v0 && ov1 === v1) || (ov0 === v1 && ov1 === v0);
    if (!samePair) continue;

    const keepId = eId < otherId ? eId : otherId;
    const dropId = eId < otherId ? otherId : eId;
    const sign = ev0[keepId] === ev0[dropId] ? 1 : -1;
    const keepBase = keepId * bodyCount;
    const dropBase = dropId * bodyCount;
    for (let b = 0; b < bodyCount; b++) {
      eDeltaW[keepBase + b] = eDeltaW[keepBase + b]! + sign * eDeltaW[dropBase + b]!;
    }
    eAlive[dropId] = 0;
    merged = true;
    if (!eAlive[eId]) break;
  }

  return merged;
}

function drainZeroStrata(arena: KernelArena, rMax: number, bodyCount: number): boolean {
  let anyChanged = false;
  let vHead = 0;
  let eHead = 0;
  const rMaxSq = rMax * rMax;

  const zeroVertexQueue = arena.zeroVertexQueue;
  const zeroEdgeQueue = arena.zeroEdgeQueue;
  const inZeroVertexQueue = arena.inZeroVertexQueue;
  const inZeroEdgeQueue = arena.inZeroEdgeQueue;
  const vertexGrid = arena.vertexGrid;
  const vertexQueryScratch = arena.vertexQueryScratch;

  while (vHead < zeroVertexQueue.length || eHead < zeroEdgeQueue.length) {
    while (vHead < zeroVertexQueue.length) {
      const rawId = zeroVertexQueue[vHead++]!;
      inZeroVertexQueue[rawId] = 0;
      const vParent = arena.vParent;
      const vAlive = arena.vAlive;
      const vId = resolveCanonicalVertex(vParent, rawId);
      if (!vAlive[vId]) continue;

      const vx = arena.vx;
      const vy = arena.vy;
      const vr = arena.vr;
      const x = vx[vId]!;
      const y = vy[vId]!;
      const r = vr[vId]!;
      const searchR = r + rMax;
      vertexGrid.queryBox(x - searchR, y - searchR, x + searchR, y + searchR, vertexQueryScratch);
      for (let k = 0; k < vertexQueryScratch.length; k++) {
        const otherId = resolveCanonicalVertex(vParent, vertexQueryScratch[k]!);
        if (otherId === vId || !vAlive[otherId]) continue;
        const dx = vx[otherId]! - x;
        const dy = vy[otherId]! - y;
        const dSq = dx * dx + dy * dy;
        if (dSq > rMaxSq) continue;
        const radSum = r + vr[otherId]!;
        if (dSq <= radSum * radSum) {
          mergeVertexPair(arena, vId, otherId, rMax);
          anyChanged = true;
          break;
        }
      }
    }

    while (eHead < zeroEdgeQueue.length) {
      const eId = zeroEdgeQueue[eHead++]!;
      inZeroEdgeQueue[eId] = 0;
      const eAlive = arena.eAlive;
      if (!eAlive[eId]) continue;

      const vParent = arena.vParent;
      const ev0 = arena.ev0;
      const ev1 = arena.ev1;
      const vx = arena.vx;
      const vy = arena.vy;
      const vr = arena.vr;

      const c0 = resolveCanonicalVertex(vParent, ev0[eId]!);
      const c1 = resolveCanonicalVertex(vParent, ev1[eId]!);
      if (c0 !== ev0[eId] || c1 !== ev1[eId]) {
        ev0[eId] = c0;
        ev1[eId] = c1;
        updateEdgeBounds(arena, eId);
        anyChanged = true;
      }
      if (c0 === c1) {
        eAlive[eId] = 0;
        anyChanged = true;
        continue;
      }

      const dx = vx[c1]! - vx[c0]!;
      const dy = vy[c1]! - vy[c0]!;
      const lenSq = dx * dx + dy * dy;
      const radSum = vr[c0]! + vr[c1]!;
      if (lenSq <= rMaxSq && lenSq <= radSum * radSum) {
        eAlive[eId] = 0;
        mergeVertexPair(arena, c0, c1, rMax);
        anyChanged = true;
        continue;
      }

      if (tryMergeCoincidentWithIncident(arena, eId, bodyCount)) {
        anyChanged = true;
      }
    }
  }

  zeroVertexQueue.length = 0;
  zeroEdgeQueue.length = 0;
  return anyChanged;
}

function recordSplit(arena: KernelArena, edgeId: number, t: number, vertexId: number): void {
  const head = arena.edgeSplitHead[edgeId]!;
  if (head === -1) {
    const listIdx = arena.splitEdgeListCount;
    if (listIdx >= arena.splitCap) {
      arena.ensureSplitCapacity(listIdx + 1);
    }
    arena.splitEdgeListCount = listIdx + 1;
    arena.splitEdgeList[listIdx] = edgeId;
  } else {
    const splitVert = arena.splitVert;
    const splitNext = arena.splitNext;
    let cur = head;
    while (cur !== -1) {
      if (splitVert[cur] === vertexId) return;
      cur = splitNext[cur]!;
    }
  }

  const sIdx = arena.splitCount;
  if (sIdx >= arena.splitCap) {
    arena.ensureSplitCapacity(sIdx + 1);
  }
  arena.splitCount = sIdx + 1;
  arena.splitT[sIdx] = t;
  arena.splitVert[sIdx] = vertexId;
  arena.splitNext[sIdx] = head;
  arena.edgeSplitHead[edgeId] = sIdx;
}

function applyEdgeSplits(arena: KernelArena, bodyCount: number, markStepDirty: boolean): boolean {
  const numSplitEdges = arena.splitEdgeListCount;
  if (numSplitEdges === 0) return false;
  let anySplit = false;

  const splitEdgeList = arena.splitEdgeList;
  const splitT = arena.splitT;
  const splitVert = arena.splitVert;
  const splitNext = arena.splitNext;

  for (let idx = 0; idx < numSplitEdges; idx++) {
    const edgeId = splitEdgeList[idx]!;
    let head = arena.edgeSplitHead[edgeId]!;
    arena.edgeSplitHead[edgeId] = -1;
    if (!arena.eAlive[edgeId] || head === -1) continue;

    let count = 0;
    while (head !== -1) {
      if (count >= splitSortCap) {
        ensureSplitSortScratch(count + 1);
      }
      const tVal = splitT[head]!;
      const vVal = splitVert[head]!;
      let pos = count;
      while (pos > 0 && splitSortT[pos - 1]! > tVal) {
        splitSortT[pos] = splitSortT[pos - 1]!;
        splitSortV[pos] = splitSortV[pos - 1]!;
        pos--;
      }
      splitSortT[pos] = tVal;
      splitSortV[pos] = vVal;
      count++;
      head = splitNext[head]!;
    }

    const startV = arena.ev0[edgeId]!;
    const endV = arena.ev1[edgeId]!;
    const vParent = arena.vParent;
    splitChainV[0] = startV;
    let chainLen = 1;

    for (let i = 0; i < count; i++) {
      const vid = resolveCanonicalVertex(vParent, splitSortV[i]!);
      if (vid === endV || vid === splitChainV[chainLen - 1]) continue;
      let dup = false;
      for (let j = 0; j < chainLen; j++) {
        if (splitChainV[j] === vid) {
          dup = true;
          break;
        }
      }
      if (!dup) {
        splitChainV[chainLen++] = vid;
      }
    }
    splitChainV[chainLen++] = endV;

    if (chainLen <= 2) continue;

    arena.eAlive[edgeId] = 0;
    anySplit = true;

    const eDeltaW = arena.eDeltaW;
    const base = edgeId * bodyCount;
    for (let b = 0; b < bodyCount; b++) {
      splitDeltaWScratch[b] = eDeltaW[base + b]!;
    }

    for (let i = 0; i < chainLen - 1; i++) {
      const u = splitChainV[i]!;
      const v = splitChainV[i + 1]!;
      if (u === v) continue;
      createEdgeFromScratchDeltaW(arena, u, v, bodyCount, markStepDirty);
    }
  }

  arena.splitCount = 0;
  arena.splitEdgeListCount = 0;
  return anySplit;
}

function buildSortedActiveEdges(arena: KernelArena): number {
  const sortedEdges = arena.sortedEdges;
  const eAlive = arena.eAlive;
  const eMinX = arena.eMinX;
  const totalEdges = arena.edgeCount;
  let count = 0;
  for (let eId = 0; eId < totalEdges; eId++) {
    if (eAlive[eId]) {
      sortedEdges[count++] = eId;
    }
  }
  sortIndicesByFloat(sortedEdges, eMinX, count);
  return count;
}

function buildSortedActiveVerts(arena: KernelArena): number {
  const sortedVerts = arena.sortedVerts;
  const vAlive = arena.vAlive;
  const vx = arena.vx;
  const totalVerts = arena.vertexCount;
  let count = 0;
  for (let vId = 0; vId < totalVerts; vId++) {
    if (vAlive[vId]) {
      sortedVerts[count++] = vId;
    }
  }
  sortIndicesByFloat(sortedVerts, vx, count);
  return count;
}

/**
 * Stage 1 & 2: Build and consolidate the 2D Stratified Tolerance Complex using
 * Struct-of-Arrays (SoA) arena buffers, intrusive incidence linked lists,
 * single-cell vertex spatial hashing, and 1D Sort-and-Sweep over edge AABBs.
 */
export function consolidateComplex(ctx: NormalizedContext): ConsolidatedComplex {
  const { arena, r0, rMax, cellSize, bodyCount, segmentCount } = ctx;
  const initialCap = Math.max(64, segmentCount * 2 + 16);

  arena.vertexCount = 0;
  arena.edgeCount = 0;
  arena.incCount = 0;
  arena.splitCount = 0;
  arena.splitEdgeListCount = 0;

  arena.ensureVertexCapacity(initialCap);
  arena.ensureEdgeCapacity(initialCap, bodyCount);
  arena.ensureIncCapacity(initialCap * 2);

  if (bodyCount > splitDeltaWScratch.length) {
    splitDeltaWScratch = new Int32Array(bodyCount * 2);
  }

  const initialVertexRadius = 0.5 * r0;
  arena.vertexGrid.reset(cellSize, initialCap);

  const zeroVertexQueue = arena.zeroVertexQueue;
  const zeroEdgeQueue = arena.zeroEdgeQueue;
  const stepVertexQueue = arena.stepVertexQueue;
  const stepEdgeQueue = arena.stepEdgeQueue;
  const dirtyVerts = arena.dirtyVertsScratch;
  const dirtyEdges = arena.dirtyEdgesScratch;

  zeroVertexQueue.length = 0;
  zeroEdgeQueue.length = 0;
  stepVertexQueue.length = 0;
  stepEdgeQueue.length = 0;

  // Stage 1: Inject raw segments from arena with consecutive loop-vertex chaining
  const rawX0 = arena.rawX0;
  const rawY0 = arena.rawY0;
  const rawX1 = arena.rawX1;
  const rawY1 = arena.rawY1;
  const rawBody = arena.rawBody;

  let prevX = NaN;
  let prevY = NaN;
  let prevV = -1;
  let loopStartX = NaN;
  let loopStartY = NaN;
  let loopStartV = -1;

  for (let i = 0; i < segmentCount; i++) {
    const x0 = rawX0[i]!;
    const y0 = rawY0[i]!;
    const x1 = rawX1[i]!;
    const y1 = rawY1[i]!;

    let v0: number;
    if (x0 === prevX && y0 === prevY && prevV !== -1 && arena.vAlive[prevV]) {
      v0 = prevV;
      arena.vWeight[v0] = arena.vWeight[v0]! + 1;
    } else {
      v0 = findOrCreateVertex(arena, x0, y0, initialVertexRadius, rMax, true);
      loopStartX = x0;
      loopStartY = y0;
      loopStartV = v0;
    }

    let v1: number;
    if (x1 === loopStartX && y1 === loopStartY && loopStartV !== -1 && arena.vAlive[loopStartV]) {
      v1 = loopStartV;
      arena.vWeight[v1] = arena.vWeight[v1]! + 1;
      prevV = -1;
    } else {
      v1 = findOrCreateVertex(arena, x1, y1, initialVertexRadius, rMax, true);
      prevX = x1;
      prevY = y1;
      prevV = v1;
    }

    if (v0 === v1) continue;
    createEdgeSingleBody(arena, v0, v1, rawBody[i]!, bodyCount);
  }

  const maxIterations = 64;

  for (let iter = 0; iter < maxIterations; iter++) {
    let iterChanged = false;

    if (drainZeroStrata(arena, rMax, bodyCount)) {
      iterChanged = true;
    }

    if (stepVertexQueue.length === 0 && stepEdgeQueue.length === 0) {
      break;
    }

    let stepStamp = (arena.crossingStampGen + 1) >>> 0;
    if (stepStamp === 0) {
      arena.edgeCrossingStamp.fill(0);
      arena.vertStepStamp.fill(0);
      stepStamp = 1;
    }
    arena.crossingStampGen = stepStamp;
    const edgeCrossingStamp = arena.edgeCrossingStamp;
    const vertStepStamp = arena.vertStepStamp;
    const inStepVertexQueue = arena.inStepVertexQueue;
    const inStepEdgeQueue = arena.inStepEdgeQueue;
    const vParent = arena.vParent;
    const vAlive = arena.vAlive;
    const eAlive = arena.eAlive;

    dirtyVerts.length = 0;
    for (let i = 0; i < stepVertexQueue.length; i++) {
      const rawV = stepVertexQueue[i]!;
      inStepVertexQueue[rawV] = 0;
      const vId = resolveCanonicalVertex(vParent, rawV);
      if (vAlive[vId] && vertStepStamp[vId] !== stepStamp) {
        vertStepStamp[vId] = stepStamp;
        dirtyVerts.push(vId);
      }
    }
    stepVertexQueue.length = 0;

    dirtyEdges.length = 0;
    for (let i = 0; i < stepEdgeQueue.length; i++) {
      const eId = stepEdgeQueue[i]!;
      inStepEdgeQueue[eId] = 0;
      if (eAlive[eId]) {
        edgeCrossingStamp[eId] = stepStamp;
        dirtyEdges.push(eId);
      }
    }
    stepEdgeQueue.length = 0;

    let activeEdgeCount = buildSortedActiveEdges(arena);

    // Operator 3a & 3b: Unified Two-Pointer 1D X-Sweep between sortedEdges and sortedVerts
    if (dirtyVerts.length > 0 || (iter > 0 && dirtyEdges.length > 0)) {
      const activeVertCount = buildSortedActiveVerts(arena);
      const sortedEdges = arena.sortedEdges;
      const sortedVerts = arena.sortedVerts;
      const vx = arena.vx;
      const vy = arena.vy;
      const vr = arena.vr;
      const ev0 = arena.ev0;
      const ev1 = arena.ev1;
      const eMinX = arena.eMinX;
      const eMinY = arena.eMinY;
      const eMaxX = arena.eMaxX;
      const eMaxY = arena.eMaxY;
      const maxTol = rMax + initialVertexRadius;
      const hasDirtyVerts = dirtyVerts.length > 0;
      let dvMinX = Infinity;
      let dvMaxX = -Infinity;
      let dvMinY = Infinity;
      let dvMaxY = -Infinity;
      if (iter > 0 && hasDirtyVerts) {
        for (let d = 0; d < dirtyVerts.length; d++) {
          const dv = dirtyVerts[d]!;
          const x = vx[dv]!;
          const y = vy[dv]!;
          if (x < dvMinX) dvMinX = x;
          if (x > dvMaxX) dvMaxX = x;
          if (y < dvMinY) dvMinY = y;
          if (y > dvMaxY) dvMaxY = y;
        }
      }
      let vStart = 0;

      for (let i = 0; i < activeEdgeCount; i++) {
        const edgeId = sortedEdges[i]!;
        const edgeDirty = iter === 0 || edgeCrossingStamp[edgeId] === stepStamp;
        if (!edgeDirty) {
          if (!hasDirtyVerts) continue;
          if (
            eMaxX[edgeId]! + maxTol < dvMinX ||
            eMinX[edgeId]! - maxTol > dvMaxX ||
            eMaxY[edgeId]! + maxTol < dvMinY ||
            eMinY[edgeId]! - maxTol > dvMaxY
          ) {
            continue;
          }
        }
        const xStart = eMinX[edgeId]! - maxTol;

        while (vStart < activeVertCount && vx[sortedVerts[vStart]!]! < xStart) {
          vStart++;
        }

        const xEnd = eMaxX[edgeId]! + maxTol;
        const minY = eMinY[edgeId]!;
        const maxY = eMaxY[edgeId]!;
        const u = ev0[edgeId]!;
        const v = ev1[edgeId]!;
        const ax = vx[u]!;
        const ay = vy[u]!;
        const bx = vx[v]!;
        const by = vy[v]!;

        for (let k = vStart; k < activeVertCount; k++) {
          const vId = sortedVerts[k]!;
          const px = vx[vId]!;
          if (px > xEnd) break;
          if (!edgeDirty && vertStepStamp[vId] !== stepStamp) continue;
          if (vId === u || vId === v) continue;
          const tol = vr[vId]! + initialVertexRadius;
          const py = vy[vId]!;
          if (py < minY - tol || py > maxY + tol) continue;
          const t = projectPointToSegmentT(px, py, ax, ay, bx, by, tol);
          if (t > 0) {
            recordSplit(arena, edgeId, t, vId);
          }
        }
      }
    }

    if (applyEdgeSplits(arena, bodyCount, true)) {
      iterChanged = true;
      drainZeroStrata(arena, rMax, bodyCount);
      const currentEdgeCrossingStamp = arena.edgeCrossingStamp;
      const curInStepE = arena.inStepEdgeQueue;
      const curEAlive = arena.eAlive;
      for (let i = 0; i < stepEdgeQueue.length; i++) {
        const eId = stepEdgeQueue[i]!;
        curInStepE[eId] = 0;
        if (curEAlive[eId]) {
          currentEdgeCrossingStamp[eId] = stepStamp;
          dirtyEdges.push(eId);
        }
      }
      stepEdgeQueue.length = 0;
      const curInStepV = arena.inStepVertexQueue;
      for (let i = 0; i < stepVertexQueue.length; i++) {
        curInStepV[stepVertexQueue[i]!] = 0;
      }
      stepVertexQueue.length = 0;
      activeEdgeCount = buildSortedActiveEdges(arena);
    }

    // Operator 4b: Interior Segment-Segment Crossings via 1D X-Sweep over sortedEdges
    if (dirtyEdges.length > 0) {
      const sortedEdges = arena.sortedEdges;
      const currentEdgeCrossingStamp = arena.edgeCrossingStamp;
      let deMinX = Infinity;
      let deMaxX = -Infinity;
      let deMinY = Infinity;
      let deMaxY = -Infinity;
      if (iter > 0) {
        for (let d = 0; d < dirtyEdges.length; d++) {
          const de = dirtyEdges[d]!;
          if (!arena.eAlive[de]) continue;
          if (arena.eMinX[de]! < deMinX) deMinX = arena.eMinX[de]!;
          if (arena.eMaxX[de]! > deMaxX) deMaxX = arena.eMaxX[de]!;
          if (arena.eMinY[de]! < deMinY) deMinY = arena.eMinY[de]!;
          if (arena.eMaxY[de]! > deMaxY) deMaxY = arena.eMaxY[de]!;
        }
      }

      for (let i = 0; i < activeEdgeCount; i++) {
        const e1Id = sortedEdges[i]!;
        if (!arena.eAlive[e1Id]) continue;
        const e1Dirty = iter === 0 || currentEdgeCrossingStamp[e1Id] === stepStamp;
        if (!e1Dirty) {
          if (arena.eMinX[e1Id]! - r0 > deMaxX) break;
          if (
            arena.eMaxX[e1Id]! + r0 < deMinX ||
            arena.eMaxY[e1Id]! + r0 < deMinY ||
            arena.eMinY[e1Id]! - r0 > deMaxY
          ) {
            continue;
          }
        }
        const maxX1 = arena.eMaxX[e1Id]! + r0;
        const minY1 = arena.eMinY[e1Id]! - r0;
        const maxY1 = arena.eMaxY[e1Id]! + r0;
        const e1v0 = arena.ev0[e1Id]!;
        const e1v1 = arena.ev1[e1Id]!;
        const ax = arena.vx[e1v0]!;
        const ay = arena.vy[e1v0]!;
        const bx = arena.vx[e1v1]!;
        const by = arena.vy[e1v1]!;

        for (let j = i + 1; j < activeEdgeCount; j++) {
          const e2Id = sortedEdges[j]!;
          if (arena.eMinX[e2Id]! > maxX1) break;
          if (!arena.eAlive[e2Id]) continue;
          if (!e1Dirty && currentEdgeCrossingStamp[e2Id] !== stepStamp) continue;
          if (arena.eMaxY[e2Id]! < minY1 || arena.eMinY[e2Id]! > maxY1) continue;
          const e2v0 = arena.ev0[e2Id]!;
          const e2v1 = arena.ev1[e2Id]!;
          if (e1v0 === e2v0 || e1v0 === e2v1 || e1v1 === e2v0 || e1v1 === e2v1) {
            continue;
          }
          if (
            !intersectSegmentsInteriorFast(
              ax,
              ay,
              bx,
              by,
              arena.vx[e2v0]!,
              arena.vy[e2v0]!,
              arena.vx[e2v1]!,
              arena.vy[e2v1]!,
              r0,
            )
          ) {
            continue;
          }

          const vInt = findOrCreateVertex(arena, hitX, hitY, initialVertexRadius, rMax, false);
          if (vInt !== e1v0 && vInt !== e1v1) {
            recordSplit(arena, e1Id, hitS, vInt);
          }
          if (vInt !== e2v0 && vInt !== e2v1) {
            recordSplit(arena, e2Id, hitT, vInt);
          }
        }
      }

      if (applyEdgeSplits(arena, bodyCount, false)) {
        iterChanged = true;
      }
    }

    if (!iterChanged && stepVertexQueue.length === 0 && stepEdgeQueue.length === 0) {
      break;
    }
  }

  drainZeroStrata(arena, rMax, bodyCount);

  return {
    arena,
    vertexCount: arena.vertexCount,
    edgeCount: arena.edgeCount,
    r0,
    rMax,
    cellSize,
    bodyCount,
  };
}
