use crate::arena::KernelArena;

#[inline]
pub fn resolve_canonical_vertex(parents: &mut [u32], v: u32) -> u32 {
    let mut root = v;
    while unsafe { *parents.get_unchecked(root as usize) } != root {
        root = unsafe { *parents.get_unchecked(root as usize) };
    }
    let mut curr = v;
    while curr != root {
        let nxt = unsafe { *parents.get_unchecked(curr as usize) };
        unsafe { *parents.get_unchecked_mut(curr as usize) = root };
        curr = nxt;
    }
    root
}

#[inline]
fn project_point_to_segment_t(
    px: f64,
    py: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    tol: f64,
) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = dx * dx + dy * dy;
    if len_sq == 0.0 {
        return -1.0;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len_sq;
    if t <= 0.0 || t >= 1.0 {
        return -1.0;
    }
    let ex = px - (ax + t * dx);
    let ey = py - (ay + t * dy);
    if ex * ex + ey * ey <= tol * tol {
        t
    } else {
        -1.0
    }
}

#[inline]
fn intersect_segments_interior_fast(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    cx: f64,
    cy: f64,
    dx: f64,
    dy: f64,
    r0: f64,
) -> Option<(f64, f64, f64, f64)> {
    let rx = bx - ax;
    let ry = by - ay;
    let sx = dx - cx;
    let sy = dy - cy;
    let denom = rx * sy - ry * sx;
    if denom == 0.0 {
        return None;
    }

    let qpx = cx - ax;
    let qpy = cy - ay;
    let inv_denom = 1.0 / denom;
    let s_raw = (qpx * sy - qpy * sx) * inv_denom;
    if s_raw < -0.5 || s_raw > 1.5 {
        return None;
    }
    let t_raw = (qpx * ry - qpy * rx) * inv_denom;
    if t_raw < -0.5 || t_raw > 1.5 {
        return None;
    }

    let len_r_sq = rx * rx + ry * ry;
    let len_s_sq = sx * sx + sy * sy;
    let len_scale_sq = len_r_sq * len_s_sq;
    if len_scale_sq == 0.0 || denom * denom <= 1e-30 * len_scale_sq {
        return None;
    }

    if s_raw > 0.0 && s_raw < 1.0 && t_raw > 0.0 && t_raw < 1.0 {
        let hx = ax + 0.5 * (s_raw * rx + (qpx + t_raw * sx));
        let hy = ay + 0.5 * (s_raw * ry + (qpy + t_raw * sy));
        return Some((s_raw, t_raw, hx, hy));
    }

    let len_r = len_r_sq.sqrt();
    let len_s = len_s_sq.sqrt();
    let s_slack = r0 / len_r;
    let t_slack = r0 / len_s;
    if s_raw > -s_slack && s_raw < 1.0 + s_slack && t_raw > -t_slack && t_raw < 1.0 + t_slack {
        let s = s_raw.clamp(1e-7, 1.0 - 1e-7);
        let t = t_raw.clamp(1e-7, 1.0 - 1e-7);
        let px = ax + s * rx;
        let py = ay + s * ry;
        let qx = cx + t * sx;
        let qy = cy + t * sy;
        let ddx = px - qx;
        let ddy = py - qy;
        if ddx * ddx + ddy * ddy <= r0 * r0 {
            return Some((s, t, 0.5 * (px + qx), 0.5 * (py + qy)));
        }
    }

    None
}

#[inline]
pub fn sort_indices_by_f64(indices: &mut [u32], keys: &[f64]) {
    let count = indices.len();
    if count <= 1 {
        return;
    }
    if count <= 24 {
        for i in 1..count {
            let idx = indices[i];
            let k = unsafe { *keys.get_unchecked(idx as usize) };
            let mut j = i;
            while j > 0 && unsafe { *keys.get_unchecked(indices[j - 1] as usize) } > k {
                indices[j] = indices[j - 1];
                j -= 1;
            }
            indices[j] = idx;
        }
        return;
    }
    indices.sort_unstable_by(|&a, &b| {
        let ka = unsafe { *keys.get_unchecked(a as usize) };
        let kb = unsafe { *keys.get_unchecked(b as usize) };
        ka.partial_cmp(&kb).unwrap_or(core::cmp::Ordering::Equal)
    });
}

#[inline]
fn mark_vertex_dirty(arena: &mut KernelArena, v_id: u32) {
    let vu = v_id as usize;
    if arena.in_zero_v_queue[vu] == 0 {
        arena.in_zero_v_queue[vu] = 1;
        arena.zero_v_queue.push(v_id);
    }
    if arena.in_step_v_queue[vu] == 0 {
        arena.in_step_v_queue[vu] = 1;
        arena.step_v_queue.push(v_id);
    }
}

#[inline]
fn mark_step_vertex_dirty(arena: &mut KernelArena, v_id: u32) {
    let vu = v_id as usize;
    if arena.in_step_v_queue[vu] == 0 {
        arena.in_step_v_queue[vu] = 1;
        arena.step_v_queue.push(v_id);
    }
}

