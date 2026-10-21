# polystrata

**[Interactive Demo & Fuzzer](https://polystrata.ptrbyr.com)** &bull; **[Live Browser Benchmark Suite](https://polystrata.ptrbyr.com/benchmark)** &bull; **[npm](https://www.npmjs.com/package/polystrata)** &bull; **[crates.io](https://crates.io/crates/polystrata)**

Polystrata is a high-performance, topologically robust 2D polygon clipping library implemented in Rust and available in JS via WebAssembly. To my knowledge, it is simultaneously the fastest AND the most robust polygon clipping library available for JS. It will consume low quality, self-intersecting input while still producing predictable results.

- **Zero dependencies**, self-contained dual ESM + CommonJS build (~53 KB gzipped, including embedded WASM) and native Rust crate (`polystrata`).
- **2.0x–3.1x faster than `clipper2-js`** and **6x–22x faster than `polygon-clipping`** across CAD, high-intersection scaling, and adversarial fuzz workloads while preserving native IEEE-754 `Float64` coordinates (no integer grid quantization).
- **100% pass rate** across 1,000+ adversarial degenerate polygon pairs (self-intersecting bowties, shared collinear walls, T-junctions, 0.08° shallow-angle crossings, and 1.5 × 10⁶ coordinate offsets with 10⁻⁵ micro-slivers).
- **Flexible inputs**: accepts `{ x, y }[]` loops, `[x, y][]` coordinate tuples, GeoJSON `Polygon` / `MultiPolygon`, `PolygonWithHoles2D`, `Float64Array` / `Float32Array` flat buffers, or raw `Segment2D[]` segment soups.

---

## Installation

**JavaScript / TypeScript (npm):**
```bash
npm install polystrata
```

**Rust (Cargo):**
```bash
cargo add polystrata
```

---

## Quick Start

```ts
import {
  union,
  intersect,
  difference,
  xor,
  heal,
  unionAll,
  toGeoJSON,
  initPolystrata,
} from "polystrata";

// Optional on Node.js / Bun / Deno / Web Workers; recommended once at startup on browser main threads:
await initPolystrata();

// 1. Using { x, y } point loops:
const boxA = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];
const boxB = [
  { x: 10, y: 5 },
  { x: 30, y: 5 },
  { x: 30, y: 15 },
  { x: 10, y: 15 },
];

const diff = difference(boxA, boxB);
console.log(diff.polygons); // [{ outer: Loop2D, holes: Loop2D[] }]
console.log(diff.loops);    // Flat array of oriented CCW outer shells & CW holes

// 2. Using [x, y] coordinate tuples or GeoJSON geometries directly:
const poly1 = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const poly2 = {
  type: "Polygon" as const,
  coordinates: [
    [
      [5, 0],
      [15, 0],
      [15, 10],
      [5, 10],
      [5, 0],
    ],
  ],
};

const merged = union(poly1, poly2);
const geojson = toGeoJSON(merged); // { type: "MultiPolygon", coordinates: number[][][][] }
```

### Quick Start (Rust)

```rust
use polystrata::{union, intersect, difference, xor, heal, KernelOptions, WindingRule};

let square_a = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
let square_b = [[5.0, 5.0], [15.0, 5.0], [15.0, 15.0], [5.0, 15.0]];

let opts = KernelOptions::default();

let u = union(&square_a, &square_b, opts);
let i = intersect(&square_a, &square_b, opts);
let d = difference(&square_a, &square_b, opts);
let x = xor(&square_a, &square_b, opts);

// Self-intersection healing (e.g. figure-8 bowtie -> 2 simple CCW triangles)
let bowtie = [[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0]];
let healed = heal(
    &bowtie,
    KernelOptions {
        winding_rule: WindingRule::NonZero,
        ..KernelOptions::default()
    },
);
```

---

## Supported Input Formats (`ShapeInput2D`)

Every operation (`union`, `intersect`, `difference`, `xor`, `heal`, `unionAll`, `intersectAll`, `clip`, `booleanMulti`) accepts any of the following shapes:

| Format | Type | Description |
| :--- | :--- | :--- |
| **Object Ring** | `Point2D[]` (`{ x, y }[]`) | Single closed loop (CCW = outer shell, CW = hole) |
| **Multi-Loop Objects** | `Point2D[][]` | Array of oriented `{ x, y }` loops |
| **Tuple Ring** | `[number, number][]` | Single closed `[x, y]` loop (duplicate closing vertex handled automatically) |
| **Tuple Multi-Loop** | `[number, number][][]` | Array of oriented `[x, y]` loops |
| **Tuple MultiPolygon** | `[number, number][][][]` | GeoJSON-style `MultiPolygon` coordinate array |
| **GeoJSON Geometry** | `GeoJSONPolygon \| GeoJSONMultiPolygon` | `{ type: "Polygon" \| "MultiPolygon", coordinates }` (rings are auto-oriented) |
| **Flat TypedArray** | `Float64Array \| Float32Array` | Packed `[x0, y0, x1, y1, ...]` coordinates (or array of TypedArrays) |
| **Polygon with Holes** | `PolygonWithHoles2D \| PolygonWithHoles2D[]` | `{ outer: Loop2D, holes: Loop2D[] }` |
| **Segment Soup** | `Segment2D[]` | `{ p0: Point2D, p1: Point2D }[]` (snaps micro-gaps & removes dangling whiskers) |

---

## API Reference

### Binary Boolean Operations
- **`union(a, b, options?)`**: Compute union (`A ∪ B`).
- **`intersect(a, b, options?)`**: Compute intersection (`A ∩ B`).
- **`difference(a, b, options?)`**: Compute difference (`A \ B`).
- **`xor(a, b, options?)`**: Compute symmetric difference (`A ⊕ B`).
- **`clip(op, a, b?, options?)`**: Dynamic dispatcher where `op` is `"union" | "intersect" | "difference" | "xor" | "heal"`.

### Topological Healing & N-Ary Operations
- **`heal(input, options?)`**: Snap micro-gaps, split self-intersections, cancel zero-winding whiskers, decompose figure-8 pinch vertices, and extract clean manifold shells and holes.
- **`unionAll(shapes, options?)`**: Single-pass N-shape union in WASM.
- **`intersectAll(shapes, options?)`**: Single-pass N-shape intersection in WASM.
- **`booleanMulti(inputs, predicate, options?)`**: Evaluate an arbitrary N-body winding predicate `(windings: ReadonlyArray<number>) => boolean` over the consolidated planar arrangement in a single pass.

```ts
// Example: (A ∪ B) \ C in a single topological arrangement pass
const res = booleanMulti(
  [shapeA, shapeB, shapeC],
  (w) => ((w[0] ?? 0) > 0 || (w[1] ?? 0) > 0) && (w[2] ?? 0) <= 0,
);
```

### Output & Geometry Helpers
- **`signedLoopArea(loop)`**: Signed area via the Shoelace formula (`> 0` for CCW outer shells, `< 0` for CW holes). Accepts `{ x, y }[]`, `[x, y][]`, or `Float64Array | Float32Array`.
- **`toTupleMultiPolygon(result, closeRings = true)`**: Converts a `KernelResult` to `[number, number][][][]`.
- **`toGeoJSON(result)`**: Converts a `KernelResult` to `{ type: "MultiPolygon", coordinates: number[][][][] }`.
- **`prepareBooleanTask(subject, clip)`**: Pre-normalizes a `(subject, clip)` pair in WASM linear memory for repeated zero-copy Boolean queries (`task.run(0 | 1 | 2 | 3)`).

### Options (`KernelOptions`)
```ts
interface KernelOptions {
  /** Explicit snap tolerance r0 in world units (default: auto-scaled 1e-9 * bboxDiagonal). */
  snapTolerance?: number;
  /** Merge collinear degree-2 vertices on output boundary loops (default: true). */
  simplifyCollinear?: boolean;
  /** Winding rule: "positive" | "nonZero" | "evenOdd" (default: "positive" for booleans, "nonZero" for heal). */
  windingRule?: "positive" | "nonZero" | "evenOdd";
}
```

---

## Benchmarks vs. Other JavaScript/TypeScript Libraries

Measured with `npm run bench` on Node.js v24 across all 4 Boolean operations (`union`, `intersect`, `difference`, `xor`):

| Workload | Vertices | `polystrata` (Rust/WASM) | `clipper2-js` (v1.2.4) | `polygon-clipping` (v0.15.7) | `@velipso/polybool` (v2.0.11) | `martinez` (v0.9.0) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **CAD Gears + Bore Holes** | 192 | **29,573 op/s** (PASS) | 13,065 op/s (PASS) | 4,627 op/s (PASS) | 3,534 op/s (PASS) | 11,446 op/s (FAIL) |
| **Swiss-Cheese 25-Hole Plate** | 224 | **15,814 op/s** (PASS) | 16,765 op/s (PASS) | 3,368 op/s (PASS) | 2,615 op/s (PASS) | 8,257 op/s (FAIL) |
| **Comb Array x Diagonal Bars** | 72 | **19,526 op/s** (PASS) | 15,106 op/s (PASS) | 2,120 op/s (PASS) | 2,584 op/s (PASS) | 6,491 op/s (FAIL) |
| **Star Scaling (N = 64)** | 64 | **71,099 op/s** (PASS) | 36,618 op/s (PASS) | 11,597 op/s (PASS) | 11,513 op/s (PASS) | 30,544 op/s (FAIL) |
| **Star Scaling (N = 256)** | 256 | **9,978 op/s** (PASS) | 3,576 op/s (PASS) | 1,322 op/s (PASS) | 1,403 op/s (PASS) | 3,413 op/s (FAIL) |
| **Star Scaling (N = 1024)** | 1,024 | **641 op/s** (PASS) | 244 op/s (PASS) | 97 op/s (PASS) | 113 op/s (PASS) | 242 op/s (FAIL) |
| **Star Scaling (N = 2048)** | 2,048 | **169 op/s** (PASS) | 55 op/s (PASS) | 21 op/s (PASS) | 23 op/s (PASS) | 59 op/s (FAIL) |
| **Shared Collinear Walls** | 24 | **235,420 op/s** (PASS) | 134,436 op/s (PASS) | 24,264 op/s (PASS) | 39,638 op/s (FAIL) | 94,279 op/s (FAIL) |
| **Shallow-Angle (0.08°)** | 8 | **367,464 op/s** (PASS) | 247,824 op/s (PASS) | 30,623 op/s (PASS) | 73,993 op/s (PASS) | 160,707 op/s (PASS) |
| **Bowties & Pinch Corners** | 12 | **305,872 op/s** (PASS) | 275,198 op/s (PASS) | 26,166 op/s (FAIL) | 53,903 op/s (FAIL) | 129,016 op/s (FAIL) |
| **Large Offset (1.5 × 10⁶)** | 9 | **600,668 op/s** (PASS) | 401,598 op/s (PASS) | 74,535 op/s (PASS) | 126,446 op/s (PASS) | 329,175 op/s (PASS) |
| **120-Pair Fuzz Suite (480 ops)** | — | **234,380 op/s (120/120)** | 119,495 op/s (120/120) | 38,276 op/s (116/120) | 52,212 op/s (113/120) | 122,595 op/s (68/120) |

---

## Architecture: 4-Stage Stratified Tolerance Complex

1. **Stage 0 — Scale-Aware Coordinate Normalization**: Shifts the global bounding-box center to the origin to maximize IEEE-754 `f64` significand bits and derives a scale-aware tolerance `r₀ = 1e-9 × L` and cap `r_max = 4 × r₀`.
2. **Stages 1 & 2 — Fixed-Point Tolerance Complex Consolidation**: Iteratively applies Vertex Cluster Merging, Degenerate Edge Collapse, Two-Pointer 1D X-Sweep Vertex-On-Edge Splitting (T-junctions), and 1D Sort-and-Sweep Interior Segment Intersection with dirty-AABB pruning until a strict topological fixed point is reached.
3. **Stage 3 — Planar Half-Edge Arrangement**: Sorts half-edges counter-clockwise around each consolidated vertex in flat CSR buffers (`O(1)` twin/next lookup) and traces minimal cycles.
4. **Stage 4 — Dual-Graph BFS Winding Classification & Pinch Decomposition**: Evaluates exact integer winding numbers in `O(C + E)` via Dual-Graph BFS across cycle boundaries, extracts surviving boundary half-edges where the predicate flips, and decomposes higher-genus pinch vertices into simple CCW shells and CW holes.

---

## License

[MIT](./LICENSE)
