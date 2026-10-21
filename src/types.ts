/**
 * A 2D point in Cartesian coordinates `{ x, y }`.
 */
export interface Point2D {
  x: number;
  y: number;
}

/**
 * A 2D coordinate tuple `[x, y]` (as used by GeoJSON, Turf.js, `polygon-clipping`, and `polybool`).
 */
export type TuplePoint2D = readonly [number, number] | [number, number];

/**
 * A directed 2D line segment from `p0` to `p1`.
 */
export interface Segment2D {
  p0: Point2D;
  p1: Point2D;
}

/**
 * A closed 2D polygonal ring of `{ x, y }` vertices.
 * Counter-clockwise (CCW, positive signed area) represents an outer boundary;
 * Clockwise (CW, negative signed area) represents an interior hole.
 */
export type Loop2D = Point2D[];

/**
 * A closed 2D polygonal ring of `[x, y]` coordinate tuples.
 * Duplicate closing vertices (where the last tuple equals the first, as in GeoJSON) are handled automatically.
 */
export type TupleLoop2D = TuplePoint2D[];

/**
 * A polygon with an outer ring and zero or more hole rings of `[x, y]` coordinate tuples
 * (matching GeoJSON `Polygon["coordinates"]`).
 */
export type TuplePolygon2D = TupleLoop2D[];

/**
 * A multi-polygon of `[x, y]` coordinate tuples (matching GeoJSON `MultiPolygon["coordinates"]`).
 */
export type TupleMultiPolygon2D = TuplePolygon2D[];

/**
 * A flat packed coordinate array `[x0, y0, x1, y1, ...]` representing a single closed loop.
 */
export type FlatLoop2D = Float64Array | Float32Array;

/**
 * A 2D polygon consisting of one counter-clockwise (`CCW`) outer shell and zero or more clockwise (`CW`) interior holes.
 */
export interface PolygonWithHoles2D {
  /** Counter-clockwise (CCW) outer boundary loop. */
  outer: Loop2D;
  /** Clockwise (CW) interior hole loops. */
  holes: Loop2D[];
}

/**
 * Minimal GeoJSON `Polygon` geometry interface.
 */
export interface GeoJSONPolygon {
  type: "Polygon";
  coordinates: ReadonlyArray<ReadonlyArray<TuplePoint2D>>;
}

/**
 * Minimal GeoJSON `MultiPolygon` geometry interface.
 */
export interface GeoJSONMultiPolygon {
  type: "MultiPolygon";
  coordinates: TupleMultiPolygon2D;
}

/**
 * Any supported 2D shape input accepted by `polystrata` operations:
 * - `Loop2D` (`{ x, y }[]`) or `Loop2D[]` (`{ x, y }[][]`)
 * - `TupleLoop2D` (`[x, y][]`), `TuplePolygon2D` (`[x, y][][]`), or `TupleMultiPolygon2D` (`[x, y][][][]`)
 * - `FlatLoop2D` (`Float64Array | Float32Array`) or `ReadonlyArray<FlatLoop2D>`
 * - `PolygonWithHoles2D` or `PolygonWithHoles2D[]`
 * - `Segment2D[]` (`{ p0, p1 }[]`)
 * - `GeoJSONPolygon` or `GeoJSONMultiPolygon`
 */
export type ShapeInput2D =
  | Loop2D
  | ReadonlyArray<Loop2D>
  | TupleLoop2D
  | ReadonlyArray<TupleLoop2D>
  | ReadonlyArray<ReadonlyArray<TupleLoop2D>>
  | FlatLoop2D
  | ReadonlyArray<FlatLoop2D>
  | PolygonWithHoles2D
  | ReadonlyArray<PolygonWithHoles2D>
  | ReadonlyArray<Segment2D>
  | GeoJSONPolygon
  | GeoJSONMultiPolygon;

/**
 * Supported 2D Boolean and topological healing operations.
 */
export type BooleanOp = "union" | "intersect" | "difference" | "xor" | "heal";

/**
 * Winding number fill rule used to classify interior vs. exterior planar regions:
 * - `"positive"`: interior where winding number `w > 0` (default for Boolean operations)
 * - `"nonZero"`: interior where winding number `w !== 0` (default for `heal`)
 * - `"evenOdd"`: interior where winding number `w % 2 !== 0`
 */
export type WindingRule = "nonZero" | "positive" | "evenOdd";

/**
 * Configuration options for `polystrata` Boolean and healing operations.
 */
export interface KernelOptions {
  /**
   * Optional explicit snap tolerance `r0` in world units.
   * When omitted, `polystrata` automatically computes a scale-aware tolerance `r0 = 1e-9 * L`
   * where `L` is the bounding-box diagonal of the input geometry.
   */
  snapTolerance?: number;
  /**
   * Merge collinear degree-2 vertices on output boundary loops (default: `true`).
   */
  simplifyCollinear?: boolean;
  /**
   * Winding fill rule for classifying interior regions.
   * Defaults to `"positive"` for Boolean operations (`union`, `intersect`, `difference`, `xor`)
   * and `"nonZero"` for `heal`.
   */
  windingRule?: WindingRule;
}

/**
 * Output of a `polystrata` 2D Boolean or healing operation.
 */
export interface KernelResult {
  /**
   * Hierarchy of outer counter-clockwise (`CCW`) boundary shells paired with their contained clockwise (`CW`) interior holes.
   */
  polygons: PolygonWithHoles2D[];
  /**
   * Flat list of all oriented closed boundary loops (CCW outer shells have positive signed area; CW holes have negative signed area).
   */
  loops: Loop2D[];
}