#[inline]
fn mark_edge_dirty(arena: &mut KernelArena, e_id: u32) {
    let eu = e_id as usize;
    if arena.in_zero_e_queue[eu] == 0 {
        arena.in_zero_e_queue[eu] = 1;
        arena.zero_e_queue.push(e_id);
    }
    if arena.in_step_e_queue[eu] == 0 {
        arena.in_step_e_queue[eu] = 1;
        arena.step_e_queue.push(e_id);
    }
}

#[inline]
fn update_edge_bounds(arena: &mut KernelArena, e_id: usize) {
    let u = arena.ev0[e_id] as usize;
    let v = arena.ev1[e_id] as usize;
    let x0 = arena.vx[u];
    let y0 = arena.vy[u];
    let x1 = arena.vx[v];
    let y1 = arena.vy[v];
    arena.e_min_x[e_id] = x0.min(x1);
    arena.e_min_y[e_id] = y0.min(y1);
    arena.e_max_x[e_id] = x0.max(x1);
    arena.e_max_y[e_id] = y0.max(y1);
}

#[inline]
fn link_incident_edge(arena: &mut KernelArena, v_id: u32, e_id: u32) {
    let idx = arena.inc_count;
    if idx >= arena.inc_edge.len() {
        arena.ensure_inc_capacity(idx + 1);
    }
    arena.inc_count = idx + 1;
    let vu = v_id as usize;
    arena.inc_edge[idx] = e_id;
    arena.inc_next[idx] = arena.v_first_inc[vu];
    arena.v_first_inc[vu] = idx as i32;
}

#[inline]
fn create_edge_single_body(
    arena: &mut KernelArena,
    v0: u32,
    v1: u32,
    body_index: usize,
    body_count: usize,
) -> u32 {
    let id = arena.edge_count;
    if id >= arena.ev0.len() || (id + 1) * body_count > arena.e_delta_w.len() {
        arena.ensure_edge_capacity(id + 1, body_count);
    }
    arena.edge_count = id + 1;
    arena.ev0[id] = v0;
    arena.ev1[id] = v1;
    arena.e_alive[id] = 1;
    arena.in_zero_e_queue[id] = 0;
    arena.in_step_e_queue[id] = 0;
    arena.edge_split_head[id] = -1;

    let base = id * body_count;
    for b in 0..body_count {
        arena.e_delta_w[base + b] = 0;
    }
    arena.e_delta_w[base + body_index] = 1;

    update_edge_bounds(arena, id);
    let eid_u32 = id as u32;
    link_incident_edge(arena, v0, eid_u32);
    link_incident_edge(arena, v1, eid_u32);
    mark_edge_dirty(arena, eid_u32);
    eid_u32
}

#[inline]
fn find_or_create_vertex(
    arena: &mut KernelArena,
    x: f64,
    y: f64,
    initial_vertex_radius: f64,
    r_max: f64,
    allow_weighted_move: bool,
) -> u32 {
    let search_r = r_max + initial_vertex_radius;
    arena.vertex_grid.query_box(
        x - search_r,
        y - search_r,
        x + search_r,
        y + search_r,
        &mut arena.vertex_query_scratch,
    );

    let mut best_id = u32::MAX;
    let mut best_dist_sq = f64::INFINITY;
    let r_max_sq = r_max * r_max;

    let q_len = arena.vertex_query_scratch.len();
    for i in 0..q_len {
        let raw_cand = arena.vertex_query_scratch[i];
        let cand_id = resolve_canonical_vertex(&mut arena.v_parent, raw_cand);
        let cu = cand_id as usize;
        if arena.v_alive[cu] == 0 {
            continue;
        }
        let dx = x - arena.vx[cu];
        let dy = y - arena.vy[cu];
        let d_sq = dx * dx + dy * dy;
        if d_sq > r_max_sq || d_sq >= best_dist_sq {
            continue;
        }
        let rad_sum = arena.vr[cu] + initial_vertex_radius;
        if d_sq <= rad_sum * rad_sum {
            best_dist_sq = d_sq;
            best_id = cand_id;
        }
    }

    if best_id != u32::MAX {
        let bu = best_id as usize;
        if best_dist_sq == 0.0 {
            if allow_weighted_move {
                arena.v_weight[bu] += 1;
            }
            return best_id;
        }
        if allow_weighted_move {
            let best_dist = best_dist_sq.sqrt();
            let w = arena.v_weight[bu] as f64;
            let total_w = w + 1.0;
            let nx = (arena.vx[bu] * w + x) / total_w;
            let ny = (arena.vy[bu] * w + y) / total_w;
            let cur_r = arena.vr[bu];
            let nr = r_max.min(cur_r.max(0.5 * (best_dist + cur_r + initial_vertex_radius)));
            arena.vx[bu] = nx;
            arena.vy[bu] = ny;
            arena.v_weight[bu] += 1;
            arena.vr[bu] = nr;
            arena.vertex_grid.insert_point(nx, ny, best_id);
            mark_vertex_dirty(arena, best_id);
        } else {
            mark_step_vertex_dirty(arena, best_id);
        }
        return best_id;
    }

    let id = arena.vertex_count;
    if id >= arena.vx.len() {
        arena.ensure_vertex_capacity(id + 1);
    }
    arena.vertex_count = id + 1;
    let id_u32 = id as u32;
    arena.vx[id] = x;
    arena.vy[id] = y;
    arena.vr[id] = initial_vertex_radius;
    arena.v_weight[id] = 1;
    arena.v_alive[id] = 1;
    arena.v_parent[id] = id_u32;
    arena.v_first_inc[id] = -1;
    arena.in_zero_v_queue[id] = 0;
    arena.in_step_v_queue[id] = 0;

    arena.vertex_grid.insert_point(x, y, id_u32);
    if allow_weighted_move {
        mark_step_vertex_dirty(arena, id_u32);
    }
    id_u32
}

