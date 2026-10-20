import type { KernelArena } from "./arena.js";
import type { ConsolidatedComplex } from "./consolidate.js";

export interface PlanarTopology {
  arena: KernelArena;
  halfEdgeCount: number;
  cycleCount: number;
}

function quadrant(dx: number, dy: number): number {
  if (dx >= 0 && dy >= 0) return 0;
  if (dx < 0 && dy >= 0) return 1;
  if (dx < 0 && dy < 0) return 2;
  return 3;
}

/**
 * Fast coordinate-based CCW angular comparator around `(vx0, vy0)` using quadrant + cross product.
 */
export function compareSpokesCoords(
  vx0: number,
  vy0: number,
  ax0: number,
  ay0: number,
  bx0: number,
  by0: number,
): number {
  const ax = ax0 - vx0;
  const ay = ay0 - vy0;
  const bx = bx0 - vx0;
  const by = by0 - vy0;
  const qa = quadrant(ax, ay);
  const qb = quadrant(bx, by);
  if (qa !== qb) return qa - qb;
  const cross = ax * by - ay * bx;
  if (cross > 0) return -1;
  if (cross < 0) return 1;
  return ax * ax + ay * ay - (bx * bx + by * by);
}

/**
 * Stage 3: Build planar half-edge graph in flat CSR arena arrays, sort outgoing spokes
 * CCW around each vertex via in-place insertion sort, wire `heNext`, and extract closed
 * half-edge cycles into `cycleHalfEdgesCsr`.
 */
export function buildPlanarTopology(complex: ConsolidatedComplex): PlanarTopology {
  const { arena, vertexCount, edgeCount, bodyCount } = complex;
  const halfEdgeCount = edgeCount * 2;

  arena.ensureHalfEdgeCapacity(halfEdgeCount);

  const vx = arena.vx;
  const vy = arena.vy;
  const vAlive = arena.vAlive;
  const vSpokeOffset = arena.vSpokeOffset;
  const vSpokeCount = arena.vSpokeCount;
  const vSpokeCursor = arena.vSpokeCursor;

  const ev0 = arena.ev0;
  const ev1 = arena.ev1;
  const eAlive = arena.eAlive;

  const heNext = arena.heNext;
  const heCycle = arena.heCycle;
  const heInOutput = arena.heInOutput;
  const heVisited = arena.heVisited;
  const spokesCsr = arena.spokesCsr;
  const cycleHalfEdgesCsr = arena.cycleHalfEdgesCsr;

  // 1. Count active outgoing spokes per vertex and initialize half-edge arrays
  for (let v = 0; v < vertexCount; v++) {
    vSpokeCount[v] = 0;
  }

  for (let eId = 0; eId < edgeCount; eId++) {
    const heFwd = eId << 1;
    const heRev = heFwd + 1;
    heNext[heFwd] = -1;
    heNext[heRev] = -1;
    heCycle[heFwd] = -1;
    heCycle[heRev] = -1;
    heInOutput[heFwd] = 0;
    heInOutput[heRev] = 0;
    heVisited[heFwd] = 0;
    heVisited[heRev] = 0;

    if (!eAlive[eId]) continue;
    vSpokeCount[ev0[eId]!]!++;
    vSpokeCount[ev1[eId]!]!++;
  }

  // 2. Compute CSR prefix sums per vertex
  let totalSpokes = 0;
  for (let v = 0; v < vertexCount; v++) {
    vSpokeOffset[v] = totalSpokes;
    vSpokeCursor[v] = totalSpokes;
    totalSpokes += vSpokeCount[v]!;
  }

  for (let eId = 0; eId < edgeCount; eId++) {
    if (!eAlive[eId]) continue;
    const u = ev0[eId]!;
    const v = ev1[eId]!;
    const heFwd = eId << 1;
    const cu = vSpokeCursor[u]!;
    vSpokeCursor[u] = cu + 1;
    spokesCsr[cu] = heFwd;
    const cv = vSpokeCursor[v]!;
    vSpokeCursor[v] = cv + 1;
    spokesCsr[cv] = heFwd + 1;
  }

  // 3. Sort outgoing half-edges CCW around each active vertex in-place and wire heNext
  for (let vId = 0; vId < vertexCount; vId++) {
    const k = vSpokeCount[vId]!;
    if (!vAlive[vId] || k === 0) continue;
    const offset = vSpokeOffset[vId]!;
    const ox = vx[vId]!;
    const oy = vy[vId]!;

    // In-place insertion sort on spokesCsr[offset .. offset + k - 1]
    for (let i = 1; i < k; i++) {
      const heKey = spokesCsr[offset + i]!;
      const tKey = (heKey & 1) === 0 ? ev1[heKey >> 1]! : ev0[heKey >> 1]!;
      const kx = vx[tKey]!;
      const ky = vy[tKey]!;
      let j = i - 1;
      while (j >= 0) {
        const hePrev = spokesCsr[offset + j]!;
        const tPrev = (hePrev & 1) === 0 ? ev1[hePrev >> 1]! : ev0[hePrev >> 1]!;
        if (compareSpokesCoords(ox, oy, vx[tPrev]!, vy[tPrev]!, kx, ky) <= 0) {
          break;
        }
        spokesCsr[offset + j + 1] = hePrev;
        j--;
      }
      spokesCsr[offset + j + 1] = heKey;
    }

    for (let i = 0; i < k; i++) {
      const outgoing = spokesCsr[offset + i]!;
      const incoming = outgoing ^ 1;
      const nextOutgoing = spokesCsr[offset + (i === 0 ? k - 1 : i - 1)]!;
      heNext[incoming] = nextOutgoing;
    }
  }

  // 4. Walk unvisited half-edges to extract closed half-edge cycles into CSR arrays
  let cycleStart = arena.cycleStart;
  let cycleLen = arena.cycleLen;
  let cycleCount = 0;
  let csrWrite = 0;

  for (let heId = 0; heId < halfEdgeCount; heId++) {
    if (!eAlive[heId >> 1] || heVisited[heId]) continue;

    const cId = cycleCount++;
    if (cId >= arena.cycleCap) {
      arena.ensureCycleCapacity(cId + 1, bodyCount);
      cycleStart = arena.cycleStart;
      cycleLen = arena.cycleLen;
    }

    const startIdx = csrWrite;
    let curr = heId;
    while (curr !== -1 && !heVisited[curr]) {
      heVisited[curr] = 1;
      heCycle[curr] = cId;
      cycleHalfEdgesCsr[csrWrite++] = curr;
      curr = heNext[curr]!;
    }

    cycleStart[cId] = startIdx;
    cycleLen[cId] = csrWrite - startIdx;
  }

  arena.cycleCount = cycleCount;
  arena.ensureCycleCapacity(Math.max(1, cycleCount), bodyCount);

  return {
    arena,
    halfEdgeCount,
    cycleCount,
  };
}
