use crate::arena::KernelArena;

#[inline]
fn quadrant(dx: f64, dy: f64) -> i32 {
    if dx >= 0.0 && dy >= 0.0 {
        0
    } else if dx < 0.0 && dy >= 0.0 {
        1
    } else if dx < 0.0 && dy < 0.0 {
        2
    } else {
        3
    }
}

#[inline]
fn compare_spokes_coords(
    vx0: f64,
    vy0: f64,
    ax0: f64,
    ay0: f64,
    bx0: f64,
    by0: f64,
) -> f64 {
    let ax = ax0 - vx0;
    let ay = ay0 - vy0;
    let bx = bx0 - vx0;
    let by = by0 - vy0;
    let qa = quadrant(ax, ay);
    let qb = quadrant(bx, by);
    if qa != qb {
        return (qa - qb) as f64;
    }
    let cross = ax * by - ay * bx;
    if cross > 0.0 {
        -1.0
    } else if cross < 0.0 {
        1.0
    } else {
        (ax * ax + ay * ay) - (bx * bx + by * by)
    }
}

/// Stage 3: Build planar half-edge graph in flat CSR arena arrays, sort outgoing spokes CCW,
/// wire `he_next`, and extract closed half-edge cycles.
pub fn build_planar_topology(arena: &mut KernelArena) {
    let vertex_count = arena.vertex_count;
    let edge_count = arena.edge_count;
    let body_count = arena.prep_body_count;
    let half_edge_count = edge_count * 2;

    arena.ensure_half_edge_capacity(half_edge_count);

    for v in 0..vertex_count {
        arena.v_spoke_count[v] = 0;
    }

    for e_id in 0..edge_count {
        let he_fwd = e_id << 1;
        let he_rev = he_fwd + 1;
        arena.he_next[he_fwd] = -1;
        arena.he_next[he_rev] = -1;
        arena.he_cycle[he_fwd] = -1;
        arena.he_cycle[he_rev] = -1;
        arena.he_in_output[he_fwd] = 0;
        arena.he_in_output[he_rev] = 0;
        arena.he_visited[he_fwd] = 0;
        arena.he_visited[he_rev] = 0;

        if arena.e_alive[e_id] == 0 {
            continue;
        }
        arena.v_spoke_count[arena.ev0[e_id] as usize] += 1;
        arena.v_spoke_count[arena.ev1[e_id] as usize] += 1;
    }

    let mut total_spokes = 0u32;
    for v in 0..vertex_count {
        arena.v_spoke_offset[v] = total_spokes;
        arena.v_spoke_cursor[v] = total_spokes;
        total_spokes += arena.v_spoke_count[v];
    }

    for e_id in 0..edge_count {
        if arena.e_alive[e_id] == 0 {
            continue;
        }
        let u = arena.ev0[e_id] as usize;
        let v = arena.ev1[e_id] as usize;
        let he_fwd = (e_id as u32) << 1;
        let cu = arena.v_spoke_cursor[u] as usize;
        arena.v_spoke_cursor[u] += 1;
        arena.spokes_csr[cu] = he_fwd;
        let cv = arena.v_spoke_cursor[v] as usize;
        arena.v_spoke_cursor[v] += 1;
        arena.spokes_csr[cv] = he_fwd + 1;
    }

    for v_id in 0..vertex_count {
        let k = arena.v_spoke_count[v_id] as usize;
        if arena.v_alive[v_id] == 0 || k == 0 {
            continue;
        }
        let offset = arena.v_spoke_offset[v_id] as usize;
        if k == 2 {
            let s0 = arena.spokes_csr[offset];
            let s1 = arena.spokes_csr[offset + 1];
            arena.he_next[(s0 ^ 1) as usize] = s1 as i32;
            arena.he_next[(s1 ^ 1) as usize] = s0 as i32;
            continue;
        }
        let ox = arena.vx[v_id];
        let oy = arena.vy[v_id];

        for i in 1..k {
            let he_key = arena.spokes_csr[offset + i];
            let t_key = if (he_key & 1) == 0 {
                arena.ev1[(he_key >> 1) as usize] as usize
            } else {
                arena.ev0[(he_key >> 1) as usize] as usize
            };
            let kx = arena.vx[t_key];
            let ky = arena.vy[t_key];
            let mut j = i;
            while j > 0 {
                let he_prev = arena.spokes_csr[offset + j - 1];
                let t_prev = if (he_prev & 1) == 0 {
                    arena.ev1[(he_prev >> 1) as usize] as usize
                } else {
                    arena.ev0[(he_prev >> 1) as usize] as usize
                };
                if compare_spokes_coords(ox, oy, arena.vx[t_prev], arena.vy[t_prev], kx, ky) <= 0.0
                {
                    break;
                }
                arena.spokes_csr[offset + j] = he_prev;
                j -= 1;
            }
            arena.spokes_csr[offset + j] = he_key;
        }

        for i in 0..k {
            let outgoing = arena.spokes_csr[offset + i];
            let incoming = (outgoing ^ 1) as usize;
            let next_outgoing = arena.spokes_csr[offset + if i == 0 { k - 1 } else { i - 1 }];
            arena.he_next[incoming] = next_outgoing as i32;
        }
    }

    let mut cycle_count = 0usize;
    let mut csr_write = 0usize;

    for he_id in 0..half_edge_count {
        if arena.e_alive[he_id >> 1] == 0 || arena.he_visited[he_id] != 0 {
            continue;
        }

        let c_id = cycle_count;
        cycle_count += 1;
        if c_id >= arena.cycle_start.len() {
            arena.ensure_cycle_capacity(c_id + 1, body_count);
        }

        let start_idx = csr_write as u32;
        let mut curr = he_id as i32;
        while curr != -1 && arena.he_visited[curr as usize] == 0 {
            let cu = curr as usize;
            arena.he_visited[cu] = 1;
            arena.he_cycle[cu] = c_id as i32;
            arena.cycle_half_edges_csr[csr_write] = curr as u32;
            csr_write += 1;
            curr = arena.he_next[cu];
        }

        arena.cycle_start[c_id] = start_idx;
        arena.cycle_len[c_id] = (csr_write as u32) - start_idx;
    }

    arena.cycle_count = cycle_count;
    arena.ensure_cycle_capacity(cycle_count.max(1), body_count);
}

