import { MetricSpec } from '../types';
import { isStraight, lineToCubic, monotoneParameter, monotonePieces, unitQuadraticRoots } from './bezier';
import { EDGE_CUBIC, EDGE_LINE, EDGE_STRIDE, Edges } from './edges';

/**
 * Nearest points under gauge distances d(p, q) = γ(A (q - p)).
 *
 * The linear map A (and for chebyshev an extra 45° rotation) is applied to the geometry up front, so the searches here
 * only deal with the bare unit shapes:
 * - l2: the euclidean circle, see nearestOnCubic in bezier.ts
 * - l1: the manhattan diamond. Chebyshev is half the L1 distance in coordinates rotated by 45°:
 *   max(|a|, |b|) = (|a + b| + |a - b|) / 2.
 * - lp: the Lp ball, 1 < p < ∞
 * - polygon: a regular polygon with apothem 1, γ(w) = max_i n_i . w over its side normals
 *
 * Along an edge the L1 distance f(t) = |X(t) - px| + |Y(t) - py| is continuous and piecewise smooth, so its minimum
 * lies at an endpoint, at a kink (X = px or Y = py), or where the smooth parts are stationary (X' = ±Y').
 * Edges are monotone in x and y, so each kink is a single root, and the stationary points are quadratic roots.
 */

export type Search = 'l2' | 'l1' | 'lp' | 'polygon';

/** a 2x2 matrix, row major: (x, y) -> (m[0] x + m[1] y, m[2] x + m[3] y) */
export type Mat2 = [number, number, number, number];

const IDENTITY: Mat2 = [1, 0, 0, 1];
const MAX_P = 32;

/** A of a spec: rotate by -angle, then shrink the rotated y axis by aspect */
export const metricMatrix = (spec: MetricSpec): Mat2 => {
  const r = (spec.angle * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const k = 1 / (spec.aspect > 0 ? spec.aspect : 1);
  return [cos, sin, -sin * k, cos * k];
};

const multiply = (a: Mat2, b: Mat2): Mat2 => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3]
];

const invert = (m: Mat2): Mat2 => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det];
};

const isIdentity = (m: Mat2) => m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-15);

/** everything a nearest search needs for a metric */
export interface MetricSetup {
  search: Search;
  /** maps world positions into the search space, null when that is the identity */
  matrix: Mat2 | null;
  inverse: Mat2 | null;
  /** search distance to world distance */
  scale: number;
  /** lp exponent */
  p: number;
  /** polygon side normals and the directions of its vertices, xy pairs */
  normals: Float64Array;
  vertices: Float64Array;
}

export const metricSetup = (spec: MetricSpec): MetricSetup => {
  let matrix = metricMatrix(spec);
  let search: Search = 'l2';
  let scale = 1;
  let p = Math.min(MAX_P, Math.max(1, spec.p));
  let sides = 0;
  switch (spec.kind) {
    case 'manhattan':
      search = 'l1';
      break;
    case 'chebyshev':
      search = 'l1';
      matrix = multiply([1, 1, 1, -1], matrix);
      scale = 0.5;
      break;
    case 'lp':
      // the ends of the range are exact elsewhere, and p close to 1 would make the lp search ill conditioned
      if (p <= 1.0001) search = 'l1';
      else if (Math.abs(p - 2) < 1e-12) search = 'l2';
      else search = 'lp';
      break;
    case 'polygon':
      search = 'polygon';
      sides = Math.max(3, Math.min(64, Math.round(spec.sides)));
      break;
  }
  // a rotation leaves euclidean distances as they are
  if (search === 'l2' && Math.abs(spec.aspect - 1) < 1e-12) matrix = IDENTITY;
  const normals = new Float64Array(sides * 2);
  const vertices = new Float64Array(sides * 2);
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    const v = a + Math.PI / sides;
    normals[i * 2] = Math.cos(a);
    normals[i * 2 + 1] = Math.sin(a);
    vertices[i * 2] = Math.cos(v);
    vertices[i * 2 + 1] = Math.sin(v);
  }
  const identity = isIdentity(matrix);
  return {
    search,
    matrix: identity ? null : matrix,
    inverse: identity ? null : invert(matrix),
    scale,
    p,
    normals,
    vertices
  };
};

export interface L1Point {
  d: number;
  x: number;
  y: number;
}

