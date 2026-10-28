declare module "robust-predicates" {
  /** Exact orientation determinant; positive when a, b, c are in clockwise order. */
  export function orient2d(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number;
}
