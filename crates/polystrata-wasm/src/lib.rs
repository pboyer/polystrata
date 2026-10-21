//! # polystrata
//!
//! High-performance, topologically robust 2D polygon clipping, Boolean operations,
//! and self-intersection healing kernel based on a **2D Stratified Tolerance Complex**.
//!
//! - **Zero dependencies**, native `f64` coordinates (no integer grid quantization).
//! - **4-Stage Snapped Consolidation Pipeline**:
//!   1. Scale-aware vertex tolerance disks (`r₀ = 1e-9 × L`) & union-find merging.
//!   2. Iterative vertex-on-edge T-junction splitting, interior crossing splits, and coincident edge consolidation.
//!   3. Planar half-edge spoke sorting (`CCW`) and closed face-cycle extraction.
//!   4. Left-normal winding evaluation + `O(C + E)` dual-graph BFS classification and pinch-vertex decomposition.
//!
//! ## Quick Start
//!
//! ```rust
//! use polystrata::{union, intersect, difference, xor, heal, KernelOptions};
//!
//! let square_a = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
//! let square_b = [[5.0, 5.0], [15.0, 5.0], [15.0, 15.0], [5.0, 15.0]];
//!
//! let opts = KernelOptions::default();
//!
//! let u = union(&square_a, &square_b, opts);
//! assert!((u.total_area - 175.0).abs() < 1e-6);
//!
//! let i = intersect(&square_a, &square_b, opts);
//! assert!((i.total_area - 25.0).abs() < 1e-6);
//!
//! let d = difference(&square_a, &square_b, opts);
//! assert!((d.total_area - 75.0).abs() < 1e-6);
//!
//! let x = xor(&square_a, &square_b, opts);
//! assert!((x.total_area - 150.0).abs() < 1e-6);
//! ```

pub mod arena;
pub mod consolidate;
pub mod grid;
pub mod topology;

use arena::KernelArena;
use consolidate::{consolidate_prepared, prepare_normalized_segments};
use std::cell::RefCell;
use topology::{
    build_planar_topology, classify_and_extract, compute_cycles_and_windings,
    extract_from_cycle_keep,
};

// ============================================================================
// High-Level Idiomatic Rust Types & API
// ============================================================================

/// A 2D point in double-precision (`f64`) world coordinates.
#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct Point2D {
    pub x: f64,
    pub y: f64,
}

impl Point2D {
    #[inline]
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

impl From<[f64; 2]> for Point2D {
    #[inline]
    fn from(arr: [f64; 2]) -> Self {
        Self {
            x: arr[0],
            y: arr[1],
        }
    }
}

impl From<(f64, f64)> for Point2D {
    #[inline]
    fn from(tup: (f64, f64)) -> Self {
        Self { x: tup.0, y: tup.1 }
    }
}

impl From<Point2D> for [f64; 2] {
    #[inline]
    fn from(pt: Point2D) -> Self {
        [pt.x, pt.y]
    }
}

impl From<Point2D> for (f64, f64) {
    #[inline]
    fn from(pt: Point2D) -> Self {
        (pt.x, pt.y)
    }
}

/// A closed 2D polygonal ring represented as an ordered list of vertices
/// (the closing edge from `last` to `first` is implicit).
///
/// - **Outer boundaries (shells)** are oriented counter-clockwise (`CCW`, positive signed area).
/// - **Interior holes** are oriented clockwise (`CW`, negative signed area).
pub type Loop2D = Vec<Point2D>;

/// A 2D polygon consisting of one counter-clockwise (`CCW`) outer shell and zero or more
/// clockwise (`CW`) interior holes.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PolygonWithHoles2D {
    pub outer: Loop2D,
    pub holes: Vec<Loop2D>,
}

impl PolygonWithHoles2D {
    #[inline]
    pub fn new(outer: Loop2D, holes: Vec<Loop2D>) -> Self {
        Self { outer, holes }
    }