/** L1 nearest point on the line from c[o, o+1] to c[o+6, o+7] */
export const nearestL1Line = (c: ArrayLike<number>, o: number, px: number, py: number, out: L1Point): L1Point => {
  const ax = c[o];
  const ay = c[o + 1];
  const ex = c[o + 6] - ax;
  const ey = c[o + 7] - ay;
  out.d = Infinity;
  // the euclidean projection first: along a 45° line f is flat over a stretch, every point of it is equally near,
  // and preferring the projection there keeps the direction to the nearest point continuous between pixels
  const len2 = ex * ex + ey * ey;
  if (len2 > 0)
    lineCandidate(ax, ay, ex, ey, Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2)), px, py, out);
  // f is piecewise linear, its minimum sits at an endpoint or a kink
  lineCandidate(ax, ay, ex, ey, 0, px, py, out, true);
  if (ex !== 0) lineCandidate(ax, ay, ex, ey, (px - ax) / ex, px, py, out, true);
  if (ey !== 0) lineCandidate(ax, ay, ex, ey, (py - ay) / ey, px, py, out, true);
  lineCandidate(ax, ay, ex, ey, 1, px, py, out, true);
  return out;
};

const lineCandidate = (
  ax: number,
  ay: number,
  ex: number,
  ey: number,
  t: number,
  px: number,
  py: number,
  out: L1Point,
  /** only take the candidate when it is clearly nearer, so ties keep the euclidean projection */
  strict = false
) => {
  if (!(t >= 0 && t <= 1)) return;
  const x = ax + t * ex;
  const y = ay + t * ey;
  const d = Math.abs(x - px) + Math.abs(y - py);
  if (strict ? d < out.d - TIE * (1 + Math.abs(out.d)) : d < out.d) {
    out.d = d;
    out.x = x;
    out.y = y;
  }
};

/** relative difference below which two candidate distances count as a tie */
const TIE = 1e-12;

const candidates = new Float64Array(8);
const quadraticRoots: number[] = [];

/** L1 nearest point on the cubic at c[o .. o + 8], which must be monotone in x and y */
export const nearestL1Cubic = (c: ArrayLike<number>, o: number, px: number, py: number, out: L1Point): L1Point => {
  const x0 = c[o];
  const y0 = c[o + 1];
  const x3 = c[o + 6];
  const y3 = c[o + 7];
  const ax = -x0 + 3 * c[o + 2] - 3 * c[o + 4] + x3;
  const ay = -y0 + 3 * c[o + 3] - 3 * c[o + 5] + y3;
  const bx = 3 * x0 - 6 * c[o + 2] + 3 * c[o + 4];
  const by = 3 * y0 - 6 * c[o + 3] + 3 * c[o + 5];
  const cx = 3 * (c[o + 2] - x0);
  const cy = 3 * (c[o + 3] - y0);

  let n = 0;
  candidates[n++] = 0;
  candidates[n++] = 1;
  // kinks, one at most per axis on a monotone piece
  if ((px - x0) * (px - x3) < 0) candidates[n++] = monotoneParameter(c, o, 0, px);
  if ((py - y0) * (py - y3) < 0) candidates[n++] = monotoneParameter(c, o, 1, py);
  // stationary points of the smooth parts: X' = Y' and X' = -Y'
  quadraticRoots.length = 0;
  unitQuadraticRoots(3 * (ax - ay), 2 * (bx - by), cx - cy, quadraticRoots);
  unitQuadraticRoots(3 * (ax + ay), 2 * (bx + by), cx + cy, quadraticRoots);
  for (const t of quadraticRoots) candidates[n++] = t;
  // ascending, so among equally near points the one with the smallest t wins
  for (let i = 1; i < n; i++)
    for (let j = i; j > 0 && candidates[j - 1] > candidates[j]; j--) {
      const t = candidates[j];
      candidates[j] = candidates[j - 1];
      candidates[j - 1] = t;
    }

  out.d = Infinity;
  for (let i = 0; i < n; i++) {
    const t = candidates[i];
    const x = ((ax * t + bx) * t + cx) * t + x0;
    const y = ((ay * t + by) * t + cy) * t + y0;
    const d = Math.abs(x - px) + Math.abs(y - py);
    if (d < out.d) {
      out.d = d;
      out.x = x;
      out.y = y;
    }
  }
  return out;
};

