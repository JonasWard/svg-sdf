import { describe, expect, it } from 'vitest';
import { Scene, SDF_STRIDE } from '../types';
import { flattenSubpaths, parsePathData } from '../svg/pathData';
import { SegmentBvh } from './bvh';
import { computeLayout, computeRows, computeSdf, prepareScene } from './compute';
import { packEdges } from './edges';
import { flattenGeometry } from '../svg/scene';
import { decodeSdf, encodeSdf } from '../io/sdfFile';

const sceneFromPaths = (
  paths: { d: string; fillRule?: 'nonzero' | 'evenodd'; filled?: boolean }[],
  tolerance = 0.01
): Scene => ({
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  shapes: paths.map(({ d, fillRule = 'nonzero', filled = true }) => ({
    fill: filled ? [0, 0, 0, 1] : null,
    stroke: null,
    fillRule,
    contours: flattenSubpaths(parsePathData(d), tolerance, filled)
  }))
});

/** samples the buffer at the pixel whose centre is nearest to (x, y) */
const sample = (sdf: ReturnType<typeof computeSdf>, x: number, y: number) => {
  const i = Math.floor((x - sdf.region.minX) / sdf.pixelSize);
  const j = Math.floor((y - sdf.region.minY) / sdf.pixelSize);
  const o = (j * sdf.width + i) * SDF_STRIDE;
  return {
    px: sdf.region.minX + (i + 0.5) * sdf.pixelSize,
    py: sdf.region.minY + (j + 0.5) * sdf.pixelSize,
    d: sdf.data[o],
    dx: sdf.data[o + 1],
    dy: sdf.data[o + 2],
    shape: sdf.data[o + 3]
  };
};

describe('computeLayout', () => {
  it('pads the bounds and keeps pixels square', () => {
    const layout = computeLayout({ minX: 0, minY: 0, maxX: 200, maxY: 100 }, { width: 240, padding: 0.1 });
    expect(layout.width).toBe(240);
    expect(layout.pixelSize).toBeCloseTo(1);
    expect(layout.height).toBe(140);
    expect(layout.region.minX).toBeCloseTo(-20);
    expect(layout.region.minY).toBeCloseTo(-20);
  });
});

describe('computeSdf', () => {
  const circle = 'M80 50 A30 30 0 0 1 20 50 A30 30 0 0 1 80 50 Z';

  it('matches the analytic distance of a circle, negative inside', () => {
    const sdf = computeSdf(sceneFromPaths([{ d: circle }]), { width: 128, padding: 0.1 });
    for (const [x, y] of [
      [50, 50],
      [10, 10],
      [55, 70],
      [95, 50],
      [2, 98]
    ]) {
      const s = sample(sdf, x, y);
      const exact = Math.hypot(s.px - 50, s.py - 50) - 30;
      expect(s.d).toBeCloseTo(exact, 1);
      // the stored vector points to the nearest point on the outline
      expect(Math.hypot(s.px + s.dx - 50, s.py + s.dy - 50)).toBeCloseTo(30, 1);
      expect(Math.hypot(s.dx, s.dy)).toBeCloseTo(Math.abs(s.d), 4);
    }
  });

  it('applies even-odd and nonzero fill rules', () => {
    // two concentric squares in the same direction: a hole under evenodd, solid under nonzero
    const d = 'M10 10 H90 V90 H10 Z M30 30 H70 V70 H30 Z';
    const evenodd = computeSdf(sceneFromPaths([{ d, fillRule: 'evenodd' }]), { width: 100, padding: 0 });
    const nonzero = computeSdf(sceneFromPaths([{ d, fillRule: 'nonzero' }]), { width: 100, padding: 0 });
    expect(sample(evenodd, 50, 50).d).toBeGreaterThan(0);
    expect(sample(nonzero, 50, 50).d).toBeLessThan(0);
    expect(sample(evenodd, 20, 50).d).toBeLessThan(0);
    expect(sample(evenodd, 5, 50).d).toBeGreaterThan(0);
  });

  it('assigns the topmost containing shape inside and the nearest edge owner outside', () => {
    const scene = sceneFromPaths([{ d: 'M10 10 H60 V60 H10 Z' }, { d: 'M40 40 H90 V90 H40 Z' }]);
    const sdf = computeSdf(scene, { width: 100, padding: 0 });
    expect(sample(sdf, 50, 50).shape).toBe(1);
    expect(sample(sdf, 20, 20).shape).toBe(0);
    expect(sample(sdf, 95, 95).shape).toBe(1);
    expect(sample(sdf, 5, 5).shape).toBe(0);
  });

  it('treats unfilled shapes as edges only', () => {
    const sdf = computeSdf(sceneFromPaths([{ d: 'M10 50 L90 50', filled: false }]), { width: 100, padding: 0 });
    const s = sample(sdf, 50, 30);
    expect(s.d).toBeCloseTo(19.5, 1);
    expect(sample(sdf, 50, 70).d).toBeGreaterThan(0);
  });

  it('fills the buffer with a far distance for an empty scene', () => {
    const sdf = computeSdf({ bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, shapes: [] }, { width: 8 });
    expect(sdf.data[0]).toBeGreaterThan(10);
    expect(sdf.data[3]).toBe(-1);
  });

  it('gives the same rows when computed in bands', () => {
    const scene = sceneFromPaths([{ d: circle }, { d: 'M0 0 L30 10 L5 40 Z', fillRule: 'evenodd' }]);
    const layout = computeLayout(scene.bounds, { width: 64 });
    const prepared = prepareScene(scene);
    const whole = computeRows(prepared, layout, 0, layout.height);
    const top = computeRows(prepared, layout, 0, 20);
    const bottom = computeRows(prepared, layout, 20, layout.height);
    const joined = new Float32Array(whole.length);
    joined.set(top);
    joined.set(bottom, top.length);
    expect(joined).toEqual(whole);
  });
});

