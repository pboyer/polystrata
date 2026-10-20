pub mod arena;
pub mod consolidate;
pub mod grid;
pub mod topology;

use arena::KernelArena;
use consolidate::{consolidate_prepared, prepare_normalized_segments};
use core::cell::UnsafeCell;
use topology::{build_planar_topology, classify_and_extract};

struct GlobalArena(UnsafeCell<Option<KernelArena>>);
unsafe impl Sync for GlobalArena {}

static ARENA: GlobalArena = GlobalArena(UnsafeCell::new(None));

#[inline]
fn with_arena<R>(f: impl FnOnce(&mut KernelArena) -> R) -> R {
    unsafe {
        let slot = &mut *ARENA.0.get();
        if slot.is_none() {
            *slot = Some(KernelArena::new());
        }
        f(slot.as_mut().unwrap_unchecked())
    }
}

/// Allocate space for `seg_count` raw segments (`seg_count * 5` f64s: `[x0, y0, x1, y1, body]`)
/// and return the linear memory pointer so JS can write directly into WASM memory.
#[no_mangle]
pub extern "C" fn wasm_alloc_raw_segments(seg_count: u32) -> *mut f64 {
    with_arena(|arena| {
        let len = (seg_count as usize) * 5;
        if arena.raw_segments.len() < len {
            arena.raw_segments.resize(len.max(1024), 0.0);
        }
        arena.raw_count = seg_count as usize;
        arena.raw_segments.as_mut_ptr()
    })
}

/// Normalize the `seg_count` segments currently in `raw_segments` and cache them in `prep_*`.
#[no_mangle]
pub extern "C" fn wasm_prepare_segments(seg_count: u32, snap_tol: f64) {
    with_arena(|arena| {
        prepare_normalized_segments(arena, seg_count as usize, snap_tol);
    })
}

/// Execute Stages 1, 2, 3, and 4 on the prepared normalized segments.
/// Returns the number of extracted output loops.
#[no_mangle]
pub extern "C" fn wasm_execute_prepared(
    op_code: u32,
    rule_code: u32,
    simplify_collinear: u32,
) -> u32 {
    with_arena(|arena| {
        if arena.prep_count == 0 {
            arena.out_coords.clear();
            arena.out_loop_meta.clear();
            arena.out_loop_count = 0;
            arena.out_total_area = 0.0;
            return 0;
        }
        consolidate_prepared(arena);
        build_planar_topology(arena);
        classify_and_extract(arena, op_code, rule_code, simplify_collinear != 0);
        arena.out_loop_count as u32
    })
}

/// Execute full pipeline (Stage 0 normalization + Stages 1–4) in a single call.
/// Returns the number of extracted output loops.
#[no_mangle]
pub extern "C" fn wasm_execute_raw(
    seg_count: u32,
    op_code: u32,
    rule_code: u32,
    snap_tol: f64,
    simplify_collinear: u32,
) -> u32 {
    with_arena(|arena| {
        prepare_normalized_segments(arena, seg_count as usize, snap_tol);
        if arena.prep_count == 0 {
            arena.out_coords.clear();
            arena.out_loop_meta.clear();
            arena.out_loop_count = 0;
            arena.out_total_area = 0.0;
            return 0;
        }
        consolidate_prepared(arena);
        build_planar_topology(arena);
        classify_and_extract(arena, op_code, rule_code, simplify_collinear != 0);
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
