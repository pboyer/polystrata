import type {
  BooleanOp,
  FlatLoop2D,
  GeoJSONMultiPolygon,
  GeoJSONPolygon,
  KernelOptions,
  KernelResult,
  Loop2D,
  Point2D,
  PolygonWithHoles2D,
  Segment2D,
  ShapeInput2D,
  TupleLoop2D,
  TupleMultiPolygon2D,
  TuplePoint2D,
  WindingRule,
} from "./types.js";
import { WASM_BASE64 } from "./wasm-bytes.js";

interface PolystrataWasmExports {
  memory: WebAssembly.Memory;
  wasm_alloc_raw_segments: (segCount: number) => number;
  wasm_prepare_segments: (segCount: number, snapTol: number) => void;
  wasm_execute_prepared: (opCode: number, ruleCode: number, simplifyCollinear: number) => number;
  wasm_execute_raw: (
    segCount: number,
    opCode: number,
    ruleCode: number,
    snapTol: number,
    simplifyCollinear: number,
  ) => number;
  wasm_compute_cycles_and_windings: (
    segCount: number,
    snapTol: number,
    captureSamples: number,
  ) => number;
  wasm_extract_from_cycle_keep: (simplifyCollinear: number) => number;
  wasm_get_out_coords_ptr: () => number;
  wasm_get_out_coords_len: () => number;
  wasm_get_out_loop_meta_ptr: () => number;
  wasm_get_out_total_area: () => number;

  // Diagnostic & custom-predicate getters
  wasm_get_prep_cx: () => number;
  wasm_get_prep_cy: () => number;
  wasm_get_prep_diagonal: () => number;
  wasm_get_prep_r0: () => number;
  wasm_get_prep_rmax: () => number;
  wasm_get_prep_body_count: () => number;
  wasm_get_vertex_count: () => number;
  wasm_get_vx_ptr: () => number;
  wasm_get_vy_ptr: () => number;
  wasm_get_vr_ptr: () => number;
  wasm_get_v_alive_ptr: () => number;
  wasm_get_edge_count: () => number;
  wasm_get_ev0_ptr: () => number;
  wasm_get_ev1_ptr: () => number;
  wasm_get_e_alive_ptr: () => number;
  wasm_get_e_delta_w_ptr: () => number;
  wasm_get_cycle_count: () => number;
  wasm_get_cycle_windings_f64_ptr: () => number;
  wasm_get_cycle_sample_x_ptr: () => number;
  wasm_get_cycle_sample_y_ptr: () => number;
  wasm_get_cycle_keep_ptr: () => number;
}

let wasmExports: PolystrataWasmExports | null = null;
let wasmInitPromise: Promise<void> | null = null;
let preparedTaskGen = 0;
let activePreparedTaskId = -1;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

let cachedWasmBytes: Uint8Array | null = null;
function getWasmBytes(): Uint8Array {
  if (cachedWasmBytes === null) {
    cachedWasmBytes = decodeBase64(WASM_BASE64);
  }
  return cachedWasmBytes;
}

/**
 * Asynchronously initialize the embedded WebAssembly module.
 *
 * In Node.js, Bun, Deno, and Web Workers, `polystrata` initializes synchronously on first call
 * so calling `initPolystrata()` is optional. On browser main threads that restrict synchronous
 * `new WebAssembly.Module()` compilation for modules > 4 KB, call `await initPolystrata()` once
 * at application startup before invoking synchronous Boolean operations.
 */
export async function initPolystrata(): Promise<void> {
  if (wasmExports !== null) return;
  if (wasmInitPromise !== null) return wasmInitPromise;
  wasmInitPromise = (async () => {
    const bytes = getWasmBytes();
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    wasmExports = instance.exports as unknown as PolystrataWasmExports;
  })();
  return wasmInitPromise;
}

/**
 * Alias for {@link initPolystrata}.
 */
export const initPolystrataWasm = initPolystrata;

function getWasm(): PolystrataWasmExports {
  if (wasmExports !== null) return wasmExports;
  const bytes = getWasmBytes();
  try {
    const mod = new WebAssembly.Module(bytes as BufferSource);
    const instance = new WebAssembly.Instance(mod, {});
    wasmExports = instance.exports as unknown as PolystrataWasmExports;
    return wasmExports;
  } catch (err) {
    throw new Error(
      `polystrata: Synchronous WebAssembly compilation failed on this thread (${err instanceof Error ? err.message : String(err)}). ` +
        `Call \`await initPolystrata()\` once at startup before invoking synchronous Boolean operations on the browser main thread.`,
    );
  }
}

