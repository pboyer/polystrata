import { SpatialHashGrid } from "./spatial-grid.js";

/**
 * Reusable Struct-of-Arrays (SoA) TypedArray Arena for the 4-stage B-Rep kernel.
 * Eliminates per-vertex, per-edge, per-half-edge, and per-cycle object and array
 * allocations across the pipeline.
 */
export class KernelArena {
  inUse = false;

  // 1. Raw input segment buffers
  rawCap = 512;
  rawCount = 0;
  rawX0 = new Float64Array(this.rawCap);
  rawY0 = new Float64Array(this.rawCap);
  rawX1 = new Float64Array(this.rawCap);
  rawY1 = new Float64Array(this.rawCap);
  rawBody = new Int32Array(this.rawCap);

  cleanCap = 256;
  cleanX = new Float64Array(this.cleanCap);
  cleanY = new Float64Array(this.cleanCap);

  // 2. Vertex SoA buffers
  vertCap = 512;
  vertexCount = 0;
  vx = new Float64Array(this.vertCap);
  vy = new Float64Array(this.vertCap);
  vr = new Float64Array(this.vertCap);
  vWeight = new Int32Array(this.vertCap);
  vAlive = new Uint8Array(this.vertCap);
  vParent = new Int32Array(this.vertCap);
  vFirstInc = new Int32Array(this.vertCap);
  inZeroVertexQueue = new Uint8Array(this.vertCap);
  inStepVertexQueue = new Uint8Array(this.vertCap);
  vSpokeOffset = new Int32Array(this.vertCap);
  vSpokeCount = new Int32Array(this.vertCap);
  vSpokeCursor = new Int32Array(this.vertCap);
  indexInStack = new Int32Array(this.vertCap).fill(-1);
  sortedVerts = new Int32Array(this.vertCap);
  vertStepStamp = new Uint32Array(this.vertCap);

  // 3. Edge SoA buffers
  edgeCap = 1024;
  edgeCount = 0;
  ev0 = new Int32Array(this.edgeCap);
  ev1 = new Int32Array(this.edgeCap);
  eMinX = new Float64Array(this.edgeCap);
  eMinY = new Float64Array(this.edgeCap);
  eMaxX = new Float64Array(this.edgeCap);
  eMaxY = new Float64Array(this.edgeCap);
  sortedEdges = new Int32Array(this.edgeCap);
  eAlive = new Uint8Array(this.edgeCap);
  inZeroEdgeQueue = new Uint8Array(this.edgeCap);
  inStepEdgeQueue = new Uint8Array(this.edgeCap);
  edgeSplitHead = new Int32Array(this.edgeCap).fill(-1);
  edgeCrossingStamp = new Uint32Array(this.edgeCap);
  crossingStampGen = 1;

  deltaWCap = 2048;
  eDeltaW = new Int32Array(this.deltaWCap);

  // 4. Intrusive vertex -> incident edges linked list pool
  incCap = 2048;
  incCount = 0;
  incEdge = new Int32Array(this.incCap);
  incNext = new Int32Array(this.incCap);

  // 5. Pending edge splits linked list pool
  splitCap = 1024;
  splitCount = 0;
  splitT = new Float64Array(this.splitCap);
  splitVert = new Int32Array(this.splitCap);
  splitNext = new Int32Array(this.splitCap);
  splitEdgeList = new Int32Array(this.splitCap);
  splitEdgeListCount = 0;

  // 6. Half-Edge & Cycle CSR buffers
  heCap = 2048;
  heNext = new Int32Array(this.heCap);
  heCycle = new Int32Array(this.heCap);
  heInOutput = new Uint8Array(this.heCap);
  heVisited = new Uint8Array(this.heCap);
  spokesCsr = new Int32Array(this.heCap);
  cycleHalfEdgesCsr = new Int32Array(this.heCap);