    /// Convert this polygon into GeoJSON-style `[x, y]` coordinate rings (`[outer, ...holes]`),
    /// explicitly closing each ring by repeating its first vertex at the end.
    pub fn to_closed_rings(&self) -> Vec<Vec<[f64; 2]>> {
        let mut rings = Vec::with_capacity(1 + self.holes.len());
        rings.push(close_ring(&self.outer));
        for hole in &self.holes {
            rings.push(close_ring(hole));
        }
        rings
    }
}

#[inline]
fn close_ring(loop_pts: &[Point2D]) -> Vec<[f64; 2]> {
    if loop_pts.is_empty() {
        return Vec::new();
    }
    let mut ring = Vec::with_capacity(loop_pts.len() + 1);
    for pt in loop_pts {
        ring.push([pt.x, pt.y]);
    }
    let first = loop_pts[0];
    let last = loop_pts[loop_pts.len() - 1];
    if first.x != last.x || first.y != last.y {
        ring.push([first.x, first.y]);
    }
    ring
}

/// A directed 2D line segment tagged with an optional `body_index`.
#[derive(Copy, Clone, Debug, Default, PartialEq)]
pub struct Segment2D {
    pub p0: Point2D,
    pub p1: Point2D,
    pub body_index: u32,
}

impl Segment2D {
    #[inline]
    pub const fn new(p0: Point2D, p1: Point2D, body_index: u32) -> Self {
        Self { p0, p1, body_index }
    }
}

/// Winding rule used to classify the interior of each input body from its signed winding number `w`:
/// - [`WindingRule::Positive`]: `w >= 1` (standard CAD/B-Rep convention where CCW = +1, CW hole = -1)
/// - [`WindingRule::NonZero`]: `w != 0`
/// - [`WindingRule::EvenOdd`]: `|w| % 2 == 1`
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash)]
pub enum WindingRule {
    #[default]
    Positive = 0,
    NonZero = 1,
    EvenOdd = 2,
}

impl WindingRule {
    #[inline]
    pub const fn code(self) -> u32 {
        self as u32
    }

    #[inline]
    pub fn apply(self, w: f64) -> bool {
        match self {
            WindingRule::Positive => w >= 0.5,
            WindingRule::NonZero => w.abs() >= 0.5,
            WindingRule::EvenOdd => (w.round() as i64).abs() % 2 == 1,
        }
    }
}

/// Standard 2-body Boolean operation selector.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum BooleanOp {
    /// Set union `A ∪ B`.
    Union = 0,
    /// Set intersection `A ∩ B`.
    Intersect = 1,
    /// Set difference `A \ B`.
    Difference = 2,
    /// Symmetric difference `A ⊕ B`.
    Xor = 3,
}

impl BooleanOp {
    #[inline]
    pub const fn code(self) -> u32 {
        self as u32
    }
}

/// Configuration options for the 2D Stratified Tolerance Complex kernel.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct KernelOptions {
    /// Base snap tolerance `r₀`.
    /// When `None`, the kernel automatically selects a scale-aware tolerance
    /// (`1e-9 × bounding_box_diagonal`) and caps vertex tolerance disk growth at `r_max = 4 × r₀`.
    pub snap_tolerance: Option<f64>,
    /// Winding rule used to determine inside/outside for each input body.
    /// Defaults to [`WindingRule::Positive`].
    pub winding_rule: WindingRule,
    /// Whether to collapse collinear degree-2 vertices along output boundary loops.
    /// Defaults to `true`.
    pub simplify_collinear: bool,
}

impl Default for KernelOptions {
    #[inline]
    fn default() -> Self {
        Self {
            snap_tolerance: None,
            winding_rule: WindingRule::Positive,
            simplify_collinear: true,
        }
    }
}

/// Output produced by a 2D Boolean or healing operation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct KernelResult {
    /// Hierarchically nested polygons, each with one `CCW` outer shell and zero or more `CW` interior holes.
    pub polygons: Vec<PolygonWithHoles2D>,
    /// Flat list of all oriented boundary loops (`CCW` outer shells and `CW` holes).
    pub loops: Vec<Loop2D>,
    /// Total net signed area of the result (`sum(shell areas) - sum(hole areas)`).
    pub total_area: f64,
}