#[inline]
fn ray_segment_hit_distance(
    ox: f64,
    oy: f64,
    dx: f64,
    dy: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    r0: f64,
) -> f64 {
    let sx = bx - ax;
    let sy = by - ay;
    let len_s_sq = sx * sx + sy * sy;
    if len_s_sq == 0.0 {
        return f64::INFINITY;
    }

    let denom = dx * sy - dy * sx;
    if denom * denom > 1e-28 * len_s_sq {
        let qpx = ax - ox;
        let qpy = ay - oy;
        let inv_denom = 1.0 / denom;
        let t = (qpx * sy - qpy * sx) * inv_denom;
        if t <= 0.0 {
            return f64::INFINITY;
        }
        let u = (qpx * dy - qpy * dx) * inv_denom;
        if u < -1e-3 || u > 1.001 {
            return f64::INFINITY;
        }
        let len_s = len_s_sq.sqrt();
        let t_min = (1e-3 * r0).max(1e-12 * len_s);
        let u_slack = (r0 / len_s).max(1e-8).min(1e-3);
        if t > t_min && u >= -u_slack && u <= 1.0 + u_slack {
            return t;
        }
    }
    f64::INFINITY
}

fn pick_cycle_sample_point(c_id: usize, arena: &KernelArena, edges_sorted: bool) -> (f64, f64) {
    let r0 = arena.prep_r0;
    let start = arena.cycle_start[c_id] as usize;
    let count = arena.cycle_len[c_id] as usize;

    let mut best_he0 = u32::MAX;
    let mut best_len_sq0 = -1.0f64;
    let mut best_bound0 = false;

    for i in 0..count {
        let he_id = arena.cycle_half_edges_csr[start + i];
        let e_id = (he_id >> 1) as usize;
        let orig = if (he_id & 1) == 0 {
            arena.ev0[e_id] as usize
        } else {
            arena.ev1[e_id] as usize
        };
        let targ = if (he_id & 1) == 0 {
            arena.ev1[e_id] as usize
        } else {
            arena.ev0[e_id] as usize
        };
        let dx = arena.vx[targ] - arena.vx[orig];
        let dy = arena.vy[targ] - arena.vy[orig];
        let len_sq = dx * dx + dy * dy;
        if len_sq <= 0.0 {
            continue;
        }
        let is_bound = arena.he_cycle[(he_id ^ 1) as usize] != c_id as i32;

        if best_he0 == u32::MAX
            || (is_bound && !best_bound0)
            || (is_bound == best_bound0 && len_sq > best_len_sq0)
        {
            best_he0 = he_id;
            best_len_sq0 = len_sq;
            best_bound0 = is_bound;
        }
    }

    if best_he0 == u32::MAX || best_len_sq0 <= 0.0 {
        return (0.0, 0.0);
    }

    let len = best_len_sq0.sqrt();
    let cand_edge_id = (best_he0 >> 1) as usize;
    let orig = if (best_he0 & 1) == 0 {
        arena.ev0[cand_edge_id] as usize
    } else {
        arena.ev1[cand_edge_id] as usize
    };
    let targ = if (best_he0 & 1) == 0 {
        arena.ev1[cand_edge_id] as usize
    } else {
        arena.ev0[cand_edge_id] as usize
    };
    let x0 = arena.vx[orig];
    let y0 = arena.vy[orig];
    let x1 = arena.vx[targ];
    let y1 = arena.vy[targ];
    let dx = x1 - x0;
    let dy = y1 - y0;
    let mx = 0.5 * (x0 + x1);
    let my = 0.5 * (y0 + y1);
    let nx = -dy / len;
    let ny = dx / len;

    let max_ray_t = 0.5 * len;
    let end_x = mx + max_ray_t * nx;
    let end_y = my + max_ray_t * ny;
    let ray_min_x = mx.min(end_x) - r0;
    let ray_min_y = my.min(end_y) - r0;
    let ray_max_x = mx.max(end_x) + r0;
    let ray_max_y = my.max(end_y) + r0;

    let mut min_hit_t = f64::INFINITY;
    let num_active = arena.active_edge_ids.len();
    for i in 0..num_active {
        let e_id = arena.active_edge_ids[i] as usize;
        if arena.e_min_x[e_id] > ray_max_x {
            if edges_sorted {
                break;
            }
            continue;
        }
        if e_id == cand_edge_id {
            continue;
        }
        if arena.e_max_x[e_id] < ray_min_x
            || arena.e_max_y[e_id] < ray_min_y
            || arena.e_min_y[e_id] > ray_max_y
        {
            continue;
        }
        let u = arena.ev0[e_id] as usize;
        let v = arena.ev1[e_id] as usize;
        let t = ray_segment_hit_distance(
            mx,
            my,
            nx,
            ny,
            arena.vx[u],
            arena.vy[u],
            arena.vx[v],
            arena.vy[v],
            r0,
        );
        if t < min_hit_t {
            min_hit_t = t;
        }
    }

    let offset = if min_hit_t.is_finite() {
        (0.5 * min_hit_t).min(0.25 * len)
    } else {
        0.2 * len
    };

    (mx + offset * nx, my + offset * ny)
}

