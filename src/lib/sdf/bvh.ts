import { Segments } from './segments';

const LEAF_SIZE = 4;
const STACK_SIZE = 256;

/** result of a nearest query, reused between queries to avoid allocations */
export interface Nearest {
  /** squared distance */
  d2: number;
  /** closest point on the edge */
  x: number;
  y: number;
  /** index of the segment, into the original Segments, -1 when there are none */
  segment: number;
}

/**
 * Bounding volume hierarchy over line segments, answering exact nearest-segment queries.
 * Median split along the longest axis of the centroids, leaves of up to four segments.
 */
export class SegmentBvh {
  private readonly nodeBox: Float64Array; // minX, minY, maxX, maxY per node
  private readonly nodeA: Int32Array; // first segment for leaves, left child for inner nodes
  private readonly nodeB: Int32Array; // segment count for leaves (> 0), -(right child) - 1 for inner nodes
  private readonly seg: Float64Array; // segment coords in leaf order
  private readonly segId: Int32Array; // leaf order -> original segment index
  private readonly stack = new Int32Array(STACK_SIZE);
  readonly nodeCount: number;

  constructor(segments: Segments) {
    const n = segments.count;
    const c = segments.coords;
    const order = new Int32Array(n);
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      order[i] = i;
      cx[i] = (c[i * 4] + c[i * 4 + 2]) / 2;
      cy[i] = (c[i * 4 + 1] + c[i * 4 + 3]) / 2;
    }

    const maxNodes = Math.max(1, 2 * Math.ceil(n / LEAF_SIZE) * 2);
    let box = new Float64Array(maxNodes * 4);
    let a = new Int32Array(maxNodes);
    let b = new Int32Array(maxNodes);
    let count = 0;
    const alloc = () => {
      if (count === a.length) {
        const grow = <T extends Float64Array | Int32Array>(arr: T, size: number): T => {
          const next = new (arr.constructor as { new (n: number): T })(size);
          next.set(arr);
          return next;
        };
        box = grow(box, a.length * 8);
        b = grow(b, a.length * 2);
        a = grow(a, a.length * 2);
      }
      return count++;
    };

    // iterative build, each entry is [node, start, end)
    const work: number[] = [alloc(), 0, n];
    while (work.length) {
      const end = work.pop()!;
      const start = work.pop()!;
      const node = work.pop()!;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let cMinX = Infinity;
      let cMinY = Infinity;
      let cMaxX = -Infinity;
      let cMaxY = -Infinity;
      for (let i = start; i < end; i++) {
        const s = order[i] * 4;
        minX = Math.min(minX, c[s], c[s + 2]);
        maxX = Math.max(maxX, c[s], c[s + 2]);
        minY = Math.min(minY, c[s + 1], c[s + 3]);
        maxY = Math.max(maxY, c[s + 1], c[s + 3]);
        cMinX = Math.min(cMinX, cx[order[i]]);
        cMaxX = Math.max(cMaxX, cx[order[i]]);
        cMinY = Math.min(cMinY, cy[order[i]]);
        cMaxY = Math.max(cMaxY, cy[order[i]]);
      }
      box[node * 4] = minX;
      box[node * 4 + 1] = minY;
      box[node * 4 + 2] = maxX;
      box[node * 4 + 3] = maxY;

      if (end - start <= LEAF_SIZE) {
        a[node] = start;
        b[node] = end - start;
        continue;
      }
      const key = cMaxX - cMinX >= cMaxY - cMinY ? cx : cy;
      const mid = (start + end) >> 1;
      quickselect(order, start, end - 1, mid, key);
      const left = alloc();
      const right = alloc();
      a[node] = left;
      b[node] = -right - 1;
      work.push(left, start, mid, right, mid, end);
    }

    this.nodeCount = count;
    this.nodeBox = box;
    this.nodeA = a;
    this.nodeB = b;
    this.seg = new Float64Array(n * 4);
    this.segId = order;
    for (let i = 0; i < n; i++) this.seg.set(c.subarray(order[i] * 4, order[i] * 4 + 4), i * 4);
  }

  /** the nearest point on any segment to (px, py); `hint` (an original segment index) seeds the search bound */
  nearest(px: number, py: number, out: Nearest, hint = -1): Nearest {
    out.d2 = Infinity;
    out.segment = -1;
    if (!this.segId.length) return out;
    if (hint >= 0) {
      // find the hint's leaf position lazily through the inverse permutation
      const i = this.position(hint);
      this.test(i, px, py, out);
    }
    const box = this.nodeBox;
    const stack = this.stack;
    let top = 0;
    stack[top++] = 0;
    while (top) {
      const node = stack[--top];
      if (boxDistance2(box, node, px, py) >= out.d2) continue;
      const nb = this.nodeB[node];
      if (nb > 0) {
        const start = this.nodeA[node];
        for (let i = start; i < start + nb; i++) this.test(i, px, py, out);
        continue;
      }
      const l = this.nodeA[node];
      const r = -nb - 1;
      const dl = boxDistance2(box, l, px, py);
      const dr = boxDistance2(box, r, px, py);
      // push the farther child first so the nearer one is searched first
      if (dl < dr) {
        if (dr < out.d2) stack[top++] = r;
        if (dl < out.d2) stack[top++] = l;
      } else {
        if (dl < out.d2) stack[top++] = l;
        if (dr < out.d2) stack[top++] = r;
      }
    }
    return out;
  }

  private inverse: Int32Array | null = null;
  private position(segment: number) {
    if (!this.inverse) {
      this.inverse = new Int32Array(this.segId.length);
      for (let i = 0; i < this.segId.length; i++) this.inverse[this.segId[i]] = i;
    }
    return this.inverse[segment];
  }

  private test(i: number, px: number, py: number, out: Nearest) {
    const s = this.seg;
    const ax = s[i * 4];
    const ay = s[i * 4 + 1];
    const ex = s[i * 4 + 2] - ax;
    const ey = s[i * 4 + 3] - ay;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = ax + t * ex;
    const qy = ay + t * ey;
    const d2 = (qx - px) * (qx - px) + (qy - py) * (qy - py);
    if (d2 < out.d2) {
      out.d2 = d2;
      out.x = qx;
      out.y = qy;
      out.segment = this.segId[i];
    }
  }
}

const boxDistance2 = (box: Float64Array, node: number, px: number, py: number) => {
  const o = node * 4;
  const dx = Math.max(box[o] - px, 0, px - box[o + 2]);
  const dy = Math.max(box[o + 1] - py, 0, py - box[o + 3]);
  return dx * dx + dy * dy;
};

/** partially sorts order[lo..hi] so that order[k] holds the element of rank k by key */
const quickselect = (order: Int32Array, lo: number, hi: number, k: number, key: Float64Array) => {
  while (hi > lo) {
    const pivot = key[order[(lo + hi) >> 1]];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (key[order[i]] < pivot) i++;
      while (key[order[j]] > pivot) j--;
      if (i <= j) {
        const t = order[i];
        order[i] = order[j];
        order[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return;
  }
};
