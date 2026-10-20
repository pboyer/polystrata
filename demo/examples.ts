import type { Loop2D, Point2D, Segment2D, ShapeInput2D, WindingRule } from "../src/index.js";

export type DemoOp = "union" | "intersect" | "difference" | "xor" | "heal" | "custom3";

export interface EditableBody {
  loops: Loop2D[];
  segments: Segment2D[];
}

export interface DemoScenario {
  id: string;
  title: string;
  tag: string;
  summary: string;
  description: string;
  defaultOp: DemoOp;
  defaultWindingRule: WindingRule;
  defaultSnapTolerance: number | null;
  defaultSimplifyCollinear: boolean;
  defaultShowConsolidated?: boolean;
  defaultShowRadii?: boolean;
  createBodies: () => {
    bodyA: EditableBody;
    bodyB: EditableBody;
    bodyC: EditableBody;
  };
}

export function editableBodyToShapeInput(body: EditableBody): ShapeInput2D {
  if (body.segments.length > 0 && body.loops.length === 0) {
    return body.segments;
  }
  if (body.segments.length > 0 && body.loops.length > 0) {
    const allSegs: Segment2D[] = body.segments.map((s) => ({
      p0: { x: s.p0.x, y: s.p0.y },
      p1: { x: s.p1.x, y: s.p1.y },
    }));
    for (const loop of body.loops) {
      const n = loop.length;
      for (let i = 0; i < n; i++) {
        allSegs.push({
          p0: { x: loop[i]!.x, y: loop[i]!.y },
          p1: { x: loop[(i + 1) % n]!.x, y: loop[(i + 1) % n]!.y },
        });
      }
    }
    return allSegs;
  }
  return body.loops;
}