fn merge_vertex_pair(arena: &mut KernelArena, id_a: u32, id_b: u32, r_max: f64) -> u32 {
    let ca = resolve_canonical_vertex(&mut arena.v_parent, id_a);
    let cb = resolve_canonical_vertex(&mut arena.v_parent, id_b);
    if ca == cb {
        return ca;
    }
    let keep_id = ca.min(cb);
    let drop_id = ca.max(cb);
    let ku = keep_id as usize;
    let du = drop_id as usize;

    let kx = arena.vx[ku];
    let ky = arena.vy[ku];
    let dx = arena.vx[du];
    let dy = arena.vy[du];
    let d = ((dx - kx) * (dx - kx) + (dy - ky) * (dy - ky)).sqrt();
    let kw = arena.v_weight[ku] as f64;
    let dw = arena.v_weight[du] as f64;
    let total_w = kw + dw;
    let nkx = (kx * kw + dx * dw) / total_w;
    let nky = (ky * kw + dy * dw) / total_w;
    let kr = arena.vr[ku];
    let dr = arena.vr[du];
    let nkr = r_max.min(kr.max(dr).max(0.5 * (d + kr + dr)));

    arena.vx[ku] = nkx;
    arena.vy[ku] = nky;
    arena.v_weight[ku] += arena.v_weight[du];
    arena.vr[ku] = nkr;
    arena.v_alive[du] = 0;
    arena.v_parent[du] = keep_id;

    arena.vertex_grid.insert_point(nkx, nky, keep_id);
    mark_vertex_dirty(arena, keep_id);

    let mut curr = arena.v_first_inc[du];
    arena.v_first_inc[du] = -1;
    while curr != -1 {
        let cu = curr as usize;
        let next_node = arena.inc_next[cu];
        let e_id = arena.inc_edge[cu] as usize;
        if arena.e_alive[e_id] != 0 {
            arena.inc_next[cu] = arena.v_first_inc[ku];
            arena.v_first_inc[ku] = curr;
        }
        curr = next_node;
    }

    let mut prev: i32 = -1;
    let mut node = arena.v_first_inc[ku];
    while node != -1 {
        let nu = node as usize;
        let next_node = arena.inc_next[nu];
        let e_id = arena.inc_edge[nu] as usize;
        if arena.e_alive[e_id] == 0 {
            if prev == -1 {
                arena.v_first_inc[ku] = next_node;
            } else {
                arena.inc_next[prev as usize] = next_node;
            }
            node = next_node;
            continue;
        }
        let c0 = resolve_canonical_vertex(&mut arena.v_parent, arena.ev0[e_id]);
        let c1 = resolve_canonical_vertex(&mut arena.v_parent, arena.ev1[e_id]);
        arena.ev0[e_id] = c0;
        arena.ev1[e_id] = c1;
        if c0 == c1 {
            arena.e_alive[e_id] = 0;
            if prev == -1 {
                arena.v_first_inc[ku] = next_node;
            } else {
                arena.inc_next[prev as usize] = next_node;
            }
            node = next_node;
            continue;
        }
        prev = node;
        update_edge_bounds(arena, e_id);
        mark_edge_dirty(arena, e_id as u32);
        node = next_node;
    }

    keep_id
}

fn try_merge_coincident_with_incident(
    arena: &mut KernelArena,
    e_id: usize,
    body_count: usize,
) -> bool {
    if arena.e_alive[e_id] == 0 {
        return false;
    }
    let v0 = arena.ev0[e_id];
    let v1 = arena.ev1[e_id];
    let mut node = arena.v_first_inc[v0 as usize];
    let mut merged = false;

    while node != -1 {
        let nu = node as usize;
        let other_id = arena.inc_edge[nu] as usize;
        node = arena.inc_next[nu];
        if other_id == e_id || arena.e_alive[other_id] == 0 {
            continue;
        }

        let ov0 = resolve_canonical_vertex(&mut arena.v_parent, arena.ev0[other_id]);
        let ov1 = resolve_canonical_vertex(&mut arena.v_parent, arena.ev1[other_id]);
        arena.ev0[other_id] = ov0;
        arena.ev1[other_id] = ov1;
        if ov0 == ov1 {
            arena.e_alive[other_id] = 0;
            merged = true;
            continue;
        }

        let same_pair = (ov0 == v0 && ov1 == v1) || (ov0 == v1 && ov1 == v0);
        if !same_pair {
            continue;
        }

        let keep_id = e_id.min(other_id);
        let drop_id = e_id.max(other_id);
        let sign: i32 = if arena.ev0[keep_id] == arena.ev0[drop_id] {
            1
        } else {
            -1
        };
        let keep_base = keep_id * body_count;
        let drop_base = drop_id * body_count;
        for b in 0..body_count {
            arena.e_delta_w[keep_base + b] += sign * arena.e_delta_w[drop_base + b];
        }
        arena.e_alive[drop_id] = 0;
        merged = true;
        if arena.e_alive[e_id] == 0 {
            break;
        }
    }

    merged
}