impl KernelResult {
    /// Convert the result into GeoJSON `MultiPolygon` coordinate rings (`Vec<Vec<Vec<[f64; 2]>>>`),
    /// where each ring is explicitly closed (`first == last`).
    pub fn to_multipolygon_coords(&self) -> Vec<Vec<Vec<[f64; 2]>>> {
        self.polygons
            .iter()
            .map(PolygonWithHoles2D::to_closed_rings)
            .collect()
    }
}

/// Compute the signed area of a closed 2D loop via the Shoelace formula.
///
/// - Positive area (`> 0.0`) indicates a counter-clockwise (`CCW`) outer shell.
/// - Negative area (`< 0.0`) indicates a clockwise (`CW`) interior hole.
pub fn signed_loop_area(loop_pts: &[Point2D]) -> f64 {
    let n = loop_pts.len();
    if n < 3 {
        return 0.0;
    }
    let mut sum = 0.0;
    for i in 0..n {
        let a = loop_pts[i];
        let b = loop_pts[if i + 1 == n { 0 } else { i + 1 }];
        sum += a.x * b.y - b.x * a.y;
    }
    0.5 * sum
}

/// Trait implemented by all supported 2D shape inputs (`[Point2D]`, `[[f64; 2]]`, `[(f64, f64)]`,
/// `PolygonWithHoles2D`, slices/vectors of loops or polygons, and `[Segment2D]`).
pub trait ShapeInput {
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>);
}

#[inline]
fn push_raw_segment(raw_segments: &mut Vec<f64>, x0: f64, y0: f64, x1: f64, y1: f64, body_index: u32) {
    raw_segments.push(x0);
    raw_segments.push(y0);
    raw_segments.push(x1);
    raw_segments.push(y1);
    raw_segments.push(body_index as f64);
}

fn push_point_loop(pts: &[Point2D], body_index: u32, raw_segments: &mut Vec<f64>) {
    let mut n = pts.len();
    if n < 3 {
        return;
    }
    if pts[0].x == pts[n - 1].x && pts[0].y == pts[n - 1].y {
        n -= 1;
        if n < 3 {
            return;
        }
    }
    raw_segments.reserve(n * 5);
    for i in 0..n {
        let a = pts[i];
        let b = pts[if i + 1 == n { 0 } else { i + 1 }];
        push_raw_segment(raw_segments, a.x, a.y, b.x, b.y, body_index);
    }
}

fn push_arr_loop(pts: &[[f64; 2]], body_index: u32, raw_segments: &mut Vec<f64>) {
    let mut n = pts.len();
    if n < 3 {
        return;
    }
    if pts[0][0] == pts[n - 1][0] && pts[0][1] == pts[n - 1][1] {
        n -= 1;
        if n < 3 {
            return;
        }
    }
    raw_segments.reserve(n * 5);
    for i in 0..n {
        let a = pts[i];
        let b = pts[if i + 1 == n { 0 } else { i + 1 }];
        push_raw_segment(raw_segments, a[0], a[1], b[0], b[1], body_index);
    }
}

fn push_tuple_loop(pts: &[(f64, f64)], body_index: u32, raw_segments: &mut Vec<f64>) {
    let mut n = pts.len();
    if n < 3 {
        return;
    }
    if pts[0].0 == pts[n - 1].0 && pts[0].1 == pts[n - 1].1 {
        n -= 1;
        if n < 3 {
            return;
        }
    }
    raw_segments.reserve(n * 5);
    for i in 0..n {
        let a = pts[i];
        let b = pts[if i + 1 == n { 0 } else { i + 1 }];
        push_raw_segment(raw_segments, a.0, a.1, b.0, b.1, body_index);
    }
}

impl<T: ShapeInput + ?Sized> ShapeInput for &T {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        (**self).write_segments(body_index, raw_segments);
    }
}

impl ShapeInput for [Point2D] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_point_loop(self, body_index, raw_segments);
    }
}