fn evaluate_winding_numbers_subtended_angle(
    px: f64,
    py: f64,
    arena: &KernelArena,
    out_windings: &mut [f64],
) {
    let body_count = arena.prep_body_count;
    for b in 0..body_count {
        out_windings[b] = 0.0;
    }

    for i in 0..arena.active_edge_ids.len() {
        let e_id = arena.active_edge_ids[i] as usize;
        let u = arena.ev0[e_id] as usize;
        let v = arena.ev1[e_id] as usize;
        let ax = arena.vx[u] - px;
        let ay = arena.vy[u] - py;
        let bx = arena.vx[v] - px;
        let by = arena.vy[v] - py;
        let d_theta = (ax * by - ay * bx).atan2(ax * bx + ay * by);
        if d_theta == 0.0 {
            continue;
        }
        let base = e_id * body_count;
        for b in 0..body_count {
            let dw = arena.e_delta_w[base + b];
            if dw != 0 {
                out_windings[b] += (dw as f64) * d_theta;
            }
        }
    }

    let inv_two_pi = 1.0 / (2.0 * core::f64::consts::PI);
    for b in 0..body_count {
        out_windings[b] *= inv_two_pi;
    }
}

fn evaluate_winding_numbers(
    px: f64,
    py: f64,
    arena: &KernelArena,
    out_windings: &mut [f64],
    edges_sorted: bool,
) {
    let r0 = arena.prep_r0;
    let body_count = arena.prep_body_count;
    let r0_sq = r0 * r0;
    let max_x_bound = px + r0;

    for b in 0..body_count {
        out_windings[b] = 0.0;
    }

    let num_active = arena.active_edge_ids.len();
    for i in 0..num_active {
        let e_id = arena.active_edge_ids[i] as usize;
        if arena.e_min_x[e_id] > max_x_bound {
            if edges_sorted {
                break;
            }
            continue;
        }
        let u = arena.ev0[e_id] as usize;
        let v = arena.ev1[e_id] as usize;
        let y0 = arena.vy[u];
        let y1 = arena.vy[v];

        let upward = y0 <= py && y1 > py;
        let downward = y1 <= py && y0 > py;
        if !upward && !downward {
            continue;
        }

        let x0 = arena.vx[u];
        let x1 = arena.vx[v];
        let dx = x1 - x0;
        let dy = y1 - y0;
        let det = dx * (py - y0) - dy * (px - x0);
        let len_sq = dx * dx + dy * dy;

        if det * det <= r0_sq * len_sq {
            evaluate_winding_numbers_subtended_angle(px, py, arena, out_windings);
            return;
        }

        let base = e_id * body_count;
        if upward {
            if det < 0.0 {
                for b in 0..body_count {
                    out_windings[b] -= arena.e_delta_w[base + b] as f64;
                }
            }
        } else if det > 0.0 {
            for b in 0..body_count {
                out_windings[b] += arena.e_delta_w[base + b] as f64;
            }
        }
    }
}

#[inline]
fn apply_rule(w: f64, rule_code: u32) -> bool {
    match rule_code {
        0 => w >= 0.5,
        1 => w.abs() >= 0.5,
        _ => (w.round() as i64).abs() % 2 == 1,
    }
}

