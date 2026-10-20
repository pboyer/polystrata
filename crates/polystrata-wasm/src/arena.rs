use crate::grid::SpatialHashGrid;

pub struct KernelArena {
    // Stage 0 input buffers (packed 5 f64s per segment: x0, y0, x1, y1, bodyIndex)
    pub raw_segments: Vec<f64>,
    pub raw_count: usize,

    // Prepared normalized buffers for repeated benchmark runs
    pub prep_x0: Vec<f64>,
    pub prep_y0: Vec<f64>,
    pub prep_x1: Vec<f64>,
    pub prep_y1: Vec<f64>,
    pub prep_body: Vec<u8>,
    pub prep_count: usize,
    pub prep_cx: f64,
    pub prep_cy: f64,
    pub prep_r0: f64,
    pub prep_rmax: f64,
    pub prep_cell_size: f64,
    pub prep_body_count: usize,

    // Working normalized segments for current run
    pub norm_x0: Vec<f64>,
    pub norm_y0: Vec<f64>,
    pub norm_x1: Vec<f64>,
    pub norm_y1: Vec<f64>,
    pub norm_body: Vec<u8>,
    pub norm_count: usize,

    // Stage 1-2: Vertices (SoA)
    pub vertex_count: usize,
    pub vx: Vec<f64>,
    pub vy: Vec<f64>,
    pub vr: Vec<f64>,
    pub v_weight: Vec<u32>,
    pub v_alive: Vec<u8>,
    pub v_parent: Vec<u32>,
    pub v_first_inc: Vec<i32>,
    pub in_zero_v_queue: Vec<u8>,
    pub in_step_v_queue: Vec<u8>,
    pub vert_step_stamp: Vec<u32>,
    pub sorted_verts: Vec<u32>,

    // Incidence pool
    pub inc_count: usize,
    pub inc_edge: Vec<u32>,
    pub inc_next: Vec<i32>,

    // Stage 1-2: Edges (SoA)
    pub edge_count: usize,
    pub ev0: Vec<u32>,
    pub ev1: Vec<u32>,
    pub e_alive: Vec<u8>,
    pub in_zero_e_queue: Vec<u8>,
    pub in_step_e_queue: Vec<u8>,
    pub e_delta_w: Vec<i32>,
    pub e_min_x: Vec<f64>,
    pub e_min_y: Vec<f64>,
    pub e_max_x: Vec<f64>,
    pub e_max_y: Vec<f64>,
    pub sorted_edges: Vec<u32>,
    pub edge_crossing_stamp: Vec<u32>,
    pub crossing_stamp_gen: u32,

    // Edge split pools
    pub edge_split_head: Vec<i32>,
    pub split_count: usize,
    pub split_t: Vec<f64>,
    pub split_vert: Vec<u32>,
    pub split_next: Vec<i32>,
    pub split_edge_list: Vec<u32>,

    // Queues & scratches
    pub zero_v_queue: Vec<u32>,
    pub zero_e_queue: Vec<u32>,
    pub step_v_queue: Vec<u32>,
    pub step_e_queue: Vec<u32>,
    pub dirty_verts: Vec<u32>,
    pub dirty_edges: Vec<u32>,
    pub vertex_query_scratch: Vec<u32>,
    pub vertex_grid: SpatialHashGrid,

    // Stage 3: Planar topology (CSR)
    pub v_spoke_offset: Vec<u32>,
    pub v_spoke_count: Vec<u32>,
    pub v_spoke_cursor: Vec<u32>,
    pub spokes_csr: Vec<u32>,
    pub he_next: Vec<i32>,
    pub he_cycle: Vec<i32>,
    pub he_in_output: Vec<u8>,
    pub he_visited: Vec<u8>,

    // Stage 3-4: Cycles & Classification
    pub cycle_count: usize,
    pub cycle_start: Vec<u32>,
    pub cycle_len: Vec<u32>,
    pub cycle_half_edges_csr: Vec<u32>,
    pub cycle_keep: Vec<u8>,
    pub cycle_visited: Vec<u8>,
    pub cycle_windings: Vec<i32>,
    pub vertex_net_winding: Vec<i32>,
    pub index_in_stack: Vec<i32>,
    pub bfs_queue: Vec<u32>,
    pub active_edge_ids: Vec<u32>,
    pub active_spokes: Vec<u32>,
    pub walk_vertex_ids: Vec<u32>,
    pub pinch_stack: Vec<u32>,
    pub simple_loops_csr: Vec<u32>,
    pub simple_loop_starts: Vec<u32>,
    pub simple_loop_lens: Vec<u32>,