fn drain_zero_strata(arena: &mut KernelArena, r_max: f64, body_count: usize) -> bool {
    let mut any_changed = false;
    let mut v_head = 0usize;
    let mut e_head = 0usize;
    let r_max_sq = r_max * r_max;

    while v_head < arena.zero_v_queue.len() || e_head < arena.zero_e_queue.len() {
        while v_head < arena.zero_v_queue.len() {
            let raw_id = arena.zero_v_queue[v_head];
            v_head += 1;
            arena.in_zero_v_queue[raw_id as usize] = 0;
            let v_id = resolve_canonical_vertex(&mut arena.v_parent, raw_id);
            let vu = v_id as usize;
            if arena.v_alive[vu] == 0 {
                continue;
            }

            let x = arena.vx[vu];
            let y = arena.vy[vu];
            let r = arena.vr[vu];
            let search_r = r + r_max;
            arena.vertex_grid.query_box(
                x - search_r,
                y - search_r,
                x + search_r,
                y + search_r,
                &mut arena.vertex_query_scratch,
            );

            let q_len = arena.vertex_query_scratch.len();
            for k in 0..q_len {
                let raw_other = arena.vertex_query_scratch[k];
                let other_id = resolve_canonical_vertex(&mut arena.v_parent, raw_other);
                let ou = other_id as usize;
                if other_id == v_id || arena.v_alive[ou] == 0 {
                    continue;
                }
                let dx = arena.vx[ou] - x;
                let dy = arena.vy[ou] - y;
                let d_sq = dx * dx + dy * dy;
                if d_sq > r_max_sq {
                    continue;
                }
                let rad_sum = r + arena.vr[ou];
                if d_sq <= rad_sum * rad_sum {
                    merge_vertex_pair(arena, v_id, other_id, r_max);
                    any_changed = true;
                    break;
                }
            }
        }

        while e_head < arena.zero_e_queue.len() {
            let e_id = arena.zero_e_queue[e_head] as usize;
            e_head += 1;
            arena.in_zero_e_queue[e_id] = 0;
            if arena.e_alive[e_id] == 0 {
                continue;
            }

            let c0 = resolve_canonical_vertex(&mut arena.v_parent, arena.ev0[e_id]);
            let c1 = resolve_canonical_vertex(&mut arena.v_parent, arena.ev1[e_id]);
            if c0 != arena.ev0[e_id] || c1 != arena.ev1[e_id] {
                arena.ev0[e_id] = c0;
                arena.ev1[e_id] = c1;
                update_edge_bounds(arena, e_id);
                any_changed = true;
            }
            if c0 == c1 {
                arena.e_alive[e_id] = 0;
                any_changed = true;
                continue;
            }

            let c0u = c0 as usize;
            let c1u = c1 as usize;
            let dx = arena.vx[c1u] - arena.vx[c0u];
            let dy = arena.vy[c1u] - arena.vy[c0u];
            let len_sq = dx * dx + dy * dy;
            let rad_sum = arena.vr[c0u] + arena.vr[c1u];
            if len_sq <= r_max_sq && len_sq <= rad_sum * rad_sum {
                arena.e_alive[e_id] = 0;
                merge_vertex_pair(arena, c0, c1, r_max);
                any_changed = true;
                continue;
            }

            if try_merge_coincident_with_incident(arena, e_id, body_count) {
                any_changed = true;
            }
        }
    }

    arena.zero_v_queue.clear();
    arena.zero_e_queue.clear();
    any_changed
}

#[inline]
fn record_split(arena: &mut KernelArena, edge_id: u32, t: f64, vertex_id: u32) {
    let eu = edge_id as usize;
    let head = arena.edge_split_head[eu];
    if head == -1 {
        arena.split_edge_list.push(edge_id);
    } else {
        let mut cur = head;
        while cur != -1 {
            let cu = cur as usize;
            if arena.split_vert[cu] == vertex_id {
                return;
            }
            cur = arena.split_next[cu];
        }
    }

    let s_idx = arena.split_count;
    if s_idx >= arena.split_t.len() {
        let next_cap = (arena.split_t.len().max(512)) << 1;
        arena.split_t.resize(next_cap, 0.0);
        arena.split_vert.resize(next_cap, 0);
        arena.split_next.resize(next_cap, -1);
    }
    arena.split_count = s_idx + 1;
    arena.split_t[s_idx] = t;
    arena.split_vert[s_idx] = vertex_id;
    arena.split_next[s_idx] = head;
    arena.edge_split_head[eu] = s_idx as i32;
}

