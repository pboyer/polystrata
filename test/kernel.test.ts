import { describe, expect, it } from "vitest";
import {
  booleanMulti,
  clip,
  difference,
  differenceWasm,
  type GeoJSONPolygon,
  heal,
  healWasm,
  intersect,
  intersectAll,
  intersectWasm,
  type KernelResult,
  type Loop2D,
  type Point2D,
  type PolygonWithHoles2D,
  type Segment2D,
  signedLoopArea,
  toGeoJSON,
  toTupleMultiPolygon,
  type TupleLoop2D,
  union,
  unionAll,
  unionWasm,
  xor,
  xorWasm,
} from "../src/index.js";

function totalSignedArea(res: KernelResult): number {
  let area = 0;
  for (const loop of res.loops) {
    area += signedLoopArea(loop);
  }
  return area;
}

function makeBox(x0: number, y0: number, x1: number, y1: number): Loop2D {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

describe("2D Straight-Line B-Rep Kernel - Deterministic Edge & Torture Cases", () => {
  it("heals a self-intersecting bowtie (figure-8) into two manifold triangles", () => {
    // Bowtie crossing at (5, 5): left triangle (0,0)-(5,5)-(0,10) CW and right (5,5)-(10,0)-(10,10) CCW
    const bowtie: Loop2D = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];

    const healedNonZero = heal(bowtie, { windingRule: "nonZero" });
    expect(healedNonZero.polygons.length).toBe(2);
    expect(totalSignedArea(healedNonZero)).toBeCloseTo(50, 6);

    // Under positive winding rule, only the CCW lobe survives (area = 25)
    const healedPositive = heal(bowtie, { windingRule: "positive" });
    expect(healedPositive.polygons.length).toBe(1);
    expect(totalSignedArea(healedPositive)).toBeCloseTo(25, 6);
  });

  it("snaps unclosed micro-gaps, collapses sliver edges, and removes dangling whiskers", () => {
    const gap = 5e-5;
    const segments: Segment2D[] = [
      // 10x10 square with a micro-gap at (0, 0) and a tiny sliver edge at (10, 0)
      { p0: { x: 0, y: gap }, p1: { x: 10 - 1e-5, y: 0 } },
      { p0: { x: 10 - 1e-5, y: 0 }, p1: { x: 10, y: 1e-5 } }, // tiny sliver
      { p0: { x: 10, y: 1e-5 }, p1: { x: 10, y: 10 } },
      { p0: { x: 10, y: 10 }, p1: { x: 0, y: 10 } },
      { p0: { x: 0, y: 10 }, p1: { x: 0, y: 0 } },
      // Dangling exterior whisker sticking out from (10, 5) to (15, 5)
      { p0: { x: 10, y: 5 }, p1: { x: 15, y: 5 } },
      // Dangling interior whisker sticking in from (0, 5) to (3, 5)
      { p0: { x: 0, y: 5 }, p1: { x: 3, y: 5 } },
      // Detached floating whisker in free space
      { p0: { x: 20, y: 20 }, p1: { x: 25, y: 25 } },
    ];

    // With snapTolerance = 1e-4 > gap, the square seals and all whiskers vanish
    const healed = heal(segments, { snapTolerance: 1e-4 });
    expect(healed.polygons.length).toBe(1);
    expect(healed.polygons[0]!.holes.length).toBe(0);
    expect(healed.polygons[0]!.outer.length).toBe(4);
    expect(totalSignedArea(healed)).toBeCloseTo(100, 2);
  });

  it("handles overlapping collinear segments and shared internal walls", () => {
    // Two adjacent 10x10 squares sharing the edge x = 10 from y = 0 to y = 10
    const leftSquare = makeBox(0, 0, 10, 10);
    const rightSquare = makeBox(10, 0, 20, 10);

    const res = union(leftSquare, rightSquare);
    expect(res.polygons.length).toBe(1);
    expect(res.loops.length).toBe(1);
    expect(res.polygons[0]!.outer.length).toBe(4);
    expect(totalSignedArea(res)).toBeCloseTo(200, 6);

    // Partial collinear overlap: right square shifted vertically by 5
    const shiftedRight = makeBox(10, 5, 20, 15);
    const resShifted = union(leftSquare, shiftedRight);
    expect(resShifted.polygons.length).toBe(1);
    expect(totalSignedArea(resShifted)).toBeCloseTo(200, 6);
    expect(resShifted.polygons[0]!.outer.length).toBe(8);
  });

  it("supports polygons with nested holes and islands across Union, Intersect, Difference, XOR", () => {
    // Outer 20x20 square with a 12x12 hole and a 4x4 island inside the hole
    const polyWithHoleAndIsland: PolygonWithHoles2D[] = [
      {
        outer: makeBox(0, 0, 20, 20), // Area = 400
        holes: [makeBox(4, 4, 16, 16).reverse()], // Hole area = -144
      },
      {
        outer: makeBox(8, 8, 12, 12), // Island area = +16
        holes: [],
      },
    ];

    const healed = heal(polyWithHoleAndIsland, { windingRule: "positive" });
    // Total expected area = 400 - 144 + 16 = 272
    expect(totalSignedArea(healed)).toBeCloseTo(272, 6);
    expect(healed.polygons.length).toBe(2);

    // Cut with a horizontal bar y in [6, 14], x in [-2, 22] (area = 24 * 8 = 192)
    const cutter = makeBox(-2, 6, 22, 14);

    const diff = difference(polyWithHoleAndIsland, cutter);
    // Remaining parts of outer frame:
    // Bottom strip y in [0, 6]: 20*6 - 12*2 = 120 - 24 = 96
    // Top strip y in [14, 20]: 20*6 - 12*2 = 96
    // Island is completely inside y in [6, 14] so it is removed!
    // Total diff area = 192
    expect(totalSignedArea(diff)).toBeCloseTo(192, 6);

    const inter = intersect(polyWithHoleAndIsland, cutter);
    // Left pillar x in [0, 4], y in [6, 14]: 4 * 8 = 32
    // Right pillar x in [16, 20], y in [6, 14]: 4 * 8 = 32
    // Central island x in [8, 12], y in [8, 12]: 4 * 4 = 16
    // Total intersect area = 80
    expect(totalSignedArea(inter)).toBeCloseTo(80, 6);
    expect(inter.polygons.length).toBe(3);

    const uni = union(polyWithHoleAndIsland, cutter);
    // Area(A | B) = Area(A) + Area(B) - Area(A & B) = 272 + 192 - 80 = 384
    expect(totalSignedArea(uni)).toBeCloseTo(384, 6);

    const symDiff = xor(polyWithHoleAndIsland, cutter);
    // Area(A ^ B) = Area(A | B) - Area(A & B) = 384 - 80 = 304
    expect(totalSignedArea(symDiff)).toBeCloseTo(304, 6);
  });

  it("handles shallow-angle crossings (0.05 deg to 1 deg) without tolerance blowup", () => {
    // Two long thin rectangles crossing at a shallow 0.1 degree angle at the origin
    const halfLen = 100;
    const halfWidth = 1;
    const angleRad = (0.1 * Math.PI) / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const rectA = makeBox(-halfLen, -halfWidth, halfLen, halfWidth);
    const rectB: Loop2D = rectA.map((p) => ({
      x: p.x * cos - p.y * sin,
      y: p.x * sin + p.y * cos,
    }));

    const u = union(rectA, rectB);
    const i = intersect(rectA, rectB);

    const areaA = 4 * halfLen * halfWidth;
    const areaB = 4 * halfLen * halfWidth;
    expect(u.polygons.length).toBe(1);
    expect(i.polygons.length).toBe(1);
    // Inclusion-exclusion: Area(A | B) + Area(A & B) == Area(A) + Area(B)
    expect(totalSignedArea(u) + totalSignedArea(i)).toBeCloseTo(areaA + areaB, 3);
  });

  it("maintains precision on models far from the origin (1,000,000+ coordinates)", () => {
    const offsetX = 1_000_000;
    const offsetY = -2_500_000;
    const boxA = makeBox(offsetX, offsetY, offsetX + 10, offsetY + 10);
    const boxB = makeBox(offsetX + 5, offsetY + 5, offsetX + 15, offsetY + 15);

    const u = union(boxA, boxB);
    const i = intersect(boxA, boxB);
    const d = difference(boxA, boxB);

    expect(totalSignedArea(u)).toBeCloseTo(175, 5);
    expect(totalSignedArea(i)).toBeCloseTo(25, 5);
    expect(totalSignedArea(d)).toBeCloseTo(75, 5);

    for (const p of u.polygons[0]!.outer) {
      expect(p.x).toBeGreaterThanOrEqual(offsetX - 1e-5);
      expect(p.x).toBeLessThanOrEqual(offsetX + 15 + 1e-5);
      expect(p.y).toBeGreaterThanOrEqual(offsetY - 1e-5);
      expect(p.y).toBeLessThanOrEqual(offsetY + 15 + 1e-5);
    }
  });

  it("supports multi-body custom Boolean expressions via booleanMulti", () => {
    const box0 = makeBox(0, 0, 10, 10);
    const box1 = makeBox(5, 0, 15, 10);
    const hole2 = makeBox(3, 3, 12, 7);

    // (Body 0 | Body 1) - Body 2
    const res = booleanMulti(
      [
        { shape: box0, bodyId: 0 },
        { shape: box1, bodyId: 1 },
        { shape: hole2, bodyId: 2 },
      ],
      (w) => ((w[0] ?? 0) >= 0.5 || (w[1] ?? 0) >= 0.5) && (w[2] ?? 0) < 0.5,
    );

    // Union of box0 and box1 is 15x10 = 150; hole2 is 9x4 = 36 inside -> 114
    expect(totalSignedArea(res)).toBeCloseTo(114, 5);
    expect(res.polygons.length).toBe(1);
    expect(res.polygons[0]!.holes.length).toBe(1);
  });

  it("preserves collinear degree-2 vertices when simplifyCollinear is false", () => {
    const loopWithMidpoint: Loop2D = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];

    const simplified = heal(loopWithMidpoint, { simplifyCollinear: true });
    expect(simplified.polygons[0]!.outer.length).toBe(4);

    const unsimplified = heal(loopWithMidpoint, { simplifyCollinear: false });
    expect(unsimplified.polygons[0]!.outer.length).toBe(5);
  });

  it("correctly separates kissing corners (checkerboard degree-4 pinch vertex)", () => {
    // Bottom-left [0,10]x[0,10] and top-right [10,20]x[10,20] kissing at (10, 10)
    const bl = makeBox(0, 0, 10, 10);
    const tr = makeBox(10, 10, 20, 20);

    const u = union(bl, tr);
    expect(u.polygons.length).toBe(2);
    expect(u.loops.length).toBe(2);
    expect(totalSignedArea(u)).toBeCloseTo(200, 6);

    // Subtracting a diagonal bar across (10, 10)
    const cutter = makeBox(5, 5, 15, 15);
    const diff = difference(u.polygons, cutter);
    // Each 10x10 square loses a 5x5 corner (area 25 each) -> 2 * 75 = 150
    expect(totalSignedArea(diff)).toBeCloseTo(150, 6);
    expect(diff.polygons.length).toBe(2);
  });

  it("cancels opposite-direction coincident spikes and handles stacked duplicate polygons", () => {
    // Two identical stacked squares: winding number inside is +2
    const sq1 = makeBox(0, 0, 10, 10);
    const sq2 = makeBox(0, 0, 10, 10);

    const healedNonZero = heal([sq1, sq2], { windingRule: "nonZero" });
    expect(healedNonZero.polygons.length).toBe(1);
    expect(totalSignedArea(healedNonZero)).toBeCloseTo(100, 6);

    // Under evenOdd rule, winding +2 cancels out to empty!
    const healedEvenOdd = heal([sq1, sq2], { windingRule: "evenOdd" });
    expect(healedEvenOdd.polygons.length).toBe(0);
    expect(totalSignedArea(healedEvenOdd)).toBeCloseTo(0, 6);
  });

  it("decomposes a hole kissing the outer shell at a single vertex into simple shell + hole loops", () => {
    const outer = makeBox(0, 0, 10, 10); // Area = 100
    // Diamond hole inside the square that touches the bottom edge at a single vertex (5, 0)
    const kissingDiamond: Loop2D = [
      { x: 5, y: 0 },
      { x: 8, y: 5 },
      { x: 5, y: 9 },
      { x: 2, y: 5 },
    ]; // Area = 0.5 * 6 * 9 = 27

    const res = difference(outer, kissingDiamond);
    expect(totalSignedArea(res)).toBeCloseTo(100 - 27, 6);
    expect(res.polygons.length).toBe(1);
    expect(res.polygons[0]!.holes.length).toBe(1);
    expect(res.loops.length).toBe(2);

    // Every loop must have unique vertices (strictly simple)
    for (const loop of res.loops) {
      const seen = new Set(loop.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`));
      expect(seen.size).toBe(loop.length);
    }
  });

  it("decomposes two interior holes kissing at a pinch vertex into two distinct simple holes", () => {
    const outer = makeBox(0, 0, 20, 20); // Area = 400
    const holeA = makeBox(2, 2, 10, 10); // Area = 64
    const holeB = makeBox(10, 10, 18, 18); // Area = 64, kisses holeA at (10, 10)

    const step1 = difference(outer, holeA);
    const res = difference(step1.polygons, holeB);

    expect(totalSignedArea(res)).toBeCloseTo(400 - 64 - 64, 6);
    expect(res.polygons.length).toBe(1);
    expect(res.polygons[0]!.holes.length).toBe(2);
    expect(res.loops.length).toBe(3);
  });

  it("removes 180-degree fold-back spikes even when simplifyCollinear is false", () => {
    // Square with an unequal-length 180-degree fold-back along the top edge and a protruding spike
    const spikedLoop: Loop2D = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 15, y: 5 }, // protruding spike tip
      { x: 10, y: 5 }, // returns to (10, 5)
      { x: 10, y: 10 },
      { x: 3, y: 10 }, // goes left to x=3
      { x: 7, y: 10 }, // folds back right to x=7 along y=10
      { x: 0, y: 10 }, // continues left to x=0
    ];

    const resTrue = heal(spikedLoop, { simplifyCollinear: true });
    expect(resTrue.polygons.length).toBe(1);
    expect(resTrue.polygons[0]!.outer.length).toBe(4);
    expect(totalSignedArea(resTrue)).toBeCloseTo(100, 6);

    const resFalse = heal(spikedLoop, { simplifyCollinear: false });
    expect(resFalse.polygons.length).toBe(1);
    expect(totalSignedArea(resFalse)).toBeCloseTo(100, 6);
  });

  it("assigns multi-level Russian-doll holes to their immediate enclosing island or outer shell", () => {
    // Shell 1: [0, 40]^2 (area 1600)
    //   Hole 1: [5, 35]^2 (area -900)
    //     Island Shell 2: [10, 30]^2 (area +400)
    //       Inner Hole 2: [15, 25]^2 (area -100)
    const outerRing = difference(makeBox(0, 0, 40, 40), makeBox(5, 5, 35, 35));
    const innerRing = difference(makeBox(10, 10, 30, 30), makeBox(15, 15, 25, 25));
    const combined = union(outerRing.polygons, innerRing.polygons);

    expect(totalSignedArea(combined)).toBeCloseTo(1600 - 900 + 400 - 100, 5);
    expect(combined.polygons.length).toBe(2);

    // Sort by outer shell area ascending: first is Island Shell 2 (area 400), second is Shell 1 (area 1600)
    const sorted = [...combined.polygons].sort(
      (a, b) => Math.abs(signedLoopArea(a.outer)) - Math.abs(signedLoopArea(b.outer)),
    );
    expect(Math.abs(signedLoopArea(sorted[0]!.outer))).toBeCloseTo(400, 5);
    expect(sorted[0]!.holes.length).toBe(1);
    expect(Math.abs(signedLoopArea(sorted[0]!.holes[0]!))).toBeCloseTo(100, 5);

    expect(Math.abs(signedLoopArea(sorted[1]!.outer))).toBeCloseTo(1600, 5);
    expect(sorted[1]!.holes.length).toBe(1);
    expect(Math.abs(signedLoopArea(sorted[1]!.holes[0]!))).toBeCloseTo(900, 5);
  });

  it("does not allow unclosed vertical whiskers on the right to corrupt winding numbers", () => {
    const segments: Segment2D[] = [
      { p0: { x: 0, y: 0 }, p1: { x: 10, y: 0 } },
      { p0: { x: 10, y: 0 }, p1: { x: 10, y: 10 } },
      { p0: { x: 10, y: 10 }, p1: { x: 0, y: 10 } },
      { p0: { x: 0, y: 10 }, p1: { x: 0, y: 0 } },
      // Vertical whisker to the right of the square spanning y in [-5, 15]
      { p0: { x: 20, y: -5 }, p1: { x: 20, y: 15 } },
    ];

    const res = heal(segments, { windingRule: "positive" });
    expect(res.polygons.length).toBe(1);
    expect(totalSignedArea(res)).toBeCloseTo(100, 5);
  });

  it("matches pure-TS kernel results identically in the Rust/WASM kernel across all Boolean ops", () => {
    const a = makeBox(0, 0, 20, 20);
    const b = makeBox(10, 5, 30, 15);

    expect(totalSignedArea(unionWasm(a, b))).toBeCloseTo(totalSignedArea(union(a, b)), 6);
    expect(totalSignedArea(intersectWasm(a, b))).toBeCloseTo(totalSignedArea(intersect(a, b)), 6);
    expect(totalSignedArea(differenceWasm(a, b))).toBeCloseTo(totalSignedArea(difference(a, b)), 6);
    expect(totalSignedArea(xorWasm(a, b))).toBeCloseTo(totalSignedArea(xor(a, b)), 6);
    expect(totalSignedArea(healWasm([a, b]))).toBeCloseTo(totalSignedArea(heal([a, b])), 6);
  });

  it("supports [x, y] coordinate tuples, GeoJSON Polygon/MultiPolygon, and toGeoJSON/toTupleMultiPolygon", () => {
    // Closed GeoJSON-style tuple ring with duplicate closing vertex
    const tupleA: TupleLoop2D = [
      [0, 0],
      [20, 0],
      [20, 20],
      [0, 20],
      [0, 0],
    ];
    // GeoJSON Polygon with an outer ring (even if CW!) and an interior hole ring
    const geoB: GeoJSONPolygon = {
      type: "Polygon",
      coordinates: [
        [
          [10, 0],
          [10, 20],
          [30, 20],
          [30, 0],
          [10, 0],
        ],
        [
          [22, 5],
          [28, 5],
          [28, 15],
          [22, 15],
          [22, 5],
        ],
      ],
    };

    const res = union(tupleA, geoB);
    // 30x20 outer = 600 minus 6x10 hole = 60 -> 540
    expect(totalSignedArea(res)).toBeCloseTo(540, 5);
    expect(res.polygons.length).toBe(1);
    expect(res.polygons[0]!.holes.length).toBe(1);

    const geoOut = toGeoJSON(res);
    expect(geoOut.type).toBe("MultiPolygon");
    expect(geoOut.coordinates.length).toBe(1);
    expect(geoOut.coordinates[0]!.length).toBe(2); // outer + 1 hole
    // Closed ring has first === last
    const outerRing = geoOut.coordinates[0]![0]!;
    expect(outerRing[0]).toEqual(outerRing[outerRing.length - 1]);

    const unclosedTuples = toTupleMultiPolygon(res, false);
    expect(unclosedTuples[0]![0]!.length).toBe(outerRing.length - 1);
  });

  it("supports flat Float64Array loops, unionAll, intersectAll, and clip dispatcher across >20 bodies", () => {
    const flatA = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
    const flatB = new Float64Array([5, 0, 15, 0, 15, 10, 5, 10]);
    expect(signedLoopArea(flatA)).toBeCloseTo(100, 6);

    expect(totalSignedArea(clip("union", flatA, flatB))).toBeCloseTo(150, 5);
    expect(totalSignedArea(clip("intersect", flatA, flatB))).toBeCloseTo(50, 5);
    expect(totalSignedArea(clip("difference", flatA, flatB))).toBeCloseTo(50, 5);
    expect(totalSignedArea(clip("xor", flatA, flatB))).toBeCloseTo(100, 5);

    // 25 overlapping 2x10 vertical strips spaced by dx=1 -> total width = 26, height = 10 -> area = 260
    const strips: Loop2D[] = [];
    for (let i = 0; i < 25; i++) {
      strips.push(makeBox(i, 0, i + 2, 10));
    }
    const uAll = unionAll(strips);
    expect(totalSignedArea(uAll)).toBeCloseTo(260, 5);
    const uAllEvenOdd = unionAll(strips, { windingRule: "evenOdd" });
    expect(totalSignedArea(uAllEvenOdd)).toBeCloseTo(260, 5);

    // IntersectAll of 3 overlapping boxes: [0,10]x[0,10], [2,12]x[0,10], [4,14]x[0,10] -> [4,10]x[0,10] = 60
    const iAll = intersectAll([
      makeBox(0, 0, 10, 10),
      makeBox(2, 0, 12, 10),
      makeBox(4, 0, 14, 10),
    ]);
    expect(totalSignedArea(iAll)).toBeCloseTo(60, 5);
  });
});
