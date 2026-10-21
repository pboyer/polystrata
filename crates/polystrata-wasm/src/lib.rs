pub mod arena;
pub mod consolidate;
pub mod grid;
pub mod topology;

use arena::KernelArena;
use consolidate::{consolidate_prepared, prepare_normalized_segments};
use core::cell::UnsafeCell;
use topology::{
    build_planar_topology, classify_and_extract, compute_cycles_and_windings,
    extract_from_cycle_keep,
};

struct GlobalArena(UnsafeCell<Option<KernelArena>>);
unsafe impl Sync for GlobalArena {}

static ARENA: GlobalArena = GlobalArena(UnsafeCell::new(None));

#[inline]
fn with_arena<F, R>(f: F) -> R
where
    F: FnOnce(&mut KernelArena) -> R,
{
    unsafe {
        let slot = &mut *ARENA.0.get();
        if slot.is_none() {
            *slot = Some(KernelArena::new());
        }
        f(slot.as_mut().unwrap_unchecked())
    }
}

/// Allocate / resize the raw input segment buffer (`seg_count * 5` f64s: `[x0, y0, x1, y1, bodyIndex]`)
/// and return a pointer in WASM linear memory where JS can write the segments directly.
#[no_mangle]
pub extern "C" fn wasm_alloc_raw_segments(seg_count: u32) -> *mut f64 {
    with_arena(|arena| {
        let len = (seg_count as usize) * 5;
        if arena.raw_segments.len() < len {
            arena.raw_segments.resize(len, 0.0);
        }
        arena.raw_count = seg_count as usize;
        arena.raw_segments.as_mut_ptr()
    })
}

/// Stage 0 preparation: normalize the `seg_count` segments already written into `raw_segments`.
/// Used by benchmark harnesses to pre-normalize segments before timed execution.
#[no_mangle]
pub extern "C" fn wasm_prepare_segments(seg_count: u32, user_snap_tol: f64) {
    with_arena(|arena| {
        prepare_normalized_segments(arena, seg_count as usize, user_snap_tol);
    });
}

/// Execute Stages 1–4 on the already-prepared normalized segments in `arena`.
/// Returns the number of output boundary loops written into `out_loop_meta` and `out_coords`.
#[no_mangle]
pub extern "C" fn wasm_execute_prepared(
    op_code: u32,
    rule_code: u32,
    simplify_collinear: u32,
) -> u32 {
    with_arena(|arena| {
        consolidate_prepared(arena);
        build_planar_topology(arena);
        classify_and_extract(arena, op_code, rule_code, simplify_collinear != 0);
        arena.out_loop_count as u32
    })
}

/// Full end-to-end execution (Stages 0–4) from `raw_segments`.
/// Returns the number of output boundary loops.
#[no_mangle]
pub extern "C" fn wasm_execute_raw(
    seg_count: u32,
    op_code: u32,
    rule_code: u32,
    user_snap_tol: f64,
    simplify_collinear: u32,
) -> u32 {
    with_arena(|arena| {
        prepare_normalized_segments(arena, seg_count as usize, user_snap_tol);
        consolidate_prepared(arena);
        build_planar_topology(arena);
        classify_and_extract(arena, op_code, rule_code, simplify_collinear != 0);
        arena.out_loop_count as u32
    })
}

/// Run Stages 0–3 plus Stage 4a winding evaluation for custom N-body predicates (`booleanMulti`)
/// and interactive pipeline inspection (`inspectPipeline`).
/// Returns `cycle_count`.
#[no_mangle]
pub extern "C" fn wasm_compute_cycles_and_windings(
    seg_count: u32,
    user_snap_tol: f64,
    capture_samples: u32,
) -> u32 {
    with_arena(|arena| {
        prepare_normalized_segments(arena, seg_count as usize, user_snap_tol);
        consolidate_prepared(arena);
        build_planar_topology(arena);
        compute_cycles_and_windings(arena, capture_samples != 0);
        arena.cycle_count as u32
    })
}

/// Run Stage 4b loop extraction from `arena.cycle_keep[0..cycle_count]` (populated by JS).
/// Returns the number of output boundary loops.
#[no_mangle]
pub extern "C" fn wasm_extract_from_cycle_keep(simplify_collinear: u32) -> u32 {
    with_arena(|arena| {
        extract_from_cycle_keep(arena, simplify_collinear != 0);
        arena.out_loop_count as u32
    })
}

#[no_mangle]
pub extern "C" fn wasm_get_out_coords_ptr() -> *const f64 {
    with_arena(|arena| arena.out_coords.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_out_coords_len() -> u32 {
    with_arena(|arena| arena.out_coords.len() as u32)
}

#[no_mangle]
pub extern "C" fn wasm_get_out_loop_meta_ptr() -> *const u32 {
    with_arena(|arena| arena.out_loop_meta.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_out_total_area() -> f64 {
    with_arena(|arena| arena.out_total_area)
}

// --- Diagnostic & Custom-Predicate Getters ---

#[no_mangle]
pub extern "C" fn wasm_get_prep_cx() -> f64 {
    with_arena(|arena| arena.prep_cx)
}

#[no_mangle]
pub extern "C" fn wasm_get_prep_cy() -> f64 {
    with_arena(|arena| arena.prep_cy)
}

#[no_mangle]
pub extern "C" fn wasm_get_prep_diagonal() -> f64 {
    with_arena(|arena| arena.prep_diagonal)
}

#[no_mangle]
pub extern "C" fn wasm_get_prep_r0() -> f64 {
    with_arena(|arena| arena.prep_r0)
}

#[no_mangle]
pub extern "C" fn wasm_get_prep_rmax() -> f64 {
    with_arena(|arena| arena.prep_rmax)
}

#[no_mangle]
pub extern "C" fn wasm_get_prep_body_count() -> u32 {
    with_arena(|arena| arena.prep_body_count as u32)
}

#[no_mangle]
pub extern "C" fn wasm_get_vertex_count() -> u32 {
    with_arena(|arena| arena.vertex_count as u32)
}

#[no_mangle]
pub extern "C" fn wasm_get_vx_ptr() -> *const f64 {
    with_arena(|arena| arena.vx.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_vy_ptr() -> *const f64 {
    with_arena(|arena| arena.vy.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_vr_ptr() -> *const f64 {
    with_arena(|arena| arena.vr.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_v_alive_ptr() -> *const u8 {
    with_arena(|arena| arena.v_alive.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_edge_count() -> u32 {
    with_arena(|arena| arena.edge_count as u32)
}

#[no_mangle]
pub extern "C" fn wasm_get_ev0_ptr() -> *const u32 {
    with_arena(|arena| arena.ev0.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_ev1_ptr() -> *const u32 {
    with_arena(|arena| arena.ev1.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_e_alive_ptr() -> *const u8 {
    with_arena(|arena| arena.e_alive.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_e_delta_w_ptr() -> *const i32 {
    with_arena(|arena| arena.e_delta_w.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_cycle_count() -> u32 {
    with_arena(|arena| arena.cycle_count as u32)
}

#[no_mangle]
pub extern "C" fn wasm_get_cycle_windings_f64_ptr() -> *const f64 {
    with_arena(|arena| arena.cycle_windings_f64.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_cycle_sample_x_ptr() -> *const f64 {
    with_arena(|arena| arena.cycle_sample_x.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_cycle_sample_y_ptr() -> *const f64 {
    with_arena(|arena| arena.cycle_sample_y.as_ptr())
}

#[no_mangle]
pub extern "C" fn wasm_get_cycle_keep_ptr() -> *mut u8 {
    with_arena(|arena| arena.cycle_keep.as_mut_ptr())
}