/// Op codes:
/// 0 = Union, 1 = Intersect, 2 = Difference, 3 = Xor, 4 = Heal,
/// 5 = UnionAll (any body in 0..body_count), 6 = IntersectAll (all bodies in 0..body_count)
/// Rule codes: 0 = Positive, 1 = NonZero, 2 = EvenOdd
#[inline]
fn eval_predicate(windings: &[f64], body_count: usize, op_code: u32, rule_code: u32) -> bool {
    if op_code == 5 {
        for &w in &windings[..body_count] {
            if apply_rule(w, rule_code) {
                return true;
            }
        }
        return false;
    }
    if op_code == 6 {
        if body_count == 0 {
            return false;
        }
        for &w in &windings[..body_count] {
            if !apply_rule(w, rule_code) {
                return false;
            }
        }
        return true;
    }

    let w0 = windings[0];
    let in_a = apply_rule(w0, rule_code);
    if op_code == 4 {
        return in_a;
    }
    let w1 = if body_count > 1 { windings[1] } else { 0.0 };
    let in_b = apply_rule(w1, rule_code);
    match op_code {
        0 => in_a || in_b,
        1 => in_a && in_b,
        2 => in_a && !in_b,
        3 => in_a != in_b,
        _ => in_a,
    }
}

/// Remove degenerate (short, spiked) and, optionally, near-collinear vertices from one output loop,
/// compacting `v_ids` to the survivors in their original order. `keep` is caller-owned scratch.
///
/// Only vertices of output degree 2 are removed: dissolving a pinch vertex shared with another
/// loop would pull this loop off the shared point and let it cross the other loop's edges. A
/// collinear merge also requires every vertex already removed between the two neighbours to lie
/// within tolerance of the new edge, so chains of removals cannot drift the boundary.
fn clean_loop_in_place(
    v_ids: &mut Vec<u32>,
    keep: &mut Vec<bool>,
    vx: &[f64],
    vy: &[f64],
    out_degree: &[u32],
    r0: f64,
    simplify_collinear: bool,
) -> Option<f64> {
    let n = v_ids.len();
    if n < 3 {
        return None;
    }
    let collinear_tol = r0.max(1e-11);
    let collinear_tol_sq = collinear_tol * collinear_tol;
    let r0_sq = r0 * r0;
    let step = |i: usize, forward: bool| if forward { (i + 1) % n } else { (i + n - 1) % n };

    keep.clear();
    keep.resize(n, true);
    let mut kept = n;
    let mut changed = true;
    while changed && kept >= 3 {
        changed = false;
        for i in 0..n {
            if !keep[i] || out_degree[v_ids[i] as usize] != 2 {
                continue;
            }
            let mut pi = step(i, false);
            while !keep[pi] {
                pi = step(pi, false);
            }
            let mut ri = step(i, true);
            while !keep[ri] {
                ri = step(ri, true);
            }
            let (p, q, r) = (v_ids[pi] as usize, v_ids[i] as usize, v_ids[ri] as usize);

            let ux = vx[q] - vx[p];
            let uy = vy[q] - vy[p];
            let vx0 = vx[r] - vx[q];
            let vy0 = vy[r] - vy[q];
            let wx = vx[r] - vx[p];
            let wy = vy[r] - vy[p];
            let len_u_sq = ux * ux + uy * uy;
            let len_v_sq = vx0 * vx0 + vy0 * vy0;
            let len_w_sq = wx * wx + wy * wy;
            let cross = ux * vy0 - uy * vx0;
            let cross_sq = cross * cross;
            let dot = ux * vx0 + uy * vy0;

            let remove = if len_u_sq <= r0_sq || len_v_sq <= r0_sq || len_w_sq <= r0_sq {
                true
            } else if dot < 0.0 {
                cross_sq <= collinear_tol_sq * len_u_sq.min(len_v_sq)
            } else {
                simplify_collinear && dot > 0.0 && cross_sq <= collinear_tol_sq * len_w_sq && {
                    let mut k = step(pi, true);
                    let mut within = true;
                    while within && k != ri {
                        let m = v_ids[k] as usize;
                        let c = (vx[m] - vx[p]) * wy - (vy[m] - vy[p]) * wx;
                        within = c * c <= collinear_tol_sq * len_w_sq;
                        k = step(k, true);
                    }
                    within
                }
            };
            if remove {
                keep[i] = false;
                kept -= 1;
                changed = true;
                if kept < 3 {
                    break;
                }
            }
        }
    }

    let mut write_idx = 0usize;
    for i in 0..n {
        if keep[i] {
            v_ids[write_idx] = v_ids[i];
            write_idx += 1;
        }
    }
    v_ids.truncate(write_idx);

    let m = v_ids.len();
    if m < 3 {
        return None;
    }

    let mut area2 = 0.0;
    for i in 0..m {
        let u = v_ids[i] as usize;
        let v = v_ids[if i + 1 == m { 0 } else { i + 1 }] as usize;
        area2 += vx[u] * vy[v] - vx[v] * vy[u];
    }
    let area = 0.5 * area2;
    if area.abs() <= r0_sq {
        return None;
    }
    Some(area)
}