  cycleCap = 512;
  cycleCount = 0;
  cycleStart = new Int32Array(this.cycleCap);
  cycleLen = new Int32Array(this.cycleCap);
  cycleKeep = new Uint8Array(this.cycleCap);
  cycleVisited = new Uint8Array(this.cycleCap);
  cycleWindings = new Int32Array(this.cycleCap * 2);

  vertexNetWinding = new Int32Array(1024);

  // 7. Reusable Spatial Hash Grids & flat scratch queues
  readonly vertexGrid = new SpatialHashGrid(1, 512);
  readonly edgeGrid = new SpatialHashGrid(1, 1024);
  readonly vertexQueryScratch: number[] = [];
  readonly edgeQueryScratch: number[] = [];

  readonly zeroVertexQueue: number[] = [];
  readonly zeroEdgeQueue: number[] = [];
  readonly stepVertexQueue: number[] = [];
  readonly stepEdgeQueue: number[] = [];
  readonly dirtyVertsScratch: number[] = [];
  readonly dirtyEdgesScratch: number[] = [];
  readonly bfsQueue: number[] = [];
  readonly walkVertexIds: number[] = [];

  ensureRawCapacity(minCap: number): void {
    if (minCap <= this.rawCap) return;
    let next = this.rawCap;
    while (next < minCap) next <<= 1;
    this.rawX0 = growFloat64(this.rawX0, next);
    this.rawY0 = growFloat64(this.rawY0, next);
    this.rawX1 = growFloat64(this.rawX1, next);
    this.rawY1 = growFloat64(this.rawY1, next);
    this.rawBody = growInt32(this.rawBody, next);
    this.rawCap = next;
  }

  ensureCleanCapacity(minCap: number): void {
    if (minCap <= this.cleanCap) return;
    let next = this.cleanCap;
    while (next < minCap) next <<= 1;
    this.cleanX = new Float64Array(next);
    this.cleanY = new Float64Array(next);
    this.cleanCap = next;
  }

  ensureVertexCapacity(minCap: number): void {
    if (minCap <= this.vertCap) return;
    let next = this.vertCap;
    while (next < minCap) next <<= 1;
    const oldCap = this.vertCap;
    this.vx = growFloat64(this.vx, next);
    this.vy = growFloat64(this.vy, next);
    this.vr = growFloat64(this.vr, next);
    this.vWeight = growInt32(this.vWeight, next);
    this.vAlive = growUint8(this.vAlive, next);
    this.vParent = growInt32(this.vParent, next);
    this.vFirstInc = growInt32(this.vFirstInc, next);
    this.inZeroVertexQueue = growUint8(this.inZeroVertexQueue, next);
    this.inStepVertexQueue = growUint8(this.inStepVertexQueue, next);
    this.vSpokeOffset = new Int32Array(next);
    this.vSpokeCount = new Int32Array(next);
    this.vSpokeCursor = new Int32Array(next);
    this.indexInStack = growInt32Fill(this.indexInStack, oldCap, next, -1);
    this.sortedVerts = new Int32Array(next);
    this.vertStepStamp = growUint32(this.vertStepStamp, next);
    this.vertCap = next;
  }

  ensureEdgeCapacity(minCap: number, bodyCount: number): void {
    if (minCap > this.edgeCap) {
      let next = this.edgeCap;
      while (next < minCap) next <<= 1;
      const oldCap = this.edgeCap;
      this.ev0 = growInt32(this.ev0, next);
      this.ev1 = growInt32(this.ev1, next);
      this.eMinX = growFloat64(this.eMinX, next);
      this.eMinY = growFloat64(this.eMinY, next);
      this.eMaxX = growFloat64(this.eMaxX, next);
      this.eMaxY = growFloat64(this.eMaxY, next);
      this.sortedEdges = new Int32Array(next);
      this.eAlive = growUint8(this.eAlive, next);
      this.inZeroEdgeQueue = growUint8(this.inZeroEdgeQueue, next);
      this.inStepEdgeQueue = growUint8(this.inStepEdgeQueue, next);
      this.edgeSplitHead = growInt32Fill(this.edgeSplitHead, oldCap, next, -1);
      this.edgeCrossingStamp = growUint32(this.edgeCrossingStamp, next);
      this.edgeCap = next;
    }
    const neededDeltaW = minCap * bodyCount;
    if (neededDeltaW > this.deltaWCap) {
      let nextDW = this.deltaWCap;
      while (nextDW < neededDeltaW) nextDW <<= 1;
      this.eDeltaW = growInt32(this.eDeltaW, nextDW);
      this.deltaWCap = nextDW;
    }
  }

