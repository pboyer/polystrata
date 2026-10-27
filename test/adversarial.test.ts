import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Prng } from "../demo/fuzzer.js";
import { difference, intersect, type Loop2D, type Point2D, union, xor } from "../src/index.js";
import { type BinaryOp, boundsOf, checkRegions, validateLoops } from "./oracle.js";

/**
 * Adversarial robustness suite. Each family targets a specific weakness of tolerance-based
 * snapping (near-coincident geometry, features at the snap radius, accumulation under iteration,
 * extreme magnitudes) and every output is judged by the exact-predicate oracle in `oracle.ts`.
 */

const OPS: Record<BinaryOp, (a: Loop2D[], b: Loop2D[]) => { loops: Loop2D[] }> = {
  union,
  intersect,
  difference,
  xor,
};
const OP_NAMES = Object.keys(OPS) as BinaryOp[];

interface CaseOptions {
  /** Guard band around boundaries, relative to the input bbox diagonal (snap radius is ~4e-9). */
  guardRel?: number;
  samples?: number;
}

interface FamilyResult {
  /** Wrong regions, bad windings, throws, non-finite output. */
  errors: string[];
  /** Outputs with exact proper crossings or collinear overlaps. */
  crossings: string[];
  /** Outputs with zero-length edges or loops under 3 vertices. */
  degenerate: string[];
}

function newResult(): FamilyResult {
  return { errors: [], crossings: [], degenerate: [] };
}

function runCase(
  rng: Prng,
  res: FamilyResult,
  label: string,
  a: Loop2D[],
  b: Loop2D[],
  opts: CaseOptions = {},
): void {
  const bb = boundsOf([...a, ...b]);
  const guard = (opts.guardRel ?? 1e-6) * Math.max(bb.diagonal, 1);

  // Random interior samples plus samples just outside the guard band around every input vertex.
  const points: Point2D[] = [];
  for (let i = 0; i < (opts.samples ?? 120); i++) {
    points.push({ x: rng.range(bb.x0, bb.x1), y: rng.range(bb.y0, bb.y1) });
  }
  for (const loop of [...a, ...b]) {
    for (const p of loop.slice(0, 40)) {
      const ang = rng.range(0, 2 * Math.PI);
      const r = guard * rng.range(2, 30);
      points.push({ x: p.x + r * Math.cos(ang), y: p.y + r * Math.sin(ang) });
    }
  }

  // Judge in coordinates rescaled by an exact power of two, so the oracle's own products cannot
  // overflow on astronomically large inputs (orientation signs are invariant under the rescale).
  const unit = 2 ** Math.floor(Math.log2(Math.max(bb.diagonal, Number.MIN_VALUE)));
  const toUnit = (loops: Loop2D[]) => loops.map((l) => l.map((p) => ({ x: p.x / unit, y: p.y / unit })));
  const [ua, ub] = [toUnit(a), toUnit(b)];
  const uPoints = points.map((p) => ({ x: p.x / unit, y: p.y / unit }));

  for (const op of OP_NAMES) {
    const tag = `${label} ${op}`;
    let out: Loop2D[];
    try {
      out = toUnit(OPS[op](a, b).loops);
    } catch (err) {
      res.errors.push(`${tag}: threw ${String(err)}`);
      continue;
    }
    const v = validateLoops(out);
    if (v.nonFiniteVertices) {
      res.errors.push(`${tag}: ${v.nonFiniteVertices} non-finite vertices`);
      continue;
    }
    if (v.crossings || v.overlaps) {
      res.crossings.push(`${tag}: ${v.crossings} crossings, ${v.overlaps} overlaps`);
    }
    if (v.degenerateEdges || v.shortLoops) {
      res.degenerate.push(`${tag}: ${v.degenerateEdges} zero-length edges, ${v.shortLoops} short loops`);
    }
    const r = checkRegions(op, ua, ub, out, uPoints, guard / unit);
    if (r.misclassified) {
      res.errors.push(`${tag}: ${r.misclassified}/${r.checked} points misclassified, e.g. ${r.example}`);
    } else if (r.badWinding) {
      res.errors.push(`${tag}: ${r.badWinding}/${r.checked} points with output winding outside {0, 1}`);
    }
  }
}

