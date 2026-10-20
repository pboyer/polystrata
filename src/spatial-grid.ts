/**
 * Zero-Allocation Flat 2D Spatial Hash Grid using open-addressed cell slots
 * and an arena-backed intrusive linked list of entity IDs.
 *
 * `reset(cellSize)` clears the entire grid in O(1) time by bumping `gridGen`
 * and resetting `nodeCount = 0`, avoiding any Map or Array allocations.
 */
export class SpatialHashGrid {
  private invCellSize = 1;
  private tableCap: number;
  private tableMask: number;
  private usedSlots = 0;
  private gridGen = 1;

  private slotIx: Int32Array;
  private slotIy: Int32Array;
  private slotStamp: Uint32Array;
  private slotHead: Int32Array;

  private nodeCap: number;
  private nodeCount = 0;
  private nodeItem: Int32Array;
  private nodeNext: Int32Array;

  private seenStamp: Uint32Array;
  private currentStamp = 1;

  constructor(cellSize = 1, initialEntityCapacity = 512) {
    let cap = 1024;
    while (cap < initialEntityCapacity * 4) {
      cap <<= 1;
    }
    this.tableCap = cap;
    this.tableMask = cap - 1;
    this.slotIx = new Int32Array(cap);
    this.slotIy = new Int32Array(cap);
    this.slotStamp = new Uint32Array(cap);
    this.slotHead = new Int32Array(cap);

    this.nodeCap = Math.max(2048, initialEntityCapacity * 8);
    this.nodeItem = new Int32Array(this.nodeCap);
    this.nodeNext = new Int32Array(this.nodeCap);

    this.seenStamp = new Uint32Array(Math.max(256, initialEntityCapacity * 2));
    this.reset(cellSize, initialEntityCapacity);
  }

  reset(cellSize: number, entityCapacity = 256): void {
    const safeCell = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : 1;
    this.invCellSize = 1 / safeCell;
    this.nodeCount = 0;
    this.usedSlots = 0;
    this.gridGen = (this.gridGen + 1) >>> 0;
    if (this.gridGen === 0) {
      this.slotStamp.fill(0);
      this.gridGen = 1;
    }
    this.ensureEntityCapacity(entityCapacity);
  }

  clear(): void {
    this.reset(1 / this.invCellSize, this.seenStamp.length);
  }

  private ensureEntityCapacity(id: number): void {
    if (id < this.seenStamp.length) return;
    let nextLen = this.seenStamp.length;
    while (nextLen <= id) {
      nextLen <<= 1;
    }
    const next = new Uint32Array(nextLen);
    next.set(this.seenStamp);
    this.seenStamp = next;
  }

  private growNodes(): void {
    const nextCap = this.nodeCap << 1;
    const nextItem = new Int32Array(nextCap);
    const nextNext = new Int32Array(nextCap);
    nextItem.set(this.nodeItem);
    nextNext.set(this.nodeNext);
    this.nodeItem = nextItem;
    this.nodeNext = nextNext;
    this.nodeCap = nextCap;
  }

