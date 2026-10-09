import { CurvePoint, nearestOnCubic } from './bezier';
import { EDGE_LINE, EDGE_STRIDE, Edges } from './edges';
import { GaugePoint, L1Point, nearestL1Cubic, nearestL1Line, nearestLp, nearestPolygon, Search } from './metrics';

const LEAF_SIZE = 4;
const STACK_SIZE = 256;

/** result of a nearest query, reused between queries to avoid allocations */
export interface Nearest {
  /** the search's score: squared euclidean, manhattan, |dx|^p + |dy|^p for lp, or the polygon gauge */
  score: number;
  /** closest point on the edge */
  x: number;
  y: number;
  /** index of the edge, into the original Edges, -1 when there are none */
  segment: number;
}

/**
 * Bounding volume hierarchy over edges (lines and cubics), answering exact nearest-edge queries under the unit shape
 * of its search: euclidean, manhattan, lp or a regular polygon (see metrics.ts).
 * Median split along the longest axis of the centroids, leaves of up to four edges.
 * Boxes hold all control points, which by the convex hull property contain the curve.
 */
export class SegmentBvh {
  private readonly nodeBox: Float64Array; // minX, minY, maxX, maxY per node
  private readonly nodeA: Int32Array; // first segment for leaves, left child for inner nodes
  private readonly nodeB: Int32Array; // segment count for leaves (> 0), -(right child) - 1 for inner nodes
  private readonly seg: Float64Array; // edge coords in leaf order
  private readonly segKind: Uint8Array; // edge kind in leaf order
  private readonly segId: Int32Array; // leaf order -> original edge index
  private readonly curvePoint: CurvePoint = { d2: 0, x: 0, y: 0, t: 0 };
  private readonly l1Point: L1Point = { d: 0, x: 0, y: 0 };
  private readonly gaugePoint: GaugePoint = { score: 0, x: 0, y: 0 };
  private readonly stack = new Int32Array(STACK_SIZE);
  readonly nodeCount: number;

  constructor(
    edges: Edges,
    private readonly search: Search = 'l2',
    private readonly p = 2,
    private readonly normals: Float64Array = new Float64Array(0),
    private readonly vertices: Float64Array = new Float64Array(0)
  ) {
    const n = edges.count;
    const c = edges.coords;
    const S = EDGE_STRIDE;
    const order = new Int32Array(n);
    const cx = new Float64Array(n);
    const cy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      order[i] = i;
      cx[i] = (c[i * S] + c[i * S + 6]) / 2;
      cy[i] = (c[i * S + 1] + c[i * S + 7]) / 2;
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
        const s = order[i] * S;
        minX = Math.min(minX, c[s], c[s + 2], c[s + 4], c[s + 6]);
        maxX = Math.max(maxX, c[s], c[s + 2], c[s + 4], c[s + 6]);
        minY = Math.min(minY, c[s + 1], c[s + 3], c[s + 5], c[s + 7]);
        maxY = Math.max(maxY, c[s + 1], c[s + 3], c[s + 5], c[s + 7]);
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
    this.seg = new Float64Array(n * S);
    this.segKind = new Uint8Array(n);
    this.segId = order;
    for (let i = 0; i < n; i++) {
      this.seg.set(c.subarray(order[i] * S, order[i] * S + S), i * S);
      this.segKind[i] = edges.kind[order[i]];
    }
  }

  /**
   * The hierarchy as flat arrays, for searches that run elsewhere (the gpu kernels):
   * per node its box (minX, minY, maxX, maxY), `a` and `b` (a leaf has b > 0 edges starting at a, an inner node has
   * children a and -b - 1), and the edges in leaf order with their kind and original index.
   */
  flatten() {
    return {
      nodeCount: this.nodeCount,
      nodeBox: this.nodeBox,
      nodeA: this.nodeA,
      nodeB: this.nodeB,
      edges: this.seg,
      kind: this.segKind,
      edgeId: this.segId
    };
  }

