import { acquireArena, releaseArena } from "./arena.js";
import { assignHolesToPolygons } from "./classify.js";
import { extractRawSegmentsFromShapeToArena, signedLoopArea } from "./tolerance.js";
import type {
  KernelOptions,
  KernelResult,
  Loop2D,
  Point2D,
  PolygonWithHoles2D,
  ShapeInput2D,
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
  wasm_get_out_coords_ptr: () => number;
  wasm_get_out_coords_len: () => number;
  wasm_get_out_loop_meta_ptr: () => number;
  wasm_get_out_total_area: () => number;
}

let wasmExports: PolystrataWasmExports | null = null;
let preparedTaskGen = 0;
let activePreparedTaskId = -1;

function decodeBase64(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
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
 * Asynchronously initialize the WebAssembly module (safe for large modules on browser main thread).
 */
export async function initPolystrataWasm(): Promise<void> {
  if (wasmExports !== null) return;
  const bytes = getWasmBytes();
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
  wasmExports = instance.exports as unknown as PolystrataWasmExports;
}

function getWasm(): PolystrataWasmExports {
  if (wasmExports !== null) return wasmExports;
  const bytes = getWasmBytes();
  const mod = new WebAssembly.Module(bytes as BufferSource);
  const instance = new WebAssembly.Instance(mod, {});
  wasmExports = instance.exports as unknown as PolystrataWasmExports;
  return wasmExports;
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

function uploadInputsToWasm(
  inputs: ReadonlyArray<{ shape: ShapeInput2D; bodyIndex: number }>,
  wasm: PolystrataWasmExports,
): number {
  const arena = acquireArena();
  try {
    arena.rawCount = 0;
    for (let i = 0; i < inputs.length; i++) {
      const item = inputs[i]!;
      extractRawSegmentsFromShapeToArena(item.shape, item.bodyIndex, arena);
    }
    const segCount = arena.rawCount;
    if (segCount === 0) return 0;

    const ptr = wasm.wasm_alloc_raw_segments(segCount);
    const dst = new Float64Array(wasm.memory.buffer, ptr, segCount * 5);
    const rx0 = arena.rawX0;
    const ry0 = arena.rawY0;
    const rx1 = arena.rawX1;
    const ry1 = arena.rawY1;
    const rbody = arena.rawBody;

    for (let i = 0; i < segCount; i++) {
      const base = i * 5;
      dst[base] = rx0[i]!;
      dst[base + 1] = ry0[i]!;
      dst[base + 2] = rx1[i]!;
      dst[base + 3] = ry1[i]!;
      dst[base + 4] = rbody[i]!;
    }
    return segCount;
  } finally {
    releaseArena(arena);
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
    assignHolesToPolygons(polygons, shellAreasScratch, holeLoopsScratch, holeAreasScratch, 1e-7);
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

export function healWasm(input: ShapeInput2D, options?: KernelOptions): KernelResult {
  return executeWasmOp([{ shape: input, bodyIndex: 0 }], 4, "nonZero", options);
}

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
 * Lightweight zero-copy handle to WASM output loops (analogous to Clipper2's `Paths64`),
 * with on-demand materialization to JS `{x, y}` loops or direct signed-area readout.
 */
export interface WasmPathsResult {
  readonly loopCount: number;
  readonly totalArea: number;
  toLoops(): Loop2D[];
}

export function prepareWasmBooleanTask(subject: Loop2D[], clip: Loop2D[]) {
  const wasm = getWasm();
  const taskId = ++preparedTaskGen;

  const arena = acquireArena();
  let packedSegments: Float64Array;
  let segCount = 0;
  try {
    arena.rawCount = 0;
    extractRawSegmentsFromShapeToArena(subject, 0, arena);
    extractRawSegmentsFromShapeToArena(clip, 1, arena);
    segCount = arena.rawCount;
    packedSegments = new Float64Array(segCount * 5);
    const rx0 = arena.rawX0;
    const ry0 = arena.rawY0;
    const rx1 = arena.rawX1;
    const ry1 = arena.rawY1;
    const rbody = arena.rawBody;
    for (let i = 0; i < segCount; i++) {
      const base = i * 5;
      packedSegments[base] = rx0[i]!;
      packedSegments[base + 1] = ry0[i]!;
      packedSegments[base + 2] = rx1[i]!;
      packedSegments[base + 3] = ry1[i]!;
      packedSegments[base + 4] = rbody[i]!;
    }
  } finally {
    releaseArena(arena);
  }

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
      };
    },
  };
}