/** the edges mapped by a linear transform, cubics split again so they are monotone along the new axes too */
export const transformEdges = (edges: Edges, m: Mat2): Edges => {
  const coords: number[] = [];
  const kind: number[] = [];
  const shape: number[] = [];
  const filled: number[] = [];
  const c = edges.coords;
  for (let i = 0; i < edges.count; i++) {
    const o = i * EDGE_STRIDE;
    const r: number[] = [];
    for (let k = 0; k < EDGE_STRIDE; k += 2)
      r.push(m[0] * c[o + k] + m[1] * c[o + k + 1], m[2] * c[o + k] + m[3] * c[o + k + 1]);
    const add = (k: number, piece: number[]) => {
      coords.push(...piece);
      kind.push(k);
      shape.push(edges.shape[i]);
      filled.push(edges.filled[i]);
    };
    if (edges.kind[i] === EDGE_LINE) add(EDGE_LINE, r);
    else
      for (const piece of monotonePieces(r)) {
        if (isStraight(piece)) add(EDGE_LINE, lineToCubic(piece[0], piece[1], piece[6], piece[7]));
        else add(EDGE_CUBIC, piece);
      }
  }
  return {
    count: kind.length,
    coords: Float64Array.from(coords),
    kind: Uint8Array.from(kind),
    shape: Int32Array.from(shape),
    filled: Uint8Array.from(filled),
    lines: kind.filter((k) => k === EDGE_LINE).length,
    curves: kind.filter((k) => k === EDGE_CUBIC).length
  };
};

/**
 * All real roots of a t^3 + b t^2 + c t + d in [0, 1], ascending, written to out from index `at`.
 * Returns the index after the last root. Splits [0, 1] at the critical points, then solves each monotone piece.
 */
export const cubicRootsInUnit = (a: number, b: number, c: number, d: number, out: Float64Array, at = 0): number => {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d));
  if (scale === 0) return at;
  const tiny = 1e-13 * scale;
  // critical points from the derivative 3a t^2 + 2b t + c
  let c1 = 2;
  let c2 = 2;
  const qa = 3 * a;
  const qb = 2 * b;
  const qs = Math.max(Math.abs(qa), Math.abs(qb), Math.abs(c));
  if (qs > 0) {
    const A = qa / qs;
    const B = qb / qs;
    const C = c / qs;
    if (Math.abs(A) < 1e-12) {
      if (Math.abs(B) > 1e-12) c1 = -C / B;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const q = -0.5 * (B + (B < 0 ? -1 : 1) * Math.sqrt(disc));
        c1 = q / A;
        c2 = q !== 0 ? C / q : 2;
      }
    }
  }
  if (c2 < c1) {
    const swap = c1;
    c1 = c2;
    c2 = swap;
  }
  // only roots of this call are deduplicated, the caller may have filled out[0 .. at) already
  const start = at;
  let lo = 0;
  let flo = d;
  if (Math.abs(flo) <= tiny) out[at++] = 0;
  for (let k = 0; k < 3; k++) {
    const hi = k === 0 ? c1 : k === 1 ? c2 : 1;
    if (!(hi > lo && hi <= 1)) continue;
    const fhi = ((a * hi + b) * hi + c) * hi + d;
    if (Math.abs(fhi) <= tiny) {
      if (at === start || hi - out[at - 1] > 1e-12) out[at++] = hi;
    } else if (Math.abs(flo) > tiny && flo * fhi < 0) {
      let l = lo;
      let h = hi;
      let fl = flo;
      let t = (l + h) / 2;
      let previous = h - l;
      let last = previous;
      for (let i = 0; i < 60; i++) {
        const v = ((a * t + b) * t + c) * t + d;
        if (v === 0) break;
        if (v * fl < 0) h = t;
        else {
          l = t;
          fl = v;
        }
        const slope = (3 * a * t + 2 * b) * t + c;
        let next = slope !== 0 ? t - v / slope : NaN;
        if (!(next > l && next < h) || Math.abs(next - t) > 0.5 * previous) next = (l + h) / 2;
        previous = last;
        last = Math.abs(next - t);
        if (Math.abs(next - t) < 1e-15) {
          t = next;
          break;
        }
        t = next;
      }
      if (at === start || t - out[at - 1] > 1e-12) out[at++] = t;
    }
    lo = hi;
    flo = fhi;
  }
  return at;
};

