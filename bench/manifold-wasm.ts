import Module, { type ManifoldToplevel } from "manifold-3d";

let manifoldInstance: ManifoldToplevel | null = null;
let manifoldPromise: Promise<ManifoldToplevel> | null = null;

/**
 * Initialize the `manifold-3d` WebAssembly module (idempotent singleton).
 */
export async function initManifoldWasm(): Promise<ManifoldToplevel> {
  if (manifoldInstance) return manifoldInstance;
  if (!manifoldPromise) {
    manifoldPromise = Module().then((wasm) => {
      wasm.setup();
      manifoldInstance = wasm;
      return wasm;
    });
  }
  return manifoldPromise;
}

/**
 * Return the synchronously accessible `ManifoldToplevel` after {@link initManifoldWasm} resolves.
 */
export function getManifoldWasm(): ManifoldToplevel {
  if (!manifoldInstance) {
    throw new Error(
      "manifold-3d WASM is not initialized yet. Call `await initManifoldWasm()` before running benchmarks.",
    );
  }
  return manifoldInstance;
}
