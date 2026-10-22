import polybool, { type Polygon as PolyBoolPolygon } from "@velipso/polybool";
import { Clipper, FillRule, Path64, Paths64, Point64 } from "clipper2-js";
import * as martinez from "martinez-polygon-clipping";
import polygonClipping from "polygon-clipping";
import {
  type Loop2D,
  type Point2D,
  prepareBooleanTask,
  signedLoopArea,
  type WasmPathsResult,
} from "../src/index.js";
import { getManifoldWasm } from "./manifold-wasm.js";
import type { BenchOp } from "./workloads.js";

export interface PreparedTask {
  run: (op: BenchOp) => unknown;
  computeArea: (result: unknown) => number;
  dispose?: () => void;
}

export interface LibraryAdapter {
  id: string;
  name: string;
  version: string;
  algorithm: string;
  prepare: (subject: Loop2D[], clip: Loop2D[]) => PreparedTask;
}

function toGeoJSONMultiPolygon(loops: Loop2D[]): polygonClipping.MultiPolygon {
  const shells: [number, number][][][] = [];
  const holes: { ring: [number, number][]; pt: Point2D }[] = [];

  for (const loop of loops) {
    if (loop.length < 3) continue;
    const ring: [number, number][] = new Array(loop.length + 1);
    for (let i = 0; i < loop.length; i++) {
      ring[i] = [loop[i]!.x, loop[i]!.y];
    }
    ring[loop.length] = [loop[0]!.x, loop[0]!.y];

    const area = signedLoopArea(loop);
    if (area < 0) {
      holes.push({ ring, pt: loop[0]! });
    } else {
      shells.push([ring]);
    }
  }

  for (const h of holes) {
    if (shells.length > 0) {
      shells[0]!.push(h.ring);
    } else {
      shells.push([h.ring]);
    }
  }

  return shells;
}

function geoJSONMultiPolygonArea(mp: unknown): number {
  if (!Array.isArray(mp)) return 0;
  let total = 0;
  for (const poly of mp) {
    if (!Array.isArray(poly)) continue;
    for (let r = 0; r < poly.length; r++) {
      const ring = poly[r] as [number, number][] | undefined;
      if (!Array.isArray(ring) || ring.length < 4) continue;
      let area2 = 0;
      const n = ring.length - 1;
      for (let i = 0; i < n; i++) {
        const p = ring[i]!;
        const q = ring[(i + 1) % n]!;
        area2 += p[0]! * q[1]! - q[0]! * p[1]!;
      }
      const ringArea = 0.5 * Math.abs(area2);
      total += r === 0 ? ringArea : -ringArea;
    }
  }
  return total;
}

const CLIPPER_SCALE = 1e5;

function toClipperPaths64(loops: Loop2D[]): Paths64 {
  const paths = new Paths64();
  for (const loop of loops) {
    const path = new Path64();
    for (const p of loop) {
      path.push(new Point64(Math.round(p.x * CLIPPER_SCALE), Math.round(p.y * CLIPPER_SCALE)));
    }
    paths.push(path);
  }
  return paths;
}

function toPolyBoolPolygon(loops: Loop2D[]): PolyBoolPolygon {
  return {
    regions: loops.map((l) => l.map((p) => [p.x, p.y] as [number, number])),
    inverted: false,
  };
}

function pointInRingXY(px: number, py: number, ring: ReadonlyArray<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const pi = ring[i]!;
    const pj = ring[j]!;
    const intersect =
      pi[1] > py !== pj[1] > py &&
      px < ((pj[0] - pi[0]) * (py - pi[1])) / (pj[1] - pi[1]) + pi[0];
    if (intersect) inside = !inside;
  }
  return inside;
}

function polyBoolPolygonArea(poly: PolyBoolPolygon): number {
  const regData: { pts: [number, number][]; absArea: number }[] = [];
  for (const reg of poly.regions) {
    if (reg.length < 3) continue;
    let area2 = 0;
    const n = reg.length;
    for (let i = 0; i < n; i++) {
      const p = reg[i]! as [number, number];
      const q = reg[(i + 1) % n]! as [number, number];
      area2 += p[0] * q[1] - q[0] * p[1];
    }
    regData.push({ pts: reg as [number, number][], absArea: 0.5 * Math.abs(area2) });
  }

  let total = 0;
  for (let i = 0; i < regData.length; i++) {
    const ri = regData[i]!;
    const p0 = ri.pts[0]!;
    const p1 = ri.pts[1]!;
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    const tx = 0.5 * (p0[0] + p1[0]);
    const ty = 0.5 * (p0[1] + p1[1]);
    let depth = 0;
    for (let j = 0; j < regData.length; j++) {
      if (i === j) continue;
      const rj = regData[j]!;
      if (rj.absArea <= ri.absArea) continue;
      if (len > 0 && pointInRingXY(tx, ty, rj.pts)) {
        depth++;
      }
    }
    total += depth % 2 === 0 ? ri.absArea : -ri.absArea;
  }
  return total;
}