/** result of the lp and polygon searches */
export interface GaugePoint {
  /** lp: |dx|^p + |dy|^p, which orders like the distance without a root; polygon: the gauge itself */
  score: number;
  x: number;
  y: number;
}

/** |e|^p summed over both axes, and its first and second derivative along the curve */
const lpTerms = (
  ex: number,
  ey: number,
  d1x: number,
  d1y: number,
  d2x: number,
  d2y: number,
  p: number,
  out: Float64Array
) => {
  const ax = Math.abs(ex);
  const ay = Math.abs(ey);
  // |e|^(p-1) once per axis, the other powers follow from it
  const px1 = ax > 0 ? Math.pow(ax, p - 1) : 0;
  const py1 = ay > 0 ? Math.pow(ay, p - 1) : 0;
  const sx = ex < 0 ? -px1 : px1;
  const sy = ey < 0 ? -py1 : py1;
  out[0] = px1 * ax + py1 * ay;
  out[1] = p * (sx * d1x + sy * d1y);
  // |e|^(p-2) is unbounded at a kink for p < 2, the caller then falls back to bisection
  const px2 = ax > 0 ? px1 / ax : p >= 2 ? 0 : Infinity;
  const py2 = ay > 0 ? py1 / ay : p >= 2 ? 0 : Infinity;
  out[2] = p * ((p - 1) * (px2 * d1x * d1x + py2 * d1y * d1y) + sx * d2x + sy * d2y);
};

const terms = new Float64Array(3);
const LP_STEPS = 48;

/**
 * Minimises the lp score of the cubic in power basis (relative to the query) on [lo, hi] from t, by Newton steps on
 * the derivative kept inside the bracket, falling back to bisection. Returns the parameter.
 */
const refineLp = (
  ax: number,
  bx: number,
  cx: number,
  dx: number,
  ay: number,
  by: number,
  cy: number,
  dy: number,
  p: number,
  lo: number,
  hi: number,
  t: number
): number => {
  // when g' does not change sign over the bracket the minimum is at one of its ends, no iteration needed
  const slopeAt = (u: number) => {
    const ex = ((ax * u + bx) * u + cx) * u + dx;
    const ey = ((ay * u + by) * u + cy) * u + dy;
    const d1x = (3 * ax * u + 2 * bx) * u + cx;
    const d1y = (3 * ay * u + 2 * by) * u + cy;
    return Math.sign(ex) * Math.pow(Math.abs(ex), p - 1) * d1x + Math.sign(ey) * Math.pow(Math.abs(ey), p - 1) * d1y;
  };
  if (slopeAt(lo) >= 0) return lo;
  if (slopeAt(hi) <= 0) return hi;
  // the step before last; newton steps longer than half of it are not converging and are replaced by bisection
  let previous = hi - lo;
  let last = previous;
  for (let i = 0; i < LP_STEPS; i++) {
    const ex = ((ax * t + bx) * t + cx) * t + dx;
    const ey = ((ay * t + by) * t + cy) * t + dy;
    lpTerms(
      ex,
      ey,
      (3 * ax * t + 2 * bx) * t + cx,
      (3 * ay * t + 2 * by) * t + cy,
      6 * ax * t + 2 * bx,
      6 * ay * t + 2 * by,
      p,
      terms
    );
    const g1 = terms[1];
    if (g1 > 0) hi = t;
    else lo = t;
    let next = terms[2] > 0 && Number.isFinite(terms[2]) ? t - g1 / terms[2] : NaN;
    // bisect when newton leaves the bracket, or stops shrinking its steps: near a kink |e|^(p-1) behaves like a root
    // for p < 2 and newton then ping-pongs from side to side while the bracket barely shrinks
    if (!(next >= lo && next <= hi) || Math.abs(next - t) > 0.5 * previous) next = (lo + hi) / 2;
    previous = last;
    last = Math.abs(next - t);
    if (Math.abs(next - t) < 1e-11 || hi - lo < 1e-11) return next;
    t = next;
  }
  return t;
};

const LP_SAMPLES = 12;
const lpSamples = new Float64Array(LP_SAMPLES + 1);

/**
 * Lp nearest point on the edge at c[o .. o + 8], a line when `line` (its score is convex along the line), otherwise
 * a monotone cubic: sampled, then refined around every local minimum of the samples.
 */
