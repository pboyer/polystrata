import { acquireArena, releaseArena } from "./arena.js";
import { applyWindingRule, classifyAndExtract, type WindingPredicate } from "./classify.js";
import { consolidateComplex } from "./consolidate.js";
import { normalizeInputs } from "./tolerance.js";
import { buildPlanarTopology } from "./topology.js";
import type {
  BooleanOp,
  KernelOptions,
  KernelResult,
  Loop2D,
  Point2D,
  PolygonWithHoles2D,
  Segment2D,
  ShapeInput2D,
  WindingRule,
} from "./types.js";

export type {
  BooleanOp,
  KernelOptions,
  KernelResult,
  Loop2D,
  Point2D,
  PolygonWithHoles2D,
  Segment2D,
  ShapeInput2D,
  WindingRule,
};

export {
  differenceWasm,
  healWasm,
  initPolystrataWasm,
  intersectWasm,
  prepareWasmBooleanTask,
  unionWasm,
  type WasmPathsResult,
  xorWasm,
} from "./wasm-kernel.js";

const singleInputPair: [{ shape: ShapeInput2D; bodyIndex: number }] = [
  { shape: [], bodyIndex: 0 },
];

const twoInputPair: [
  { shape: ShapeInput2D; bodyIndex: number },
  { shape: ShapeInput2D; bodyIndex: number },
] = [
  { shape: [], bodyIndex: 0 },
  { shape: [], bodyIndex: 1 },
];

function executeNormalizedPipeline(
  normalizedInputs: ReadonlyArray<{ shape: ShapeInput2D; bodyIndex: number }>,
  predicate: WindingPredicate,
  options?: KernelOptions,
): KernelResult {
  const arena = acquireArena();
  try {
    const ctx = normalizeInputs(normalizedInputs, options?.snapTolerance, arena);
    if (ctx.segmentCount === 0) {
      return { polygons: [], loops: [] };
    }
    const complex = consolidateComplex(ctx);
    const topology = buildPlanarTopology(complex);
    const simplifyCollinear = options?.simplifyCollinear ?? true;
    return classifyAndExtract(complex, topology, predicate, ctx.cx, ctx.cy, simplifyCollinear);
  } finally {
    releaseArena(arena);
  }
}

/**
 * Execute an arbitrary N-body 2D Boolean or healing operation using a custom winding predicate.
 */
export function booleanMulti(
  inputs: { shape: ShapeInput2D; bodyId: number }[],
  predicate: (windings: number[]) => boolean,
  options?: KernelOptions,
): KernelResult {
  if (inputs.length === 0) {
    return { polygons: [], loops: [] };
  }

  const uniqueBodyIds: number[] = [];
  const bodyIdToDense = new Map<number, number>();
  let maxCallerBodyId = 0;

  const normalizedInputs: { shape: ShapeInput2D; bodyIndex: number }[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const item = inputs[i]!;
    if (!Number.isInteger(item.bodyId) || item.bodyId < 0) {
      throw new Error(`bodyId must be a non-negative integer, received: ${item.bodyId}`);
    }
    if (item.bodyId > maxCallerBodyId) {
      maxCallerBodyId = item.bodyId;
    }
    let denseIdx = bodyIdToDense.get(item.bodyId);
    if (denseIdx === undefined) {
      denseIdx = uniqueBodyIds.length;
      uniqueBodyIds.push(item.bodyId);
      bodyIdToDense.set(item.bodyId, denseIdx);
    }
    normalizedInputs.push({
      shape: item.shape,
      bodyIndex: denseIdx,
    });
  }

  const callerWindings = new Array<number>(maxCallerBodyId + 1).fill(0);

  return executeNormalizedPipeline(
    normalizedInputs,
    (denseWindings) => {
      callerWindings.fill(0);
      for (let d = 0; d < uniqueBodyIds.length; d++) {
        callerWindings[uniqueBodyIds[d]!] = denseWindings[d]!;
      }
      return predicate(callerWindings);
    },
    options,
  );
}

const PRED_HEAL: Record<WindingRule, WindingPredicate> = {
  positive: (w) => (w[0] ?? 0) >= 0.5,
  nonZero: (w) => Math.abs(w[0] ?? 0) >= 0.5,
  evenOdd: (w) => Math.abs(Math.round(w[0] ?? 0)) % 2 === 1,
};

const PRED_UNION: Record<WindingRule, WindingPredicate> = {
  positive: (w) => (w[0] ?? 0) >= 0.5 || (w[1] ?? 0) >= 0.5,
  nonZero: (w) => Math.abs(w[0] ?? 0) >= 0.5 || Math.abs(w[1] ?? 0) >= 0.5,
  evenOdd: (w) =>
    Math.abs(Math.round(w[0] ?? 0)) % 2 === 1 || Math.abs(Math.round(w[1] ?? 0)) % 2 === 1,
};