impl ShapeInput for Vec<Point2D> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_point_loop(self, body_index, raw_segments);
    }
}

impl<const N: usize> ShapeInput for [Point2D; N] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_point_loop(self.as_slice(), body_index, raw_segments);
    }
}

impl ShapeInput for [[f64; 2]] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_arr_loop(self, body_index, raw_segments);
    }
}

impl ShapeInput for Vec<[f64; 2]> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_arr_loop(self, body_index, raw_segments);
    }
}

impl<const N: usize> ShapeInput for [[f64; 2]; N] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_arr_loop(self.as_slice(), body_index, raw_segments);
    }
}

impl ShapeInput for [(f64, f64)] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_tuple_loop(self, body_index, raw_segments);
    }
}

impl ShapeInput for Vec<(f64, f64)> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_tuple_loop(self, body_index, raw_segments);
    }
}

impl<const N: usize> ShapeInput for [(f64, f64); N] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_tuple_loop(self.as_slice(), body_index, raw_segments);
    }
}

impl ShapeInput for PolygonWithHoles2D {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        push_point_loop(&self.outer, body_index, raw_segments);
        for hole in &self.holes {
            push_point_loop(hole, body_index, raw_segments);
        }
    }
}

impl ShapeInput for [PolygonWithHoles2D] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for poly in self {
            poly.write_segments(body_index, raw_segments);
        }
    }
}

impl ShapeInput for Vec<PolygonWithHoles2D> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for poly in self {
            poly.write_segments(body_index, raw_segments);
        }
    }
}

impl ShapeInput for [Vec<Point2D>] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for loop_pts in self {
            push_point_loop(loop_pts, body_index, raw_segments);
        }
    }
}

impl ShapeInput for Vec<Vec<Point2D>> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for loop_pts in self {
            push_point_loop(loop_pts, body_index, raw_segments);
        }
    }
}

impl ShapeInput for [Vec<[f64; 2]>] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for loop_pts in self {
            push_arr_loop(loop_pts, body_index, raw_segments);
        }
    }
}

impl ShapeInput for Vec<Vec<[f64; 2]>> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for loop_pts in self {
            push_arr_loop(loop_pts, body_index, raw_segments);
        }
    }
}

impl ShapeInput for [Vec<(f64, f64)>] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for loop_pts in self {
            push_tuple_loop(loop_pts, body_index, raw_segments);
        }
    }
}

impl ShapeInput for Vec<Vec<(f64, f64)>> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        for loop_pts in self {
            push_tuple_loop(loop_pts, body_index, raw_segments);
        }
    }
}

impl ShapeInput for [Segment2D] {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        raw_segments.reserve(self.len() * 5);
        for seg in self {
            push_raw_segment(
                raw_segments,
                seg.p0.x,
                seg.p0.y,
                seg.p1.x,
                seg.p1.y,
                body_index,
            );
        }
    }
}

impl ShapeInput for Vec<Segment2D> {
    #[inline]
    fn write_segments(&self, body_index: u32, raw_segments: &mut Vec<f64>) {
        self.as_slice().write_segments(body_index, raw_segments);
    }
}

