import { Prng } from "../demo/fuzzer.js";
import { heal, type Loop2D } from "../src/index.js";
import { signedLoopArea } from "../src/tolerance.js";
import { LIBRARY_ADAPTERS, type LibraryAdapter } from "./adapters.js";
import { type BenchOp, type BenchWorkload, createBenchmarkWorkloads } from "./workloads.js";

export interface WorkloadLibraryResult {
  libraryId: string;
  libraryName: string;
  opsPerSec: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  unionArea: number;
  intersectArea: number;
  differenceArea: number;
  xorArea: number;
  areaIdentityError: number;
  succeeded: boolean;
  errorMessage?: string;
}

export interface WorkloadBenchmarkSummary {
  workload: BenchWorkload;
  referenceAreaA: number;
  referenceAreaB: number;
  results: WorkloadLibraryResult[];
}

export interface FuzzStressSummary {
  libraryId: string;
  libraryName: string;
  trials: number;
  crashes: number;
  areaIdentityPass: number;
  areaIdentityFail: number;
  totalMs: number;
  opsPerSec: number;
}

export interface FullBenchmarkReport {
  timestamp: string;
  workloadSummaries: WorkloadBenchmarkSummary[];
  fuzzSummaries: FuzzStressSummary[];
}

const ALL_OPS: BenchOp[] = ["union", "intersect", "difference", "xor"];

function totalLoopArea(loops: Loop2D[]): number {
  let a = 0;
  for (const l of loops) a += signedLoopArea(l);
  return a;
}