fn apply_edge_splits(arena: &mut KernelArena, body_count: usize, mark_step_dirty: bool) -> bool {
    let num_split_edges = arena.split_edge_list.len();
    if num_split_edges == 0 {
        return false;
    }
    let mut any_split = false;

    let mut sort_t: [f64; 64] = [0.0; 64];
    let mut sort_v: [u32; 64] = [0; 64];
    let mut chain_v: [u32; 66] = [0; 66];
    let mut dw_scratch: [i32; 16] = [0; 16];

    for idx in 0..num_split_edges {
        let edge_id = arena.split_edge_list[idx] as usize;
        let mut head = arena.edge_split_head[edge_id];
        arena.edge_split_head[edge_id] = -1;
        if arena.e_alive[edge_id] == 0 || head == -1 {
            continue;
        }

        let mut count = 0usize;
        while head != -1 && count < 64 {
            let hu = head as usize;
            let t_val = arena.split_t[hu];
            let v_val = arena.split_vert[hu];
            let mut pos = count;
            while pos > 0 && sort_t[pos - 1] > t_val {
                sort_t[pos] = sort_t[pos - 1];
                sort_v[pos] = sort_v[pos - 1];
                pos -= 1;
            }
            sort_t[pos] = t_val;
            sort_v[pos] = v_val;
            count += 1;
            head = arena.split_next[hu];
        }

        let start_v = arena.ev0[edge_id];
        let end_v = arena.ev1[edge_id];
        chain_v[0] = start_v;
        let mut chain_len = 1usize;

        for i in 0..count {
            let vid = resolve_canonical_vertex(&mut arena.v_parent, sort_v[i]);
            if vid == end_v || vid == chain_v[chain_len - 1] {
                continue;
            }
            let mut dup = false;
            for j in 0..chain_len {
                if chain_v[j] == vid {
                    dup = true;
                    break;
                }
            }
            if !dup {
                chain_v[chain_len] = vid;
                chain_len += 1;
            }
        }
        chain_v[chain_len] = end_v;
        chain_len += 1;

        if chain_len <= 2 {
            continue;
        }

        arena.e_alive[edge_id] = 0;
        any_split = true;

        let base = edge_id * body_count;
        for b in 0..body_count {
            dw_scratch[b] = arena.e_delta_w[base + b];
        }

        for i in 0..(chain_len - 1) {
            let u = chain_v[i];
            let v = chain_v[i + 1];
            if u == v {
                continue;
            }
            let new_id = arena.edge_count;
            if new_id >= arena.ev0.len() || (new_id + 1) * body_count > arena.e_delta_w.len() {
                arena.ensure_edge_capacity(new_id + 1, body_count);
            }
            arena.edge_count = new_id + 1;
            arena.ev0[new_id] = u;
            arena.ev1[new_id] = v;
            arena.e_alive[new_id] = 1;
            arena.in_zero_e_queue[new_id] = 0;
            arena.in_step_e_queue[new_id] = 0;
            arena.edge_split_head[new_id] = -1;

            let new_base = new_id * body_count;
            for b in 0..body_count {
                arena.e_delta_w[new_base + b] = dw_scratch[b];
            }
            update_edge_bounds(arena, new_id);
            let new_id_u32 = new_id as u32;
            link_incident_edge(arena, u, new_id_u32);
            link_incident_edge(arena, v, new_id_u32);
            if mark_step_dirty {
                mark_edge_dirty(arena, new_id_u32);
            } else if arena.in_zero_e_queue[new_id] == 0 {
                arena.in_zero_e_queue[new_id] = 1;
                arena.zero_e_queue.push(new_id_u32);
            }
        }
    }

    arena.split_count = 0;
    arena.split_edge_list.clear();
    any_split
}

fn build_sorted_active_edges(arena: &mut KernelArena) -> usize {
    let total_edges = arena.edge_count;
    let mut count = 0usize;
    for e_id in 0..total_edges {
        if arena.e_alive[e_id] != 0 {
            arena.sorted_edges[count] = e_id as u32;
            count += 1;
        }
    }
    sort_indices_by_f64(&mut arena.sorted_edges[..count], &arena.e_min_x);
    count
}

fn build_sorted_active_verts(arena: &mut KernelArena) -> usize {
    let total_verts = arena.vertex_count;
    let mut count = 0usize;
    for v_id in 0..total_verts {
        if arena.v_alive[v_id] != 0 {
            arena.sorted_verts[count] = v_id as u32;
            count += 1;
        }
    }
    sort_indices_by_f64(&mut arena.sorted_verts[..count], &arena.vx);
    count
}