/// Stage 4: Classify planar regions by winding predicate via O(C + E) Dual-Graph BFS,
/// extract boundary half-edges, relink spokes, decompose pinch vertices, and write cleaned
/// world loops directly into `arena.out_coords` and `arena.out_loop_meta`.
pub fn classify_and_extract(
    arena: &mut KernelArena,
    op_code: u32,
    rule_code: u32,
    simplify_collinear: bool,
) {
    arena.out_coords.clear();
    arena.out_loop_meta.clear();
    arena.out_loop_count = 0;
    arena.out_total_area = 0.0;

    let vertex_count = arena.vertex_count;
    let edge_count = arena.edge_count;
    let cycle_count = arena.cycle_count;
    let body_count = arena.prep_body_count;

    if edge_count == 0 || cycle_count == 0 {
        return;
    }

    arena.active_edge_ids.clear();
    let needed_net_w = vertex_count * body_count;
    if arena.vertex_net_winding.len() < needed_net_w {
        arena.vertex_net_winding.resize(needed_net_w.max(1024) * 2, 0);
    }
    arena.vertex_net_winding[..needed_net_w].fill(0);

    for i in 0..edge_count {
        if arena.e_alive[i] == 0 {
            continue;
        }
        arena.active_edge_ids.push(i as u32);
        let u = arena.ev0[i] as usize;
        let v = arena.ev1[i] as usize;
        let base0 = u * body_count;
        let base1 = v * body_count;
        let e_base = i * body_count;
        for b in 0..body_count {
            let dw = arena.e_delta_w[e_base + b];
            arena.vertex_net_winding[base0 + b] -= dw;
            arena.vertex_net_winding[base1 + b] += dw;
        }
    }

    if arena.active_edge_ids.is_empty() {
        return;
    }

    let mut is_closed_chain = true;
    for i in 0..needed_net_w {
        if arena.vertex_net_winding[i] != 0 {
            is_closed_chain = false;
            break;
        }
    }

    let mut w_scratch = vec![0.0f64; body_count];
    let mut edges_sorted = false;

    if is_closed_chain {
        arena.cycle_visited[..cycle_count].fill(0);
        let mut comp_count = 0usize;

        for start_cid in 0..cycle_count {
            if arena.cycle_visited[start_cid] != 0 {
                continue;
            }
            if comp_count == 1 && !edges_sorted {
                let e_min_x = &arena.e_min_x;
                arena.active_edge_ids.sort_unstable_by(|&a, &b| {
                    e_min_x[a as usize]
                        .partial_cmp(&e_min_x[b as usize])
                        .unwrap_or(core::cmp::Ordering::Equal)
                });
                edges_sorted = true;
            }
            comp_count += 1;

            let (sx, sy) = pick_cycle_sample_point(start_cid, arena, edges_sorted);
            evaluate_winding_numbers(sx, sy, arena, &mut w_scratch, edges_sorted);

            arena.cycle_visited[start_cid] = 1;
            let base_start = start_cid * body_count;
            for b in 0..body_count {
                let w_int = w_scratch[b].round() as i32;
                arena.cycle_windings[base_start + b] = w_int;
                w_scratch[b] = w_int as f64;
            }
            arena.cycle_keep[start_cid] =
                if eval_predicate(&w_scratch, body_count, op_code, rule_code) {
                    1
                } else {
                    0
                };

            arena.bfs_queue.clear();
            arena.bfs_queue.push(start_cid as u32);
            let mut head = 0usize;

            while head < arena.bfs_queue.len() {
                let curr_cid = arena.bfs_queue[head] as usize;
                head += 1;
                let curr_base = curr_cid * body_count;
                let c_start = arena.cycle_start[curr_cid] as usize;
                let c_len = arena.cycle_len[curr_cid] as usize;

                for i in 0..c_len {
                    let he_id = arena.cycle_half_edges_csr[c_start + i];
                    let next_cid_i32 = arena.he_cycle[(he_id ^ 1) as usize];
                    if next_cid_i32 < 0 {
                        continue;
                    }
                    let next_cid = next_cid_i32 as usize;
                    if arena.cycle_visited[next_cid] != 0 {
                        continue;
                    }

                    arena.cycle_visited[next_cid] = 1;
                    let e_base = ((he_id >> 1) as usize) * body_count;
                    let step_sign: i32 = if (he_id & 1) == 0 { -1 } else { 1 };
                    let next_base = next_cid * body_count;

                    for b in 0..body_count {
                        let nw =
                            arena.cycle_windings[curr_base + b] + step_sign * arena.e_delta_w[e_base + b];
                        arena.cycle_windings[next_base + b] = nw;
                        w_scratch[b] = nw as f64;
                    }
                    arena.cycle_keep[next_cid] =
                        if eval_predicate(&w_scratch, body_count, op_code, rule_code) {
                            1
                        } else {
                            0
                        };
                    arena.bfs_queue.push(next_cid as u32);
                }
            }
        }
    } else {
        if cycle_count > 1 {
            let e_min_x = &arena.e_min_x;
            arena.active_edge_ids.sort_unstable_by(|&a, &b| {
                e_min_x[a as usize]
                    .partial_cmp(&e_min_x[b as usize])
                    .unwrap_or(core::cmp::Ordering::Equal)
            });
            edges_sorted = true;
        }
        for c_id in 0..cycle_count {
            let (sx, sy) = pick_cycle_sample_point(c_id, arena, edges_sorted);
            evaluate_winding_numbers_subtended_angle(sx, sy, arena, &mut w_scratch);
            arena.cycle_keep[c_id] =
                if eval_predicate(&w_scratch, body_count, op_code, rule_code) {
                    1
                } else {
                    0
                };
        }
    }

    // 2. Algebraic boundary extraction + spoke relinking + pinch decomposition
    extract_from_cycle_keep(arena, simplify_collinear);
}