const PRED_INTERSECT: Record<WindingRule, WindingPredicate> = {
  positive: (w) => (w[0] ?? 0) >= 0.5 && (w[1] ?? 0) >= 0.5,
  nonZero: (w) => Math.abs(w[0] ?? 0) >= 0.5 && Math.abs(w[1] ?? 0) >= 0.5,
  evenOdd: (w) =>
    Math.abs(Math.round(w[0] ?? 0)) % 2 === 1 && Math.abs(Math.round(w[1] ?? 0)) % 2 === 1,
};

const PRED_DIFFERENCE: Record<WindingRule, WindingPredicate> = {
  positive: (w) => (w[0] ?? 0) >= 0.5 && !((w[1] ?? 0) >= 0.5),
  nonZero: (w) => Math.abs(w[0] ?? 0) >= 0.5 && !(Math.abs(w[1] ?? 0) >= 0.5),
  evenOdd: (w) =>
    Math.abs(Math.round(w[0] ?? 0)) % 2 === 1 && !(Math.abs(Math.round(w[1] ?? 0)) % 2 === 1),
};

const PRED_XOR: Record<WindingRule, WindingPredicate> = {
  positive: (w) => ((w[0] ?? 0) >= 0.5) !== ((w[1] ?? 0) >= 0.5),
  nonZero: (w) => (Math.abs(w[0] ?? 0) >= 0.5) !== (Math.abs(w[1] ?? 0) >= 0.5),
  evenOdd: (w) =>
    (Math.abs(Math.round(w[0] ?? 0)) % 2 === 1) !== (Math.abs(Math.round(w[1] ?? 0)) % 2 === 1),
};

/**
 * Heal a single 2D shape or raw segment soup (resolves self-intersections, snaps micro-gaps,
 * collapses sliver edges, removes dangling whiskers, and extracts manifold loops).
 */
export function heal(input: ShapeInput2D, options?: KernelOptions): KernelResult {
  const rule: WindingRule = options?.windingRule ?? "nonZero";
  singleInputPair[0].shape = input;
  try {
    return executeNormalizedPipeline(singleInputPair, PRED_HEAL[rule], options);
  } finally {
    singleInputPair[0].shape = [];
  }
}

/**
 * Compute the 2D Boolean Union (A | B) of two shapes.
 */
export function union(a: ShapeInput2D, b: ShapeInput2D, options?: KernelOptions): KernelResult {
  const rule: WindingRule = options?.windingRule ?? "positive";
  twoInputPair[0].shape = a;
  twoInputPair[1].shape = b;
  try {
    return executeNormalizedPipeline(twoInputPair, PRED_UNION[rule], options);
  } finally {
    twoInputPair[0].shape = [];
    twoInputPair[1].shape = [];
  }
}

/**
 * Compute the 2D Boolean Intersection (A & B) of two shapes.
 */
export function intersect(a: ShapeInput2D, b: ShapeInput2D, options?: KernelOptions): KernelResult {
  const rule: WindingRule = options?.windingRule ?? "positive";
  twoInputPair[0].shape = a;
  twoInputPair[1].shape = b;
  try {
    return executeNormalizedPipeline(twoInputPair, PRED_INTERSECT[rule], options);
  } finally {
    twoInputPair[0].shape = [];
    twoInputPair[1].shape = [];
  }
}

/**
 * Compute the 2D Boolean Difference (A - B) of two shapes.
 */
export function difference(a: ShapeInput2D, b: ShapeInput2D, options?: KernelOptions): KernelResult {
  const rule: WindingRule = options?.windingRule ?? "positive";
  twoInputPair[0].shape = a;
  twoInputPair[1].shape = b;
  try {
    return executeNormalizedPipeline(twoInputPair, PRED_DIFFERENCE[rule], options);
  } finally {
    twoInputPair[0].shape = [];
    twoInputPair[1].shape = [];
  }
}

/**
 * Compute the 2D Boolean Symmetric Difference (A ^ B) of two shapes.
 */
export function xor(a: ShapeInput2D, b: ShapeInput2D, options?: KernelOptions): KernelResult {
  const rule: WindingRule = options?.windingRule ?? "positive";
  twoInputPair[0].shape = a;
  twoInputPair[1].shape = b;
  try {
    return executeNormalizedPipeline(twoInputPair, PRED_XOR[rule], options);
  } finally {
    twoInputPair[0].shape = [];
    twoInputPair[1].shape = [];
  }
}
