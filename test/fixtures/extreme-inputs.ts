// Spawned by adversarial.test.ts in a child process so that a regression to an infinite loop
// fails the test via a timeout instead of hanging the runner. Prints one JSON array to stdout.
import { difference, intersect, type Loop2D, union } from "../../src/index.js";

type Op = (a: Loop2D[], b: Loop2D[]) => { loops: Loop2D[] };

const box = (x0: number, y0: number, x1: number, y1: number, s = 1): Loop2D => [
  { x: x0 * s, y: y0 * s },
  { x: x1 * s, y: y0 * s },
  { x: x1 * s, y: y1 * s },
  { x: x0 * s, y: y1 * s },
];

/** Signed area of the output measured in `unit` lengths, so overflow-scale inputs stay comparable. */
function areaInUnits(loops: Loop2D[], unit: number): number {
  let area = 0;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i]!;
      const q = loop[(i + 1) % loop.length]!;
      area += (p.x / unit) * (q.y / unit) - (q.x / unit) * (p.y / unit);
    }
  }
  return 0.5 * area;
}

interface Case {
  name: string;
  op: Op;
  a: Loop2D[];
  b: Loop2D[];
  unit: number;
  expectedArea: number;
}

const cases: Case[] = [
  {
    name: "Infinity vertex in subject is dropped",
    op: union,
    a: [[{ x: 0, y: 0 }, { x: Infinity, y: 1 }, { x: 1, y: 1 }]],
    b: [box(0.2, 0.2, 0.8, 0.8)],
    unit: 1,
    expectedArea: 0.36,
  },
  {
    name: "NaN vertex in subject is dropped",
    op: union,
    a: [[{ x: 0, y: 0 }, { x: NaN, y: 1 }, { x: 1, y: 1 }]],
    b: [box(0.2, 0.2, 0.8, 0.8)],
    unit: 1,
    expectedArea: 0.36,
  },
  {
    name: "-Infinity vertex in clip is dropped",
    op: difference,
    a: [box(0, 0, 1, 1)],
    b: [[{ x: -Infinity, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0, y: 1 }]],
    unit: 1,
    expectedArea: 1,
  },
  {
    name: "all-non-finite inputs give an empty result",
    op: union,
    a: [[{ x: NaN, y: 0 }, { x: Infinity, y: 1 }, { x: 1, y: -Infinity }]],
    b: [[{ x: NaN, y: NaN }, { x: Infinity, y: Infinity }, { x: 0, y: NaN }]],
    unit: 1,
    expectedArea: 0,
  },
  ...[1e154, 1e200, 1e300].flatMap((s) => [
    {
      name: `squares at ${s}: intersect`,
      op: intersect,
      a: [box(0, 0, 1, 1, s)],
      b: [box(0.1, 0.1, 2, 2, s)],
      unit: s,
      expectedArea: 0.81,
    },
    {
      name: `squares at ${s}: union`,
      op: union,
      a: [box(0, 0, 1, 1, s)],
      b: [box(0.1, 0.1, 2, 2, s)],
      unit: s,
      expectedArea: 3.8,
    },
  ]),
  {
    name: "triangle spanning to 1e308",
    op: union,
    a: [[{ x: 0, y: 0 }, { x: 1e308, y: 0 }, { x: 1e308, y: 1e308 }]],
    b: [box(0.2, 0.2, 0.8, 0.8)],
    unit: 1e308,
    expectedArea: 0.5,
  },
  {
    name: "bodies at opposite ends of the f64 range (span exceeds f64::MAX)",
    op: union,
    a: [box(-1.7, -1.7, -1, -1, 1e308)],
    b: [box(1, 1, 1.7, 1.7, 1e308)],
    unit: 1e308,
    expectedArea: 0.98,
  },
];

const results = cases.map((c) => {
  const t0 = performance.now();
  const loops = c.op(c.a, c.b).loops;
  const ms = performance.now() - t0;
  const finite = loops.every((l) => l.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  return { name: c.name, ms, finite, area: areaInUnits(loops, c.unit), expectedArea: c.expectedArea };
});

process.stdout.write(JSON.stringify(results));