function makeBox(x0: number, y0: number, x1: number, y1: number): Loop2D {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

function makeRegularPolygon(cx: number, cy: number, r: number, n: number, phase = 0): Loop2D {
  const pts: Point2D[] = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (2 * Math.PI * i) / n;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function makeStar(cx: number, cy: number, rOuter: number, rInner: number, points: number, phase = 0): Loop2D {
  const pts: Point2D[] = [];
  const total = points * 2;
  for (let i = 0; i < total; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = phase + (Math.PI * i) / points;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function makeGear(cx: number, cy: number, rRoot: number, rTip: number, teeth: number): Loop2D {
  const pts: Point2D[] = [];
  const step = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a0 = i * step;
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

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: "gear-star-boolean",
    title: "1. Gear & Star Boolean Showcase",
    tag: "BOOLEAN",
    summary: "12-tooth mechanical gear with bore hole vs. 7-point star.",
    description:
      "Drag the orange 7-point star (Body B) across the cyan 12-tooth gear (Body A) or switch between Union, Intersect, Difference, and XOR.",
    defaultOp: "difference",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          makeGear(-4, 0, 22, 29, 12),
          makeRegularPolygon(-4, 0, 10, 12).reverse(),
        ],
        segments: [],
      },
      bodyB: {
        loops: [makeStar(10, 4, 28, 12, 7, 0.2)],
        segments: [],
      },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "micro-gaps-whiskers",
    title: "2. Micro-Gaps, Slivers & Whiskers",
    tag: "HEALING",
    summary: "Broken CAD contour with open corner gaps, slivers, and dangling whiskers.",
    description:
      "Stage 1–2 merges open endpoints within snapTolerance, contracts sub-tolerance sliver edges, and Stage 4 eliminates interior/exterior/floating whiskers because leftKeep == rightKeep across them.",
    defaultOp: "heal",
    defaultWindingRule: "nonZero",
    defaultSnapTolerance: 0.35,
    defaultSimplifyCollinear: true,
    defaultShowConsolidated: true,
    defaultShowRadii: true,
    createBodies: () => ({
      bodyA: {
        loops: [],
        segments: [
          // Outer square with an unclosed gap of ~0.25 at (-15, -15) and a tiny sliver at (15, -15)
          { p0: { x: -15, y: -14.78 }, p1: { x: 14.85, y: -15 } },
          { p0: { x: 14.85, y: -15 }, p1: { x: 15, y: -14.88 } }, // micro-sliver
          { p0: { x: 15, y: -14.88 }, p1: { x: 15, y: 15 } },
          { p0: { x: 15, y: 15 }, p1: { x: -15, y: 15 } },
          { p0: { x: -15, y: 15 }, p1: { x: -15, y: -15 } },
          // Interior hole with a micro-gap at (-6, -6)
          { p0: { x: -6, y: -5.82 }, p1: { x: -6, y: 6 } },
          { p0: { x: -6, y: 6 }, p1: { x: 6, y: 6 } },
          { p0: { x: 6, y: 6 }, p1: { x: 6, y: -6 } },
          { p0: { x: 6, y: -6 }, p1: { x: -6, y: -6 } },
          // Dangling exterior whisker
          { p0: { x: 15, y: 2 }, p1: { x: 26, y: 6 } },
          // Dangling interior whisker
          { p0: { x: -15, y: 0 }, p1: { x: -9, y: 0 } },
          // Detached floating filament in free space
          { p0: { x: -26, y: 18 }, p1: { x: -19, y: 24 } },
        ],
      },
      bodyB: { loops: [], segments: [] },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "self-intersecting-bowtie",
    title: "3. Self-Intersecting Bowtie & Double Star",
    tag: "WINDING",
    summary: "Figure-8 bowtie & pentagram comparing nonZero, positive, and evenOdd rules.",
    description:
      "Toggle Winding Rule between 'nonZero', 'positive', and 'evenOdd': on the figure-8 bowtie, the CW lobe has winding -1 and the CCW lobe has +1. On the pentagram, the core has winding +2.",
    defaultOp: "heal",
    defaultWindingRule: "nonZero",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          // Self-crossing figure-8 bowtie on the left
          [
            { x: -32, y: -16 },
            { x: -6, y: 16 },
            { x: -6, y: -16 },
            { x: -32, y: 16 },
          ],
          // Self-crossing 5-pointed pentagram on the right (winding +2 in pentagon core)
          [
            { x: 18, y: 20 },
            { x: 6, y: -18 },
            { x: 35, y: 6 },
            { x: 1, y: 6 },
            { x: 30, y: -18 },
          ],
        ],
        segments: [],
      },
      bodyB: { loops: [], segments: [] },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "russian-doll-holes",
    title: "4. Russian-Doll Nested Holes & Islands",
    tag: "NESTING",
    summary: "4-level concentric shells, holes, and islands sliced by a horizontal cutter.",
    description:
      "Demonstrates Stage 4 Left-Normal Ray-Cast sample point placement and multi-level hole-to-shell nesting across Union, Intersect, Difference, and XOR.",
    defaultOp: "difference",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          makeBox(-28, -28, 28, 28), // Outer shell (+1)
          makeBox(-21, -21, 21, 21).reverse(), // Hole 1 (0)
          makeBox(-14, -14, 14, 14), // Island shell (+1)
          makeBox(-7, -7, 7, 7).reverse(), // Inner hole (0)
          makeBox(-3, -3, 3, 3), // Innermost core island (+1)
        ],
        segments: [],
      },
      bodyB: {
        loops: [makeBox(-34, -8, 34, 8)],
        segments: [],
      },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "kissing-pinch-vertices",
    title: "5. Kissing Corners & Pinch-Vertex Holes",
    tag: "TOPOLOGY",
    summary: "Checkerboard degree-4 pinch vertex + diamond hole kissing an outer shell.",
    description:
      "Demonstrates high-valence spoke relinking and decomposePinchedVertexWalk: a hole touching the outer shell at (0, -20) is cleanly separated into a strictly simple CCW shell and CW hole.",
    defaultOp: "difference",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          makeBox(-26, -20, 10, 16),
          makeBox(10, 16, 28, 30), // Kisses first box at (10, 16)
        ],
        segments: [],
      },
      bodyB: {
        loops: [
          // Diamond hole kissing bottom edge of first box at (-8, -20)
          [
            { x: -8, y: -20 },
            { x: 2, y: -6 },
            { x: -8, y: 8 },
            { x: -18, y: -6 },
          ],
          // Second hole kissing the diamond at (2, -6)
          [
            { x: 2, y: -6 },
            { x: 8, y: -12 },
            { x: 8, y: 2 },
          ],
        ],
        segments: [],
      },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "shallow-angle-slivers",
    title: "6. Shallow-Angle Crossings (0.15° Ribbon)",
    tag: "ROBUSTNESS",
    summary: "Long ribbons intersecting at a grazing angle without diamond tolerance blowup.",
    description:
      "Curved-carrier B-rep kernels suffer 1/sin(θ/2) tolerance inflation at shallow angles. Snapped straight-line segments split cleanly at the intersection vertex with zero radius blowup.",
    defaultOp: "xor",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => {
      const len = 36;
      const w = 2.2;
      const angle = (2.2 * Math.PI) / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const base = makeBox(-len, -w, len, w);
      const rotated = base.map((p) => ({
        x: p.x * cos - p.y * sin,
        y: p.x * sin + p.y * cos,
      }));
      const rotated2 = base.map((p) => ({
        x: p.x * cos + p.y * sin,
        y: -p.x * sin + p.y * cos,
      }));
      return {
        bodyA: { loops: [base], segments: [] },
        bodyB: { loops: [rotated, rotated2], segments: [] },
        bodyC: { loops: [], segments: [] },
      };
    },
  },

  {
    id: "shared-walls-collinear",
    title: "7. Shared Walls & Partial Collinear Overlaps",
    tag: "COINCIDENT",
    summary: "Adjacent floorplan rooms sharing internal walls and T-junctions.",
    description:
      "Operator 3 splits overlapping edges at T-junctions, and Operator 4a sums signed deltaW across shared segments so opposite-direction internal walls cancel out (deltaW = 0) during Union.",
    defaultOp: "union",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          makeBox(-28, -20, 0, 12),
          makeBox(-28, 12, -8, 26),
        ],
        segments: [],
      },
      bodyB: {
        loops: [
          makeBox(0, -12, 26, 20),
          makeBox(-8, 12, 12, 26),
        ],
        segments: [],
      },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "foldback-spikes-collinear",
    title: "8. 180° Fold-Back Spikes & Collinear Vertices",
    tag: "SIMPLIFY",
    summary: "Polygon with protruding needle spikes, 180° fold-backs, and collinear midpoints.",
    description:
      "Toggle 'Simplify Collinear Degree-2 Vertices' in the right panel: 180° fold-back spikes are always removed, while stepped collinear vertices along the edges are preserved when unchecked.",
    defaultOp: "heal",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          [
            { x: -20, y: -18 },
            { x: -10, y: -18 }, // collinear midpoint 1
            { x: 0, y: -18 },   // collinear midpoint 2
            { x: 10, y: -18 },  // collinear midpoint 3
            { x: 20, y: -18 },
            { x: 20, y: -3 },
            { x: 34, y: -3 },   // needle spike out
            { x: 20, y: -3 },   // needle spike return
            { x: 20, y: 18 },
            { x: -8, y: 18 },   // goes left past 4
            { x: 6, y: 18 },    // 180-deg fold-back right
            { x: -20, y: 18 },  // continues to corner
            { x: -20, y: 4 },
            { x: -32, y: 4 },   // left needle spike
            { x: -20, y: 4 },
          ],
        ],
        segments: [],
      },
      bodyB: { loops: [], segments: [] },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "stacked-duplicates-winding",
    title: "9. Stacked Duplicate Shells (Winding +2)",
    tag: "WINDING",
    summary: "Two overlapping squares with a third offset square comparing nonZero vs. evenOdd.",
    description:
      "Body A contains two overlapping polygons creating a winding=+2 overlap region. Switch Winding Rule between 'nonZero' (solid) and 'evenOdd' (overlap region becomes an interior hole!).",
    defaultOp: "heal",
    defaultWindingRule: "evenOdd",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          makeBox(-24, -18, 10, 16),
          makeBox(-12, -10, 22, 22),
          makeBox(-4, -22, 18, 6),
        ],
        segments: [],
      },
      bodyB: { loops: [], segments: [] },
      bodyC: { loops: [], segments: [] },
    }),
  },

  {
    id: "three-body-csg-bracket",
    title: "10. 3-Body CSG Mechanical Bracket ((A ∪ B) \\ C)",
    tag: "MULTI-BODY",
    summary: "Single-pass 3-body Boolean expression combining flange A, arm B, and cutouts C.",
    description:
      "Uses booleanMulti([A, B, C], w => (w[0] > 0 || w[1] > 0) && w[2] <= 0) to evaluate a multi-body CSG tree in a single planar arrangement pass.",
    defaultOp: "custom3",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => ({
      bodyA: {
        loops: [
          makeRegularPolygon(-12, 0, 22, 16),
          makeBox(-12, -14, 24, 14),
        ],
        segments: [],
      },
      bodyB: {
        loops: [
          makeRegularPolygon(22, 0, 16, 16),
          makeBox(-4, -22, 8, 22),
        ],
        segments: [],
      },
      bodyC: {
        loops: [
          makeRegularPolygon(-12, 0, 9, 14),
          makeRegularPolygon(22, 0, 7, 14),
          makeBox(-2, -5, 11, 5),
          makeRegularPolygon(2, 16, 3.2, 10),
          makeRegularPolygon(2, -16, 3.2, 10),
        ],
        segments: [],
      },
    }),
  },

  {
    id: "starburst-torture",
    title: "11. 60-Segment Radial Starburst Torture",
    tag: "TORTURE",
    summary: "20 thin radial wedges meeting near (0, 0) with micro-offsets.",
    description:
      "Stress-tests Stage 1–2 vertex cluster merging and Stage 3 CCW spoke sorting around a high-valence central hub.",
    defaultOp: "union",
    defaultWindingRule: "nonZero",
    defaultSnapTolerance: 0.02,
    defaultSimplifyCollinear: true,
    createBodies: () => {
      const loopsA: Loop2D[] = [];
      const count = 16;
      for (let i = 0; i < count; i++) {
        const a0 = (2 * Math.PI * i) / count;
        const a1 = a0 + 0.14;
        const ox = Math.cos(i * 1.7) * 0.008;
        const oy = Math.sin(i * 2.3) * 0.008;
        const r = 28;
        loopsA.push([
          { x: ox, y: oy },
          { x: r * Math.cos(a0), y: r * Math.sin(a0) },
          { x: r * Math.cos(a1), y: r * Math.sin(a1) },
        ]);
      }
      return {
        bodyA: { loops: loopsA, segments: [] },
        bodyB: {
          loops: [
            makeRegularPolygon(0, 0, 20, 20),
            makeRegularPolygon(0, 0, 11, 16).reverse(),
          ],
          segments: [],
        },
        bodyC: { loops: [], segments: [] },
      };
    },
  },

  {
    id: "large-coordinate-offset",
    title: "12. Large Coordinate Offset (1,000,000+)",
    tag: "PRECISION",
    summary: "Geometry located at (1,000,000, -2,500,000) testing coordinate centering.",
    description:
      "Without coordinate centering (p' = p - C), IEEE-754 cross products lose ~20 bits of mantissa at 10^6 coordinates. The kernel centers inputs before consolidation and restores world coordinates on output.",
    defaultOp: "xor",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => {
      const ox = 1_000_000;
      const oy = -2_500_000;
      return {
        bodyA: {
          loops: [
            makeBox(ox - 20, oy - 20, ox + 12, oy + 12),
            makeBox(ox - 12, oy - 12, ox + 4, oy + 4).reverse(),
          ],
          segments: [],
        },
        bodyB: {
          loops: [makeStar(ox + 6, oy + 6, 22, 10, 6, 0.3)],
          segments: [],
        },
        bodyC: { loops: [], segments: [] },
      };
    },
  },

  {
    id: "swiss-cheese-grid",
    title: "13. Swiss-Cheese Perforated Plate",
    tag: "HOLES",
    summary: "Plate with 9 polygonal holes intersected with a diagonal frame.",
    description:
      "Demonstrates fast spatial-grid ray-casting and hole classification when cutting a multi-hole perforated plate against a rotated frame.",
    defaultOp: "intersect",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => {
      const loopsA: Loop2D[] = [makeBox(-28, -28, 28, 28)];
      for (let gx = -1; gx <= 1; gx++) {
        for (let gy = -1; gy <= 1; gy++) {
          loopsA.push(makeRegularPolygon(gx * 16, gy * 16, 5.2, 8).reverse());
        }
      }
      return {
        bodyA: { loops: loopsA, segments: [] },
        bodyB: {
          loops: [
            makeRegularPolygon(0, 0, 31, 4, 0.15),
            makeRegularPolygon(0, 0, 10, 4, 0.15).reverse(),
          ],
          segments: [],
        },
        bodyC: { loops: [], segments: [] },
      };
    },
  },

  {
    id: "spiral-comb-labyrinth",
    title: "14. Comb Array vs. Diagonal Bars",
    tag: "ARRANGEMENT",
    summary: "High-intersection grid of comb fingers and diagonal bars.",
    description:
      "Generates dozens of interior crossings and regions in a single arrangement to showcase Stage 3–4 planar cycle extraction.",
    defaultOp: "xor",
    defaultWindingRule: "positive",
    defaultSnapTolerance: null,
    defaultSimplifyCollinear: true,
    createBodies: () => {
      // Multi-finger comb polygon
      const comb: Point2D[] = [
        { x: -28, y: -24 },
        { x: 28, y: -24 },
        { x: 28, y: -16 },
      ];
      const teeth = 5;
      const span = 52;
      const step = span / teeth;
      for (let i = teeth - 1; i >= 0; i--) {
        const xRight = -26 + (i + 0.85) * step;
        const xMid = -26 + (i + 0.35) * step;
        const xLeft = -26 + i * step;
        comb.push(
          { x: xRight, y: -16 },
          { x: xRight, y: 22 },
          { x: xMid, y: 22 },
          { x: xMid, y: -16 },
          { x: xLeft, y: -16 },
        );
      }
      comb.push({ x: -28, y: -16 });

      const bars: Loop2D[] = [];
      for (let i = -2; i <= 2; i++) {
        const yOff = i * 9;
        bars.push([
          { x: -30, y: yOff - 6 },
          { x: 30, y: yOff + 4 },
          { x: 30, y: yOff + 8 },
          { x: -30, y: yOff - 2 },
        ]);
      }

      return {
        bodyA: { loops: [comb], segments: [] },
        bodyB: { loops: bars, segments: [] },
        bodyC: { loops: [], segments: [] },
      };
    },
  },
];