export const nearestLp = (
  c: ArrayLike<number>,
  o: number,
  line: boolean,
  px: number,
  py: number,
  p: number,
  out: GaugePoint
): GaugePoint => {
  const x0 = c[o];
  const y0 = c[o + 1];
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  let cx: number;
  let cy: number;
  if (line) {
    cx = c[o + 6] - x0;
    cy = c[o + 7] - y0;
  } else {
    ax = -x0 + 3 * c[o + 2] - 3 * c[o + 4] + c[o + 6];
    ay = -y0 + 3 * c[o + 3] - 3 * c[o + 5] + c[o + 7];
    bx = 3 * x0 - 6 * c[o + 2] + 3 * c[o + 4];
    by = 3 * y0 - 6 * c[o + 3] + 3 * c[o + 5];
    cx = 3 * (c[o + 2] - x0);
    cy = 3 * (c[o + 3] - y0);
  }
  const dx = x0 - px;
  const dy = y0 - py;
  const score = (t: number) => {
    const ex = Math.abs(((ax * t + bx) * t + cx) * t + dx);
    const ey = Math.abs(((ay * t + by) * t + cy) * t + dy);
    return Math.pow(ex, p) + Math.pow(ey, p);
  };

  let best = Infinity;
  let bestT = 0;
  const consider = (t: number) => {
    const v = score(t);
    if (v < best) {
      best = v;
      bestT = t;
    }
  };
  if (line) {
    consider(0);
    consider(1);
    // g is convex along a line and smooth between its kinks (where x or y meets the query), so find the smooth
    // interval in which g' turns positive, then refine inside it where newton converges quickly
    const kx = cx !== 0 ? -dx / cx : -1;
    const ky = cy !== 0 ? -dy / cy : -1;
    let lo = 0;
    let hi = 1;
    for (const k of kx < ky ? [kx, ky] : [ky, kx]) {
      if (!(k > lo && k < hi)) continue;
      const ex = cx * k + dx;
      const ey = cy * k + dy;
      // g'(k), one of the two terms vanishes at the kink
      const slope =
        Math.sign(ex) * Math.pow(Math.abs(ex), p - 1) * cx + Math.sign(ey) * Math.pow(Math.abs(ey), p - 1) * cy;
      if (slope > 0) hi = k;
      else lo = k;
    }
    consider(lo);
    consider(hi);
    consider(refineLp(0, 0, cx, dx, 0, 0, cy, dy, p, lo, hi, (lo + hi) / 2));
  } else {
    for (let i = 0; i <= LP_SAMPLES; i++) lpSamples[i] = score(i / LP_SAMPLES);
    for (let i = 0; i <= LP_SAMPLES; i++) {
      if ((i > 0 && lpSamples[i - 1] < lpSamples[i]) || (i < LP_SAMPLES && lpSamples[i + 1] < lpSamples[i])) continue;
      consider(i / LP_SAMPLES);
      const lo = Math.max(0, (i - 1) / LP_SAMPLES);
      const hi = Math.min(1, (i + 1) / LP_SAMPLES);
      consider(refineLp(ax, bx, cx, dx, ay, by, cy, dy, p, lo, hi, i / LP_SAMPLES));
    }
  }
  out.score = best;
  out.x = ((ax * bestT + bx) * bestT + cx) * bestT + x0;
  out.y = ((ay * bestT + by) * bestT + cy) * bestT + y0;
  return out;
};

const polygonCandidates = new Float64Array(8 * 64 + 2);

/**
 * Polygon gauge nearest point on the edge at c[o .. o + 8]: F(t) = max_i n_i . (B(t) - q) is smooth inside each cone of
 * the polygon, so its minimum lies at an endpoint, where B - q crosses a vertex direction (cross(v_k, B - q) = 0),
 * or where the active side's piece is stationary (n_k . B' = 0). F is evaluated at all of them.
 */
