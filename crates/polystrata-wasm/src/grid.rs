/// Zero-allocation flat 2D Spatial Hash Grid using open-addressed cell slots
/// and an arena-backed intrusive linked list of entity IDs.
pub struct SpatialHashGrid {
    inv_cell_size: f64,
    table_cap: usize,
    table_mask: usize,
    used_slots: usize,
    grid_gen: u32,

    slot_ix: Vec<i32>,
    slot_iy: Vec<i32>,
    slot_stamp: Vec<u32>,
    slot_head: Vec<i32>,

    node_item: Vec<u32>,
    node_next: Vec<i32>,
    node_count: usize,

    seen_stamp: Vec<u32>,
    current_stamp: u32,
}

impl SpatialHashGrid {
    pub fn new() -> Self {
        let cap = 1024usize;
        Self {
            inv_cell_size: 1.0,
            table_cap: cap,
            table_mask: cap - 1,
            used_slots: 0,
            grid_gen: 1,
            slot_ix: vec![0; cap],
            slot_iy: vec![0; cap],
            slot_stamp: vec![0; cap],
            slot_head: vec![-1; cap],
            node_item: Vec::with_capacity(2048),
            node_next: Vec::with_capacity(2048),
            node_count: 0,
            seen_stamp: vec![0; 512],
            current_stamp: 1,
        }
    }

    #[inline]
    pub fn reset(&mut self, cell_size: f64, entity_cap: usize) {
        let safe_cell = if cell_size > 0.0 && cell_size.is_finite() {
            cell_size
        } else {
            1.0
        };
        self.inv_cell_size = 1.0 / safe_cell;
        self.node_count = 0;
        self.used_slots = 0;
        if self.table_cap < entity_cap * 2 {
            let mut new_cap = self.table_cap.max(1024);
            while new_cap < entity_cap * 2 {
                new_cap <<= 1;
            }
            self.table_cap = new_cap;
            self.table_mask = new_cap - 1;
            self.slot_ix.resize(new_cap, 0);
            self.slot_iy.resize(new_cap, 0);
            self.slot_stamp.resize(new_cap, 0);
            self.slot_head.resize(new_cap, -1);
        }
        self.grid_gen = self.grid_gen.wrapping_add(1);
        if self.grid_gen == 0 {
            self.slot_stamp.fill(0);
            self.grid_gen = 1;
        }
        if self.seen_stamp.len() <= entity_cap {
            let mut next_len = self.seen_stamp.len().max(256);
            while next_len <= entity_cap {
                next_len <<= 1;
            }
            self.seen_stamp.resize(next_len, 0);
        }
    }

    #[cold]
    fn rehash_table(&mut self) {
        let old_cap = self.table_cap;
        let new_cap = old_cap << 1;
        let new_mask = new_cap - 1;
        let gen = self.grid_gen;

        let mut new_ix = vec![0i32; new_cap];
        let mut new_iy = vec![0i32; new_cap];
        let mut new_stamp = vec![0u32; new_cap];
        let mut new_head = vec![-1i32; new_cap];

        for i in 0..old_cap {
            if self.slot_stamp[i] != gen {
                continue;
            }
            let ix = self.slot_ix[i];
            let iy = self.slot_iy[i];
            let h = ((ix.wrapping_mul(73856093)) ^ (iy.wrapping_mul(19349663))) as usize;
            let mut slot = h & new_mask;
            while new_stamp[slot] == gen {
                slot = (slot + 1) & new_mask;
            }
            new_stamp[slot] = gen;
            new_ix[slot] = ix;
            new_iy[slot] = iy;
            new_head[slot] = self.slot_head[i];
        }

        self.table_cap = new_cap;
        self.table_mask = new_mask;
        self.slot_ix = new_ix;
        self.slot_iy = new_iy;
        self.slot_stamp = new_stamp;
        self.slot_head = new_head;
    }