function ruleToCode(rule: WindingRule): number {
  switch (rule) {
    case "positive":
      return 0;
    case "nonZero":
      return 1;
    case "evenOdd":
      return 2;
  }
}

/**
 * Compute the signed area of a closed 2D loop (`{ x, y }[]`, `[x, y][]`, or flat `Float64Array | Float32Array`)
 * via the Shoelace formula.
 *
 * - Positive area (`> 0`) = counter-clockwise (`CCW`) outer shell
 * - Negative area (`< 0`) = clockwise (`CW`) interior hole
 */
export function signedLoopArea(
  loop: ReadonlyArray<Point2D> | ReadonlyArray<TuplePoint2D> | FlatLoop2D,
): number {
  if (loop instanceof Float64Array || loop instanceof Float32Array) {
    const nCoords = loop.length & ~1;
    if (nCoords < 6) return 0;
    let sum = 0;
    for (let i = 0; i < nCoords; i += 2) {
      const next = i + 2 === nCoords ? 0 : i + 2;
      sum += loop[i]! * loop[next + 1]! - loop[next]! * loop[i + 1]!;
    }
    return 0.5 * sum;
  }

  const n = loop.length;
  if (n < 3) return 0;
  const first = loop[0];
  if (Array.isArray(first)) {
    const tLoop = loop as ReadonlyArray<TuplePoint2D>;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = tLoop[i]!;
      const b = tLoop[i + 1 === n ? 0 : i + 1]!;
      sum += a[0] * b[1] - b[0] * a[1];
    }
    return 0.5 * sum;
  }

  const pLoop = loop as ReadonlyArray<Point2D>;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = pLoop[i]!;
    const b = pLoop[i + 1 === n ? 0 : i + 1]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return 0.5 * sum;
}

function isSegment(item: unknown): item is Segment2D {
  return typeof item === "object" && item !== null && "p0" in item && "p1" in item;
}

function isPoint(item: unknown): item is Point2D {
  return typeof item === "object" && item !== null && "x" in item && "y" in item;
}

function isTuplePoint(item: unknown): item is TuplePoint2D {
  return (
    Array.isArray(item) &&
    item.length >= 2 &&
    typeof item[0] === "number" &&
    typeof item[1] === "number"
  );
}

function isPolygonWithHoles(item: unknown): item is PolygonWithHoles2D {
  return typeof item === "object" && item !== null && "outer" in item && "holes" in item;
}

function isGeoJSONGeometry(item: unknown): item is GeoJSONPolygon | GeoJSONMultiPolygon {
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    "coordinates" in item &&
    ((item as { type: unknown }).type === "Polygon" ||
      (item as { type: unknown }).type === "MultiPolygon")
  );
}

function isFlatLoop(item: unknown): item is FlatLoop2D {
  return item instanceof Float64Array || item instanceof Float32Array;
}

// Reusable flat staging buffer for packing [x0, y0, x1, y1, bodyIndex]
let stagingBuf = new Float64Array(4096 * 5);
let stagingSegCount = 0;

function ensureStagingCapacity(neededSegs: number): void {
  const neededFloats = neededSegs * 5;
  if (neededFloats <= stagingBuf.length) return;
  let cap = stagingBuf.length;
  while (cap < neededFloats) cap <<= 1;
  const next = new Float64Array(cap);
  next.set(stagingBuf.subarray(0, stagingSegCount * 5));
  stagingBuf = next;
}

function pushStagingSegment(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bodyIndex: number,
): void {
  const idx = stagingSegCount;
  if ((idx + 1) * 5 > stagingBuf.length) {
    ensureStagingCapacity(idx + 1);
  }
  const base = idx * 5;
  stagingBuf[base] = x0;
  stagingBuf[base + 1] = y0;
  stagingBuf[base + 2] = x1;
  stagingBuf[base + 3] = y1;
  stagingBuf[base + 4] = bodyIndex;
  stagingSegCount = idx + 1;
}

function appendLoopToStaging(loop: ReadonlyArray<Point2D>, bodyIndex: number): void {
  let n = loop.length;
  if (n < 2) return;
  if (n > 2) {
    const first = loop[0]!;
    const last = loop[n - 1]!;
    if (first.x === last.x && first.y === last.y) {
      n -= 1;
    }
  }
  if (n < 2) return;
  ensureStagingCapacity(stagingSegCount + n);
  for (let i = 0; i < n; i++) {
    const p0 = loop[i]!;
    const p1 = loop[i + 1 === n ? 0 : i + 1]!;
    pushStagingSegment(p0.x, p0.y, p1.x, p1.y, bodyIndex);
  }
}