export const LIBRARY_ADAPTERS: LibraryAdapter[] = [
  {
    id: "polystrata",
    name: "polystrata",
    version: "0.1.0",
    algorithm: "4-Stage Snapped B-Rep + 1D Sweep + Rust/WASM SIMD",
    prepare: (subject, clip) => {
      const wasmTask = prepareBooleanTask(subject, clip);
      return {
        run: (op) => {
          switch (op) {
            case "union":
              return wasmTask.run(0);
            case "intersect":
              return wasmTask.run(1);
            case "difference":
              return wasmTask.run(2);
            case "xor":
              return wasmTask.run(3);
          }
        },
        computeArea: (res) => (res as WasmPathsResult).totalArea,
      };
    },
  },

  {
    id: "manifold-2d",
    name: "manifold-3d (CrossSection)",
    version: "3.5.4",
    algorithm: "C++/WASM Clipper2 Vatti Scanbeam (Manifold CrossSection)",
    prepare: (subject, clip) => {
      const wasm = getManifoldWasm();
      const subPolys = subject.map((l) => l.map((p) => [p.x, p.y] as [number, number]));
      const clipPolys = clip.map((l) => l.map((p) => [p.x, p.y] as [number, number]));
      const csA = new wasm.CrossSection(subPolys, "Positive");
      const csB = new wasm.CrossSection(clipPolys, "Positive");

      return {
        run: (op) => {
          let out;
          switch (op) {
            case "union":
              out = wasm.CrossSection.union(csA, csB);
              break;
            case "intersect":
              out = wasm.CrossSection.intersection(csA, csB);
              break;
            case "difference":
              out = wasm.CrossSection.difference(csA, csB);
              break;
            case "xor": {
              const d1 = csA.subtract(csB);
              const d2 = csB.subtract(csA);
              out = d1.add(d2);
              d1.delete();
              d2.delete();
              break;
            }
          }
          const area = out.area();
          const polys = out.toPolygons();
          out.delete();
          return { area, polys };
        },
        computeArea: (res) => (res as { area: number }).area,
        dispose: () => {
          csA.delete();
          csB.delete();
        },
      };
    },
  },

  {
    id: "clipper2-js",
    name: "clipper2-js",
    version: "1.2.4",
    algorithm: "Vatti Scanbeam (64-bit Integer Coordinates)",
    prepare: (subject, clip) => {
      const subPaths = toClipperPaths64(subject);
      const clipPaths = toClipperPaths64(clip);
      const invScaleSq = 1 / (CLIPPER_SCALE * CLIPPER_SCALE);
      return {
        run: (op) => {
          switch (op) {
            case "union":
              return Clipper.Union(subPaths, clipPaths, FillRule.Positive);
            case "intersect":
              return Clipper.Intersect(subPaths, clipPaths, FillRule.Positive);
            case "difference":
              return Clipper.Difference(subPaths, clipPaths, FillRule.Positive);
            case "xor":
              return Clipper.Xor(subPaths, clipPaths, FillRule.Positive);
          }
        },
        computeArea: (res) => {
          const paths = res as Paths64;
          return Math.abs(Clipper.areaPaths(paths)) * invScaleSq;
        },
      };
    },
  },

  {
    id: "polygon-clipping",
    name: "polygon-clipping",
    version: "0.15.7",
    algorithm: "Martínez-Rueda-Feito Sweep-Line + SplayTree + Robust Predicates",
    prepare: (subject, clip) => {
      const subGeo = toGeoJSONMultiPolygon(subject);
      const clipGeo = toGeoJSONMultiPolygon(clip);
      return {
        run: (op) => {
          switch (op) {
            case "union":
              return polygonClipping.union(subGeo, clipGeo);
            case "intersect":
              return polygonClipping.intersection(subGeo, clipGeo);
            case "difference":
              return polygonClipping.difference(subGeo, clipGeo);
            case "xor":
              return polygonClipping.xor(subGeo, clipGeo);
          }
        },
        computeArea: (res) => geoJSONMultiPolygonArea(res as polygonClipping.MultiPolygon),
      };
    },
  },

  {
    id: "martinez",
    name: "martinez-polygon-clipping",
    version: "0.9.0",
    algorithm: "Martínez-Rueda Sweep-Line + TinyQueue + SplayTree",
    prepare: (subject, clip) => {
      const subGeo = toGeoJSONMultiPolygon(subject);
      const clipGeo = toGeoJSONMultiPolygon(clip);
      return {
        run: (op) => {
          switch (op) {
            case "union":
              return martinez.union(subGeo, clipGeo);
            case "intersect":
              return martinez.intersection(subGeo, clipGeo);
            case "difference":
              return martinez.diff(subGeo, clipGeo);
            case "xor":
              return martinez.xor(subGeo, clipGeo);
          }
        },
        computeArea: (res) => geoJSONMultiPolygonArea(res),
      };
    },
  },

  {
    id: "polybool",
    name: "@velipso/polybool",
    version: "2.0.11",
    algorithm: "Epsilon Sweep-Line Segment Chainer (PolyBool)",
    prepare: (subject, clip) => {
      const subPb = toPolyBoolPolygon(subject);
      const clipPb = toPolyBoolPolygon(clip);
      return {
        run: (op) => {
          switch (op) {
            case "union":
              return polybool.union(subPb, clipPb);
            case "intersect":
              return polybool.intersect(subPb, clipPb);
            case "difference":
              return polybool.difference(subPb, clipPb);
            case "xor":
              return polybool.xor(subPb, clipPb);
          }
        },
        computeArea: (res) => polyBoolPolygonArea(res as PolyBoolPolygon),
      };
    },
  },
];