    #[inline]
    pub fn insert_point(&mut self, x: f64, y: f64, id: u32) {
        let id_usize = id as usize;
        if id_usize >= self.seen_stamp.len() {
            let mut next_len = self.seen_stamp.len().max(256);
            while next_len <= id_usize {
                next_len <<= 1;
            }
            self.seen_stamp.resize(next_len, 0);
        }
        if self.used_slots * 2 >= self.table_cap {
            self.rehash_table();
        }
        let inv = self.inv_cell_size;
        let ix = (x * inv).floor() as i32;
        let iy = (y * inv).floor() as i32;
        let mask = self.table_mask;
        let gen = self.grid_gen;
        let h = ((ix.wrapping_mul(73856093)) ^ (iy.wrapping_mul(19349663))) as usize;
        let mut slot = h & mask;

        loop {
            if unsafe { *self.slot_stamp.get_unchecked(slot) } != gen {
                unsafe {
                    *self.slot_stamp.get_unchecked_mut(slot) = gen;
                    *self.slot_ix.get_unchecked_mut(slot) = ix;
                    *self.slot_iy.get_unchecked_mut(slot) = iy;
                    *self.slot_head.get_unchecked_mut(slot) = -1;
                }
                self.used_slots += 1;
                break;
            }
            if unsafe {
                *self.slot_ix.get_unchecked(slot) == ix && *self.slot_iy.get_unchecked(slot) == iy
            } {
                break;
            }
            slot = (slot + 1) & mask;
        }

        let head = unsafe { *self.slot_head.get_unchecked(slot) };
        if head != -1 && unsafe { *self.node_item.get_unchecked(head as usize) } == id {
            return;
        }

        let n = self.node_count;
        if n >= self.node_item.len() {
            let next_cap = (self.node_item.len().max(1024)) << 1;
            self.node_item.resize(next_cap, 0);
            self.node_next.resize(next_cap, -1);
        }
        self.node_count = n + 1;
        unsafe {
            *self.node_item.get_unchecked_mut(n) = id;
            *self.node_next.get_unchecked_mut(n) = head;
            *self.slot_head.get_unchecked_mut(slot) = n as i32;
        }
    }

    #[inline]
    pub fn query_box(&mut self, min_x: f64, min_y: f64, max_x: f64, max_y: f64, out: &mut Vec<u32>) {
        out.clear();
        let inv = self.inv_cell_size;
        let ix0 = (min_x * inv).floor() as i32;
        let iy0 = (min_y * inv).floor() as i32;
        let ix1 = (max_x * inv).floor() as i32;
        let iy1 = (max_y * inv).floor() as i32;

        let mask = self.table_mask;
        let gen = self.grid_gen;

        if ix0 == ix1 && iy0 == iy1 {
            let h = ((ix0.wrapping_mul(73856093)) ^ (iy0.wrapping_mul(19349663))) as usize;
            let mut slot = h & mask;
            while unsafe { *self.slot_stamp.get_unchecked(slot) } == gen {
                if unsafe {
                    *self.slot_ix.get_unchecked(slot) == ix0
                        && *self.slot_iy.get_unchecked(slot) == iy0
                } {
                    let mut n = unsafe { *self.slot_head.get_unchecked(slot) };
                    while n != -1 {
                        let nu = n as usize;
                        out.push(unsafe { *self.node_item.get_unchecked(nu) });
                        n = unsafe { *self.node_next.get_unchecked(nu) };
                    }
                    return;
                }
                slot = (slot + 1) & mask;
            }
            return;
        }

        let mut stamp = self.current_stamp.wrapping_add(1);
        if stamp == 0 {
            self.seen_stamp.fill(0);
            stamp = 1;
        }
        self.current_stamp = stamp;

        // Huge or saturated cell ranges (e.g. a query radius far larger than the cell size, or
        // coordinates beyond i32 cell indices) would take ~2^64 iterations to walk cell by cell.
        // Scanning the occupied slots instead bounds the query at O(table_cap).
        let span_x = (ix1 as i64 - ix0 as i64 + 1).max(0);
        let span_y = (iy1 as i64 - iy0 as i64 + 1).max(0);
        if span_x.saturating_mul(span_y) > self.table_cap as i64 {
            for slot in 0..self.table_cap {
                if self.slot_stamp[slot] != gen {
                    continue;
                }
                let (ix, iy) = (self.slot_ix[slot], self.slot_iy[slot]);
                if ix < ix0 || ix > ix1 || iy < iy0 || iy > iy1 {
                    continue;
                }
                let mut n = self.slot_head[slot];
                while n != -1 {
                    let nu = n as usize;
                    let id = self.node_item[nu];
                    if self.seen_stamp[id as usize] != stamp {
                        self.seen_stamp[id as usize] = stamp;
                        out.push(id);
                    }
                    n = self.node_next[nu];
                }
            }
            return;
        }

        for ix in ix0..=ix1 {
            let hx = ix.wrapping_mul(73856093);
            for iy in iy0..=iy1 {
                let h = (hx ^ iy.wrapping_mul(19349663)) as usize;
                let mut slot = h & mask;
                while unsafe { *self.slot_stamp.get_unchecked(slot) } == gen {
                    if unsafe {
                        *self.slot_ix.get_unchecked(slot) == ix
                            && *self.slot_iy.get_unchecked(slot) == iy
                    } {
                        let mut n = unsafe { *self.slot_head.get_unchecked(slot) };
                        while n != -1 {
                            let nu = n as usize;
                            let id = unsafe { *self.node_item.get_unchecked(nu) };
                            let id_u = id as usize;
                            if unsafe { *self.seen_stamp.get_unchecked(id_u) } != stamp {
                                unsafe { *self.seen_stamp.get_unchecked_mut(id_u) = stamp };
                                out.push(id);
                            }
                            n = unsafe { *self.node_next.get_unchecked(nu) };
                        }
                        break;
                    }
                    slot = (slot + 1) & mask;
                }
            }
        }
    }
}