describe('SegmentBvh', () => {
  it('agrees with a brute force nearest search on random polygons', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 100;
    const paths = Array.from({ length: 6 }, () => {
      let d = `M${rand()} ${rand()}`;
      for (let i = 0; i < 40; i++) d += ` L${rand()} ${rand()}`;
      return { d: d + ' Z' };
    });
    const segments = packEdges(sceneFromPaths(paths));
    const bvh = new SegmentBvh(segments);
    const out = { d2: 0, x: 0, y: 0, segment: -1 };
    for (let q = 0; q < 500; q++) {
      const px = rand() * 1.4 - 20;
      const py = rand() * 1.4 - 20;
      bvh.nearest(px, py, out, q % 2 ? out.segment : -1);
      let best = Infinity;
      const c = segments.coords;
      for (let i = 0; i < segments.count; i++) {
        const ax = c[i * 8];
        const ay = c[i * 8 + 1];
        const ex = c[i * 8 + 6] - ax;
        const ey = c[i * 8 + 7] - ay;
        const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey)));
        best = Math.min(best, (ax + t * ex - px) ** 2 + (ay + t * ey - py) ** 2);
      }
      expect(out.d2).toBeCloseTo(best, 9);
    }
  });
});

describe('sdf file', () => {
  it('round-trips through the binary format', () => {
    const sdf = computeSdf(sceneFromPaths([{ d: 'M10 10 H60 V60 Z' }]), { width: 33 });
    sdf.colors = [[1, 0.5, 0, 1]];
    const back = decodeSdf(encodeSdf(sdf));
    expect(back.width).toBe(sdf.width);
    expect(back.height).toBe(sdf.height);
    expect(back.region).toEqual(sdf.region);
    expect(back.colors).toEqual(sdf.colors);
    expect(back.data).toEqual(sdf.data);
  });
});

/** a scene from path data in one of the two curve modes, through the same path as the app */
const sceneInMode = (
  paths: { d: string; fillRule?: 'nonzero' | 'evenodd' }[],
  mode: 'polyline' | 'exact',
  tolerance = 0.05
): Scene =>
  flattenGeometry(
    {
      bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
      shapes: paths.map(({ d, fillRule = 'nonzero' }) => ({
        fill: [0, 0, 0, 1],
        stroke: null,
        fillRule,
        subpaths: parsePathData(d)
      }))
    },
    tolerance,
    mode
  );