/// Compute `arena.cycle_windings_f64` (and `cycle_sample_x`/`cycle_sample_y` in world coordinates
/// when `capture_samples` is true) for all cycles `0..arena.cycle_count` so a custom JS predicate
/// (`booleanMulti` or `inspectPipeline`) can populate `arena.cycle_keep[0..cycle_count]`.
pub fn compute_cycles_and_windings(arena: &mut KernelArena, capture_samples: bool) {
    arena.out_coords.clear();
    arena.out_loop_meta.clear();
    arena.out_loop_count = 0;
    arena.out_total_area = 0.0;

    let vertex_count = arena.vertex_count;
    let edge_count = arena.edge_count;
    let cycle_count = arena.cycle_count;
    let body_count = arena.prep_body_count;
    let cx = arena.prep_cx;
    let cy = arena.prep_cy;
    let inv_scale = arena.prep_inv_scale;

    if edge_count == 0 || cycle_count == 0 {
        return;
    }

    arena.active_edge_ids.clear();
    let needed_net_w = vertex_count * body_count;
    if arena.vertex_net_winding.len() < needed_net_w {
        arena.vertex_net_winding.resize(needed_net_w.max(1024) * 2, 0);
    }
    arena.vertex_net_winding[..needed_net_w].fill(0);

    for i in 0..edge_count {
        if arena.e_alive[i] == 0 {
            continue;
        }
        arena.active_edge_ids.push(i as u32);
        let u = arena.ev0[i] as usize;
        let v = arena.ev1[i] as usize;
        let base0 = u * body_count;
        let base1 = v * body_count;
        let e_base = i * body_count;
        for b in 0..body_count {
            let dw = arena.e_delta_w[e_base + b];
            arena.vertex_net_winding[base0 + b] -= dw;
            arena.vertex_net_winding[base1 + b] += dw;
        }
    }

    if arena.active_edge_ids.is_empty() {
        return;
    }

    let mut is_closed_chain = true;
    for i in 0..needed_net_w {
        if arena.vertex_net_winding[i] != 0 {
            is_closed_chain = false;
            break;
        }
    }

    let mut w_scratch = vec![0.0f64; body_count];
    let mut edges_sorted = false;

    if is_closed_chain {
        arena.cycle_visited[..cycle_count].fill(0);
        let mut comp_count = 0usize;

        for start_cid in 0..cycle_count {
            if arena.cycle_visited[start_cid] != 0 {
                continue;
            }
            if (comp_count == 1 || (capture_samples && cycle_count > 1)) && !edges_sorted {
                let e_min_x = &arena.e_min_x;
                arena.active_edge_ids.sort_unstable_by(|&a, &b| {
                    e_min_x[a as usize]
                        .partial_cmp(&e_min_x[b as usize])
                        .unwrap_or(core::cmp::Ordering::Equal)
                });
                edges_sorted = true;
            }
            comp_count += 1;

            let (sx, sy) = pick_cycle_sample_point(start_cid, arena, edges_sorted);
            if capture_samples {
                arena.cycle_sample_x[start_cid] = sx * inv_scale + cx;
                arena.cycle_sample_y[start_cid] = sy * inv_scale + cy;
            }
            evaluate_winding_numbers(sx, sy, arena, &mut w_scratch, edges_sorted);

            arena.cycle_visited[start_cid] = 1;
            let base_start = start_cid * body_count;
            for b in 0..body_count {
                let w_int = w_scratch[b].round() as i32;
                arena.cycle_windings[base_start + b] = w_int;
                arena.cycle_windings_f64[base_start + b] = w_int as f64;
            }

            arena.bfs_queue.clear();
            arena.bfs_queue.push(start_cid as u32);
            let mut head = 0usize;

            while head < arena.bfs_queue.len() {
                let curr_cid = arena.bfs_queue[head] as usize;
                head += 1;
                let curr_base = curr_cid * body_count;
                let c_start = arena.cycle_start[curr_cid] as usize;
                let c_len = arena.cycle_len[curr_cid] as usize;

                for i in 0..c_len {
                    let he_id = arena.cycle_half_edges_csr[c_start + i];
                    let next_cid_i32 = arena.he_cycle[(he_id ^ 1) as usize];
                    if next_cid_i32 < 0 {
                        continue;
                    }
                    let next_cid = next_cid_i32 as usize;
                    if arena.cycle_visited[next_cid] != 0 {
                        continue;
                    }

                    arena.cycle_visited[next_cid] = 1;
                    if capture_samples {
                        let (nsx, nsy) = pick_cycle_sample_point(next_cid, arena, edges_sorted);
                        arena.cycle_sample_x[next_cid] = nsx * inv_scale + cx;
                        arena.cycle_sample_y[next_cid] = nsy * inv_scale + cy;
                    }
                    let e_base = ((he_id >> 1) as usize) * body_count;
                    let step_sign: i32 = if (he_id & 1) == 0 { -1 } else { 1 };
                    let next_base = next_cid * body_count;

                    for b in 0..body_count {
                        let nw =
                            arena.cycle_windings[curr_base + b] + step_sign * arena.e_delta_w[e_base + b];
                        arena.cycle_windings[next_base + b] = nw;
                        arena.cycle_windings_f64[next_base + b] = nw as f64;
                    }
                    arena.bfs_queue.push(next_cid as u32);
                }
            }
        }
    } else {
        if cycle_count > 1 {
            let e_min_x = &arena.e_min_x;
            arena.active_edge_ids.sort_unstable_by(|&a, &b| {
                e_min_x[a as usize]
                    .partial_cmp(&e_min_x[b as usize])
                    .unwrap_or(core::cmp::Ordering::Equal)
            });
            edges_sorted = true;
        }
        for c_id in 0..cycle_count {
            let (sx, sy) = pick_cycle_sample_point(c_id, arena, edges_sorted);
            if capture_samples {
                arena.cycle_sample_x[c_id] = sx * inv_scale + cx;
                arena.cycle_sample_y[c_id] = sy * inv_scale + cy;
            }
            evaluate_winding_numbers_subtended_angle(sx, sy, arena, &mut w_scratch);
            let base = c_id * body_count;
            for b in 0..body_count {
                arena.cycle_windings_f64[base + b] = w_scratch[b];
            }
        }
    }
}

