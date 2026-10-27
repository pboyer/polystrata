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
#[allow(clippy::too_many_arguments)]
fn intersect_segments_interior_fast(
    ax: f64,
    ay: f64,
    rx: f64,
    ry: f64,
    len_r_sq: f64,
    cx: f64,
    cy: f64,
    dx: f64,
    dy: f64,
    r0: f64,
) -> Option<(f64, f64, f64, f64)> {
    let sx = dx - cx;
    let sy = dy - cy;
    let denom = rx * sy - ry * sx;
    if denom == 0.0 {
        return None;
    }

    let qpx = cx - ax;
    let qpy = cy - ay;
    let half_denom = 0.5 * denom;
    let half_abs = 0.5 * denom.abs();
    let ds_num = (qpx * sy - qpy * sx - half_denom).abs() - half_abs;
    if ds_num > half_abs {
        return None;
    }
    let dt_num = (qpx * ry - qpy * rx - half_denom).abs() - half_abs;
    if dt_num > half_abs {
        return None;
    }

    let len_s_sq = sx * sx + sy * sy;
    let len_scale_sq = len_r_sq * len_s_sq;
    let denom_sq = denom * denom;
    if len_scale_sq == 0.0 || denom_sq <= 1e-30 * len_scale_sq {
        return None;
    }

    if ds_num < 0.0 && dt_num < 0.0 {
        let inv_denom = 1.0 / denom;
        let s_raw = (qpx * sy - qpy * sx) * inv_denom;
        let t_raw = (qpx * ry - qpy * rx) * inv_denom;
        let hx = ax + 0.5 * (s_raw * rx + (qpx + t_raw * sx));
        let hy = ay + 0.5 * (s_raw * ry + (qpy + t_raw * sy));
        return Some((s_raw, t_raw, hx, hy));
    }

    let r0_sq = r0 * r0;
    let r0_denom_sq = r0_sq * denom_sq;
    if (ds_num <= 0.0 || ds_num * ds_num * len_r_sq < r0_denom_sq)
        && (dt_num <= 0.0 || dt_num * dt_num * len_s_sq < r0_denom_sq)
    {
        let inv_denom = 1.0 / denom;
        let s_raw = (qpx * sy - qpy * sx) * inv_denom;
        let t_raw = (qpx * ry - qpy * rx) * inv_denom;
        let s = s_raw.clamp(1e-7, 1.0 - 1e-7);
        let t = t_raw.clamp(1e-7, 1.0 - 1e-7);
        let px = ax + s * rx;
        let py = ay + s * ry;
        let qx = cx + t * sx;
        let qy = cy + t * sy;
        let ddx = px - qx;
        let ddy = py - qy;
        if ddx * ddx + ddy * ddy <= r0_sq {
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
fn has_coincident_incident_edge(arena: &KernelArena, v0: u32, v1: u32) -> bool {
    let mut node = arena.v_first_inc[v0 as usize];
    while node != -1 {
        let nu = node as usize;
        let other_id = arena.inc_edge[nu] as usize;
        node = arena.inc_next[nu];
        if arena.e_alive[other_id] == 0 {
            continue;
        }
        let ov0 = arena.ev0[other_id];
        let ov1 = arena.ev1[other_id];
        if (ov0 == v0 && ov1 == v1) || (ov0 == v1 && ov1 == v0) {
            return true;
        }
    }
    false
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
    let need_zero = if arena.v_first_inc[v0 as usize] != -1 && arena.v_first_inc[v1 as usize] != -1
    {
        has_coincident_incident_edge(arena, v0, v1)
    } else {
        false
    };
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

    let u = v0 as usize;
    let v = v1 as usize;
    let x0 = arena.vx[u];
    let y0 = arena.vy[u];
    let x1 = arena.vx[v];
    let y1 = arena.vy[v];
    arena.e_min_x[id] = x0.min(x1);
    arena.e_min_y[id] = y0.min(y1);
    arena.e_max_x[id] = x0.max(x1);
    arena.e_max_y[id] = y0.max(y1);

    let dx = x1 - x0;
    let dy = y1 - y0;
    let rad_sum = arena.vr[u] + arena.vr[v];
    let is_short = dx * dx + dy * dy <= rad_sum * rad_sum;

    let eid_u32 = id as u32;
    link_incident_edge(arena, v0, eid_u32);
    link_incident_edge(arena, v1, eid_u32);
    if need_zero
        || is_short
        || arena.in_zero_v_queue[u] != 0
        || arena.in_zero_v_queue[v] != 0
    {
        mark_edge_dirty(arena, eid_u32);
    } else {
        arena.in_step_e_queue[id] = 1;
        arena.step_e_queue.push(eid_u32);
    }
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
    } else if arena.split_vert[head as usize] == vertex_id {
        return;
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

    for idx in 0..num_split_edges {
        let edge_id = arena.split_edge_list[idx] as usize;
        let mut head = arena.edge_split_head[edge_id];
        arena.edge_split_head[edge_id] = -1;
        if arena.e_alive[edge_id] == 0 || head == -1 {
            continue;
        }

        arena.split_scratch.clear();
        while head != -1 {
            let hu = head as usize;
            arena
                .split_scratch
                .push((arena.split_t[hu], arena.split_vert[hu]));
            head = arena.split_next[hu];
        }

        let count = arena.split_scratch.len();
        if count <= 24 {
            for i in 1..count {
                let item = arena.split_scratch[i];
                let mut pos = i;
                while pos > 0 && arena.split_scratch[pos - 1].0 > item.0 {
                    arena.split_scratch[pos] = arena.split_scratch[pos - 1];
                    pos -= 1;
                }
                arena.split_scratch[pos] = item;
            }
        } else {
            arena.split_scratch.sort_unstable_by(|a, b| {
                a.0.partial_cmp(&b.0).unwrap_or(core::cmp::Ordering::Equal)
            });
        }

        let start_v = arena.ev0[edge_id];
        let end_v = arena.ev1[edge_id];
        arena.chain_scratch.clear();
        arena.chain_scratch.push(start_v);

        for i in 0..count {
            let raw_v = arena.split_scratch[i].1;
            let vid = resolve_canonical_vertex(&mut arena.v_parent, raw_v);
            if vid == end_v || vid == *arena.chain_scratch.last().unwrap() {
                continue;
            }
            if !arena.chain_scratch.contains(&vid) {
                arena.chain_scratch.push(vid);
            }
        }
        arena.chain_scratch.push(end_v);

        let chain_len = arena.chain_scratch.len();
        if chain_len <= 2 {
            continue;
        }

        arena.e_alive[edge_id] = 0;
        any_split = true;

        let base = edge_id * body_count;

        for i in 0..(chain_len - 1) {
            let u = arena.chain_scratch[i];
            let v = arena.chain_scratch[i + 1];
            if u == v {
                continue;
            }
            let new_id = arena.edge_count;
            if new_id >= arena.ev0.len() || (new_id + 1) * body_count > arena.e_delta_w.len() {
                arena.ensure_edge_capacity(new_id + 1, body_count);
            }
            let need_zero = if !mark_step_dirty {
                if arena.v_first_inc[u as usize] != -1 && arena.v_first_inc[v as usize] != -1 {
                    has_coincident_incident_edge(arena, u, v)
                } else {
                    false
                }
            } else {
                true
            };
            arena.edge_count = new_id + 1;
            arena.ev0[new_id] = u;
            arena.ev1[new_id] = v;
            arena.e_alive[new_id] = 1;
            arena.in_zero_e_queue[new_id] = 0;
            arena.in_step_e_queue[new_id] = 0;
            arena.edge_split_head[new_id] = -1;

            let new_base = new_id * body_count;
            for b in 0..body_count {
                arena.e_delta_w[new_base + b] = arena.e_delta_w[base + b];
            }
            let uu = u as usize;
            let vu = v as usize;
            let x0 = arena.vx[uu];
            let y0 = arena.vy[uu];
            let x1 = arena.vx[vu];
            let y1 = arena.vy[vu];
            arena.e_min_x[new_id] = x0.min(x1);
            arena.e_min_y[new_id] = y0.min(y1);
            arena.e_max_x[new_id] = x0.max(x1);
            arena.e_max_y[new_id] = y0.max(y1);

            let new_id_u32 = new_id as u32;
            link_incident_edge(arena, u, new_id_u32);
            link_incident_edge(arena, v, new_id_u32);
            if mark_step_dirty {
                mark_edge_dirty(arena, new_id_u32);
            } else {
                let dx = x1 - x0;
                let dy = y1 - y0;
                let rad_sum = arena.vr[uu] + arena.vr[vu];
                let is_short = dx * dx + dy * dy <= rad_sum * rad_sum;
                if need_zero
                    || is_short
                    || arena.in_zero_v_queue[uu] != 0
                    || arena.in_zero_v_queue[vu] != 0
                {
                    if arena.in_zero_e_queue[new_id] == 0 {
                        arena.in_zero_e_queue[new_id] = 1;
                        arena.zero_e_queue.push(new_id_u32);
                    }
                }
            }
        }
    }

    arena.split_count = 0;
    arena.split_edge_list.clear();
    any_split
}

fn populate_sorted_edge_bounds(arena: &mut KernelArena, count: usize) {
    for i in 0..count {
        let eu = unsafe { *arena.sorted_edges.get_unchecked(i) } as usize;
        unsafe {
            *arena.se_min_x.get_unchecked_mut(i) = *arena.e_min_x.get_unchecked(eu);
            *arena.se_min_y.get_unchecked_mut(i) = *arena.e_min_y.get_unchecked(eu);
            *arena.se_max_y.get_unchecked_mut(i) = *arena.e_max_y.get_unchecked(eu);
            let v0 = *arena.ev0.get_unchecked(eu);
            let v1 = *arena.ev1.get_unchecked(eu);
            *arena.se_v0.get_unchecked_mut(i) = v0;
            *arena.se_v1.get_unchecked_mut(i) = v1;
            *arena.se_x0.get_unchecked_mut(i) = *arena.vx.get_unchecked(v0 as usize);
            *arena.se_y0.get_unchecked_mut(i) = *arena.vy.get_unchecked(v0 as usize);
            *arena.se_x1.get_unchecked_mut(i) = *arena.vx.get_unchecked(v1 as usize);
            *arena.se_y1.get_unchecked_mut(i) = *arena.vy.get_unchecked(v1 as usize);
        }
    }
}

fn populate_sorted_vert_coords(arena: &mut KernelArena, count: usize) {
    for i in 0..count {
        let vu = unsafe { *arena.sorted_verts.get_unchecked(i) } as usize;
        unsafe {
            *arena.sv_x.get_unchecked_mut(i) = *arena.vx.get_unchecked(vu);
            *arena.sv_y.get_unchecked_mut(i) = *arena.vy.get_unchecked(vu);
        }
    }
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
    populate_sorted_edge_bounds(arena, count);
    count
}

fn build_sorted_active_edges_in_box(
    arena: &mut KernelArena,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
) -> usize {
    let total_edges = arena.edge_count;
    let mut count = 0usize;
    for e_id in 0..total_edges {
        if arena.e_alive[e_id] != 0
            && arena.e_max_x[e_id] >= min_x
            && arena.e_min_x[e_id] <= max_x
            && arena.e_max_y[e_id] >= min_y
            && arena.e_min_y[e_id] <= max_y
        {
            arena.sorted_edges[count] = e_id as u32;
            count += 1;
        }
    }
    sort_indices_by_f64(&mut arena.sorted_edges[..count], &arena.e_min_x);
    populate_sorted_edge_bounds(arena, count);
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
    populate_sorted_vert_coords(arena, count);
    count
}

fn build_sorted_active_verts_in_box(
    arena: &mut KernelArena,
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
) -> usize {
    let total_verts = arena.vertex_count;
    let mut count = 0usize;
    for v_id in 0..total_verts {
        if arena.v_alive[v_id] != 0 {
            let x = arena.vx[v_id];
            let y = arena.vy[v_id];
            if x >= min_x && x <= max_x && y >= min_y && y <= max_y {
                arena.sorted_verts[count] = v_id as u32;
                count += 1;
            }
        }
    }
    sort_indices_by_f64(&mut arena.sorted_verts[..count], &arena.vx);
    populate_sorted_vert_coords(arena, count);
    count
}

/// Bounding-box diagonal above which Stage 0 rescales coordinates by an exact power of two.
const LARGE_INPUT_DIAGONAL: f64 = 3.402823669209385e38; // 2^128

/// Normalize raw segments in `arena.raw_segments[0..seg_count*5]` and store into `prep_*` buffers.
///
/// Segments with a non-finite (`NaN` / `±Infinity`) coordinate are dropped, and the bounding box,
/// center, and diagonal are computed without intermediate overflow so that coordinates near
/// `f64::MAX` still yield finite tolerances and grid cell sizes.
pub fn prepare_normalized_segments(arena: &mut KernelArena, seg_count: usize, user_snap_tol: f64) {
    arena.prep_count = 0;
    if seg_count == 0 {
        set_empty_preparation(arena, 2);
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
    let mut kept = 0usize;

    for i in 0..seg_count {
        let base = i * 5;
        let x0 = arena.raw_segments[base];
        let y0 = arena.raw_segments[base + 1];
        let x1 = arena.raw_segments[base + 2];
        let y1 = arena.raw_segments[base + 3];
        // Body count includes bodies whose segments are all dropped, so N-ary predicates still see them.
        let b = arena.raw_segments[base + 4] as usize;
        if b > max_body {
            max_body = b;
        }
        if !(x0.is_finite() && y0.is_finite() && x1.is_finite() && y1.is_finite()) {
            continue;
        }
        min_x = min_x.min(x0).min(x1);
        min_y = min_y.min(y0).min(y1);
        max_x = max_x.max(x0).max(x1);
        max_y = max_y.max(y0).max(y1);
        arena.prep_x0[kept] = x0;
        arena.prep_y0[kept] = y0;
        arena.prep_x1[kept] = x1;
        arena.prep_y1[kept] = y1;
        arena.prep_body[kept] = b as u32;
        kept += 1;
    }

    let body_count = (max_body + 1).max(2);
    if kept == 0 {
        set_empty_preparation(arena, body_count);
        return;
    }

    // Halve before combining so neither the center nor the half-extents can overflow.
    let cx = 0.5 * min_x + 0.5 * max_x;
    let cy = 0.5 * min_y + 0.5 * max_y;
    let half_w = 0.5 * max_x - 0.5 * min_x;
    let half_h = 0.5 * max_y - 0.5 * min_y;
    let diagonal = (2.0 * half_w.hypot(half_h)).min(f64::MAX);

    // Products of squared lengths overflow once extents pass ~1e77, so astronomically large inputs
    // are mapped by an exact power of two to a unit-sized diagonal. Every tolerance below is
    // relative to the diagonal in that regime, so results are scale-equivariant; ordinary inputs
    // (diagonal <= 2^128) keep a scale of exactly 1.0 and are unaffected.
    let (scale_factor, inv_scale) = if diagonal > LARGE_INPUT_DIAGONAL {
        // Exact binary exponent (diagonal is normal here); `log2` rounds f64::MAX up to 1024.
        let k = ((diagonal.to_bits() >> 52) & 0x7ff) as i32 - 1023;
        (2f64.powi(-k), 2f64.powi(k))
    } else {
        (1.0, 1.0)
    };
    let scaled_diagonal = diagonal * scale_factor;
    let scale = scaled_diagonal.max(1.0);
    let numerical_floor = 1e-9 * scale;

    let (r0, r_max) = if user_snap_tol >= 0.0 && user_snap_tol.is_finite() {
        let r = (user_snap_tol * scale_factor).max(numerical_floor);
        (r, r * 2.0)
    } else {
        (numerical_floor, numerical_floor * 4.0)
    };

    // Scale before subtracting so the shift cannot overflow; both steps are exact for powers of two.
    let (scx, scy) = (cx * scale_factor, cy * scale_factor);
    for i in 0..kept {
        arena.prep_x0[i] = arena.prep_x0[i] * scale_factor - scx;
        arena.prep_y0[i] = arena.prep_y0[i] * scale_factor - scy;
        arena.prep_x1[i] = arena.prep_x1[i] * scale_factor - scx;
        arena.prep_y1[i] = arena.prep_y1[i] * scale_factor - scy;
    }

    let cell_size = (r0 * 16.0).max(r_max * 8.0).max(1e-6 * scale);

    arena.prep_count = kept;
    arena.prep_cx = cx;
    arena.prep_cy = cy;
    arena.prep_inv_scale = inv_scale;
    arena.prep_diagonal = diagonal;
    arena.prep_r0 = r0;
    arena.prep_rmax = r_max;
    arena.prep_cell_size = cell_size;
    arena.prep_body_count = body_count;
}

fn set_empty_preparation(arena: &mut KernelArena, body_count: usize) {
    arena.prep_count = 0;
    arena.prep_cx = 0.0;
    arena.prep_cy = 0.0;
    arena.prep_diagonal = 0.0;
    arena.prep_r0 = 1e-9;
    arena.prep_rmax = 2e-9;
    arena.prep_cell_size = 1.0;
    arena.prep_inv_scale = 1.0;
    arena.prep_body_count = body_count;
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

        let max_tol = r_max + initial_vertex_radius;
        let pad = max_tol + r0;
        let mut act_min_x = f64::INFINITY;
        let mut act_max_x = f64::NEG_INFINITY;
        let mut act_min_y = f64::INFINITY;
        let mut act_max_y = f64::NEG_INFINITY;
        if iter > 0 {
            for &dv in &arena.dirty_verts {
                let dvu = dv as usize;
                let x = arena.vx[dvu];
                let y = arena.vy[dvu];
                act_min_x = act_min_x.min(x);
                act_max_x = act_max_x.max(x);
                act_min_y = act_min_y.min(y);
                act_max_y = act_max_y.max(y);
            }
            for &de in &arena.dirty_edges {
                let deu = de as usize;
                if arena.e_alive[deu] == 0 {
                    continue;
                }
                act_min_x = act_min_x.min(arena.e_min_x[deu]);
                act_max_x = act_max_x.max(arena.e_max_x[deu]);
                act_min_y = act_min_y.min(arena.e_min_y[deu]);
                act_max_y = act_max_y.max(arena.e_max_y[deu]);
            }
            act_min_x -= pad;
            act_max_x += pad;
            act_min_y -= pad;
            act_max_y += pad;
        }
        let mut active_edge_count = if iter == 0 {
            build_sorted_active_edges(arena)
        } else {
            build_sorted_active_edges_in_box(arena, act_min_x, act_max_x, act_min_y, act_max_y)
        };

        // Operator 3a & 3b: Unified Two-Pointer 1D X-Sweep between sorted_edges and sorted_verts
        if !arena.dirty_verts.is_empty() || (iter > 0 && !arena.dirty_edges.is_empty()) {
            let active_vert_count = if iter == 0 {
                build_sorted_active_verts(arena)
            } else {
                build_sorted_active_verts_in_box(arena, act_min_x, act_max_x, act_min_y, act_max_y)
            };
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
                let x_start = arena.se_min_x[i] - max_tol;

                while v_start < active_vert_count
                    && unsafe { *arena.sv_x.get_unchecked(v_start) } < x_start
                {
                    v_start += 1;
                }

                let x_end = arena.e_max_x[eu] + max_tol;
                let min_y_pad = arena.se_min_y[i] - max_tol;
                let max_y_pad = arena.se_max_y[i] + max_tol;
                let u = arena.ev0[eu];
                let v = arena.ev1[eu];
                let ax = arena.vx[u as usize];
                let ay = arena.vy[u as usize];
                let bx = arena.vx[v as usize];
                let by = arena.vy[v as usize];
                let dx = bx - ax;
                let dy = by - ay;
                let len_sq = dx * dx + dy * dy;
                if len_sq == 0.0 {
                    continue;
                }
                let inv_len_sq = 1.0 / len_sq;
                let max_cross_sq = (max_tol * max_tol) * len_sq;

                for k in v_start..active_vert_count {
                    let px = unsafe { *arena.sv_x.get_unchecked(k) };
                    if px > x_end {
                        break;
                    }
                    let py = unsafe { *arena.sv_y.get_unchecked(k) };
                    if py < min_y_pad || py > max_y_pad {
                        continue;
                    }
                    let qx = px - ax;
                    let qy = py - ay;
                    let cross = qx * dy - qy * dx;
                    if cross * cross > max_cross_sq {
                        continue;
                    }
                    let v_id = unsafe { *arena.sorted_verts.get_unchecked(k) };
                    let vu = v_id as usize;
                    if !edge_dirty && arena.vert_step_stamp[vu] != step_stamp {
                        continue;
                    }
                    if v_id == u || v_id == v {
                        continue;
                    }
                    let tol = arena.vr[vu] + initial_vertex_radius;
                    if cross * cross > (tol * tol) * len_sq {
                        continue;
                    }
                    let dot = qx * dx + qy * dy;
                    if dot <= 0.0 || dot >= len_sq {
                        continue;
                    }
                    let t = dot * inv_len_sq;
                    if t > 0.0 && t < 1.0 {
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
                    if iter > 0 {
                        act_min_x = act_min_x.min(arena.e_min_x[eu] - pad);
                        act_max_x = act_max_x.max(arena.e_max_x[eu] + pad);
                        act_min_y = act_min_y.min(arena.e_min_y[eu] - pad);
                        act_max_y = act_max_y.max(arena.e_max_y[eu] + pad);
                    }
                }
            }
            arena.step_e_queue.clear();
            for i in 0..arena.step_v_queue.len() {
                let v_id = arena.step_v_queue[i] as usize;
                arena.in_step_v_queue[v_id] = 0;
            }
            arena.step_v_queue.clear();
            active_edge_count = if iter == 0 {
                build_sorted_active_edges(arena)
            } else {
                build_sorted_active_edges_in_box(arena, act_min_x, act_max_x, act_min_y, act_max_y)
            };
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
                let min_y1 = arena.se_min_y[i] - r0;
                let max_y1 = arena.se_max_y[i] + r0;
                let e1v0 = arena.se_v0[i];
                let e1v1 = arena.se_v1[i];
                let ax = arena.se_x0[i];
                let ay = arena.se_y0[i];
                let bx = arena.se_x1[i];
                let by = arena.se_y1[i];
                let rx = bx - ax;
                let ry = by - ay;
                let len_r_sq = rx * rx + ry * ry;

                for j in (i + 1)..active_edge_count {
                    if unsafe { *arena.se_min_x.get_unchecked(j) } > max_x1 {
                        break;
                    }
                    if unsafe {
                        *arena.se_max_y.get_unchecked(j) < min_y1
                            || *arena.se_min_y.get_unchecked(j) > max_y1
                    } {
                        continue;
                    }
                    let e2v0 = unsafe { *arena.se_v0.get_unchecked(j) };
                    let e2v1 = unsafe { *arena.se_v1.get_unchecked(j) };
                    if e1v0 == e2v0 || e1v0 == e2v1 || e1v1 == e2v0 || e1v1 == e2v1 {
                        continue;
                    }
                    if !e1_dirty {
                        let e2u = unsafe { *arena.sorted_edges.get_unchecked(j) } as usize;
                        if arena.edge_crossing_stamp[e2u] != step_stamp {
                            continue;
                        }
                    }

                    if let Some((hit_s, hit_t, hit_x, hit_y)) = intersect_segments_interior_fast(
                        ax,
                        ay,
                        rx,
                        ry,
                        len_r_sq,
                        unsafe { *arena.se_x0.get_unchecked(j) },
                        unsafe { *arena.se_y0.get_unchecked(j) },
                        unsafe { *arena.se_x1.get_unchecked(j) },
                        unsafe { *arena.se_y1.get_unchecked(j) },
                        r0,
                    ) {
                        let e2_id = unsafe { *arena.sorted_edges.get_unchecked(j) };
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

        if (!iter_changed || (arena.zero_v_queue.is_empty() && arena.zero_e_queue.is_empty()))
            && arena.step_v_queue.is_empty()
            && arena.step_e_queue.is_empty()
        {
            break;
        }
    }

    drain_zero_strata(arena, r_max, body_count);
}