    // Flat output buffers read directly by JS
    pub out_coords: Vec<f64>,
    pub out_loop_meta: Vec<u32>, // 3 u32s per loop: [start_pt_idx, pt_count, parent_shell_idx_or_u32_max]
    pub out_loop_count: usize,
    pub out_total_area: f64,
}

impl KernelArena {
    pub fn new() -> Self {
        Self {
            raw_segments: Vec::with_capacity(4096 * 5),
            raw_count: 0,
            prep_x0: Vec::with_capacity(2048),
            prep_y0: Vec::with_capacity(2048),
            prep_x1: Vec::with_capacity(2048),
            prep_y1: Vec::with_capacity(2048),
            prep_body: Vec::with_capacity(2048),
            prep_count: 0,
            prep_cx: 0.0,
            prep_cy: 0.0,
            prep_r0: 1e-9,
            prep_rmax: 4e-9,
            prep_cell_size: 1.0,
            prep_body_count: 2,
            norm_x0: Vec::with_capacity(2048),
            norm_y0: Vec::with_capacity(2048),
            norm_x1: Vec::with_capacity(2048),
            norm_y1: Vec::with_capacity(2048),
            norm_body: Vec::with_capacity(2048),
            norm_count: 0,

            vertex_count: 0,
            vx: Vec::with_capacity(2048),
            vy: Vec::with_capacity(2048),
            vr: Vec::with_capacity(2048),
            v_weight: Vec::with_capacity(2048),
            v_alive: Vec::with_capacity(2048),
            v_parent: Vec::with_capacity(2048),
            v_first_inc: Vec::with_capacity(2048),
            in_zero_v_queue: Vec::with_capacity(2048),
            in_step_v_queue: Vec::with_capacity(2048),
            vert_step_stamp: Vec::with_capacity(2048),
            sorted_verts: Vec::with_capacity(2048),

            inc_count: 0,
            inc_edge: Vec::with_capacity(4096),
            inc_next: Vec::with_capacity(4096),

            edge_count: 0,
            ev0: Vec::with_capacity(2048),
            ev1: Vec::with_capacity(2048),
            e_alive: Vec::with_capacity(2048),
            in_zero_e_queue: Vec::with_capacity(2048),
            in_step_e_queue: Vec::with_capacity(2048),
            e_delta_w: Vec::with_capacity(4096),
            e_min_x: Vec::with_capacity(2048),
            e_min_y: Vec::with_capacity(2048),
            e_max_x: Vec::with_capacity(2048),
            e_max_y: Vec::with_capacity(2048),
            sorted_edges: Vec::with_capacity(2048),
            edge_crossing_stamp: Vec::with_capacity(2048),
            crossing_stamp_gen: 1,

            edge_split_head: Vec::with_capacity(2048),
            split_count: 0,
            split_t: Vec::with_capacity(1024),
            split_vert: Vec::with_capacity(1024),
            split_next: Vec::with_capacity(1024),
            split_edge_list: Vec::with_capacity(1024),

            zero_v_queue: Vec::with_capacity(1024),
            zero_e_queue: Vec::with_capacity(1024),
            step_v_queue: Vec::with_capacity(1024),
            step_e_queue: Vec::with_capacity(1024),
            dirty_verts: Vec::with_capacity(1024),
            dirty_edges: Vec::with_capacity(1024),
            vertex_query_scratch: Vec::with_capacity(64),
            vertex_grid: SpatialHashGrid::new(),

            v_spoke_offset: Vec::with_capacity(2048),
            v_spoke_count: Vec::with_capacity(2048),
            v_spoke_cursor: Vec::with_capacity(2048),
            spokes_csr: Vec::with_capacity(4096),
            he_next: Vec::with_capacity(4096),
            he_cycle: Vec::with_capacity(4096),
            he_in_output: Vec::with_capacity(4096),
            he_visited: Vec::with_capacity(4096),

            cycle_count: 0,
            cycle_start: Vec::with_capacity(1024),
            cycle_len: Vec::with_capacity(1024),
            cycle_half_edges_csr: Vec::with_capacity(4096),
            cycle_keep: Vec::with_capacity(1024),
            cycle_visited: Vec::with_capacity(1024),
            cycle_windings: Vec::with_capacity(2048),
            vertex_net_winding: Vec::with_capacity(4096),
            index_in_stack: vec![-1; 2048],
            bfs_queue: Vec::with_capacity(1024),
            active_edge_ids: Vec::with_capacity(2048),
            active_spokes: Vec::with_capacity(64),
            walk_vertex_ids: Vec::with_capacity(1024),
            pinch_stack: Vec::with_capacity(1024),
            simple_loops_csr: Vec::with_capacity(1024),
            simple_loop_starts: Vec::with_capacity(128),
            simple_loop_lens: Vec::with_capacity(128),

            out_coords: Vec::with_capacity(4096),
            out_loop_meta: Vec::with_capacity(512),
            out_loop_count: 0,
            out_total_area: 0.0,
        }
    }

