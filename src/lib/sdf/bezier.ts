/**
 * Cubic bezier helpers for the exact curve mode. A cubic is 8 numbers: x0 y0 x1 y1 x2 y2 x3 y3.
 * Curves are split into pieces that are monotone in x and y and free of inflections, which makes
 * their endpoint box their exact bounding box, lets every horizontal line cross them at most once,
 * and keeps the nearest point search well behaved.
 */

const EPS = 1e-9;

/** roots of a t^2 + b t + c in the open interval (0, 1) */
export const unitQuadraticRoots = (a: number, b: number, c: number, out: number[]) => {
  const scale = Math.max(Math.abs(a), Math.abs(b), Math.abs(c));
  if (scale === 0) return;
  a /= scale;
  b /= scale;
  c /= scale;
  const push = (t: number) => {
    if (t > EPS && t < 1 - EPS) out.push(t);
  };
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) push(-c / b);
    return;
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return;
  // the numerically stable form, avoids cancellation in -b ± sqrt(disc)
  const q = -0.5 * (b + Math.sign(b || 1) * Math.sqrt(disc));
  push(q / a);
  if (q !== 0) push(c / q);
};

/** parameters where the cubic turns in x or y, or where its curvature changes sign */
export const splitParameters = (p: ArrayLike<number>): number[] => {
  const ts: number[] = [];
  // power basis B(t) = a t^3 + b t^2 + c t + d, per axis
  const ax = -p[0] + 3 * p[2] - 3 * p[4] + p[6];
  const ay = -p[1] + 3 * p[3] - 3 * p[5] + p[7];
  const bx = 3 * p[0] - 6 * p[2] + 3 * p[4];
  const by = 3 * p[1] - 6 * p[3] + 3 * p[5];
  const cx = 3 * (p[2] - p[0]);
  const cy = 3 * (p[3] - p[1]);
  // B'(t) = 3a t^2 + 2b t + c
  unitQuadraticRoots(3 * ax, 2 * bx, cx, ts);
  unitQuadraticRoots(3 * ay, 2 * by, cy, ts);
  // inflections: B' x B'' = 0, which works out to -6 (a x b) t^2 + 6 (c x a) t + 2 (c x b)
  const axb = ax * by - ay * bx;
  const cxa = cx * ay - cy * ax;
  const cxb = cx * by - cy * bx;
  unitQuadraticRoots(-6 * axb, 6 * cxa, 2 * cxb, ts);
  ts.sort((a, b) => a - b);
  return ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-7);
};

/** the part of the cubic between parameters t0 and t1, by two de casteljau splits */
export const subCubic = (p: ArrayLike<number>, t0: number, t1: number): number[] => {
  const split = (q: number[], t: number, keepRight: boolean): number[] => {
    const lerp = (a: number, b: number) => a + (b - a) * t;
    const out: number[] = new Array(8);
    for (let k = 0; k < 2; k++) {
      const p0 = q[k];
      const p1 = q[2 + k];
      const p2 = q[4 + k];
      const p3 = q[6 + k];
      const a = lerp(p0, p1);
      const b = lerp(p1, p2);
      const c = lerp(p2, p3);
      const d = lerp(a, b);
      const e = lerp(b, c);
      const f = lerp(d, e);
      if (keepRight) [out[k], out[2 + k], out[4 + k], out[6 + k]] = [f, e, c, p3];
      else [out[k], out[2 + k], out[4 + k], out[6 + k]] = [p0, a, d, f];
    }
    return out;
  };
  let q = Array.from(p);
  if (t1 < 1) q = split(q, t1, false);
  if (t0 > 0) q = split(q, t0 / t1, true);
  return q;
};

/** whether the control points lie on the chord, so the piece is a straight line between its endpoints */
export const isStraight = (p: ArrayLike<number>): boolean => {
  const dx = p[6] - p[0];
  const dy = p[7] - p[1];
  const len = Math.hypot(dx, dy);
  const scale = Math.max(len, Math.hypot(p[2] - p[0], p[3] - p[1]), Math.hypot(p[4] - p[6], p[5] - p[7]));
  if (scale === 0) return true;
  if (len === 0) return false;
  const off = (x: number, y: number) => Math.abs((x - p[0]) * dy - (y - p[1]) * dx) / len;
  return Math.max(off(p[2], p[3]), off(p[4], p[5])) <= 1e-9 * scale;
};

/** splits a cubic into monotone, inflection free pieces */
export const monotonePieces = (p: ArrayLike<number>): number[][] => {
  const ts = [0, ...splitParameters(p), 1];
  const pieces: number[][] = [];
  for (let i = 0; i + 1 < ts.length; i++) {
    const piece = subCubic(p, ts[i], ts[i + 1]);
    // neighbours share their endpoint exactly, the scanline inside test depends on it
    const prev = pieces[pieces.length - 1];
    piece[0] = prev ? prev[6] : p[0];
    piece[1] = prev ? prev[7] : p[1];
    if (i + 2 === ts.length) {
      piece[6] = p[6];
      piece[7] = p[7];
    }
    pieces.push(piece);
  }
  return pieces;
};

