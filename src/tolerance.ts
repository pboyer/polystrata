import { acquireArena, type KernelArena } from "./arena.js";
import type {
  Loop2D,
  Point2D,
  PolygonWithHoles2D,
  Segment2D,
  ShapeInput2D,
} from "./types.js";

export interface NormalizedContext {
  arena: KernelArena;
  cx: number;
  cy: number;
  diagonal: number;
  r0: number;
  rMax: number;
  cellSize: number;
  bodyCount: number;
  segmentCount: number;
}

export function signedLoopArea(loop: ReadonlyArray<Point2D>): number {
  const n = loop.length;
  if (n < 3) return 0;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const p = loop[i]!;
    const q = loop[(i + 1) % n]!;
    area2 += p.x * q.y - q.x * p.y;
  }
  return 0.5 * area2;
}

function signedArenaLoopArea(xs: Float64Array, ys: Float64Array, n: number): number {
  if (n < 3) return 0;
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    area2 += xs[i]! * ys[j]! - xs[j]! * ys[i]!;
  }
  return 0.5 * area2;
}

function isPoint2D(v: unknown): v is Point2D {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.x === "number" && typeof p.y === "number" && !("p0" in p) && !("outer" in p);
}

function isSegment2D(v: unknown): v is Segment2D {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return isPoint2D(s.p0) && isPoint2D(s.p1);
}

function isPolygonWithHoles2D(v: unknown): v is PolygonWithHoles2D {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return Array.isArray(p.outer) && Array.isArray(p.holes);
}

