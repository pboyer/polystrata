# AGENTS.md

Guidance for agents (and humans) changing polystrata.

## Design principle: simplicity, robustness at the source

polystrata should stay as simple as possible. Robustness comes from one place: the Stage 1–2
fixed-point consolidation loop in `crates/polystrata-wasm/src/consolidate.rs` (vertex merging,
degenerate-edge collapse, vertex-on-edge splitting, segment intersection), iterated until the
tolerance complex reaches a fixed point. Every later stage relies on what that fixed point
guarantees and should not need to defend against it.

- **Fix robustness bugs where the invariant is established, not where the symptom shows up.**
  When an output is wrong (a crossing, an overlap, a misclassified region), first find which
  property the consolidated complex failed to guarantee (e.g. a surviving crossing, or a vertex
  within tolerance of a non-incident edge that was never split), then fix the fixed-point loop
  so the property holds.
- **No repair passes downstream.** Topology (Stage 3) and classification/extraction (Stage 4)
  should be combinatorial. Do not add post-hoc crossing checks, "undo" or restore passes,
  retry loops, or validation-and-patch steps after consolidation.
- **No special cases.** Avoid fast paths or branches for particular geometry (axis-aligned
  edges, specific workloads, magic thresholds) unless they are needed for correctness of the
  general algorithm and are explained. If a fix needs a special case, treat that as a sign the
  fix is in the wrong place.
- **Prefer removing code to adding it.** A change that makes the general mechanism correct and
  deletes a workaround is better than one that adds a guard.

## Verifying changes

- `npm run build:wasm` rebuilds the Rust kernel into `src/wasm-bytes.ts`; commit the rebuilt
  bytes with any kernel change.
- `npm test` runs the vitest suites. `test/adversarial.test.ts` judges outputs with an
  independent exact-predicate oracle (`test/oracle.ts`); never weaken its checks or tolerances
  to make a change pass. Known open issues are tracked with `it.fails`; flip them to `it` only
  when the root cause is fixed.
- `cargo test --release` runs the Rust unit tests.
- `npm run bench` for performance; report regressions rather than hiding them.