/// Normalize raw segments in `arena.raw_segments[0..seg_count*5]` and store into `prep_*` buffers.
pub fn prepare_normalized_segments(arena: &mut KernelArena, seg_count: usize, user_snap_tol: f64) {
    arena.prep_count = seg_count;
    if seg_count == 0 {
        arena.prep_cx = 0.0;
        arena.prep_cy = 0.0;
        arena.prep_r0 = 1e-9;
        arena.prep_rmax = 2e-9;
        arena.prep_cell_size = 1.0;
        arena.prep_body_count = 2;
        return;
    }

    if arena.prep_x0.len() < seg_count {
        arena.prep_x0.resize(seg_count, 0.0);
        arena.prep_y0.resize(seg_count, 0.0);
        arena.prep_x1.resize(seg_count, 0.0);
        arena.prep_y1.resize(seg_count, 0.0);
        arena.prep_body.resize(seg_count, 0);
    }

    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;
    let mut max_body = 0usize;

    for i in 0..seg_count {
        let base = i * 5;
        let x0 = arena.raw_segments[base];
        let y0 = arena.raw_segments[base + 1];
        let x1 = arena.raw_segments[base + 2];
        let y1 = arena.raw_segments[base + 3];
        let b = arena.raw_segments[base + 4] as usize;
        if b > max_body {
            max_body = b;
        }
        min_x = min_x.min(x0).min(x1);
        min_y = min_y.min(y0).min(y1);
        max_x = max_x.max(x0).max(x1);
        max_y = max_y.max(y0).max(y1);
    }

    let cx = 0.5 * (min_x + max_x);
    let cy = 0.5 * (min_y + max_y);
    let diagonal = ((max_x - min_x) * (max_x - min_x) + (max_y - min_y) * (max_y - min_y)).sqrt();
    let scale = diagonal.max(1.0);
    let numerical_floor = 1e-9 * scale;

    let (r0, r_max) = if user_snap_tol >= 0.0 {
        let r = user_snap_tol.max(numerical_floor);
        (r, r * 2.0)
    } else {
        (numerical_floor, numerical_floor * 4.0)
    };

    let r0_sq = r0 * r0;
    let mut total_manhattan = 0.0;
    let mut non_zero_count = 0usize;

    for i in 0..seg_count {
        let base = i * 5;
        let x0 = arena.raw_segments[base] - cx;
        let y0 = arena.raw_segments[base + 1] - cy;
        let x1 = arena.raw_segments[base + 2] - cx;
        let y1 = arena.raw_segments[base + 3] - cy;
        let b = arena.raw_segments[base + 4] as u8;
        arena.prep_x0[i] = x0;
        arena.prep_y0[i] = y0;
        arena.prep_x1[i] = x1;
        arena.prep_y1[i] = y1;
        arena.prep_body[i] = b;
        let dx = x1 - x0;
        let dy = y1 - y0;
        if dx * dx + dy * dy > r0_sq {
            total_manhattan += dx.abs() + dy.abs();
            non_zero_count += 1;
        }
    }

    let mean_len = if non_zero_count > 0 {
        (0.75 * total_manhattan) / (non_zero_count as f64)
    } else {
        scale
    };
    let target_grid_dim = ((seg_count * 4) as f64).sqrt().max(8.0);
    let bbox_cell = if diagonal > 0.0 {
        diagonal / target_grid_dim
    } else {
        1.0
    };
    let cell_size = (r0 * 16.0).max((mean_len * 0.5).min(bbox_cell)).max(1e-6 * scale);

    arena.prep_cx = cx;
    arena.prep_cy = cy;
    arena.prep_r0 = r0;
    arena.prep_rmax = r_max;
    arena.prep_cell_size = cell_size;
    arena.prep_body_count = (max_body + 1).max(2);
}