function assertFiniteCoords(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid non-finite coordinate: (${x}, ${y})`);
  }
}

function appendRawSegment(
  arena: KernelArena,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bodyIndex: number,
): void {
  const idx = arena.rawCount;
  arena.ensureRawCapacity(idx + 1);
  arena.rawX0[idx] = x0;
  arena.rawY0[idx] = y0;
  arena.rawX1[idx] = x1;
  arena.rawY1[idx] = y1;
  arena.rawBody[idx] = bodyIndex;
  arena.rawCount = idx + 1;
}

function emitLoopSegmentsToArena(
  loop: ReadonlyArray<Point2D>,
  bodyIndex: number,
  arena: KernelArena,
  enforceSign?: 1 | -1,
): void {
  const len = loop.length;
  if (len < 2) return;
  arena.ensureCleanCapacity(len);
  const cx = arena.cleanX;
  const cy = arena.cleanY;
  let n = 0;

  for (let i = 0; i < len; i++) {
    const p = loop[i]!;
    assertFiniteCoords(p.x, p.y);
    if (n > 0 && cx[n - 1] === p.x && cy[n - 1] === p.y) continue;
    cx[n] = p.x;
    cy[n] = p.y;
    n++;
  }
  if (n >= 2 && cx[0] === cx[n - 1] && cy[0] === cy[n - 1]) {
    n--;
  }
  if (n < 2) return;

  let reverse = false;
  if (enforceSign !== undefined && n >= 3) {
    const area = signedArenaLoopArea(cx, cy, n);
    if ((enforceSign > 0 && area < 0) || (enforceSign < 0 && area > 0)) {
      reverse = true;
    }
  }

  const count = n >= 3 ? n : n - 1;
  arena.ensureRawCapacity(arena.rawCount + count);

  if (!reverse) {
    for (let i = 0; i < count; i++) {
      const j = i + 1 === n ? 0 : i + 1;
      const x0 = cx[i]!;
      const y0 = cy[i]!;
      const x1 = cx[j]!;
      const y1 = cy[j]!;
      if (x0 === x1 && y0 === y1) continue;
      appendRawSegment(arena, x0, y0, x1, y1, bodyIndex);
    }
  } else {
    for (let i = 0; i < count; i++) {
      const iRev = n - 1 - i;
      const jRev = iRev === 0 ? n - 1 : iRev - 1;
      const x0 = cx[iRev]!;
      const y0 = cy[iRev]!;
      const x1 = cx[jRev]!;
      const y1 = cy[jRev]!;
      if (x0 === x1 && y0 === y1) continue;
      appendRawSegment(arena, x0, y0, x1, y1, bodyIndex);
    }
  }
}

export function extractRawSegmentsFromShapeToArena(
  shape: ShapeInput2D,
  bodyIndex: number,
  arena: KernelArena,
): void {
  if (isPolygonWithHoles2D(shape)) {
    emitLoopSegmentsToArena(shape.outer, bodyIndex, arena, 1);
    for (let i = 0; i < shape.holes.length; i++) {
      emitLoopSegmentsToArena(shape.holes[i]!, bodyIndex, arena, -1);
    }
    return;
  }

  if (!Array.isArray(shape) || shape.length === 0) {
    return;
  }

  const first = shape[0];
  if (isPoint2D(first)) {
    emitLoopSegmentsToArena(shape as Loop2D, bodyIndex, arena);
    return;
  }

  if (isSegment2D(first)) {
    const segs = shape as Segment2D[];
    arena.ensureRawCapacity(arena.rawCount + segs.length);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      assertFiniteCoords(seg.p0.x, seg.p0.y);
      assertFiniteCoords(seg.p1.x, seg.p1.y);
      if (seg.p0.x === seg.p1.x && seg.p0.y === seg.p1.y) continue;
      appendRawSegment(arena, seg.p0.x, seg.p0.y, seg.p1.x, seg.p1.y, bodyIndex);
    }
    return;
  }

  if (isPolygonWithHoles2D(first)) {
    const polys = shape as PolygonWithHoles2D[];
    for (let i = 0; i < polys.length; i++) {
      const poly = polys[i]!;
      emitLoopSegmentsToArena(poly.outer, bodyIndex, arena, 1);
      for (let h = 0; h < poly.holes.length; h++) {
        emitLoopSegmentsToArena(poly.holes[h]!, bodyIndex, arena, -1);
      }
    }
    return;
  }

  if (Array.isArray(first)) {
    const loops = shape as Loop2D[];
    for (let i = 0; i < loops.length; i++) {
      emitLoopSegmentsToArena(loops[i]!, bodyIndex, arena);
    }
    return;
  }
}

export function normalizeInputs(
  inputs: ReadonlyArray<{ shape: ShapeInput2D; bodyIndex: number }>,
  userSnapTolerance?: number,
  providedArena?: KernelArena,
): NormalizedContext {
  const arena = providedArena ?? acquireArena();
  arena.rawCount = 0;
  let maxBodyIndex = -1;

  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i]!;
    if (item.bodyIndex > maxBodyIndex) {
      maxBodyIndex = item.bodyIndex;
    }
    extractRawSegmentsFromShapeToArena(item.shape, item.bodyIndex, arena);
  }

  const bodyCount = Math.max(1, maxBodyIndex + 1);
  const segCount = arena.rawCount;

  if (segCount === 0) {
    const r0 = userSnapTolerance !== undefined && userSnapTolerance > 0 ? userSnapTolerance : 1e-9;
    return {
      arena,
      cx: 0,
      cy: 0,
      diagonal: 0,
      r0,
      rMax: r0 * 2,
      cellSize: 1,
      bodyCount,
      segmentCount: 0,
    };
  }

  const rawX0 = arena.rawX0;
  const rawY0 = arena.rawY0;
  const rawX1 = arena.rawX1;
  const rawY1 = arena.rawY1;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < segCount; i++) {
    const x0 = rawX0[i]!;
    const y0 = rawY0[i]!;
    const x1 = rawX1[i]!;
    const y1 = rawY1[i]!;
    if (x0 < minX) minX = x0;
    if (y0 < minY) minY = y0;
    if (x0 > maxX) maxX = x0;
    if (y0 > maxY) maxY = y0;
    if (x1 < minX) minX = x1;
    if (y1 < minY) minY = y1;
    if (x1 > maxX) maxX = x1;
    if (y1 > maxY) maxY = y1;
  }

  const cx = 0.5 * (minX + maxX);
  const cy = 0.5 * (minY + maxY);
  const diagonal = Math.hypot(maxX - minX, maxY - minY);

  const scale = Math.max(diagonal, 1);
  const numericalFloor = 1e-9 * scale;

  if (userSnapTolerance !== undefined && (!Number.isFinite(userSnapTolerance) || userSnapTolerance < 0)) {
    throw new Error("snapTolerance must be a non-negative finite number");
  }

  const r0 =
    userSnapTolerance !== undefined
      ? Math.max(userSnapTolerance, numericalFloor)
      : numericalFloor;

  const rMax = userSnapTolerance !== undefined ? r0 * 2 : r0 * 4;

  // Normalize segment coordinates in-place around (cx, cy) and estimate grid cell size
  let totalManhattanLen = 0;
  let nonZeroCount = 0;
  const r0Sq = r0 * r0;

  for (let i = 0; i < segCount; i++) {
    const x0 = rawX0[i]! - cx;
    const y0 = rawY0[i]! - cy;
    const x1 = rawX1[i]! - cx;
    const y1 = rawY1[i]! - cy;
    rawX0[i] = x0;
    rawY0[i] = y0;
    rawX1[i] = x1;
    rawY1[i] = y1;
    const dx = x1 - x0;
    const dy = y1 - y0;
    if (dx * dx + dy * dy > r0Sq) {
      totalManhattanLen += (dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy);
      nonZeroCount++;
    }
  }

  const meanLen = nonZeroCount > 0 ? (0.75 * totalManhattanLen) / nonZeroCount : scale;
  const targetGridDim = Math.max(8, Math.sqrt(segCount * 4));
  const bboxCell = diagonal > 0 ? diagonal / targetGridDim : 1;
  const cellSize = Math.max(r0 * 16, Math.min(meanLen * 0.5, bboxCell), 1e-6 * scale);

  return {
    arena,
    cx,
    cy,
    diagonal,
    r0,
    rMax,
    cellSize,
    bodyCount,
    segmentCount: segCount,
  };
}

export function denormalizePoint(p: Point2D, cx: number, cy: number): Point2D {
  return {
    x: p.x + cx,
    y: p.y + cy,
  };
}