  /** the nearest point on any edge to (px, py); `hint` (an original edge index) seeds the search bound */
  nearest(px: number, py: number, out: Nearest, hint = -1): Nearest {
    out.score = Infinity;
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
      if (this.boxScore(box, node, px, py) >= out.score) continue;
      const nb = this.nodeB[node];
      if (nb > 0) {
        const start = this.nodeA[node];
        for (let i = start; i < start + nb; i++) this.test(i, px, py, out);
        continue;
      }
      const l = this.nodeA[node];
      const r = -nb - 1;
      const dl = this.boxScore(box, l, px, py);
      const dr = this.boxScore(box, r, px, py);
      // push the farther child first so the nearer one is searched first
      if (dl < dr) {
        if (dr < out.score) stack[top++] = r;
        if (dl < out.score) stack[top++] = l;
      } else {
        if (dl < out.score) stack[top++] = l;
        if (dr < out.score) stack[top++] = r;
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

  /** lower bound of the score of anything inside the box */
  private boxScore(box: Float64Array, node: number, px: number, py: number) {
    const o = node * 4;
    return this.rangeScore(box[o] - px, box[o + 1] - py, box[o + 2] - px, box[o + 3] - py);
  }

  /** lower bound of the score of every offset w = q - p with x0 <= w.x <= x1 and y0 <= w.y <= y1 */
  private rangeScore(x0: number, y0: number, x1: number, y1: number) {
    if (this.search === 'polygon') {
      // min over the box of max_k n_k . w is at least max_k of min over the box of n_k . w, a corner per side
      const n = this.normals;
      let bound = 0;
      for (let k = 0; k < n.length; k += 2) {
        const nx = n[k];
        const ny = n[k + 1];
        bound = Math.max(bound, nx * (nx > 0 ? x0 : x1) + ny * (ny > 0 ? y0 : y1));
      }
      return bound;
    }
    return this.pointScore(Math.max(x0, 0, -x1), Math.max(y0, 0, -y1));
  }

  /** the score of an axis offset whose components are both positive, for the l2, l1 and lp searches */
  private pointScore(dx: number, dy: number) {
    if (this.search === 'l2') return dx * dx + dy * dy;
    if (this.search === 'l1') return dx + dy;
    // the exact box score; a cheaper, looser bound lets far more edges through to the costly lp search
    return Math.pow(dx, this.p) + Math.pow(dy, this.p);
  }

  private gauge(s: Float64Array, o: number, line: boolean, px: number, py: number) {
    return this.search === 'lp'
      ? nearestLp(s, o, line, px, py, this.p, this.gaugePoint)
      : nearestPolygon(s, o, line, px, py, this.normals, this.vertices, this.gaugePoint);
  }

  private test(i: number, px: number, py: number, out: Nearest) {
    const s = this.seg;
    const o = i * EDGE_STRIDE;
    let score: number;
    let x: number;
    let y: number;
    if (this.segKind[i] !== EDGE_LINE) {
      // skip the curve search when the control point box cannot win
      const bound = this.rangeScore(
        Math.min(s[o], s[o + 2], s[o + 4], s[o + 6]) - px,
        Math.min(s[o + 1], s[o + 3], s[o + 5], s[o + 7]) - py,
        Math.max(s[o], s[o + 2], s[o + 4], s[o + 6]) - px,
        Math.max(s[o + 1], s[o + 3], s[o + 5], s[o + 7]) - py
      );
      if (bound >= out.score) return;
      if (this.search === 'lp' || this.search === 'polygon') {
        const q = this.gauge(s, o, false, px, py);
        score = q.score;
        x = q.x;
        y = q.y;
      } else if (this.search === 'l1') {
        const q = nearestL1Cubic(s, o, px, py, this.l1Point);
        score = q.d;
        x = q.x;
        y = q.y;
      } else {
        const q = nearestOnCubic(s, o, px, py, this.curvePoint);
        score = q.d2;
        x = q.x;
        y = q.y;
      }
    } else if (this.search === 'lp' || this.search === 'polygon') {
      // the line searches cost more than a box test
      const bound = this.rangeScore(
        Math.min(s[o], s[o + 6]) - px,
        Math.min(s[o + 1], s[o + 7]) - py,
        Math.max(s[o], s[o + 6]) - px,
        Math.max(s[o + 1], s[o + 7]) - py
      );
      if (bound >= out.score) return;
      const q = this.gauge(s, o, true, px, py);
      score = q.score;
      x = q.x;
      y = q.y;
    } else if (this.search === 'l1') {
      const q = nearestL1Line(s, o, px, py, this.l1Point);
      score = q.d;
      x = q.x;
      y = q.y;
    } else {
      const ax = s[o];
      const ay = s[o + 1];
      const ex = s[o + 6] - ax;
      const ey = s[o + 7] - ay;
      const len2 = ex * ex + ey * ey;
      let t = len2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      x = ax + t * ex;
      y = ay + t * ey;
      score = (x - px) * (x - px) + (y - py) * (y - py);
    }
    if (score < out.score) {
      out.score = score;
      out.x = x;
      out.y = y;
      out.segment = this.segId[i];
    }
  }
}

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