#[inline]
fn point_in_loop(pt: Point2D, loop_pts: &[Point2D]) -> bool {
    let mut inside = false;
    let px = pt.x;
    let py = pt.y;
    let n = loop_pts.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let xi = loop_pts[i].x;
        let yi = loop_pts[i].y;
        let xj = loop_pts[j].x;
        let yj = loop_pts[j].y;
        if (yi > py) != (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn read_kernel_result_from_arena(arena: &KernelArena) -> KernelResult {
    let loop_count = arena.out_loop_count;
    if loop_count == 0 {
        return KernelResult::default();
    }

    let mut loops = Vec::with_capacity(loop_count);
    let mut polygons = Vec::new();
    let mut shell_areas = Vec::new();
    let mut hole_loops = Vec::new();
    let mut hole_areas = Vec::new();

    for i in 0..loop_count {
        let m_base = i * 3;
        let pt_start = arena.out_loop_meta[m_base] as usize;
        let pt_count = arena.out_loop_meta[m_base + 1] as usize;
        let is_outer = arena.out_loop_meta[m_base + 2];

        let mut loop_pts = Vec::with_capacity(pt_count);
        let mut c_idx = pt_start * 2;
        for _ in 0..pt_count {
            loop_pts.push(Point2D {
                x: arena.out_coords[c_idx],
                y: arena.out_coords[c_idx + 1],
            });
            c_idx += 2;
        }

        loops.push(loop_pts.clone());

        let abs_area = signed_loop_area(&loop_pts).abs();
        if is_outer == 1 {
            polygons.push(PolygonWithHoles2D {
                outer: loop_pts,
                holes: Vec::new(),
            });
            shell_areas.push(abs_area);
        } else {
            hole_loops.push(loop_pts);
            hole_areas.push(abs_area);
        }
    }

    if !polygons.is_empty() && !hole_loops.is_empty() {
        if polygons.len() == 1 {
            polygons[0].holes.extend(hole_loops);
        } else {
            for (hole, h_area) in hole_loops.into_iter().zip(hole_areas.into_iter()) {
                let test_pt = hole[0];
                let mut best_idx: Option<usize> = None;
                let mut best_area = f64::INFINITY;

                for (s, poly) in polygons.iter().enumerate() {
                    let s_area = shell_areas[s];
                    if s_area <= h_area {
                        continue;
                    }
                    if point_in_loop(test_pt, &poly.outer) && s_area < best_area {
                        best_area = s_area;
                        best_idx = Some(s);
                    }
                }

                if let Some(idx) = best_idx {
                    polygons[idx].holes.push(hole);
                } else {
                    polygons[0].holes.push(hole);
                }
            }
        }
    }

    KernelResult {
        polygons,
        loops,
        total_area: arena.out_total_area,
    }
}

/// Reusable 2D Boolean & topological healing kernel owning its own pre-allocated [`KernelArena`].
///
/// Using an explicit [`PolystrataKernel`] avoids arena allocations across repeated operations and
/// allows independent kernel instances to run concurrently on multiple threads.
pub struct PolystrataKernel {
    arena: KernelArena,
}

impl Default for PolystrataKernel {
    #[inline]
    fn default() -> Self {
        Self::new()
    }
}

impl PolystrataKernel {
    /// Create a new kernel instance with pre-allocated arena buffers.
    pub fn new() -> Self {
        Self {
            arena: KernelArena::new(),
        }
    }

    fn execute_two_body<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
        &mut self,
        subject: &A,
        clip: &B,
        op_code: u32,
        options: KernelOptions,
    ) -> KernelResult {
        self.arena.raw_segments.clear();
        subject.write_segments(0, &mut self.arena.raw_segments);
        clip.write_segments(1, &mut self.arena.raw_segments);
        let seg_count = self.arena.raw_segments.len() / 5;
        self.arena.raw_count = seg_count;
        if seg_count == 0 {
            return KernelResult::default();
        }
        let user_tol = options.snap_tolerance.unwrap_or(-1.0);
        prepare_normalized_segments(&mut self.arena, seg_count, user_tol);
        consolidate_prepared(&mut self.arena);
        build_planar_topology(&mut self.arena);
        classify_and_extract(
            &mut self.arena,
            op_code,
            options.winding_rule.code(),
            options.simplify_collinear,
        );
        read_kernel_result_from_arena(&self.arena)
    }

    /// Compute the Boolean union (`A ∪ B`) of two 2D shapes.
    pub fn union<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
        &mut self,
        subject: &A,
        clip: &B,
        options: KernelOptions,
    ) -> KernelResult {
        self.execute_two_body(subject, clip, 0, options)
    }

    /// Compute the Boolean intersection (`A ∩ B`) of two 2D shapes.
    pub fn intersect<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
        &mut self,
        subject: &A,
        clip: &B,
        options: KernelOptions,
    ) -> KernelResult {
        self.execute_two_body(subject, clip, 1, options)
    }

    /// Compute the Boolean difference (`A \ B`) of two 2D shapes.
    pub fn difference<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
        &mut self,
        subject: &A,
        clip: &B,
        options: KernelOptions,
    ) -> KernelResult {
        self.execute_two_body(subject, clip, 2, options)
    }

    /// Compute the Boolean symmetric difference (`A ⊕ B`) of two 2D shapes.
    pub fn xor<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
        &mut self,
        subject: &A,
        clip: &B,
        options: KernelOptions,
    ) -> KernelResult {
        self.execute_two_body(subject, clip, 3, options)
    }

    /// Topological self-intersection healing & polygonization of a single 2D shape or segment soup.
    pub fn heal<A: ShapeInput + ?Sized>(&mut self, input: &A, options: KernelOptions) -> KernelResult {
        self.arena.raw_segments.clear();
        input.write_segments(0, &mut self.arena.raw_segments);
        let seg_count = self.arena.raw_segments.len() / 5;
        self.arena.raw_count = seg_count;
        if seg_count == 0 {
            return KernelResult::default();
        }
        let user_tol = options.snap_tolerance.unwrap_or(-1.0);
        prepare_normalized_segments(&mut self.arena, seg_count, user_tol);
        consolidate_prepared(&mut self.arena);
        build_planar_topology(&mut self.arena);
        classify_and_extract(
            &mut self.arena,
            4,
            options.winding_rule.code(),
            options.simplify_collinear,
        );
        read_kernel_result_from_arena(&self.arena)
    }

    /// Single-pass N-body Boolean union (`B₀ ∪ B₁ ∪ … ∪ Bₙ₋₁`) across an arbitrary slice of shapes.
    pub fn union_all<S: ShapeInput>(&mut self, bodies: &[S], options: KernelOptions) -> KernelResult {
        if bodies.is_empty() {
            return KernelResult::default();
        }
        if bodies.len() == 1 {
            return self.heal(&bodies[0], options);
        }
        self.arena.raw_segments.clear();
        for (i, body) in bodies.iter().enumerate() {
            body.write_segments(i as u32, &mut self.arena.raw_segments);
        }
        let seg_count = self.arena.raw_segments.len() / 5;
        self.arena.raw_count = seg_count;
        if seg_count == 0 {
            return KernelResult::default();
        }
        let user_tol = options.snap_tolerance.unwrap_or(-1.0);
        prepare_normalized_segments(&mut self.arena, seg_count, user_tol);
        consolidate_prepared(&mut self.arena);
        build_planar_topology(&mut self.arena);
        classify_and_extract(
            &mut self.arena,
            5,
            options.winding_rule.code(),
            options.simplify_collinear,
        );
        read_kernel_result_from_arena(&self.arena)
    }

    /// Single-pass N-body Boolean intersection (`B₀ ∩ B₁ ∩ … ∩ Bₙ₋₁`) across an arbitrary slice of shapes.
    pub fn intersect_all<S: ShapeInput>(
        &mut self,
        bodies: &[S],
        options: KernelOptions,
    ) -> KernelResult {
        if bodies.is_empty() {
            return KernelResult::default();
        }
        if bodies.len() == 1 {
            return self.heal(&bodies[0], options);
        }
        self.arena.raw_segments.clear();
        for (i, body) in bodies.iter().enumerate() {
            body.write_segments(i as u32, &mut self.arena.raw_segments);
        }
        let seg_count = self.arena.raw_segments.len() / 5;
        self.arena.raw_count = seg_count;
        if seg_count == 0 {
            return KernelResult::default();
        }
        let user_tol = options.snap_tolerance.unwrap_or(-1.0);
        prepare_normalized_segments(&mut self.arena, seg_count, user_tol);
        consolidate_prepared(&mut self.arena);
        build_planar_topology(&mut self.arena);
        classify_and_extract(
            &mut self.arena,
            6,
            options.winding_rule.code(),
            options.simplify_collinear,
        );
        read_kernel_result_from_arena(&self.arena)
    }

    /// Execute a general N-body Boolean operation defined by a custom predicate `predicate(&[w₀, w₁, …]) -> bool`
    /// over the per-body winding vector of each planar face cycle.
    pub fn boolean_multi<S: ShapeInput, F: FnMut(&[f64]) -> bool>(
        &mut self,
        bodies: &[S],
        mut predicate: F,
        options: KernelOptions,
    ) -> KernelResult {
        if bodies.is_empty() {
            return KernelResult::default();
        }
        self.arena.raw_segments.clear();
        for (i, body) in bodies.iter().enumerate() {
            body.write_segments(i as u32, &mut self.arena.raw_segments);
        }
        let seg_count = self.arena.raw_segments.len() / 5;
        self.arena.raw_count = seg_count;
        if seg_count == 0 {
            return KernelResult::default();
        }
        let user_tol = options.snap_tolerance.unwrap_or(-1.0);
        prepare_normalized_segments(&mut self.arena, seg_count, user_tol);
        if self.arena.prep_body_count < bodies.len() {
            self.arena.prep_body_count = bodies.len();
        }
        consolidate_prepared(&mut self.arena);
        build_planar_topology(&mut self.arena);
        compute_cycles_and_windings(&mut self.arena, false);

        let cycle_count = self.arena.cycle_count;
        let body_count = self.arena.prep_body_count;
        for c in 0..cycle_count {
            let base = c * body_count;
            let w_slice = &self.arena.cycle_windings_f64[base..(base + bodies.len())];
            self.arena.cycle_keep[c] = if predicate(w_slice) { 1 } else { 0 };
        }
        extract_from_cycle_keep(&mut self.arena, options.simplify_collinear);
        read_kernel_result_from_arena(&self.arena)
    }

    /// Execute a 2-body Boolean operation and return GeoJSON-style `MultiPolygon` coordinate rings
    /// (`Vec<Vec<Vec<[f64; 2]>>>`), where each ring is explicitly closed (`first == last`).
    pub fn clip<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
        &mut self,
        op: BooleanOp,
        subject: &A,
        clip: &B,
        options: KernelOptions,
    ) -> Vec<Vec<Vec<[f64; 2]>>> {
        self.execute_two_body(subject, clip, op.code(), options)
            .to_multipolygon_coords()
    }
}

