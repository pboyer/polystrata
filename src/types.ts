export interface Point2D {
  x: number;
  y: number;
}

export interface Segment2D {
  p0: Point2D;
  p1: Point2D;
}

export type Loop2D = Point2D[];

export interface PolygonWithHoles2D {
  outer: Loop2D;   // CCW outer boundary
  holes: Loop2D[]; // CW interior holes
}

export type ShapeInput2D =
  | Loop2D
  | Loop2D[]
  | PolygonWithHoles2D
  | PolygonWithHoles2D[]
  | Segment2D[];

export type BooleanOp = "union" | "intersect" | "difference" | "xor" | "heal";
export type WindingRule = "nonZero" | "positive" | "evenOdd";

export interface KernelOptions {
  snapTolerance?: number;      // Optional explicit snap tolerance (auto-computed if omitted)
  simplifyCollinear?: boolean; // Merge collinear degree-2 vertices on output (default: true)
  windingRule?: WindingRule;   // Default: "nonZero" for heal, "positive" / "nonZero" for booleans
}

export interface KernelResult {
  polygons: PolygonWithHoles2D[]; // Organized outer CCW shells + CW holes
  loops: Loop2D[];                // Flat list of oriented closed boundary loops
}
