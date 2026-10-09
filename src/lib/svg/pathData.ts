import { Contour, Matrix, PathSegment, Subpath } from '../types';
import { NumberScanner } from './numbers';
import { apply } from './transform';

const ARGUMENT_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/**
 * Parses svg path data into subpaths of lines, quadratic and cubic beziers in absolute coordinates.
 * Arcs become cubics. Like a browser it keeps everything up to the first malformed command.
 */
export const parsePathData = (d: string | null | undefined): Subpath[] => {
  const subpaths: Subpath[] = [];
  if (!d) return subpaths;
  const s = new NumberScanner(d);

  let current: Subpath | null = null;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // reflected control points for S and T, only valid right after a C/S or Q/T
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let command = '';

  const ensureSubpath = () => {
    if (!current) {
      current = { x, y, segments: [], closed: false };
      subpaths.push(current);
    }
    return current;
  };

  try {
    while (!s.done) {
      if (!s.isNumberStart()) {
        command = s.next();
        if (!(command.toUpperCase() in ARGUMENT_COUNT)) throw new Error(`unknown path command ${command}`);
      } else if (!command || command === 'z' || command === 'Z') {
        throw new Error('path data without a command');
      }
      const upper = command.toUpperCase();
      const relative = command !== upper;
      const ox = relative ? x : 0;
      const oy = relative ? y : 0;
      // a drawing command right after z starts a new subpath at the current point
      if (upper !== 'M' && upper !== 'Z') ensureSubpath();

      switch (upper) {
        case 'M': {
          x = ox + s.number();
          y = oy + s.number();
          startX = x;
          startY = y;
          current = { x, y, segments: [], closed: false };
          subpaths.push(current);
          // further coordinate pairs after a moveto are linetos
          command = relative ? 'l' : 'L';
          lastCubic = lastQuad = null;
          break;
        }
        case 'L':
        case 'H':
        case 'V': {
          if (upper !== 'V') x = ox + s.number();
          if (upper !== 'H') y = oy + s.number();
          ensureSubpath().segments.push({ type: 'L', x, y });
          lastCubic = lastQuad = null;
          break;
        }
        case 'C':
        case 'S': {
          let x1: number;
          let y1: number;
          if (upper === 'C') {
            x1 = ox + s.number();
            y1 = oy + s.number();
          } else {
            x1 = lastCubic ? 2 * x - lastCubic[0] : x;
            y1 = lastCubic ? 2 * y - lastCubic[1] : y;
          }
          const x2 = ox + s.number();
          const y2 = oy + s.number();
          x = ox + s.number();
          y = oy + s.number();
          ensureSubpath().segments.push({ type: 'C', x1, y1, x2, y2, x, y });
          lastCubic = [x2, y2];
          lastQuad = null;
          break;
        }
        case 'Q':
        case 'T': {
          let x1: number;
          let y1: number;
          if (upper === 'Q') {
            x1 = ox + s.number();
            y1 = oy + s.number();
          } else {
            x1 = lastQuad ? 2 * x - lastQuad[0] : x;
            y1 = lastQuad ? 2 * y - lastQuad[1] : y;
          }
          x = ox + s.number();
          y = oy + s.number();
          ensureSubpath().segments.push({ type: 'Q', x1, y1, x, y });
          lastQuad = [x1, y1];
          lastCubic = null;
          break;
        }
        case 'A': {
          const rx = s.number();
          const ry = s.number();
          const rotation = s.number();
          const largeArc = s.flag();
          const sweep = s.flag();
          const x2 = ox + s.number();
          const y2 = oy + s.number();
          ensureSubpath().segments.push(...arcToCubics(x, y, rx, ry, rotation, largeArc, sweep, x2, y2));
          x = x2;
          y = y2;
          lastCubic = lastQuad = null;
          break;
        }
        case 'Z': {
          if (current) {
            (current as Subpath).closed = true;
            current = null;
          }
          x = startX;
          y = startY;
          lastCubic = lastQuad = null;
          break;
        }
      }
    }
  } catch {
    // keep what was parsed so far
  }
  return subpaths;
};