  private rehashTable(): void {
    const oldCap = this.tableCap;
    const oldIx = this.slotIx;
    const oldIy = this.slotIy;
    const oldStamp = this.slotStamp;
    const oldHead = this.slotHead;
    const gen = this.gridGen;

    const newCap = oldCap << 1;
    const newMask = newCap - 1;
    const newIx = new Int32Array(newCap);
    const newIy = new Int32Array(newCap);
    const newStamp = new Uint32Array(newCap);
    const newHead = new Int32Array(newCap);

    for (let i = 0; i < oldCap; i++) {
      if (oldStamp[i] !== gen) continue;
      const ix = oldIx[i]!;
      const iy = oldIy[i]!;
      let slot = ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) >>> 0) & newMask;
      while (newStamp[slot] === gen) {
        slot = (slot + 1) & newMask;
      }
      newStamp[slot] = gen;
      newIx[slot] = ix;
      newIy[slot] = iy;
      newHead[slot] = oldHead[i]!;
    }

    this.tableCap = newCap;
    this.tableMask = newMask;
    this.slotIx = newIx;
    this.slotIy = newIy;
    this.slotStamp = newStamp;
    this.slotHead = newHead;
  }

  insertPoint(x: number, y: number, _r: number, id: number): void {
    if (id >= this.seenStamp.length) {
      this.ensureEntityCapacity(id);
    }
    if (this.usedSlots * 2 >= this.tableCap) {
      this.rehashTable();
    }
    const inv = this.invCellSize;
    const ix = Math.floor(x * inv);
    const iy = Math.floor(y * inv);
    const mask = this.tableMask;
    const gen = this.gridGen;
    let slot = ((Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) >>> 0) & mask;

    while (true) {
      if (this.slotStamp[slot] !== gen) {
        this.slotStamp[slot] = gen;
        this.slotIx[slot] = ix;
        this.slotIy[slot] = iy;
        this.slotHead[slot] = -1;
        this.usedSlots++;
        break;
      }
      if (this.slotIx[slot] === ix && this.slotIy[slot] === iy) {
        break;
      }
      slot = (slot + 1) & mask;
    }

    const head = this.slotHead[slot]!;
    if (head !== -1 && this.nodeItem[head] === id) {
      return;
    }

    const n = this.nodeCount;
    if (n >= this.nodeCap) {
      this.growNodes();
    }
    this.nodeCount = n + 1;
    this.nodeItem[n] = id;
    this.nodeNext[n] = head;
    this.slotHead[slot] = n;
  }

  removePoint(_x: number, _y: number, _r: number, _id: number): void {
    // Lazy deletion: callers check vertex liveness and canonical coordinates on query
  }

  removeBox(_minX: number, _minY: number, _maxX: number, _maxY: number, _id: number): void {
    // Lazy deletion: callers check edge liveness on query
  }

  insertBox(minX: number, minY: number, maxX: number, maxY: number, id: number): void {
    if (id >= this.seenStamp.length) {
      this.ensureEntityCapacity(id);
    }
    const inv = this.invCellSize;
    const ix0 = Math.floor(minX * inv);
    const iy0 = Math.floor(minY * inv);
    const ix1 = Math.floor(maxX * inv);
    const iy1 = Math.floor(maxY * inv);

    for (let ix = ix0; ix <= ix1; ix++) {
      const hx = Math.imul(ix, 73856093);
      for (let iy = iy0; iy <= iy1; iy++) {
        if (this.usedSlots * 2 >= this.tableCap) {
          this.rehashTable();
        }
        const mask = this.tableMask;
        const gen = this.gridGen;
        let slot = ((hx ^ Math.imul(iy, 19349663)) >>> 0) & mask;

        while (true) {
          if (this.slotStamp[slot] !== gen) {
            this.slotStamp[slot] = gen;
            this.slotIx[slot] = ix;
            this.slotIy[slot] = iy;
            this.slotHead[slot] = -1;
            this.usedSlots++;
            break;
          }
          if (this.slotIx[slot] === ix && this.slotIy[slot] === iy) {
            break;
          }
          slot = (slot + 1) & mask;
        }

        const head = this.slotHead[slot]!;
        if (head !== -1 && this.nodeItem[head] === id) {
          continue;
        }

        const n = this.nodeCount;
        if (n >= this.nodeCap) {
          this.growNodes();
        }
        this.nodeCount = n + 1;
        this.nodeItem[n] = id;
        this.nodeNext[n] = head;
        this.slotHead[slot] = n;
      }
    }
  }

  queryBox(minX: number, minY: number, maxX: number, maxY: number, out: number[]): void {
    out.length = 0;
    const inv = this.invCellSize;
    const ix0 = Math.floor(minX * inv);
    const iy0 = Math.floor(minY * inv);
    const ix1 = Math.floor(maxX * inv);
    const iy1 = Math.floor(maxY * inv);

    const mask = this.tableMask;
    const gen = this.gridGen;
    const slotStamp = this.slotStamp;
    const slotIx = this.slotIx;
    const slotIy = this.slotIy;
    const slotHead = this.slotHead;
    const nodeItem = this.nodeItem;
    const nodeNext = this.nodeNext;

    let stamp = (this.currentStamp + 1) >>> 0;
    if (stamp === 0) {
      this.seenStamp.fill(0);
      stamp = 1;
    }
    this.currentStamp = stamp;
    const seenStamp = this.seenStamp;

    if (ix0 === ix1 && iy0 === iy1) {
      let slot = ((Math.imul(ix0, 73856093) ^ Math.imul(iy0, 19349663)) >>> 0) & mask;
      while (slotStamp[slot] === gen) {
        if (slotIx[slot] === ix0 && slotIy[slot] === iy0) {
          let n = slotHead[slot]!;
          while (n !== -1) {
            const id = nodeItem[n]!;
            if (seenStamp[id] !== stamp) {
              seenStamp[id] = stamp;
              out.push(id);
            }
            n = nodeNext[n]!;
          }
          return;
        }
        slot = (slot + 1) & mask;
      }
      return;
    }

    for (let ix = ix0; ix <= ix1; ix++) {
      const hx = Math.imul(ix, 73856093);
      for (let iy = iy0; iy <= iy1; iy++) {
        let slot = ((hx ^ Math.imul(iy, 19349663)) >>> 0) & mask;
        while (slotStamp[slot] === gen) {
          if (slotIx[slot] === ix && slotIy[slot] === iy) {
            let n = slotHead[slot]!;
            while (n !== -1) {
              const id = nodeItem[n]!;
              if (seenStamp[id] !== stamp) {
                seenStamp[id] = stamp;
                out.push(id);
              }
              n = nodeNext[n]!;
            }
            break;
          }
          slot = (slot + 1) & mask;
        }
      }
    }
  }
}