function appendTupleLoopToStaging(
  loop: ReadonlyArray<TuplePoint2D>,
  bodyIndex: number,
  reverse = false,
): void {
  let n = loop.length;
  if (n < 2) return;
  if (n > 2) {
    const first = loop[0]!;
    const last = loop[n - 1]!;
    if (first[0] === last[0] && first[1] === last[1]) {
      n -= 1;
    }
  }
  if (n < 2) return;
  ensureStagingCapacity(stagingSegCount + n);
  if (!reverse) {
    for (let i = 0; i < n; i++) {
      const p0 = loop[i]!;
      const p1 = loop[i + 1 === n ? 0 : i + 1]!;
      pushStagingSegment(p0[0], p0[1], p1[0], p1[1], bodyIndex);
    }
  } else {
    for (let i = n - 1; i >= 0; i--) {
      const p0 = loop[i]!;
      const p1 = loop[i === 0 ? n - 1 : i - 1]!;
      pushStagingSegment(p0[0], p0[1], p1[0], p1[1], bodyIndex);
    }
  }
}

function appendFlatLoopToStaging(coords: FlatLoop2D, bodyIndex: number): void {
  let nPts = coords.length >>> 1;
  if (nPts < 2) return;
  if (nPts > 2) {
    const lastIdx = (nPts - 1) * 2;
    if (coords[0] === coords[lastIdx] && coords[1] === coords[lastIdx + 1]) {
      nPts -= 1;
    }
  }
  if (nPts < 2) return;
  ensureStagingCapacity(stagingSegCount + nPts);
  for (let i = 0; i < nPts; i++) {
    const i0 = i * 2;
    const i1 = i + 1 === nPts ? 0 : (i + 1) * 2;
    pushStagingSegment(coords[i0]!, coords[i0 + 1]!, coords[i1]!, coords[i1 + 1]!, bodyIndex);
  }
}

function appendGeoJSONPolygonRingsToStaging(
  rings: ReadonlyArray<ReadonlyArray<TuplePoint2D>>,
  bodyIndex: number,
): void {
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;
    if (ring.length < 3) continue;
    const area = signedLoopArea(ring);
    // In GeoJSON Polygon rings, r === 0 is the outer shell (must be CCW / area > 0)
    // and r > 0 are interior holes (must be CW / area < 0).
    const shouldReverse = r === 0 ? area < 0 : area > 0;
    appendTupleLoopToStaging(ring, bodyIndex, shouldReverse);
  }
}

function extractShapeToStaging(input: ShapeInput2D, bodyIndex: number): void {
  if (isFlatLoop(input)) {
    appendFlatLoopToStaging(input, bodyIndex);
    return;
  }
  if (isPolygonWithHoles(input)) {
    appendLoopToStaging(input.outer, bodyIndex);
    for (let i = 0; i < input.holes.length; i++) {
      appendLoopToStaging(input.holes[i]!, bodyIndex);
    }
    return;
  }
  if (isGeoJSONGeometry(input)) {
    if (input.type === "Polygon") {
      appendGeoJSONPolygonRingsToStaging(input.coordinates, bodyIndex);
    } else {
      for (let p = 0; p < input.coordinates.length; p++) {
        appendGeoJSONPolygonRingsToStaging(input.coordinates[p]!, bodyIndex);
      }
    }
    return;
  }
  if (!Array.isArray(input)) return;
  const arr = input as ReadonlyArray<unknown>;
  if (arr.length === 0) return;

  const first = arr[0];
  if (isPoint(first)) {
    appendLoopToStaging(arr as ReadonlyArray<Point2D>, bodyIndex);
    return;
  }
  if (isTuplePoint(first)) {
    appendTupleLoopToStaging(arr as ReadonlyArray<TuplePoint2D>, bodyIndex);
    return;
  }
  if (isSegment(first)) {
    const segs = arr as ReadonlyArray<Segment2D>;
    ensureStagingCapacity(stagingSegCount + segs.length);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      pushStagingSegment(seg.p0.x, seg.p0.y, seg.p1.x, seg.p1.y, bodyIndex);
    }
    return;
  }
  if (isFlatLoop(first)) {
    const flatLoops = arr as ReadonlyArray<FlatLoop2D>;
    for (let i = 0; i < flatLoops.length; i++) {
      appendFlatLoopToStaging(flatLoops[i]!, bodyIndex);
    }
    return;
  }
  if (isPolygonWithHoles(first)) {
    const polys = arr as ReadonlyArray<PolygonWithHoles2D>;
    for (let i = 0; i < polys.length; i++) {
      const poly = polys[i]!;
      appendLoopToStaging(poly.outer, bodyIndex);
      for (let h = 0; h < poly.holes.length; h++) {
        appendLoopToStaging(poly.holes[h]!, bodyIndex);
      }
    }
    return;
  }

  // Nested array: could be Loop2D[], TupleLoop2D[], or TupleMultiPolygon2D
  if (Array.isArray(first)) {
    const firstArr = first as ReadonlyArray<unknown>;
    if (firstArr.length === 0) return;
    const second = firstArr[0];
    if (isPoint(second)) {
      const loops = arr as ReadonlyArray<Loop2D>;
      for (let i = 0; i < loops.length; i++) {
        appendLoopToStaging(loops[i]!, bodyIndex);
      }
      return;
    }
    if (isTuplePoint(second)) {
      const tupleLoops = arr as ReadonlyArray<TupleLoop2D>;
      for (let i = 0; i < tupleLoops.length; i++) {
        appendTupleLoopToStaging(tupleLoops[i]!, bodyIndex);
      }
      return;
    }
    if (Array.isArray(second)) {
      // TupleMultiPolygon2D ([ [ [x, y], ... ], ... ][])
      const multi = arr as ReadonlyArray<ReadonlyArray<ReadonlyArray<TuplePoint2D>>>;
      for (let p = 0; p < multi.length; p++) {
        appendGeoJSONPolygonRingsToStaging(multi[p]!, bodyIndex);
      }
    }
  }
}