/** svg arc (endpoint parameterisation) to at most quarter-turn cubic beziers, see svg spec appendix F.6 */
export const arcToCubics = (
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number
): PathSegment[] => {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) return [{ type: 'L', x: x2, y: y2 }];

  const phi = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cos * dx2 + sin * dy2;
  const y1p = -sin * dx2 + cos * dy2;

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const theta1 = angle(1, 0, ux, uy);
  let dTheta = angle(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  else if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const n = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2) - 1e-9));
  const delta = dTheta / n;
  const k = (4 / 3) * Math.tan(delta / 4);
  const point = (t: number): [number, number] => [
    cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos
  ];
  const tangent = (t: number): [number, number] => [
    -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos
  ];

  const out: PathSegment[] = [];
  for (let i = 0; i < n; i++) {
    const t1 = theta1 + i * delta;
    const t2 = t1 + delta;
    const p1 = point(t1);
    const d1 = tangent(t1);
    // land exactly on the requested end point, avoids slivers when the subpath gets closed
    const p2 = i === n - 1 ? ([x2, y2] as [number, number]) : point(t2);
    const d2 = tangent(t2);
    out.push({
      type: 'C',
      x1: p1[0] + k * d1[0],
      y1: p1[1] + k * d1[1],
      x2: p2[0] - k * d2[0],
      y2: p2[1] - k * d2[1],
      x: p2[0],
      y: p2[1]
    });
  }
  return out;
};

/** applies an affine transform to every point of the subpaths, beziers stay beziers under affine maps */
export const transformSubpaths = (subpaths: Subpath[], m: Matrix): Subpath[] =>
  subpaths.map((sp) => {
    const [x, y] = apply(m, sp.x, sp.y);
    return {
      x,
      y,
      closed: sp.closed,
      segments: sp.segments.map((seg): PathSegment => {
        const [px, py] = apply(m, seg.x, seg.y);
        if (seg.type === 'L') return { type: 'L', x: px, y: py };
        const [x1, y1] = apply(m, seg.x1, seg.y1);
        if (seg.type === 'Q') return { type: 'Q', x1, y1, x: px, y: py };
        const [x2, y2] = apply(m, seg.x2, seg.y2);
        return { type: 'C', x1, y1, x2, y2, x: px, y: py };
      })
    };
  });

const MAX_PIECES = 4096;

/**
 * Flattens subpaths into polylines whose distance to the true curve stays below `tolerance`.
 * The piece count per curve follows Wang's formula. `close` forces every contour closed, svg fills open subpaths as if they were.
 */
export const flattenSubpaths = (subpaths: Subpath[], tolerance: number, close = false): Contour[] => {
  const contours: Contour[] = [];
  for (const sp of subpaths) {
    const pts: number[] = [sp.x, sp.y];
    let x = sp.x;
    let y = sp.y;
    for (const seg of sp.segments) {
      if (seg.type === 'L') {
        pts.push(seg.x, seg.y);
      } else if (seg.type === 'Q') {
        const m = Math.hypot(x - 2 * seg.x1 + seg.x, y - 2 * seg.y1 + seg.y);
        const n = pieceCount(0.25 * m, tolerance);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          pts.push(u * u * x + 2 * u * t * seg.x1 + t * t * seg.x, u * u * y + 2 * u * t * seg.y1 + t * t * seg.y);
        }
      } else {
        const m = Math.max(
          Math.hypot(x - 2 * seg.x1 + seg.x2, y - 2 * seg.y1 + seg.y2),
          Math.hypot(seg.x1 - 2 * seg.x2 + seg.x, seg.y1 - 2 * seg.y2 + seg.y)
        );
        const n = pieceCount(0.75 * m, tolerance);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const d = t * t * t;
          pts.push(a * x + b * seg.x1 + c * seg.x2 + d * seg.x, a * y + b * seg.y1 + c * seg.y2 + d * seg.y);
        }
      }
      x = seg.x;
      y = seg.y;
    }
    const closed = sp.closed || close;
    const points = dedupe(pts, closed);
    if (points.length < 4) continue;
    contours.push({ points, closed });
  }
  return contours;
};

const pieceCount = (scaledSecondDifference: number, tolerance: number) =>
  Math.min(MAX_PIECES, Math.max(1, Math.ceil(Math.sqrt(scaledSecondDifference / tolerance))));

/** drops consecutive duplicate points, and for closed contours the last point when it repeats the first */
const dedupe = (pts: number[], closed: boolean): Float64Array => {
  const out: number[] = [];
  for (let i = 0; i < pts.length; i += 2) {
    const n = out.length;
    if (n && out[n - 2] === pts[i] && out[n - 1] === pts[i + 1]) continue;
    out.push(pts[i], pts[i + 1]);
  }
  const n = out.length;
  if (closed && n >= 4 && out[0] === out[n - 2] && out[1] === out[n - 1]) out.length = n - 2;
  return Float64Array.from(out);
};