/** a quadratic as the identical cubic */
export const quadraticToCubic = (x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number[] => [
  x0,
  y0,
  x0 + (2 / 3) * (x1 - x0),
  y0 + (2 / 3) * (y1 - y0),
  x2 + (2 / 3) * (x1 - x2),
  y2 + (2 / 3) * (y1 - y2),
  x2,
  y2
];

/** a line as a cubic, control points at the thirds */
export const lineToCubic = (x0: number, y0: number, x1: number, y1: number): number[] => [
  x0,
  y0,
  x0 + (x1 - x0) / 3,
  y0 + (y1 - y0) / 3,
  x0 + (2 * (x1 - x0)) / 3,
  y0 + (2 * (y1 - y0)) / 3,
  x1,
  y1
];

const SAMPLES = 12;
const NEWTON_STEPS = 12;
const sampleDistances = new Float64Array(SAMPLES + 1);

export interface CurvePoint {
  d2: number;
  x: number;
  y: number;
  t: number;
}

/**
 * The point on the cubic stored at c[o .. o + 8] nearest to (px, py).
 * Samples the piece, then refines every local minimum of the samples with Newton steps on (B - p) . B' = 0,
 * kept inside the bracket of the neighbouring samples and falling back to bisection when a step leaves it.
 */
export const nearestOnCubic = (
  c: ArrayLike<number>,
  o: number,
  px: number,
  py: number,
  out: CurvePoint
): CurvePoint => {
  const x0 = c[o];
  const y0 = c[o + 1];
  // power basis, relative to the query point
  const ax = -x0 + 3 * c[o + 2] - 3 * c[o + 4] + c[o + 6];
  const ay = -y0 + 3 * c[o + 3] - 3 * c[o + 5] + c[o + 7];
  const bx = 3 * x0 - 6 * c[o + 2] + 3 * c[o + 4];
  const by = 3 * y0 - 6 * c[o + 3] + 3 * c[o + 5];
  const cx = 3 * (c[o + 2] - x0);
  const cy = 3 * (c[o + 3] - y0);
  const dx = x0 - px;
  const dy = y0 - py;
  const dist2 = (t: number) => {
    const ex = ((ax * t + bx) * t + cx) * t + dx;
    const ey = ((ay * t + by) * t + cy) * t + dy;
    return ex * ex + ey * ey;
  };

  const d = sampleDistances;
  for (let i = 0; i <= SAMPLES; i++) d[i] = dist2(i / SAMPLES);

  let best = Infinity;
  let bestT = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    if ((i > 0 && d[i - 1] < d[i]) || (i < SAMPLES && d[i + 1] < d[i])) continue;
    let lo = Math.max(0, (i - 1) / SAMPLES);
    let hi = Math.min(1, (i + 1) / SAMPLES);
    let t = i / SAMPLES;
    for (let k = 0; k < NEWTON_STEPS; k++) {
      const ex = ((ax * t + bx) * t + cx) * t + dx;
      const ey = ((ay * t + by) * t + cy) * t + dy;
      const d1x = (3 * ax * t + 2 * bx) * t + cx;
      const d1y = (3 * ay * t + 2 * by) * t + cy;
      const f = ex * d1x + ey * d1y;
      const fp = d1x * d1x + d1y * d1y + ex * (6 * ax * t + 2 * bx) + ey * (6 * ay * t + 2 * by);
      if (f > 0) hi = t;
      else lo = t;
      let next = fp > 0 ? t - f / fp : NaN;
      if (!(next >= lo && next <= hi)) next = (lo + hi) / 2;
      if (Math.abs(next - t) < 1e-14) break;
      t = next;
    }
    const refined = dist2(t);
    if (refined < best) {
      best = refined;
      bestT = t;
    }
    if (d[i] < best) {
      best = d[i];
      bestT = i / SAMPLES;
    }
  }

  out.d2 = best;
  out.x = ((ax * bestT + bx) * bestT + cx) * bestT + x0;
  out.y = ((ay * bestT + by) * bestT + cy) * bestT + y0;
  out.t = bestT;
  return out;
};

/**
 * The parameter where a cubic at c[o .. o + 8], monotone along `axis` (0 = x, 1 = y), reaches `value`,
 * which must lie between the end values on that axis. Newton steps, kept in a shrinking bracket.
 */
export const monotoneParameter = (c: ArrayLike<number>, o: number, axis: 0 | 1, value: number): number => {
  const v0 = c[o + axis];
  const v3 = c[o + 6 + axis];
  const a = -v0 + 3 * c[o + 2 + axis] - 3 * c[o + 4 + axis] + v3;
  const b = 3 * v0 - 6 * c[o + 2 + axis] + 3 * c[o + 4 + axis];
  const k = 3 * (c[o + 2 + axis] - v0);
  const rising = v3 > v0;
  let lo = 0;
  let hi = 1;
  let t = (value - v0) / (v3 - v0);
  for (let i = 0; i < 40; i++) {
    const f = ((a * t + b) * t + k) * t + v0 - value;
    if (f > 0 === rising) hi = t;
    else lo = t;
    const fp = (3 * a * t + 2 * b) * t + k;
    let next = fp !== 0 ? t - f / fp : NaN;
    if (!(next >= lo && next <= hi)) next = (lo + hi) / 2;
    if (Math.abs(next - t) < 1e-14) return next;
    t = next;
  }
  return t;
};

/** x where a y-monotone cubic at c[o .. o + 8] crosses the horizontal line at y, which must lie between its end ys */
export const crossingX = (c: ArrayLike<number>, o: number, y: number): number => {
  const t = monotoneParameter(c, o, 1, y);
  const x0 = c[o];
  const ax = -x0 + 3 * c[o + 2] - 3 * c[o + 4] + c[o + 6];
  const bx = 3 * x0 - 6 * c[o + 2] + 3 * c[o + 4];
  const cx = 3 * (c[o + 2] - x0);
  return ((ax * t + bx) * t + cx) * t + x0;
};