/// Stage 1 & 2: Consolidate the prepared normalized segments into a 2D Stratified Tolerance Complex.
pub fn consolidate_prepared(arena: &mut KernelArena) {
    let seg_count = arena.prep_count;
    let r0 = arena.prep_r0;
    let r_max = arena.prep_rmax;
    let cell_size = arena.prep_cell_size;
    let body_count = arena.prep_body_count;

    let initial_cap = (seg_count * 2 + 16).max(64);
    arena.vertex_count = 0;
    arena.edge_count = 0;
    arena.inc_count = 0;
    arena.split_count = 0;
    arena.split_edge_list.clear();

    arena.ensure_vertex_capacity(initial_cap);
    arena.ensure_edge_capacity(initial_cap, body_count);
    arena.ensure_inc_capacity(initial_cap * 2);

    let initial_vertex_radius = 0.5 * r0;
    arena.vertex_grid.reset(cell_size, initial_cap);

    arena.zero_v_queue.clear();
    arena.zero_e_queue.clear();
    arena.step_v_queue.clear();
    arena.step_e_queue.clear();

    // Stage 1: Inject normalized segments with consecutive loop-vertex chaining
    let mut prev_x = f64::NAN;
    let mut prev_y = f64::NAN;
    let mut prev_v = u32::MAX;
    let mut loop_start_x = f64::NAN;
    let mut loop_start_y = f64::NAN;
    let mut loop_start_v = u32::MAX;

    for i in 0..seg_count {
        let x0 = arena.prep_x0[i];
        let y0 = arena.prep_y0[i];
        let x1 = arena.prep_x1[i];
        let y1 = arena.prep_y1[i];
        let b = arena.prep_body[i] as usize;

        let v0 = if x0 == prev_x
            && y0 == prev_y
            && prev_v != u32::MAX
            && arena.v_alive[prev_v as usize] != 0
        {
            arena.v_weight[prev_v as usize] += 1;
            prev_v
        } else {
            let v = find_or_create_vertex(arena, x0, y0, initial_vertex_radius, r_max, true);
            loop_start_x = x0;
            loop_start_y = y0;
            loop_start_v = v;
            v
        };

        let v1 = if x1 == loop_start_x
            && y1 == loop_start_y
            && loop_start_v != u32::MAX
            && arena.v_alive[loop_start_v as usize] != 0
        {
            arena.v_weight[loop_start_v as usize] += 1;
            prev_v = u32::MAX;
            loop_start_v
        } else {
            let v = find_or_create_vertex(arena, x1, y1, initial_vertex_radius, r_max, true);
            prev_x = x1;
            prev_y = y1;
            prev_v = v;
            v
        };

        if v0 == v1 {
            continue;
        }
        create_edge_single_body(arena, v0, v1, b, body_count);
    }

    for iter in 0..64 {
        let mut iter_changed = false;

        if drain_zero_strata(arena, r_max, body_count) {
            iter_changed = true;
        }

        if arena.step_v_queue.is_empty() && arena.step_e_queue.is_empty() {
            break;
        }

        let mut step_stamp = arena.crossing_stamp_gen.wrapping_add(1);
        if step_stamp == 0 {
            arena.edge_crossing_stamp.fill(0);
            arena.vert_step_stamp.fill(0);
            step_stamp = 1;
        }
        arena.crossing_stamp_gen = step_stamp;

        arena.dirty_verts.clear();
        for i in 0..arena.step_v_queue.len() {
            let raw_v = arena.step_v_queue[i];
            arena.in_step_v_queue[raw_v as usize] = 0;
            let v_id = resolve_canonical_vertex(&mut arena.v_parent, raw_v);
            let vu = v_id as usize;
            if arena.v_alive[vu] != 0 && arena.vert_step_stamp[vu] != step_stamp {
                arena.vert_step_stamp[vu] = step_stamp;
                arena.dirty_verts.push(v_id);
            }
        }
        arena.step_v_queue.clear();

        arena.dirty_edges.clear();
        for i in 0..arena.step_e_queue.len() {
            let e_id = arena.step_e_queue[i];
            let eu = e_id as usize;
            arena.in_step_e_queue[eu] = 0;
            if arena.e_alive[eu] != 0 {
                arena.edge_crossing_stamp[eu] = step_stamp;
                arena.dirty_edges.push(e_id);
            }
        }
        arena.step_e_queue.clear();

        let mut active_edge_count = build_sorted_active_edges(arena);

        // Operator 3a & 3b: Unified Two-Pointer 1D X-Sweep between sorted_edges and sorted_verts
        if !arena.dirty_verts.is_empty() || (iter > 0 && !arena.dirty_edges.is_empty()) {
            let active_vert_count = build_sorted_active_verts(arena);
            let max_tol = r_max + initial_vertex_radius;
            let has_dirty_verts = !arena.dirty_verts.is_empty();
            let mut dv_min_x = f64::INFINITY;
            let mut dv_max_x = f64::NEG_INFINITY;
            let mut dv_min_y = f64::INFINITY;
            let mut dv_max_y = f64::NEG_INFINITY;
            if iter > 0 && has_dirty_verts {
                for &dv in &arena.dirty_verts {
                    let dvu = dv as usize;
                    let x = arena.vx[dvu];
                    let y = arena.vy[dvu];
                    dv_min_x = dv_min_x.min(x);
                    dv_max_x = dv_max_x.max(x);
                    dv_min_y = dv_min_y.min(y);
                    dv_max_y = dv_max_y.max(y);
                }
            }
            let mut v_start = 0usize;

            for i in 0..active_edge_count {
                let edge_id = arena.sorted_edges[i];
                let eu = edge_id as usize;
                let edge_dirty = iter == 0 || arena.edge_crossing_stamp[eu] == step_stamp;
                if !edge_dirty {
                    if !has_dirty_verts {
                        continue;
                    }
                    if arena.e_max_x[eu] + max_tol < dv_min_x
                        || arena.e_min_x[eu] - max_tol > dv_max_x
                        || arena.e_max_y[eu] + max_tol < dv_min_y
                        || arena.e_min_y[eu] - max_tol > dv_max_y
                    {
                        continue;
                    }
                }
                let x_start = arena.e_min_x[eu] - max_tol;

                while v_start < active_vert_count
                    && arena.vx[arena.sorted_verts[v_start] as usize] < x_start
                {
                    v_start += 1;
                }

                let x_end = arena.e_max_x[eu] + max_tol;
                let min_y = arena.e_min_y[eu];
                let max_y = arena.e_max_y[eu];
                let u = arena.ev0[eu];
                let v = arena.ev1[eu];
                let ax = arena.vx[u as usize];
                let ay = arena.vy[u as usize];
                let bx = arena.vx[v as usize];
                let by = arena.vy[v as usize];

                for k in v_start..active_vert_count {
                    let v_id = arena.sorted_verts[k];
                    let vu = v_id as usize;
                    let px = arena.vx[vu];
                    if px > x_end {
                        break;
                    }
                    if !edge_dirty && arena.vert_step_stamp[vu] != step_stamp {
                        continue;
                    }
                    if v_id == u || v_id == v {
                        continue;
                    }
                    let tol = arena.vr[vu] + initial_vertex_radius;
                    let py = arena.vy[vu];
                    if py < min_y - tol || py > max_y + tol {
                        continue;
                    }
                    let t = project_point_to_segment_t(px, py, ax, ay, bx, by, tol);
                    if t > 0.0 {
                        record_split(arena, edge_id, t, v_id);
                    }
                }
            }
        }

        if apply_edge_splits(arena, body_count, true) {
            iter_changed = true;
            drain_zero_strata(arena, r_max, body_count);
            for i in 0..arena.step_e_queue.len() {
                let e_id = arena.step_e_queue[i];
                let eu = e_id as usize;
                arena.in_step_e_queue[eu] = 0;
                if arena.e_alive[eu] != 0 {
                    arena.edge_crossing_stamp[eu] = step_stamp;
                    arena.dirty_edges.push(e_id);
                }
            }
            arena.step_e_queue.clear();
            for i in 0..arena.step_v_queue.len() {
                let v_id = arena.step_v_queue[i] as usize;
                arena.in_step_v_queue[v_id] = 0;
            }
            arena.step_v_queue.clear();
            active_edge_count = build_sorted_active_edges(arena);
        }

        // Operator 4b: Interior Segment-Segment Crossings via 1D X-Sweep over sorted_edges
        if !arena.dirty_edges.is_empty() {
            let mut de_min_x = f64::INFINITY;
            let mut de_max_x = f64::NEG_INFINITY;
            let mut de_min_y = f64::INFINITY;
            let mut de_max_y = f64::NEG_INFINITY;
            if iter > 0 {
                for &de in &arena.dirty_edges {
                    let deu = de as usize;
                    if arena.e_alive[deu] == 0 {
                        continue;
                    }
                    de_min_x = de_min_x.min(arena.e_min_x[deu]);
                    de_max_x = de_max_x.max(arena.e_max_x[deu]);
                    de_min_y = de_min_y.min(arena.e_min_y[deu]);
                    de_max_y = de_max_y.max(arena.e_max_y[deu]);
                }
            }

            for i in 0..active_edge_count {
                let e1_id = arena.sorted_edges[i];
                let e1u = e1_id as usize;
                if arena.e_alive[e1u] == 0 {
                    continue;
                }
                let e1_dirty = iter == 0 || arena.edge_crossing_stamp[e1u] == step_stamp;
                if !e1_dirty {
                    if arena.e_min_x[e1u] - r0 > de_max_x {
                        break;
                    }
                    if arena.e_max_x[e1u] + r0 < de_min_x
                        || arena.e_max_y[e1u] + r0 < de_min_y
                        || arena.e_min_y[e1u] - r0 > de_max_y
                    {
                        continue;
                    }
                }
                let max_x1 = arena.e_max_x[e1u] + r0;
                let min_y1 = arena.e_min_y[e1u] - r0;
                let max_y1 = arena.e_max_y[e1u] + r0;
                let e1v0 = arena.ev0[e1u];
                let e1v1 = arena.ev1[e1u];
                let ax = arena.vx[e1v0 as usize];
                let ay = arena.vy[e1v0 as usize];
                let bx = arena.vx[e1v1 as usize];
                let by = arena.vy[e1v1 as usize];

                for j in (i + 1)..active_edge_count {
                    let e2_id = arena.sorted_edges[j];
                    let e2u = e2_id as usize;
                    if arena.e_min_x[e2u] > max_x1 {
                        break;
                    }
                    if arena.e_alive[e2u] == 0 {
                        continue;
                    }
                    if !e1_dirty && arena.edge_crossing_stamp[e2u] != step_stamp {
                        continue;
                    }
                    if arena.e_max_y[e2u] < min_y1 || arena.e_min_y[e2u] > max_y1 {
                        continue;
                    }
                    let e2v0 = arena.ev0[e2u];
                    let e2v1 = arena.ev1[e2u];
                    if e1v0 == e2v0 || e1v0 == e2v1 || e1v1 == e2v0 || e1v1 == e2v1 {
                        continue;
                    }

                    if let Some((hit_s, hit_t, hit_x, hit_y)) = intersect_segments_interior_fast(
                        ax,
                        ay,
                        bx,
                        by,
                        arena.vx[e2v0 as usize],
                        arena.vy[e2v0 as usize],
                        arena.vx[e2v1 as usize],
                        arena.vy[e2v1 as usize],
                        r0,
                    ) {
                        let v_int = find_or_create_vertex(
                            arena,
                            hit_x,
                            hit_y,
                            initial_vertex_radius,
                            r_max,
                            false,
                        );
                        if v_int != e1v0 && v_int != e1v1 {
                            record_split(arena, e1_id, hit_s, v_int);
                        }
                        if v_int != e2v0 && v_int != e2v1 {
                            record_split(arena, e2_id, hit_t, v_int);
                        }
                    }
                }
            }

            if apply_edge_splits(arena, body_count, false) {
                iter_changed = true;
            }
        }

        if !iter_changed && arena.step_v_queue.is_empty() && arena.step_e_queue.is_empty() {
            break;
        }
    }

    drain_zero_strata(arena, r_max, body_count);
}