  ensureIncCapacity(minCap: number): void {
    if (minCap <= this.incCap) return;
    let next = this.incCap;
    while (next < minCap) next <<= 1;
    this.incEdge = growInt32(this.incEdge, next);
    this.incNext = growInt32(this.incNext, next);
    this.incCap = next;
  }

  ensureSplitCapacity(minCap: number): void {
    if (minCap <= this.splitCap) return;
    let next = this.splitCap;
    while (next < minCap) next <<= 1;
    this.splitT = growFloat64(this.splitT, next);
    this.splitVert = growInt32(this.splitVert, next);
    this.splitNext = growInt32(this.splitNext, next);
    this.splitEdgeList = growInt32(this.splitEdgeList, next);
    this.splitCap = next;
  }

  ensureHalfEdgeCapacity(minCap: number): void {
    if (minCap <= this.heCap) return;
    let next = this.heCap;
    while (next < minCap) next <<= 1;
    this.heNext = new Int32Array(next);
    this.heCycle = new Int32Array(next);
    this.heInOutput = new Uint8Array(next);
    this.heVisited = new Uint8Array(next);
    this.spokesCsr = new Int32Array(next);
    this.cycleHalfEdgesCsr = new Int32Array(next);
    this.heCap = next;
  }

  ensureCycleCapacity(minCap: number, bodyCount: number): void {
    if (minCap > this.cycleCap) {
      let next = this.cycleCap;
      while (next < minCap) next <<= 1;
      this.cycleStart = growInt32(this.cycleStart, next);
      this.cycleLen = growInt32(this.cycleLen, next);
      this.cycleKeep = new Uint8Array(next);
      this.cycleVisited = new Uint8Array(next);
      this.cycleCap = next;
    }
    const neededW = minCap * bodyCount;
    if (neededW > this.cycleWindings.length) {
      let nextW = this.cycleWindings.length;
      while (nextW < neededW) nextW <<= 1;
      this.cycleWindings = new Int32Array(nextW);
    }
  }
}

function growFloat64(arr: Float64Array<ArrayBuffer>, newLen: number): Float64Array<ArrayBuffer> {
  const next = new Float64Array(newLen);
  next.set(arr);
  return next;
}

function growInt32(arr: Int32Array<ArrayBuffer>, newLen: number): Int32Array<ArrayBuffer> {
  const next = new Int32Array(newLen);
  next.set(arr);
  return next;
}

function growInt32Fill(
  arr: Int32Array<ArrayBuffer>,
  oldLen: number,
  newLen: number,
  fillVal: number,
): Int32Array<ArrayBuffer> {
  const next = new Int32Array(newLen);
  next.set(arr);
  next.fill(fillVal, oldLen);
  return next;
}

function growUint32(arr: Uint32Array<ArrayBuffer>, newLen: number): Uint32Array<ArrayBuffer> {
  const next = new Uint32Array(newLen);
  next.set(arr);
  return next;
}

function growUint8(arr: Uint8Array<ArrayBuffer>, newLen: number): Uint8Array<ArrayBuffer> {
  const next = new Uint8Array(newLen);
  next.set(arr);
  return next;
}

const SHARED_ARENA = new KernelArena();

export function acquireArena(): KernelArena {
  if (!SHARED_ARENA.inUse) {
    SHARED_ARENA.inUse = true;
    return SHARED_ARENA;
  }
  const fallback = new KernelArena();
  fallback.inUse = true;
  return fallback;
}

export function releaseArena(arena: KernelArena): void {
  arena.inUse = false;
}