describe('exact curve mode', () => {
  const circle = 'M80 50 A30 30 0 0 1 20 50 A30 30 0 0 1 80 50 Z';

  it('keeps curves as cubic edges instead of flattening them', () => {
    const exact = packEdges(sceneInMode([{ d: circle }], 'exact'));
    const polyline = packEdges(sceneInMode([{ d: circle }], 'polyline'));
    expect(exact.curves).toBeGreaterThanOrEqual(4);
    expect(exact.lines).toBe(0);
    expect(polyline.curves).toBe(0);
    expect(polyline.lines).toBeGreaterThan(exact.count);
  });

  it('matches the analytic distance and direction of a circle', () => {
    const sdf = computeSdf(sceneInMode([{ d: circle }], 'exact'), { width: 96, padding: 0.1 });
    let worstDistance = 0;
    let worstAngle = 0;
    for (let j = 0; j < sdf.height; j++)
      for (let i = 0; i < sdf.width; i++) {
        const o = (j * sdf.width + i) * SDF_STRIDE;
        const px = sdf.region.minX + (i + 0.5) * sdf.pixelSize;
        const py = sdf.region.minY + (j + 0.5) * sdf.pixelSize;
        const r = Math.hypot(px - 50, py - 50);
        worstDistance = Math.max(worstDistance, Math.abs(sdf.data[o] - (r - 30)));
        // near the centre every edge point is almost equally far, the arc approximation dominates there
        if (r < 15) continue;
        // the vector to the nearest point is radial: outwards inside the circle, inwards outside
        const radial = Math.atan2(py - 50, px - 50);
        const toEdge = Math.atan2(sdf.data[o + 2], sdf.data[o + 1]) + (r > 30 ? Math.PI : 0);
        const diff = Math.abs(Math.atan2(Math.sin(toEdge - radial), Math.cos(toEdge - radial)));
        if (Math.abs(r - 30) > 0.5) worstAngle = Math.max(worstAngle, diff);
      }
    // arcs are quarter-turn cubics, their radius deviates by at most about 0.03 % and their tangent by about 1e-3 rad
    expect(worstDistance).toBeLessThan(0.01);
    expect(worstAngle).toBeLessThan(3e-3);
  });

  it('removes the faceting a polyline leaves in the direction field', () => {
    const angleError = (mode: 'polyline' | 'exact') => {
      const sdf = computeSdf(sceneInMode([{ d: circle }], mode, 0.25), { width: 64, padding: 0.1 });
      let worst = 0;
      for (let k = 0; k < sdf.width * sdf.height; k++) {
        const o = k * SDF_STRIDE;
        const i = k % sdf.width;
        const j = Math.floor(k / sdf.width);
        const px = sdf.region.minX + (i + 0.5) * sdf.pixelSize;
        const py = sdf.region.minY + (j + 0.5) * sdf.pixelSize;
        if (sdf.data[o] < 3) continue;
        const radial = Math.atan2(50 - py, 50 - px);
        const toEdge = Math.atan2(sdf.data[o + 2], sdf.data[o + 1]);
        worst = Math.max(worst, Math.abs(Math.atan2(Math.sin(toEdge - radial), Math.cos(toEdge - radial))));
      }
      return worst;
    };
    expect(angleError('polyline')).toBeGreaterThan(10 * angleError('exact'));
  });

  it('agrees with polyline mode on inside and outside, away from the edge', () => {
    const paths = [
      { d: 'M50 85 C10 55 5 30 25 18 C40 10 50 25 50 30 C50 25 60 10 75 18 C95 30 90 55 50 85 Z' },
      { d: 'M10 10 Q50 -10 90 10 T90 40 L60 30 Z M30 15 Q50 5 70 15 Z', fillRule: 'evenodd' as const }
    ];
    const exact = computeSdf(sceneInMode(paths, 'exact'), { width: 80 });
    const polyline = computeSdf(sceneInMode(paths, 'polyline', 0.01), { width: 80 });
    for (let k = 0; k < exact.width * exact.height; k++) {
      const a = exact.data[k * SDF_STRIDE];
      const b = polyline.data[k * SDF_STRIDE];
      expect(Math.abs(a - b)).toBeLessThan(0.02);
      if (Math.abs(a) > 0.05) expect(Math.sign(a)).toBe(Math.sign(b));
      expect(exact.data[k * SDF_STRIDE + 3]).toBe(polyline.data[k * SDF_STRIDE + 3]);
    }
  });

  it('gives the same rows when computed in bands', () => {
    const scene = sceneInMode([{ d: circle }, { d: 'M0 0 Q30 40 5 40 Z', fillRule: 'evenodd' }], 'exact');
    const layout = computeLayout(scene.bounds, { width: 64 });
    const prepared = prepareScene(scene);
    const whole = computeRows(prepared, layout, 0, layout.height);
    const joined = new Float32Array(whole.length);
    const top = computeRows(prepared, layout, 0, 17);
    joined.set(top);
    joined.set(computeRows(prepared, layout, 17, layout.height), top.length);
    expect(joined).toEqual(whole);
  });
});