function measureWorkloadForLibrary(
  workload: BenchWorkload,
  adapter: LibraryAdapter,
  refAreaA: number,
  refAreaB: number,
  targetDurationMs = 120,
): WorkloadLibraryResult {
  try {
    const task = adapter.prepare(workload.subject, workload.clip);

    // Warmup & correctness capture across all 4 ops
    const resU = task.run("union");
    const resI = task.run("intersect");
    const resD = task.run("difference");
    const resX = task.run("xor");

    const unionArea = task.computeArea(resU);
    const intersectArea = task.computeArea(resI);
    const differenceArea = task.computeArea(resD);
    const xorArea = task.computeArea(resX);

    const err1 = Math.abs(unionArea + intersectArea - (refAreaA + refAreaB));
    const err2 = Math.abs(differenceArea + intersectArea - refAreaA);
    const err3 = Math.abs(xorArea + 2 * intersectArea - (refAreaA + refAreaB));
    const areaIdentityError = Math.max(err1, err2, err3);

    // Warmup loop (10ms) so V8 TurboFan tiers up before timed samples
    const warmupStart = performance.now();
    while (performance.now() - warmupStart < 10) {
      for (const op of ALL_OPS) {
        task.run(op);
      }
    }

    // Timed iterations (each sample runs all 4 Boolean operations: union, intersect, difference, xor)
    const sampleTimesMs: number[] = [];
    const startWall = performance.now();

    while (
      (performance.now() - startWall < targetDurationMs && sampleTimesMs.length < 200) ||
      sampleTimesMs.length < 2
    ) {
      const t0 = performance.now();
      for (const op of ALL_OPS) {
        task.run(op);
      }
      const dt = (performance.now() - t0) / ALL_OPS.length;
      sampleTimesMs.push(dt);
    }

    sampleTimesMs.sort((a, b) => a - b);
    const trimCount =
      sampleTimesMs.length >= 10
        ? Math.max(1, Math.floor(sampleTimesMs.length * 0.9))
        : sampleTimesMs.length;
    let sum = 0;
    for (let i = 0; i < trimCount; i++) {
      sum += sampleTimesMs[i]!;
    }
    const meanMs = sum / trimCount;
    const p50Ms = sampleTimesMs[Math.floor(sampleTimesMs.length * 0.5)]!;
    const p95Ms = sampleTimesMs[Math.floor(sampleTimesMs.length * 0.95)]!;
    const opsPerSec = meanMs > 0 ? 1000 / meanMs : 0;

    return {
      libraryId: adapter.id,
      libraryName: adapter.name,
      opsPerSec,
      meanMs,
      p50Ms,
      p95Ms,
      unionArea,
      intersectArea,
      differenceArea,
      xorArea,
      areaIdentityError,
      succeeded: Number.isFinite(areaIdentityError) && areaIdentityError < 1.0,
    };
  } catch (err) {
    return {
      libraryId: adapter.id,
      libraryName: adapter.name,
      opsPerSec: 0,
      meanMs: Infinity,
      p50Ms: Infinity,
      p95Ms: Infinity,
      unionArea: NaN,
      intersectArea: NaN,
      differenceArea: NaN,
      xorArea: NaN,
      areaIdentityError: Infinity,
      succeeded: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
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
    const angle = baseAngle + rng.range(-0.55, 0.55);
    const r = radius * rng.range(0.2, 1.2);
    pts.push({
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    });
  }
  return pts;
}

export function runFuzzStressComparison(numTrials = 150): FuzzStressSummary[] {
  const trialInputs: { polyA: Loop2D[]; polyB: Loop2D[]; areaA: number; areaB: number }[] = [];
  const rng = new Prng(0xbadcafe);

  for (let t = 0; t < numTrials; t++) {
    const nA = rng.int(4, 9);
    const nB = rng.int(4, 9);
    const rawA = randomDegeneratePolygon(rng, rng.range(-8, 8), rng.range(-8, 8), rng.range(8, 24), nA);
    const rawB = randomDegeneratePolygon(rng, rng.range(-8, 8), rng.range(-8, 8), rng.range(8, 24), nB);

    if (t % 3 === 0) {
      rawB[0] = {
        x: rawA[0]!.x + rng.range(-1e-10, 1e-10),
        y: rawA[0]!.y + rng.range(-1e-10, 1e-10),
      };
    }
    if (t % 4 === 0) {
      const p0 = rawA[0]!;
      const p1 = rawA[1]!;
      rawA.splice(1, 0, {
        x: 0.5 * (p0.x + p1.x) + rng.range(-1e-10, 1e-10),
        y: 0.5 * (p0.y + p1.y) + rng.range(-1e-10, 1e-10),
      });
    }

    // Heal A and B first into clean positive loops so libraries that require valid simple rings
    // get a fair baseline, EXCEPT every 3rd trial where we pass raw self-intersecting polygons!
    const useRawSelfIntersecting = t % 3 === 0;
    const healedA = heal(rawA, { windingRule: "positive" });
    const healedB = heal(rawB, { windingRule: "positive" });
    const areaA = totalLoopArea(healedA.loops);
    const areaB = totalLoopArea(healedB.loops);

    trialInputs.push({
      polyA: useRawSelfIntersecting ? [rawA] : healedA.loops,
      polyB: useRawSelfIntersecting ? [rawB] : healedB.loops,
      areaA,
      areaB,
    });
  }

  return LIBRARY_ADAPTERS.map((adapter) => {
    let crashes = 0;
    let areaIdentityPass = 0;
    let areaIdentityFail = 0;

    const t0 = performance.now();
    for (let t = 0; t < numTrials; t++) {
      const inp = trialInputs[t]!;
      try {
        const task = adapter.prepare(inp.polyA, inp.polyB);
        const resU = task.run("union");
        const resI = task.run("intersect");
        const resD = task.run("difference");
        const resX = task.run("xor");

        const areaU = task.computeArea(resU);
        const areaI = task.computeArea(resI);
        const areaD = task.computeArea(resD);
        const areaX = task.computeArea(resX);

        const err1 = Math.abs(areaU + areaI - (inp.areaA + inp.areaB));
        const err2 = Math.abs(areaD + areaI - inp.areaA);
        const err3 = Math.abs(areaX + 2 * areaI - (inp.areaA + inp.areaB));
        const maxErr = Math.max(err1, err2, err3);

        if (Number.isFinite(maxErr) && maxErr < 0.5) {
          areaIdentityPass++;
        } else {
          areaIdentityFail++;
        }
      } catch {
        crashes++;
        areaIdentityFail++;
      }
    }
    const totalMs = performance.now() - t0;
    const totalOps = numTrials * 4;

    return {
      libraryId: adapter.id,
      libraryName: adapter.name,
      trials: numTrials,
      crashes,
      areaIdentityPass,
      areaIdentityFail,
      totalMs,
      opsPerSec: totalMs > 0 ? (totalOps / totalMs) * 1000 : 0,
    };
  });
}

export function runFullBenchmarkSuite(
  targetDurationPerWorkloadMs = 100,
  fuzzTrials = 150,
  onProgress?: (msg: string) => void,
): FullBenchmarkReport {
  const workloads = createBenchmarkWorkloads();
  const workloadSummaries: WorkloadBenchmarkSummary[] = [];

  for (const workload of workloads) {
    const healedA = heal(workload.subject, { windingRule: "positive" });
    const healedB = heal(workload.clip, { windingRule: "positive" });
    const refAreaA = totalLoopArea(healedA.loops);
    const refAreaB = totalLoopArea(healedB.loops);

    const results = LIBRARY_ADAPTERS.map((adapter) => {
      onProgress?.(`Running ${workload.id} on ${adapter.id}...`);
      return measureWorkloadForLibrary(
        workload,
        adapter,
        refAreaA,
        refAreaB,
        targetDurationPerWorkloadMs,
      );
    });

    workloadSummaries.push({
      workload,
      referenceAreaA: refAreaA,
      referenceAreaB: refAreaB,
      results,
    });
  }

  const fuzzSummaries = runFuzzStressComparison(fuzzTrials);

  return {
    timestamp: new Date().toISOString(),
    workloadSummaries,
    fuzzSummaries,
  };
}