function uploadInputsToWasm(
  inputs: ReadonlyArray<{ shape: ShapeInput2D; bodyIndex: number }>,
  wasm: PolystrataWasmExports,
): number {
  stagingSegCount = 0;
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i]!;
    extractShapeToStaging(item.shape, item.bodyIndex);
  }
  const segCount = stagingSegCount;
  if (segCount === 0) return 0;

  const ptr = wasm.wasm_alloc_raw_segments(segCount);
  const dst = new Float64Array(wasm.memory.buffer, ptr, segCount * 5);
  dst.set(stagingBuf.subarray(0, segCount * 5));
  return segCount;
}

function pointInLoop(pt: Point2D, loop: ReadonlyArray<Point2D>): boolean {
  let inside = false;
  const px = pt.x;
  const py = pt.y;
  const n = loop.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = loop[i]!.x;
    const yi = loop[i]!.y;
    const xj = loop[j]!.x;
    const yj = loop[j]!.y;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function assignHolesToPolygons(
  polygons: PolygonWithHoles2D[],
  shellAreas: number[],
  holeLoops: Loop2D[],
  holeAreas: number[],
): void {
  if (polygons.length === 0 || holeLoops.length === 0) return;
  if (polygons.length === 1) {
    for (let h = 0; h < holeLoops.length; h++) {
      polygons[0]!.holes.push(holeLoops[h]!);
    }
    return;
  }

  for (let h = 0; h < holeLoops.length; h++) {
    const hole = holeLoops[h]!;
    const hArea = holeAreas[h]!;
    const testPt = hole[0]!;
    let bestIdx = -1;
    let bestArea = Infinity;

    for (let s = 0; s < polygons.length; s++) {
      const sArea = shellAreas[s]!;
      if (sArea <= hArea) continue;
      if (pointInLoop(testPt, polygons[s]!.outer)) {
        if (sArea < bestArea) {
          bestArea = sArea;
          bestIdx = s;
        }
      }
    }

    if (bestIdx !== -1) {
      polygons[bestIdx]!.holes.push(hole);
    } else {
      polygons[0]!.holes.push(hole);
    }
  }
}

const shellAreasScratch: number[] = [];
const holeLoopsScratch: Loop2D[] = [];
const holeAreasScratch: number[] = [];

function readKernelResultFromWasm(wasm: PolystrataWasmExports, loopCount: number): KernelResult {
  if (loopCount === 0) {
    return { polygons: [], loops: [] };
  }

  const coordsPtr = wasm.wasm_get_out_coords_ptr();
  const coordsLen = wasm.wasm_get_out_coords_len();
  const metaPtr = wasm.wasm_get_out_loop_meta_ptr();

  const coords = new Float64Array(wasm.memory.buffer, coordsPtr, coordsLen);
  const meta = new Uint32Array(wasm.memory.buffer, metaPtr, loopCount * 3);

  const loops: Loop2D[] = new Array(loopCount);
  const polygons: PolygonWithHoles2D[] = [];
  shellAreasScratch.length = 0;
  holeLoopsScratch.length = 0;
  holeAreasScratch.length = 0;

  for (let i = 0; i < loopCount; i++) {
    const mBase = i * 3;
    const ptStart = meta[mBase]!;
    const ptCount = meta[mBase + 1]!;
    const isOuter = meta[mBase + 2]!;

    const loop: Point2D[] = new Array(ptCount);
    let cIdx = ptStart * 2;
    for (let k = 0; k < ptCount; k++) {
      loop[k] = {
        x: coords[cIdx]!,
        y: coords[cIdx + 1]!,
      };
      cIdx += 2;
    }
    loops[i] = loop;

    if (isOuter === 1) {
      polygons.push({ outer: loop, holes: [] });
      shellAreasScratch.push(Math.abs(signedLoopArea(loop)));
    } else {
      holeLoopsScratch.push(loop);
      holeAreasScratch.push(Math.abs(signedLoopArea(loop)));
    }
  }

  if (holeLoopsScratch.length > 0) {
    assignHolesToPolygons(polygons, shellAreasScratch, holeLoopsScratch, holeAreasScratch);
  }

  return { polygons, loops };
}

function executeWasmOp(
  inputs: ReadonlyArray<{ shape: ShapeInput2D; bodyIndex: number }>,
  opCode: number,
  defaultRule: WindingRule,
  options?: KernelOptions,
): KernelResult {
  const wasm = getWasm();
  activePreparedTaskId = -1;
  const segCount = uploadInputsToWasm(inputs, wasm);
  if (segCount === 0) {
    return { polygons: [], loops: [] };
  }
  const snapTol = options?.snapTolerance !== undefined ? options.snapTolerance : -1.0;
  const ruleCode = ruleToCode(options?.windingRule ?? defaultRule);
  const simplify = (options?.simplifyCollinear ?? true) ? 1 : 0;
  const loopCount = wasm.wasm_execute_raw(segCount, opCode, ruleCode, snapTol, simplify);
  return readKernelResultFromWasm(wasm, loopCount);
}

/**
 * Topologically heal a single polygon, multi-loop shape, or raw segment soup:
 * snaps micro-gaps within tolerance `r0`, resolves self-intersections, cancels folded
 * zero-winding whiskers, decomposes figure-8 / pinch vertices, and extracts clean manifold shells and holes.
 */
export function healWasm(input: ShapeInput2D, options?: KernelOptions): KernelResult {
  return executeWasmOp([{ shape: input, bodyIndex: 0 }], 4, "nonZero", options);
}

/**
 * Compute the 2D Boolean **Union** (`A ∪ B`) of two shapes.
 */
export function unionWasm(a: ShapeInput2D, b: ShapeInput2D, options?: KernelOptions): KernelResult {
  return executeWasmOp(
    [
      { shape: a, bodyIndex: 0 },
      { shape: b, bodyIndex: 1 },
    ],
    0,
    "positive",
    options,
  );
}

/**
 * Compute the 2D Boolean **Intersection** (`A ∩ B`) of two shapes.
 */
export function intersectWasm(
  a: ShapeInput2D,
  b: ShapeInput2D,
  options?: KernelOptions,
): KernelResult {
  return executeWasmOp(
    [
      { shape: a, bodyIndex: 0 },
      { shape: b, bodyIndex: 1 },
    ],
    1,
    "positive",
    options,
  );
}

/**
 * Compute the 2D Boolean **Difference** (`A \ B`) of two shapes.
 */
export function differenceWasm(
  a: ShapeInput2D,
  b: ShapeInput2D,
  options?: KernelOptions,
): KernelResult {
  return executeWasmOp(
    [
      { shape: a, bodyIndex: 0 },
      { shape: b, bodyIndex: 1 },
    ],
    2,
    "positive",
    options,
  );
}

/**
 * Compute the 2D Boolean **Symmetric Difference / XOR** (`A ⊕ B`) of two shapes.
 */
export function xorWasm(a: ShapeInput2D, b: ShapeInput2D, options?: KernelOptions): KernelResult {
  return executeWasmOp(
    [
      { shape: a, bodyIndex: 0 },
      { shape: b, bodyIndex: 1 },
    ],
    3,
    "positive",
    options,
  );
}

/**
 * Compute the single-pass N-body Boolean **Union** of an array of shapes in WASM.
 */
export function unionAllWasm(
  shapes: ReadonlyArray<ShapeInput2D>,
  options?: KernelOptions,
): KernelResult {
  if (shapes.length === 0) return { polygons: [], loops: [] };
  if (shapes.length === 1) {
    return executeWasmOp([{ shape: shapes[0]!, bodyIndex: 0 }], 4, "positive", options);
  }
  const rule = options?.windingRule ?? "positive";
  if (rule === "positive") {
    // Under the positive winding rule, merging oriented shapes into a single body
    // uses O(1) winding delta per edge regardless of N.
    const tagged = shapes.map((shape) => ({ shape, bodyIndex: 0 }));
    return executeWasmOp(tagged, 4, "positive", options);
  }
  const tagged = shapes.map((shape, bodyIndex) => ({ shape, bodyIndex }));
  return executeWasmOp(tagged, 5, rule, options);
}

/**
 * Compute the single-pass N-body Boolean **Intersection** of an array of shapes in WASM.
 */
export function intersectAllWasm(
  shapes: ReadonlyArray<ShapeInput2D>,
  options?: KernelOptions,
): KernelResult {
  if (shapes.length === 0) return { polygons: [], loops: [] };
  if (shapes.length === 1) {
    return executeWasmOp([{ shape: shapes[0]!, bodyIndex: 0 }], 4, "positive", options);
  }
  const tagged = shapes.map((shape, bodyIndex) => ({ shape, bodyIndex }));
  return executeWasmOp(tagged, 6, "positive", options);
}

/**
 * Dynamic dispatcher for any 2D Boolean or healing operation (`"union" | "intersect" | "difference" | "xor" | "heal"`).
 */
export function clipWasm(
  op: BooleanOp,
  a: ShapeInput2D,
  b?: ShapeInput2D,
  options?: KernelOptions,
): KernelResult {
  switch (op) {
    case "heal":
      return healWasm(a, options);
    case "union":
      return b !== undefined ? unionWasm(a, b, options) : healWasm(a, options);
    case "intersect":
      return b !== undefined ? intersectWasm(a, b, options) : { polygons: [], loops: [] };
    case "difference":
      return b !== undefined ? differenceWasm(a, b, options) : healWasm(a, options);
    case "xor":
      return b !== undefined ? xorWasm(a, b, options) : healWasm(a, options);
  }
}

export type MultiBodyEntry = { shape: ShapeInput2D; bodyId: number } | ShapeInput2D;

function isTaggedBodyEntry(item: MultiBodyEntry): item is { shape: ShapeInput2D; bodyId: number } {
  return (
    typeof item === "object" &&
    item !== null &&
    !Array.isArray(item) &&
    "shape" in item &&
    "bodyId" in item
  );
}

/**
 * Evaluate an arbitrary N-body winding predicate over the consolidated planar arrangement in Rust/WASM.
 *
 * @example
 * ```ts
 * // Compute (A ∪ B) \ C in a single topological pass:
 * const res = booleanMulti([polyA, polyB, polyC], (w) => (w[0] > 0 || w[1] > 0) && w[2] <= 0);
 * ```
 */
export function booleanMultiWasm(
  inputs: ReadonlyArray<MultiBodyEntry>,
  predicate: (windings: ReadonlyArray<number>) => boolean,
  options?: KernelOptions,
): KernelResult {
  const wasm = getWasm();
  activePreparedTaskId = -1;
  const tagged = inputs.map((entry, idx) =>
    isTaggedBodyEntry(entry)
      ? { shape: entry.shape, bodyIndex: entry.bodyId }
      : { shape: entry, bodyIndex: idx },
  );
  const segCount = uploadInputsToWasm(tagged, wasm);
  if (segCount === 0) {
    return { polygons: [], loops: [] };
  }

  const snapTol = options?.snapTolerance !== undefined ? options.snapTolerance : -1.0;
  const simplify = (options?.simplifyCollinear ?? true) ? 1 : 0;

  const cycleCount = wasm.wasm_compute_cycles_and_windings(segCount, snapTol, 0);
  if (cycleCount === 0) {
    return { polygons: [], loops: [] };
  }

  const wasmBodyCount = wasm.wasm_get_prep_body_count();
  const userBodyCount = Math.max(inputs.length, wasmBodyCount);
  const cwPtr = wasm.wasm_get_cycle_windings_f64_ptr();
  const ckPtr = wasm.wasm_get_cycle_keep_ptr();

  const cwView = new Float64Array(wasm.memory.buffer, cwPtr, cycleCount * wasmBodyCount);
  const ckView = new Uint8Array(wasm.memory.buffer, ckPtr, cycleCount);

  const wArr = new Array<number>(userBodyCount).fill(0);
  for (let c = 0; c < cycleCount; c++) {
    const base = c * wasmBodyCount;
    for (let b = 0; b < userBodyCount; b++) {
      wArr[b] = b < wasmBodyCount ? cwView[base + b]! : 0;
    }
    ckView[c] = predicate(wArr) ? 1 : 0;
  }

  const loopCount = wasm.wasm_extract_from_cycle_keep(simplify);
  return readKernelResultFromWasm(wasm, loopCount);
}

function loopToTupleRing(loop: ReadonlyArray<Point2D>, closeRing: boolean): TupleLoop2D {
  const n = loop.length;
  if (n === 0) return [];
  const out: TuplePoint2D[] = new Array(closeRing ? n + 1 : n);
  for (let i = 0; i < n; i++) {
    const p = loop[i]!;
    out[i] = [p.x, p.y];
  }
  if (closeRing) {
    const first = loop[0]!;
    out[n] = [first.x, first.y];
  }
  return out;
}

/**
 * Convert a {@link KernelResult} into a `TupleMultiPolygon2D` (`[x, y][][][]`).
 *
 * @param result - Result returned by `union`, `intersect`, `difference`, `xor`, `heal`, etc.
 * @param closeRings - When `true` (default), repeats the first vertex at the end of each ring per the GeoJSON spec.
 */
export function toTupleMultiPolygon(result: KernelResult, closeRings = true): TupleMultiPolygon2D {
  return result.polygons.map((poly) => [
    loopToTupleRing(poly.outer, closeRings),
    ...poly.holes.map((hole) => loopToTupleRing(hole, closeRings)),
  ]);
}

/**
 * Convert a {@link KernelResult} into a standard GeoJSON `MultiPolygon` geometry object.
 */
export function toGeoJSON(result: KernelResult): GeoJSONMultiPolygon {
  return {
    type: "MultiPolygon",
    coordinates: toTupleMultiPolygon(result, true),
  };
}

export interface CycleDiagnostic {
  cycleId: number;
  samplePoint: Point2D;
  windings: number[];
  keep: boolean;
}

export interface PipelineInspection {
  normalization: {
    cx: number;
    cy: number;
    diagonal: number;
    r0: number;
    rMax: number;
    segmentCount: number;
    bodyCount: number;
  };
  complex: {
    vertexCount: number;
    vx: Float64Array;
    vy: Float64Array;
    vr: Float64Array;
    vAlive: Uint8Array;
    edgeCount: number;
    ev0: Uint32Array;
    ev1: Uint32Array;
    eAlive: Uint8Array;
    eDeltaW: Int32Array;
    bodyCount: number;
  };
  cycleCount: number;
  diagnostics: CycleDiagnostic[];
  result: KernelResult;
}

/**
 * Full pipeline execution with diagnostic readouts from WASM memory (for interactive visualizers).
 */
export function inspectPipelineWasm(
  inputs: ReadonlyArray<ShapeInput2D>,
  predicate: (windings: number[]) => boolean,
  options?: KernelOptions,
): PipelineInspection {
  const wasm = getWasm();
  activePreparedTaskId = -1;
  const tagged = inputs.map((shape, bodyIndex) => ({ shape, bodyIndex }));
  const segCount = uploadInputsToWasm(tagged, wasm);
  const snapTol = options?.snapTolerance !== undefined ? options.snapTolerance : -1.0;
  const simplify = (options?.simplifyCollinear ?? true) ? 1 : 0;

  if (segCount === 0) {
    return {
      normalization: {
        cx: 0,
        cy: 0,
        diagonal: 0,
        r0: 1e-9,
        rMax: 2e-9,
        segmentCount: 0,
        bodyCount: Math.max(1, inputs.length),
      },
      complex: {
        vertexCount: 0,
        vx: new Float64Array(0),
        vy: new Float64Array(0),
        vr: new Float64Array(0),
        vAlive: new Uint8Array(0),
        edgeCount: 0,
        ev0: new Uint32Array(0),
        ev1: new Uint32Array(0),
        eAlive: new Uint8Array(0),
        eDeltaW: new Int32Array(0),
        bodyCount: Math.max(1, inputs.length),
      },
      cycleCount: 0,
      diagnostics: [],
      result: { polygons: [], loops: [] },
    };
  }

  const cycleCount = wasm.wasm_compute_cycles_and_windings(segCount, snapTol, 1);
  const wasmBodyCount = wasm.wasm_get_prep_body_count();
  const userBodyCount = Math.max(inputs.length, wasmBodyCount);

  const cwPtr = wasm.wasm_get_cycle_windings_f64_ptr();
  const sxPtr = wasm.wasm_get_cycle_sample_x_ptr();
  const syPtr = wasm.wasm_get_cycle_sample_y_ptr();
  const ckPtr = wasm.wasm_get_cycle_keep_ptr();

  const cwView = new Float64Array(wasm.memory.buffer, cwPtr, cycleCount * wasmBodyCount);
  const sxView = new Float64Array(wasm.memory.buffer, sxPtr, cycleCount);
  const syView = new Float64Array(wasm.memory.buffer, syPtr, cycleCount);
  const ckView = new Uint8Array(wasm.memory.buffer, ckPtr, cycleCount);

  const diagnostics: CycleDiagnostic[] = new Array(cycleCount);
  for (let c = 0; c < cycleCount; c++) {
    const base = c * wasmBodyCount;
    const windings = new Array<number>(userBodyCount);
    for (let b = 0; b < userBodyCount; b++) {
      windings[b] = b < wasmBodyCount ? cwView[base + b]! : 0;
    }
    const keep = predicate(windings);
    ckView[c] = keep ? 1 : 0;
    diagnostics[c] = {
      cycleId: c,
      samplePoint: { x: sxView[c]!, y: syView[c]! },
      windings,
      keep,
    };
  }

  const loopCount = wasm.wasm_extract_from_cycle_keep(simplify);
  const result = readKernelResultFromWasm(wasm, loopCount);

  const vertexCount = wasm.wasm_get_vertex_count();
  const edgeCount = wasm.wasm_get_edge_count();
  const buf = wasm.memory.buffer;

  return {
    normalization: {
      cx: wasm.wasm_get_prep_cx(),
      cy: wasm.wasm_get_prep_cy(),
      diagonal: wasm.wasm_get_prep_diagonal(),
      r0: wasm.wasm_get_prep_r0(),
      rMax: wasm.wasm_get_prep_rmax(),
      segmentCount: segCount,
      bodyCount: wasmBodyCount,
    },
    complex: {
      vertexCount,
      vx: new Float64Array(buf, wasm.wasm_get_vx_ptr(), vertexCount).slice(),
      vy: new Float64Array(buf, wasm.wasm_get_vy_ptr(), vertexCount).slice(),
      vr: new Float64Array(buf, wasm.wasm_get_vr_ptr(), vertexCount).slice(),
      vAlive: new Uint8Array(buf, wasm.wasm_get_v_alive_ptr(), vertexCount).slice(),
      edgeCount,
      ev0: new Uint32Array(buf, wasm.wasm_get_ev0_ptr(), edgeCount).slice(),
      ev1: new Uint32Array(buf, wasm.wasm_get_ev1_ptr(), edgeCount).slice(),
      eAlive: new Uint8Array(buf, wasm.wasm_get_e_alive_ptr(), edgeCount).slice(),
      eDeltaW: new Int32Array(buf, wasm.wasm_get_e_delta_w_ptr(), edgeCount * wasmBodyCount).slice(),
      bodyCount: wasmBodyCount,
    },
    cycleCount,
    diagnostics,
    result,
  };
}

/**
 * Lightweight zero-copy handle to WASM output loops (analogous to Clipper2's `Paths64`),
 * with on-demand materialization to JS `{x, y}` loops, `KernelResult`, or direct signed-area readout.
 */
export interface WasmPathsResult {
  readonly loopCount: number;
  readonly totalArea: number;
  toLoops(): Loop2D[];
  toKernelResult(): KernelResult;
}

/**
 * Pre-normalize a `(subject, clip)` pair inside WASM linear memory for repeated Boolean queries.
 */
export function prepareWasmBooleanTask(subject: ShapeInput2D, clip: ShapeInput2D) {
  const wasm = getWasm();
  const taskId = ++preparedTaskGen;

  stagingSegCount = 0;
  extractShapeToStaging(subject, 0);
  extractShapeToStaging(clip, 1);
  const segCount = stagingSegCount;
  const packedSegments = stagingBuf.slice(0, segCount * 5);

  function ensurePrepared(): void {
    if (activePreparedTaskId === taskId) return;
    if (segCount > 0) {
      const ptr = wasm.wasm_alloc_raw_segments(segCount);
      new Float64Array(wasm.memory.buffer, ptr, segCount * 5).set(packedSegments);
    }
    wasm.wasm_prepare_segments(segCount, -1.0);
    activePreparedTaskId = taskId;
  }

  ensurePrepared();

  return {
    run(opCode: 0 | 1 | 2 | 3): WasmPathsResult {
      ensurePrepared();
      const loopCount = wasm.wasm_execute_prepared(opCode, 0, 1);
      const totalArea = wasm.wasm_get_out_total_area();
      return {
        loopCount,
        totalArea,
        toLoops(): Loop2D[] {
          return readKernelResultFromWasm(wasm, loopCount).loops;
        },
        toKernelResult(): KernelResult {
          return readKernelResultFromWasm(wasm, loopCount);
        },
      };
    },
  };
}
