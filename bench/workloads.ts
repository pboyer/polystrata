import type { Loop2D, Point2D } from "../src/index.js";

export type BenchOp = "union" | "intersect" | "difference" | "xor";

export interface BenchWorkload {
  id: string;
  name: string;
  category: "standard" | "scaling" | "robustness";
  description: string;
  vertexCount: number;
  subject: Loop2D[];
  clip: Loop2D[];
}

function makeBox(x0: number, y0: number, x1: number, y1: number): Loop2D {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function makeRegularPolygon(
  cx: number,
  cy: number,
  r: number,
  n: number,
  phase = 0,
): Loop2D {
  const pts: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (2 * Math.PI * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function makeStar(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  points: number,
  phase = 0,
): Loop2D {
  const pts: Point2D[] = [];
  const total = points * 2;
  for (let i = 0; i < total; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = phase + (Math.PI * i) / points;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function makeGear(
  cx: number,
  cy: number,
  rRoot: number,
  rTip: number,
  teeth: number,
  phase = 0,
): Loop2D {
  const pts: Point2D[] = [];
  const step = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a0 = phase + i * step;
    const a1 = a0 + step * 0.2;
    const a2 = a0 + step * 0.32;
    const a3 = a0 + step * 0.68;
    const a4 = a0 + step * 0.8;
    pts.push(
      { x: cx + rRoot * Math.cos(a0), y: cy + rRoot * Math.sin(a0) },
      { x: cx + rRoot * Math.cos(a1), y: cy + rRoot * Math.sin(a1) },
      { x: cx + rTip * Math.cos(a2), y: cy + rTip * Math.sin(a2) },
      { x: cx + rTip * Math.cos(a3), y: cy + rTip * Math.sin(a3) },
      { x: cx + rRoot * Math.cos(a4), y: cy + rRoot * Math.sin(a4) },
    );
  }
  return pts;
}

function makeComb(teeth: number): Loop2D {
  const comb: Point2D[] = [
    { x: -30, y: -25 },
    { x: 30, y: -25 },
    { x: 30, y: -15 },
  ];
  const span = 56;
  const step = span / teeth;
  for (let i = teeth - 1; i >= 0; i--) {
    const xRight = -28 + (i + 0.82) * step;
    const xMid = -28 + (i + 0.32) * step;
    const xLeft = -28 + i * step;
    comb.push(
      { x: xRight, y: -15 },
      { x: xRight, y: 24 },
      { x: xMid, y: 24 },
      { x: xMid, y: -15 },
      { x: xLeft, y: -15 },
    );
  }
  comb.push({ x: -30, y: -15 });
  return comb;
}

function countLoopsVertices(a: Loop2D[], b: Loop2D[]): number {
  let n = 0;
  for (const l of a) n += l.length;
  for (const l of b) n += l.length;
  return n;
}

export function createBenchmarkWorkloads(): BenchWorkload[] {
  const workloads: BenchWorkload[] = [];

  // 1. Overlapping Gears with Bore Holes (Medium CAD Part)
  {
    const subject = [
      makeGear(-4, 0, 22, 29, 16, 0),
      makeRegularPolygon(-4, 0, 10, 16).reverse(),
    ];
    const clip = [
      makeGear(8, 3, 20, 27, 16, 0.17),
      makeRegularPolygon(8, 3, 8, 16).reverse(),
    ];
    workloads.push({
      id: "cad-gears-192",
      name: "CAD Gears + Bore Holes",
      category: "standard",
      description: "Two 16-tooth gears with concentric bore holes overlapping off-center.",
      vertexCount: countLoopsVertices(subject, clip),
      subject,
      clip,
    });
  }

  // 2. Swiss-Cheese Perforated Plate (Multi-Hole Grid)
  {
    const subject: Loop2D[] = [makeBox(-30, -30, 30, 30)];
    for (let gx = -2; gx <= 2; gx++) {
      for (let gy = -2; gy <= 2; gy++) {
        subject.push(makeRegularPolygon(gx * 11, gy * 11, 3.6, 8).reverse());
      }
    }
    const clip: Loop2D[] = [
      makeStar(0, 0, 34, 15, 10, 0.2),
    ];
    workloads.push({
      id: "swiss-cheese-224",
      name: "Swiss-Cheese 25-Hole Plate",
      category: "standard",
      description: "Square plate with 25 octagonal holes clipped against a 10-point star.",
      vertexCount: countLoopsVertices(subject, clip),
      subject,
      clip,
    });
  }

  // 3. Comb Fingers vs. Diagonal Bars (High Intersection Density)
  {
    const subject = [makeComb(8)];
    const clip: Loop2D[] = [];
    for (let i = -3; i <= 3; i++) {
      const yOff = i * 6.5;
      clip.push([
        { x: -32, y: yOff - 4 },
        { x: 32, y: yOff + 3 },
        { x: 32, y: yOff + 6 },
        { x: -32, y: yOff - 1 },
      ]);
    }
    workloads.push({
      id: "comb-grid-72",
      name: "Comb Array x Diagonal Bars",
      category: "standard",
      description: "8-finger comb crossed by 7 diagonal bars (~120 interior crossings).",
      vertexCount: countLoopsVertices(subject, clip),
      subject,
      clip,
    });
  }

  // 4-7. Vertex Scaling Series: N = 64, 256, 1024, 2048 total vertices
  for (const totalVerts of [64, 256, 1024, 2048]) {
    const pointsPerStar = totalVerts / 4;
    const subject = [makeStar(-3, 0, 28, 18, pointsPerStar, 0)];
    const clip = [makeStar(3, 2, 28, 18, pointsPerStar, Math.PI / pointsPerStar)];
    workloads.push({
      id: `scale-star-${totalVerts}`,
      name: `Star Scaling (N=${totalVerts})`,
      category: "scaling",
      description: `Two high-frequency star polygons with ${totalVerts} total vertices.`,
      vertexCount: countLoopsVertices(subject, clip),
      subject,
      clip,
    });
  }

  // 8. Robustness: Shared Collinear Walls & T-Junction Floorplan
  {
    const subject = [
      makeBox(-20, -20, 0, 10),
      makeBox(-20, 10, -5, 25),
      makeBox(0, -20, 15, -5),
    ];
    const clip = [
      makeBox(0, -10, 20, 20),
      makeBox(-5, 10, 10, 25),
      makeBox(-10, -20, 0, -5),
    ];
    workloads.push({
      id: "robust-shared-walls",
      name: "Shared Collinear Walls & T-Junctions",
      category: "robustness",
      description: "Adjacent floorplan rooms sharing exact collinear edges and T-junctions.",
      vertexCount: countLoopsVertices(subject, clip),
      subject,
      clip,
    });
  }

  // 9. Robustness: Shallow-Angle Grazing Ribbons (0.08 deg)
  {
    const len = 100;
    const w = 1.2;
    const rad = (0.08 * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const base = makeBox(-len, -w, len, w);
    const rotated = base.map((p) => ({
      x: p.x * cos - p.y * sin,
      y: p.x * sin + p.y * cos,
    }));
    workloads.push({
      id: "robust-shallow-angle",
      name: "Shallow-Angle Crossing (0.08°)",
      category: "robustness",
      description: "Long ribbons intersecting at 0.08° where ill-conditioned intersections occur.",
      vertexCount: 8,
      subject: [base],
      clip: [rotated],
    });
  }

  // 10. Robustness: Self-Intersecting Bowties & Kissing Pinch Corners
  {
    const subject: Loop2D[] = [
      // Self-intersecting bowtie
      [
        { x: -20, y: -15 },
        { x: 10, y: 15 },
        { x: 10, y: -15 },
        { x: -20, y: 15 },
      ],
      makeBox(10, 15, 25, 28), // Kissing corner at (10, 15)
    ];
    const clip: Loop2D[] = [
      [
        { x: -10, y: -20 },
        { x: 20, y: 10 },
        { x: -10, y: 10 },
        { x: 20, y: -20 },
      ],
    ];
    workloads.push({
      id: "robust-bowtie-pinch",
      name: "Self-Intersecting Bowties & Pinch Corners",
      category: "robustness",
      description: "Figure-8 self-intersecting loops combined with degree-4 kissing corners.",
      vertexCount: countLoopsVertices(subject, clip),
      subject,
      clip,
    });
  }

  // 11. Robustness: Large Coordinate Offset (10^6) with Micro-Slivers
  {
    const ox = 1_500_000;
    const oy = -2_250_000;
    const subject: Loop2D[] = [
      [
        { x: ox, y: oy },
        { x: ox + 20 - 1e-5, y: oy },
        { x: ox + 20, y: oy + 1e-5 }, // micro-sliver at corner
        { x: ox + 20, y: oy + 20 },
        { x: ox, y: oy + 20 },
      ],
    ];
    const clip: Loop2D[] = [
      makeBox(ox + 8, oy + 8, ox + 28, oy + 28),
    ];
    workloads.push({
      id: "robust-large-coords",
      name: "Large Offset (1.5×10⁶) + Micro-Sliver",
      category: "robustness",
      description: "Tests IEEE-754 precision loss far from origin with a 10⁻⁵ corner sliver.",
      vertexCount: countLoopsVertices(subject, clip),
      subject,
      clip,
    });
  }

  return workloads;
}