/// Compute the Boolean union (`A ∪ B`) of two 2D shapes.
pub fn union<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
    subject: &A,
    clip: &B,
    options: KernelOptions,
) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.union(subject, clip, options);
        *arena = kernel.arena;
        res
    })
}

/// Compute the Boolean intersection (`A ∩ B`) of two 2D shapes.
pub fn intersect<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
    subject: &A,
    clip: &B,
    options: KernelOptions,
) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.intersect(subject, clip, options);
        *arena = kernel.arena;
        res
    })
}

/// Compute the Boolean difference (`A \ B`) of two 2D shapes.
pub fn difference<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
    subject: &A,
    clip: &B,
    options: KernelOptions,
) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.difference(subject, clip, options);
        *arena = kernel.arena;
        res
    })
}

/// Compute the Boolean symmetric difference (`A ⊕ B`) of two 2D shapes.
pub fn xor<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
    subject: &A,
    clip: &B,
    options: KernelOptions,
) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.xor(subject, clip, options);
        *arena = kernel.arena;
        res
    })
}

/// Topological self-intersection healing & polygonization of a single 2D shape or segment soup.
pub fn heal<A: ShapeInput + ?Sized>(input: &A, options: KernelOptions) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.heal(input, options);
        *arena = kernel.arena;
        res
    })
}