export const nearestPolygon = (
  c: ArrayLike<number>,
  o: number,
  line: boolean,
  px: number,
  py: number,
  normals: Float64Array,
  vertices: Float64Array,
  out: GaugePoint
): GaugePoint => {
  const x0 = c[o];
  const y0 = c[o + 1];
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  let cx: number;
  let cy: number;
  if (line) {
    cx = c[o + 6] - x0;
    cy = c[o + 7] - y0;
  } else {
    ax = -x0 + 3 * c[o + 2] - 3 * c[o + 4] + c[o + 6];
    ay = -y0 + 3 * c[o + 3] - 3 * c[o + 5] + c[o + 7];
    bx = 3 * x0 - 6 * c[o + 2] + 3 * c[o + 4];
    by = 3 * y0 - 6 * c[o + 3] + 3 * c[o + 5];
    cx = 3 * (c[o + 2] - x0);
    cy = 3 * (c[o + 3] - y0);
  }
  const dx = x0 - px;
  const dy = y0 - py;
  const n = normals.length / 2;
  const cand = polygonCandidates;
  let count = 0;
  cand[count++] = 0;
  cand[count++] = 1;
  if (line) {
    // F is piecewise linear along a line, it bends only where the line crosses a vertex ray: cross(v, w0 + t e) = 0
    for (let k = 0; k < n; k++) {
      const vx = vertices[k * 2];
      const vy = vertices[k * 2 + 1];
      const denom = vx * cy - vy * cx;
      if (denom === 0) continue;
      const t = -(vx * dy - vy * dx) / denom;
      if (t > 0 && t < 1) cand[count++] = t;
    }
  } else {
    // control points relative to the query, and the hodograph (derivative control points)
    const q0x = dx;
    const q0y = dy;
    const q1x = c[o + 2] - px;
    const q1y = c[o + 3] - py;
    const q2x = c[o + 4] - px;
    const q2y = c[o + 5] - py;
    const q3x = c[o + 6] - px;
    const q3y = c[o + 7] - py;
    for (let k = 0; k < n; k++) {
      const vx = vertices[k * 2];
      const vy = vertices[k * 2 + 1];
      // the curve lies in the hull of its control points: when they are all on one side of the ray, no crossing
      const s0 = vx * q0y - vy * q0x;
      const s1 = vx * q1y - vy * q1x;
      const s2 = vx * q2y - vy * q2x;
      const s3 = vx * q3y - vy * q3x;
      if (!((s0 > 0 && s1 > 0 && s2 > 0 && s3 > 0) || (s0 < 0 && s1 < 0 && s2 < 0 && s3 < 0)))
        count = cubicRootsInUnit(
          vx * ay - vy * ax,
          vx * by - vy * bx,
          vx * cy - vy * cx,
          vx * dy - vy * dx,
          cand,
          count
        );
      // n . B'(t) has the hodograph as control points, the same test applies
      const nx = normals[k * 2];
      const ny = normals[k * 2 + 1];
      const h0 = nx * (q1x - q0x) + ny * (q1y - q0y);
      const h1 = nx * (q2x - q1x) + ny * (q2y - q1y);
      const h2 = nx * (q3x - q2x) + ny * (q3y - q2y);
      if (!((h0 > 0 && h1 > 0 && h2 > 0) || (h0 < 0 && h1 < 0 && h2 < 0)))
        count = cubicRootsInUnit(0, 3 * (nx * ax + ny * ay), 2 * (nx * bx + ny * by), nx * cx + ny * cy, cand, count);
    }
  }
  let best = Infinity;
  let bestT = 0;
  // on a line parallel to a side F is flat over a stretch; the euclidean projection goes first and wins such ties,
  // which keeps the direction to the nearest point continuous between pixels
  let first = 0;
  if (line) {
    const len2 = cx * cx + cy * cy;
    cand[count] = len2 > 0 ? Math.min(1, Math.max(0, -(dx * cx + dy * cy) / len2)) : 0;
    first = count;
    count++;
  }
  for (let j = 0; j < count; j++) {
    const i = (first + j) % count;
    const t = cand[i];
    const ex = ((ax * t + bx) * t + cx) * t + dx;
    const ey = ((ay * t + by) * t + cy) * t + dy;
    let f = -Infinity;
    for (let k = 0; k < n; k++) f = Math.max(f, normals[k * 2] * ex + normals[k * 2 + 1] * ey);
    if (j === 0 || f < best - TIE * (1 + Math.abs(best))) {
      best = f;
      bestT = t;
    }
  }
  out.score = best;
  out.x = ((ax * bestT + bx) * bestT + cx) * bestT + x0;
  out.y = ((ay * bestT + by) * bestT + cy) * bestT + y0;
  return out;
};