function expectClean(res: FamilyResult): void {
  expect(res.errors).toEqual([]);
  expect(res.crossings).toEqual([]);
  expect(res.degenerate).toEqual([]);
}

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

function jitteredPolygon(rng: Prng, cx: number, cy: number, r: number, n: number, jitter: number): Loop2D {
  const pts: Loop2D = [];
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / n + rng.range(-jitter, jitter);
    const rr = r * rng.range(0.15, 1.2);
    pts.push({ x: cx + rr * Math.cos(ang), y: cy + rr * Math.sin(ang) });
  }
  return pts;
}

function rotate(loop: Loop2D, theta: number, c: Point2D = { x: 0, y: 0 }): Loop2D {
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return loop.map((p) => ({
    x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
    y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
  }));
}

function transform(loop: Loop2D, scale: number, offset: number): Loop2D {
  return loop.map((p) => ({ x: p.x * scale + offset, y: p.y * scale + offset }));
}

function box(x0: number, y0: number, x1: number, y1: number): Loop2D {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function fanWedges(rng: Prng, apexJitter: number, phase: number): Loop2D[] {
  return Array.from({ length: 12 }, (_, k) => {
    const a0 = (2 * Math.PI * k) / 12 + phase;
    return [
      { x: rng.range(-apexJitter, apexJitter), y: rng.range(-apexJitter, apexJitter) },
      { x: 10 * Math.cos(a0), y: 10 * Math.sin(a0) },
      { x: 10 * Math.cos(a0 + 0.2), y: 10 * Math.sin(a0 + 0.2) },
    ];
  });
}

// ---------------------------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------------------------

describe("adversarial robustness (exact-predicate oracle)", () => {
  it("heavily self-intersecting 60-vertex polygons", () => {
    const rng = new Prng(0x5eed0001);
    const res = newResult();
    for (let i = 0; i < 30; i++) {
      const a = jitteredPolygon(rng, 0, 0, 10, 60, 3);
      const b = jitteredPolygon(rng, rng.range(-3, 3), rng.range(-3, 3), 10, 60, 3);
      runCase(rng, res, `pair ${i}`, [a], [b], { samples: 200 });
    }
    expectClean(res);
  });

  it("near-coincident copies (B = A rotated and shifted by 1e-15 .. 1e-6)", () => {
    const rng = new Prng(0x5eed0002);
    const res = newResult();
    for (const eps of [1e-15, 1e-13, 1e-11, 1e-9, 1e-8, 1e-7, 1e-6]) {
      for (let i = 0; i < 8; i++) {
        const a = jitteredPolygon(rng, 0, 0, 10, 20, 0.3);
        const pivot = { x: rng.range(-5, 5), y: rng.range(-5, 5) };
        const b = rotate(a, eps, pivot).map((p) => ({ x: p.x + eps * rng.range(-10, 10), y: p.y }));
        runCase(rng, res, `eps=${eps} #${i}`, [a], [b]);
      }
    }
    expectClean(res);
  });

  it("thin slivers of width 0.3 .. 1000 snap radii crossing a polygon", () => {
    const rng = new Prng(0x5eed0003);
    const res = newResult();
    for (const k of [0.3, 0.9, 1.1, 2, 4.5, 8, 20, 100, 1000]) {
      for (let i = 0; i < 5; i++) {
        const w = k * 1e-9 * 28;
        const sliver = rotate(box(-10, -w / 2, 10, w / 2), rng.range(0, Math.PI));
        runCase(rng, res, `k=${k} #${i}`, [sliver], [jitteredPolygon(rng, 0, 0, 8, 7, 0.6)]);
      }
    }
    expectClean(res);
  });

  it("zipper edges subdivided into micro-vertices wobbling at the snap radius", () => {
    const rng = new Prng(0x5eed0004);
    const res = newResult();
    const r0 = 1e-9 * 30;
    for (const k of [0.5, 0.95, 1.5, 3]) {
      for (let i = 0; i < 4; i++) {
        const top: Loop2D = [];
        for (let x = 10; x >= -10; x -= 20 / 400) {
          top.push({ x: x + rng.range(-k, k) * r0, y: 5 + rng.range(-k, k) * r0 });
        }
        const a = [{ x: -10, y: -5 }, { x: 10, y: -5 }, ...top];
        const b = rotate(box(-3, 4.99999999, 3, 15), rng.range(-0.01, 0.01));
        runCase(rng, res, `k=${k} #${i}`, [a], [b]);
      }
    }
    expectClean(res);
  });

  it("many shared collinear edges (overlapping grid-aligned rectangles)", () => {
    const rng = new Prng(0x5eed0005);
    const res = newResult();
    for (let i = 0; i < 25; i++) {
      const a: Loop2D[] = [];
      const b: Loop2D[] = [];
      for (let k = 0; k < 15; k++) {
        const x = rng.int(0, 9);
        const y = rng.int(0, 9);
        const w = rng.int(1, 4);
        const h = rng.int(1, 4);
        (k % 2 ? a : b).push(box(x / 10, y / 10, (x + w) / 10, (y + h) / 10));
      }
      runCase(rng, res, `grid ${i}`, a, b, { samples: 250 });
    }
    expectClean(res);
  });

  it("disjoint nested components (holes, islands in holes, holes in islands)", () => {
    const rng = new Prng(0x5eed0006);
    const res = newResult();
    for (let i = 0; i < 30; i++) {
      const c = rng.range(-1, 1);
      const ring = (r: number, cw: boolean) => {
        const loop = jitteredPolygon(rng, c, c, r, 12, 0.05);
        return cw ? loop.reverse() : loop;
      };
      const a = [box(-20, -20, 20, 20), ring(15, true), ring(10, false), ring(5, true)];
      const b = [ring(12, false), ring(7, true), ring(2, false)].map((l) => rotate(l, rng.range(0, 0.3)));
      runCase(rng, res, `nest ${i}`, a, b, { samples: 300 });
    }
    expectClean(res);
  });

  it("iterated Booleans feeding outputs back in (60 steps)", () => {
    const rng = new Prng(0x5eed0007);
    const res = newResult();
    for (let trial = 0; trial < 3; trial++) {
      let s: Loop2D[] = [box(-1, -1, 1, 1)];
      for (let k = 1; k <= 60; k++) {
        const bar = [rotate(box(-1.2, -0.05, 1.2, 0.05), k * 2.399963229728653 + trial, { x: rng.range(-0.01, 0.01), y: 0 })];
        runCase(rng, res, `trial ${trial} step ${k}`, s, bar, { samples: 80 });
        const next = (k % 3 === 0 ? difference(s, bar) : union(s, bar)).loops;
        if (next.length === 0) break;
        s = next;
      }
    }
    expectClean(res);
  });

  it("self-overlapping inputs (doubly traced loops, out-and-back spikes)", () => {
    const rng = new Prng(0x5eed0008);
    const res = newResult();
    for (let i = 0; i < 30; i++) {
      const a = jitteredPolygon(rng, 0, 0, 10, 10, 0.2);
      const twice = [...a, ...a];
      const spike = [...a.slice(0, 3), { x: 30, y: 30 }, a[2]!, ...a.slice(3)];
      runCase(rng, res, `twice ${i}`, [twice], [jitteredPolygon(rng, rng.range(-3, 3), rng.range(-3, 3), 9, 9, 0.6)]);
      runCase(rng, res, `spike ${i}`, [spike], [jitteredPolygon(rng, rng.range(-3, 3), rng.range(-3, 3), 9, 9, 0.6)]);
    }
    expectClean(res);
  });

  // Magnitudes >= 1e154 overflowed squared lengths and used to hang; those live in the
  // child-process test below so a regression cannot hang this runner.
  it("coordinate magnitudes from 1e-12 to 1e100 and offsets up to 1e15", () => {
    const rng = new Prng(0x5eed0009);
    const res = newResult();
    const configs: [number, number][] = [
      [1e-12, 0],
      [1e12, 0],
      [1e40, 0],
      [1e100, 0],
      [1, 1e8],
      [1, 1e12],
      [1, 1e15],
      [1e-3, 1e9],
    ];
    for (const [scale, offset] of configs) {
      for (let i = 0; i < 6; i++) {
        const a = transform(jitteredPolygon(rng, 0, 0, 10, 8, 0.6), scale, offset);
        const b = transform(jitteredPolygon(rng, rng.range(-3, 3), rng.range(-3, 3), 10, 8, 0.6), scale, offset);
        runCase(rng, res, `scale=${scale} offset=${offset} #${i}`, [a], [b]);
      }
    }
    expect(res.errors).toEqual([]);
    expect(res.crossings).toEqual([]);
  });

  it("jittered fans and rotated integer grids classify regions correctly", () => {
    const rng = new Prng(0x5eed000a);
    const res = newResult();
    for (const jitter of [1e-10, 1e-9, 1e-8, 1e-7]) {
      for (let i = 0; i < 6; i++) {
        runCase(rng, res, `fan jitter=${jitter} #${i}`, fanWedges(rng, jitter, 0), fanWedges(rng, jitter, 0.1 + rng.range(-1e-9, 1e-9)));
      }
    }
    for (let i = 0; i < 60; i++) {
      const grid = () =>
        Array.from({ length: 4 + (i % 6) }, () => ({ x: rng.int(0, 7) / 3, y: rng.int(0, 7) / 3 }));
      const theta = 0.5235987755982988 + i * 1e-3;
      runCase(rng, res, `grid ${i}`, [rotate(grid(), theta)], [rotate(grid(), theta)]);
    }
    expect(res.errors).toEqual([]);
  });

  // Regression: the fixed-point loop used to stop before re-checking intersection vertices and
  // merged edges against vertex-on-edge snapping, and collinear simplification dissolved pinch
  // vertices; both left exact crossings ~1e-7 deep in fan outputs.
  it("jittered fans produce crossing-free output", () => {
    const rng = new Prng(0x5eed000b);
    const res = newResult();
    for (let i = 0; i < 40; i++) {
      runCase(rng, res, `fan #${i}`, fanWedges(rng, 1e-7, 0), fanWedges(rng, 1e-7, 0.1 + rng.range(-1e-9, 1e-9)), {
        samples: 20,
      });
    }
    expect(res.crossings).toEqual([]);
  });
});

describe("extreme and non-finite inputs", () => {
  // Run in a child process: a regression here hangs synchronously inside WASM, which an in-process
  // vitest timeout cannot interrupt.
  it("terminate quickly and produce finite, correctly sized output", () => {
    const script = fileURLToPath(new URL("./fixtures/extreme-inputs.ts", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", "tsx", script], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(child.error, "fixture process did not exit (possible hang)").toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    const results = JSON.parse(child.stdout) as {
      name: string;
      ms: number;
      finite: boolean;
      area: number;
      expectedArea: number;
    }[];
    for (const r of results) {
      expect(r.finite, r.name).toBe(true);
      expect(r.ms, r.name).toBeLessThan(1000);
      const relErr = Math.abs(r.area - r.expectedArea) / Math.max(Math.abs(r.expectedArea), Number.MIN_VALUE);
      expect(relErr, `${r.name}: area ${r.area} vs ${r.expectedArea}`).toBeLessThan(1e-9);
    }
  });
});
