import { describe, expect, it } from 'vitest';
import { arcToCubics, flattenSubpaths, parsePathData } from './pathData';
import { apply, multiply, parseTransform, rotate, translate } from './transform';

describe('parsePathData', () => {
  it('reads absolute and relative lines, with implicit linetos after a moveto', () => {
    const [sp] = parsePathData('M10 10 20 10 l0 10 h-10 v-5 H5 V0 z');
    expect(sp.x).toBe(10);
    expect(sp.closed).toBe(true);
    expect(sp.segments.map((s) => [s.x, s.y])).toEqual([
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 15],
      [5, 15],
      [5, 0]
    ]);
  });

  it('handles glued numbers and exponents', () => {
    const [sp] = parsePathData('M.5.5L-1e1-2.5e-1');
    expect(sp.x).toBe(0.5);
    expect(sp.y).toBe(0.5);
    expect(sp.segments[0]).toEqual({ type: 'L', x: -10, y: -0.25 });
  });

  it('reflects control points for S and T', () => {
    const [sp] = parsePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0 Q25 5 30 0 T40 0');
    expect(sp.segments[1]).toMatchObject({ type: 'C', x1: 10, y1: -10, x2: 20, y2: -10, x: 20, y: 0 });
    expect(sp.segments[3]).toMatchObject({ type: 'Q', x1: 35, y1: -5, x: 40, y: 0 });
  });

  it('starts a new subpath at the start point after z', () => {
    const sps = parsePathData('M0 0 L10 0 L10 10 Z l5 5');
    expect(sps).toHaveLength(2);
    expect(sps[1].x).toBe(0);
    expect(sps[1].segments[0]).toMatchObject({ x: 5, y: 5 });
  });

  it('keeps everything before an error', () => {
    const sps = parsePathData('M0 0 L10 0 L10 x');
    expect(sps[0].segments).toHaveLength(1);
  });

  it('parses arc flags glued to the next number', () => {
    const [sp] = parsePathData('M0 0a5 5 0 1010 0');
    const last = sp.segments[sp.segments.length - 1];
    expect(last.x).toBeCloseTo(10);
    expect(last.y).toBeCloseTo(0);
  });
});

describe('arcToCubics', () => {
  it('approximates a half circle, every flattened point near radius 10', () => {
    const segments = arcToCubics(10, 0, 10, 10, 0, false, true, -10, 0);
    expect(segments.length).toBe(2);
    const [contour] = flattenSubpaths([{ x: 10, y: 0, segments, closed: false }], 0.001);
    for (let i = 0; i < contour.points.length; i += 2) {
      expect(Math.hypot(contour.points[i], contour.points[i + 1])).toBeCloseTo(10, 2);
      // sweep flag set: positive angle direction, with y down that passes through +y
      expect(contour.points[i + 1]).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('scales up radii that are too small', () => {
    const segments = arcToCubics(0, 0, 1, 1, 0, false, true, 10, 0);
    const end = segments[segments.length - 1];
    expect(end.x).toBe(10);
    expect(end.y).toBe(0);
  });
});

describe('flattenSubpaths', () => {
  it('keeps flattened cubics within tolerance', () => {
    const tolerance = 0.01;
    const [sp] = parsePathData('M0 0 C0 100 100 100 100 0');
    const [contour] = flattenSubpaths([sp], tolerance);
    // midpoint of the curve at t = 0.5 is (50, 75); some flattened point or edge lies near it
    let best = Infinity;
    const p = contour.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const ex = p[i + 2] - ax;
      const ey = p[i + 3] - ay;
      const t = Math.max(0, Math.min(1, ((50 - ax) * ex + (75 - ay) * ey) / (ex * ex + ey * ey)));
      best = Math.min(best, Math.hypot(ax + t * ex - 50, ay + t * ey - 75));
    }
    expect(best).toBeLessThan(tolerance);
  });

  it('drops the repeated closing point of closed contours only', () => {
    const closed = flattenSubpaths(parsePathData('M0 0 L10 0 L10 10 L0 0 Z'), 1)[0];
    expect(closed.points.length).toBe(6);
    const open = flattenSubpaths(parsePathData('M0 0 L10 0 L10 10 L0 0'), 1)[0];
    expect(open.points.length).toBe(8);
    expect(open.closed).toBe(false);
  });
});

describe('transforms', () => {
  it('applies transform lists left to right like svg', () => {
    const m = parseTransform('translate(10, 0) scale(2)');
    expect(apply(m, 1, 1)).toEqual([12, 2]);
  });

  it('rotates about a centre', () => {
    const [x, y] = apply(parseTransform('rotate(90 10 10)'), 20, 10);
    expect(x).toBeCloseTo(10);
    expect(y).toBeCloseTo(20);
  });

  it('composes like matrix multiplication', () => {
    const m = multiply(translate(5, 5), rotate(180));
    const [x, y] = apply(m, 1, 0);
    expect(x).toBeCloseTo(4);
    expect(y).toBeCloseTo(5);
  });
});
