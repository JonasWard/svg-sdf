import { isStraight, lineToCubic, monotoneParameter, monotonePieces, unitQuadraticRoots } from './bezier';
import { EDGE_CUBIC, EDGE_LINE, EDGE_STRIDE, Edges } from './edges';

/**
 * Nearest points under the Manhattan (L1) metric. Chebyshev (L∞) reduces to L1 in coordinates rotated by 45°:
 * max(|a|, |b|) = (|a + b| + |a - b|) / 2, so a Chebyshev query is an L1 query on (x + y, x - y), halved.
 *
 * Along an edge the L1 distance f(t) = |X(t) - px| + |Y(t) - py| is continuous and piecewise smooth, so its minimum
 * lies at an endpoint, at a kink (X = px or Y = py), or where the smooth parts are stationary (X' = ±Y').
 * Edges are monotone in x and y, so each kink is a single root, and the stationary points are quadratic roots.
 */

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
  // f is piecewise linear, its minimum sits at an endpoint or a kink
  lineCandidate(ax, ay, ex, ey, 0, px, py, out);
  if (ex !== 0) lineCandidate(ax, ay, ex, ey, (px - ax) / ex, px, py, out);
  if (ey !== 0) lineCandidate(ax, ay, ex, ey, (py - ay) / ey, px, py, out);
  lineCandidate(ax, ay, ex, ey, 1, px, py, out);
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
  out: L1Point
) => {
  if (!(t >= 0 && t <= 1)) return;
  const x = ax + t * ex;
  const y = ay + t * ey;
  const d = Math.abs(x - px) + Math.abs(y - py);
  if (d < out.d) {
    out.d = d;
    out.x = x;
    out.y = y;
  }
};

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

/**
 * The edges rotated by 45° into the space where chebyshev distance is half the manhattan distance.
 * Cubics are split again so they are monotone along the rotated axes too.
 */
export const toChebyshevEdges = (edges: Edges): Edges => {
  const coords: number[] = [];
  const kind: number[] = [];
  const shape: number[] = [];
  const filled: number[] = [];
  const c = edges.coords;
  for (let i = 0; i < edges.count; i++) {
    const r: number[] = [];
    for (let k = 0; k < EDGE_STRIDE; k += 2)
      r.push(c[i * EDGE_STRIDE + k] + c[i * EDGE_STRIDE + k + 1], c[i * EDGE_STRIDE + k] - c[i * EDGE_STRIDE + k + 1]);
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