/// Single-pass N-body Boolean union (`B₀ ∪ B₁ ∪ … ∪ Bₙ₋₁`) across an arbitrary slice of shapes.
pub fn union_all<S: ShapeInput>(bodies: &[S], options: KernelOptions) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.union_all(bodies, options);
        *arena = kernel.arena;
        res
    })
}

/// Single-pass N-body Boolean intersection (`B₀ ∩ B₁ ∩ … ∩ Bₙ₋₁`) across an arbitrary slice of shapes.
pub fn intersect_all<S: ShapeInput>(bodies: &[S], options: KernelOptions) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.intersect_all(bodies, options);
        *arena = kernel.arena;
        res
    })
}

/// Execute a general N-body Boolean operation defined by a custom predicate `predicate(&[w₀, w₁, …]) -> bool`
/// over the per-body winding vector of each planar face cycle.
pub fn boolean_multi<S: ShapeInput, F: FnMut(&[f64]) -> bool>(
    bodies: &[S],
    predicate: F,
    options: KernelOptions,
) -> KernelResult {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.boolean_multi(bodies, predicate, options);
        *arena = kernel.arena;
        res
    })
}

/// Execute a 2-body Boolean operation and return GeoJSON-style `MultiPolygon` coordinate rings
/// (`Vec<Vec<Vec<[f64; 2]>>>`), where each ring is explicitly closed (`first == last`).
pub fn clip<A: ShapeInput + ?Sized, B: ShapeInput + ?Sized>(
    op: BooleanOp,
    subject: &A,
    clip: &B,
    options: KernelOptions,
) -> Vec<Vec<Vec<[f64; 2]>>> {
    with_arena(|arena| {
        let mut kernel = PolystrataKernel {
            arena: core::mem::take(arena),
        };
        let res = kernel.clip(op, subject, clip, options);
        *arena = kernel.arena;
        res
    })
}