/// Extract surviving boundary half-edges, relink spokes, decompose pinch vertices, and write
/// cleaned world loops directly into `arena.out_coords` and `arena.out_loop_meta` from `arena.cycle_keep`.
pub fn extract_from_cycle_keep(arena: &mut KernelArena, simplify_collinear: bool) {
    arena.out_coords.clear();
    arena.out_loop_meta.clear();
    arena.out_loop_count = 0;
    arena.out_total_area = 0.0;

    let vertex_count = arena.vertex_count;
    let edge_count = arena.edge_count;
    let cycle_count = arena.cycle_count;
    let half_edge_count = edge_count * 2;
    let r0 = arena.prep_r0;
    let cx = arena.prep_cx;
    let cy = arena.prep_cy;
    let inv_scale = arena.prep_inv_scale;

    if edge_count == 0 || cycle_count == 0 || arena.active_edge_ids.is_empty() {
        return;
    }

    // 2. Algebraic boundary extraction
    for i in 0..arena.active_edge_ids.len() {
        let e_id = arena.active_edge_ids[i] as usize;
        let he_fwd = e_id << 1;
        let he_rev = he_fwd + 1;
        let left_keep = arena.cycle_keep[arena.he_cycle[he_fwd] as usize] == 1;
        let right_keep = arena.cycle_keep[arena.he_cycle[he_rev] as usize] == 1;

        arena.he_in_output[he_fwd] = if left_keep && !right_keep { 1 } else { 0 };
        arena.he_in_output[he_rev] = if !left_keep && right_keep { 1 } else { 0 };
        arena.he_next[he_fwd] = -1;
        arena.he_next[he_rev] = -1;
    }

    // 3. Relink `he_next` strictly among surviving `he_in_output` spokes around each vertex
    for v_id in 0..vertex_count {
        let k = arena.v_spoke_count[v_id] as usize;
        if arena.v_alive[v_id] == 0 || k == 0 {
            continue;
        }
        let offset = arena.v_spoke_offset[v_id] as usize;

        arena.active_spokes.clear();
        for i in 0..k {
            let out_he = arena.spokes_csr[offset + i];
            let in_he = out_he ^ 1;
            if arena.he_in_output[out_he as usize] != 0 {
                arena.active_spokes.push(out_he);
            } else if arena.he_in_output[in_he as usize] != 0 {
                arena.active_spokes.push(in_he);
            }
        }

        let m = arena.active_spokes.len();
        arena.v_out_degree[v_id] = m as u32;
        if m == 0 {
            continue;
        }

        for i in 0..m {
            let he_id = arena.active_spokes[i];
            let e_id = (he_id >> 1) as usize;
            let target = if (he_id & 1) == 0 {
                arena.ev1[e_id] as usize
            } else {
                arena.ev0[e_id] as usize
            };
            if target == v_id {
                let next_he = arena.active_spokes[if i == 0 { m - 1 } else { i - 1 }];
                arena.he_next[he_id as usize] = next_he as i32;
            }
        }
    }

    // 4. Trace closed boundary loops and decompose pinch vertices
    arena.he_visited[..half_edge_count].fill(0);
    let mut sub_loop_scratch = Vec::with_capacity(128);
    let mut keep_scratch = Vec::with_capacity(128);
    let mut total_signed_area = 0.0f64;

    for he_id in 0..half_edge_count {
        if arena.he_in_output[he_id] == 0 || arena.he_visited[he_id] != 0 {
            continue;
        }

        arena.walk_vertex_ids.clear();
        let mut curr = he_id as i32;
        while curr != -1 && arena.he_visited[curr as usize] == 0 {
            let cu = curr as usize;
            arena.he_visited[cu] = 1;
            let e_id = cu >> 1;
            let origin = if (cu & 1) == 0 {
                arena.ev0[e_id]
            } else {
                arena.ev1[e_id]
            };
            arena.walk_vertex_ids.push(origin);
            curr = arena.he_next[cu];
        }

        if arena.walk_vertex_ids.len() < 3 {
            continue;
        }

        // Decompose pinched vertex walk into simple loops stored in simple_loops_csr
        arena.pinch_stack.clear();
        arena.simple_loops_csr.clear();
        arena.simple_loop_starts.clear();
        arena.simple_loop_lens.clear();

        for i in 0..arena.walk_vertex_ids.len() {
            let v_id = arena.walk_vertex_ids[i];
            let prev_idx = arena.index_in_stack[v_id as usize];
            if prev_idx != -1 {
                let p_usize = prev_idx as usize;
                let sub_len = arena.pinch_stack.len() - p_usize;
                if sub_len >= 3 {
                    let start = arena.simple_loops_csr.len() as u32;
                    arena
                        .simple_loops_csr
                        .extend_from_slice(&arena.pinch_stack[p_usize..]);
                    arena.simple_loop_starts.push(start);
                    arena.simple_loop_lens.push(sub_len as u32);
                }
                for k in (p_usize + 1)..arena.pinch_stack.len() {
                    let vk = arena.pinch_stack[k] as usize;
                    arena.index_in_stack[vk] = -1;
                }
                arena.pinch_stack.truncate(p_usize + 1);
            } else {
                arena.index_in_stack[v_id as usize] = arena.pinch_stack.len() as i32;
                arena.pinch_stack.push(v_id);
            }
        }

        for i in 0..arena.pinch_stack.len() {
            let vk = arena.pinch_stack[i] as usize;
            arena.index_in_stack[vk] = -1;
        }
        if arena.pinch_stack.len() >= 3 {
            let start = arena.simple_loops_csr.len() as u32;
            let len = arena.pinch_stack.len() as u32;
            arena.simple_loops_csr.extend_from_slice(&arena.pinch_stack);
            arena.simple_loop_starts.push(start);
            arena.simple_loop_lens.push(len);
        }

        for s in 0..arena.simple_loop_starts.len() {
            let start = arena.simple_loop_starts[s] as usize;
            let len = arena.simple_loop_lens[s] as usize;
            sub_loop_scratch.clear();
            sub_loop_scratch.extend_from_slice(&arena.simple_loops_csr[start..(start + len)]);

            if let Some(area) = clean_loop_in_place(
                &mut sub_loop_scratch,
                &mut keep_scratch,
                &arena.vx,
                &arena.vy,
                &arena.v_out_degree,
                r0,
                simplify_collinear,
            ) {
                total_signed_area += area;
                let pt_start = (arena.out_coords.len() / 2) as u32;
                let pt_count = sub_loop_scratch.len() as u32;
                let is_outer = if area > 0.0 { 1u32 } else { 0u32 };

                for &v in &sub_loop_scratch {
                    let vu = v as usize;
                    arena.out_coords.push(arena.vx[vu] * inv_scale + cx);
                    arena.out_coords.push(arena.vy[vu] * inv_scale + cy);
                }

                arena.out_loop_meta.push(pt_start);
                arena.out_loop_meta.push(pt_count);
                arena.out_loop_meta.push(is_outer);
                arena.out_loop_count += 1;
            }
        }
    }

    arena.out_total_area = total_signed_area * inv_scale * inv_scale;
}