    #[inline]
    pub fn ensure_vertex_capacity(&mut self, needed: usize) {
        if needed <= self.vx.len() {
            return;
        }
        let mut cap = self.vx.len().max(512);
        while cap < needed {
            cap <<= 1;
        }
        self.vx.resize(cap, 0.0);
        self.vy.resize(cap, 0.0);
        self.vr.resize(cap, 0.0);
        self.v_weight.resize(cap, 0);
        self.v_alive.resize(cap, 0);
        self.v_parent.resize(cap, 0);
        self.v_first_inc.resize(cap, -1);
        self.in_zero_v_queue.resize(cap, 0);
        self.in_step_v_queue.resize(cap, 0);
        self.vert_step_stamp.resize(cap, 0);
        self.sorted_verts.resize(cap, 0);
        self.v_spoke_offset.resize(cap, 0);
        self.v_spoke_count.resize(cap, 0);
        self.v_spoke_cursor.resize(cap, 0);
        self.index_in_stack.resize(cap, -1);
    }

    #[inline]
    pub fn ensure_edge_capacity(&mut self, needed: usize, body_count: usize) {
        if needed > self.ev0.len() {
            let mut cap = self.ev0.len().max(512);
            while cap < needed {
                cap <<= 1;
            }
            self.ev0.resize(cap, 0);
            self.ev1.resize(cap, 0);
            self.e_alive.resize(cap, 0);
            self.in_zero_e_queue.resize(cap, 0);
            self.in_step_e_queue.resize(cap, 0);
            self.e_min_x.resize(cap, 0.0);
            self.e_min_y.resize(cap, 0.0);
            self.e_max_x.resize(cap, 0.0);
            self.e_max_y.resize(cap, 0.0);
            self.sorted_edges.resize(cap, 0);
            self.edge_crossing_stamp.resize(cap, 0);
            self.edge_split_head.resize(cap, -1);
        }
        let needed_dw = self.ev0.len() * body_count;
        if needed_dw > self.e_delta_w.len() {
            let mut dw_cap = self.e_delta_w.len().max(1024);
            while dw_cap < needed_dw {
                dw_cap <<= 1;
            }
            self.e_delta_w.resize(dw_cap, 0);
        }
    }

    #[inline]
    pub fn ensure_inc_capacity(&mut self, needed: usize) {
        if needed <= self.inc_edge.len() {
            return;
        }
        let mut cap = self.inc_edge.len().max(1024);
        while cap < needed {
            cap <<= 1;
        }
        self.inc_edge.resize(cap, 0);
        self.inc_next.resize(cap, -1);
    }

    #[inline]
    pub fn ensure_half_edge_capacity(&mut self, needed: usize) {
        if needed <= self.he_next.len() {
            return;
        }
        let mut cap = self.he_next.len().max(1024);
        while cap < needed {
            cap <<= 1;
        }
        self.spokes_csr.resize(cap, 0);
        self.he_next.resize(cap, -1);
        self.he_cycle.resize(cap, -1);
        self.he_in_output.resize(cap, 0);
        self.he_visited.resize(cap, 0);
        self.cycle_half_edges_csr.resize(cap, 0);
    }

    #[inline]
    pub fn ensure_cycle_capacity(&mut self, needed: usize, body_count: usize) {
        if needed > self.cycle_start.len() {
            let mut cap = self.cycle_start.len().max(512);
            while cap < needed {
                cap <<= 1;
            }
            self.cycle_start.resize(cap, 0);
            self.cycle_len.resize(cap, 0);
            self.cycle_keep.resize(cap, 0);
            self.cycle_visited.resize(cap, 0);
        }
        let needed_cw = self.cycle_start.len() * body_count;
        if needed_cw > self.cycle_windings.len() {
            let mut cw_cap = self.cycle_windings.len().max(1024);
            while cw_cap < needed_cw {
                cw_cap <<= 1;
            }
            self.cycle_windings.resize(cw_cap, 0);
        }
    }
}