// ============================================================================
// Thread-Local Arena & WebAssembly C-ABI Exports
// ============================================================================

std::thread_local! {
    static ARENA: RefCell<KernelArena> = RefCell::new(KernelArena::new());
}

#[inline]
fn with_arena<F, R>(f: F) -> R
where
    F: FnOnce(&mut KernelArena) -> R,
{
    ARENA.with(|cell| f(&mut cell.borrow_mut()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_boolean_squares_inclusion_exclusion() {
        let a = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let b = [[5.0, 5.0], [15.0, 5.0], [15.0, 15.0], [5.0, 15.0]];
        let opts = KernelOptions::default();

        let u = union(&a, &b, opts);
        let i = intersect(&a, &b, opts);
        let d = difference(&a, &b, opts);
        let x = xor(&a, &b, opts);

        assert!((u.total_area - 175.0).abs() < 1e-6);
        assert!((i.total_area - 25.0).abs() < 1e-6);
        assert!((d.total_area - 75.0).abs() < 1e-6);
        assert!((x.total_area - 150.0).abs() < 1e-6);
        assert_eq!(x.polygons.len(), 2);
    }

    #[test]
    fn test_self_intersecting_bowtie_healing() {
        let bowtie = [[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0]];
        let res = heal(
            &bowtie,
            KernelOptions {
                winding_rule: WindingRule::NonZero,
                ..KernelOptions::default()
            },
        );
        assert_eq!(res.polygons.len(), 2);
        assert!((res.total_area - 50.0).abs() < 1e-6);
    }

    #[test]
    fn test_union_all_and_intersect_all_and_clip() {
        let s1 = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let s2 = vec![[5.0, 0.0], [15.0, 0.0], [15.0, 10.0], [5.0, 10.0]];
        let s3 = vec![[8.0, 0.0], [20.0, 0.0], [20.0, 10.0], [8.0, 10.0]];
        let bodies = [s1, s2, s3];

        let u_all = union_all(&bodies, KernelOptions::default());
        assert_eq!(u_all.polygons.len(), 1);
        assert!((u_all.total_area - 200.0).abs() < 1e-6);

        let i_all = intersect_all(&bodies, KernelOptions::default());
        assert_eq!(i_all.polygons.len(), 1);
        assert!((i_all.total_area - 20.0).abs() < 1e-6);

        let multi = clip(
            BooleanOp::Difference,
            &bodies[0],
            &[[2.0, 2.0], [8.0, 2.0], [8.0, 8.0], [2.0, 8.0]],
            KernelOptions::default(),
        );
        assert_eq!(multi.len(), 1);
        assert_eq!(multi[0].len(), 2); // 1 outer shell + 1 hole
    }
}
