import { describe, expect, it } from 'vitest';
import { monotonePieces } from './bezier';
import { SegmentBvh } from './bvh';
import { EDGE_CUBIC, EDGE_LINE, Edges } from './edges';
import {
  cubicRootsInUnit,
  GaugePoint,
  nearestL1Cubic,
  nearestL1Line,
  nearestLp,
  nearestPolygon,
  metricSetup
} from './metrics';
import { toMetricSpec } from '../types';

const point = (c: number[], t: number): [number, number] => {
  const u = 1 - t;
  return [
    u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
    u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7]
  ];
};

let seed = 5;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 100;

const l1 = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) + Math.abs(ay - by);

describe('L1 nearest points', () => {
  it('matches brute force on lines', () => {
    const out = { d: 0, x: 0, y: 0 };
    for (let k = 0; k < 200; k++) {
      const c = [rand(), rand(), 0, 0, 0, 0, rand(), rand()];
      const px = rand();
      const py = rand();
      nearestL1Line(c, 0, px, py, out);
      let best = Infinity;
      for (let i = 0; i <= 20000; i++) {
        const t = i / 20000;
        best = Math.min(best, l1(c[0] + t * (c[6] - c[0]), c[1] + t * (c[7] - c[1]), px, py));
      }
      expect(out.d).toBeLessThanOrEqual(best + 1e-9);
      expect(best - out.d).toBeLessThan(1e-2);
      expect(l1(out.x, out.y, px, py)).toBeCloseTo(out.d, 9);
    }
  });

  it('matches brute force on cubics, also rotated into chebyshev space', () => {
    const out = { d: 0, x: 0, y: 0 };
    for (let k = 0; k < 40; k++) {
      const raw = Array.from({ length: 8 }, rand);
      // the same curve rotated into chebyshev space, split again to be monotone there
      const rotated = raw.map((v, i) => (i % 2 ? raw[i - 1] - v : v + raw[i + 1]));
      for (const piece of [...monotonePieces(raw), ...monotonePieces(rotated)]) {
        for (const c of [piece]) {
          const samples = Array.from({ length: 20001 }, (_, i) => point(c, i / 20000));
          for (let q = 0; q < 5; q++) {
            const px = rand() * 1.4 - 20;
            const py = rand() * 1.4 - 20;
            nearestL1Cubic(c, 0, px, py, out);
            let best = Infinity;
            for (const [x, y] of samples) best = Math.min(best, l1(x, y, px, py));
            expect(out.d).toBeLessThanOrEqual(best + 1e-9);
            expect(best - out.d).toBeLessThan(1e-2);
            expect(l1(out.x, out.y, px, py)).toBeCloseTo(out.d, 9);
          }
        }
      }
    }
  });

  it('lets an L1 hierarchy agree with brute force over mixed edges', () => {
    const coords: number[] = [];
    const kind: number[] = [];
    for (let k = 0; k < 60; k++) {
      if (k % 2) {
        const [x0, y0, x1, y1] = [rand(), rand(), rand(), rand()];
        coords.push(x0, y0, 0, 0, 0, 0, x1, y1);
        kind.push(EDGE_LINE);
      } else
        for (const piece of monotonePieces(Array.from({ length: 8 }, rand))) {
          coords.push(...piece);
          kind.push(EDGE_CUBIC);
        }
    }
    const n = kind.length;
    const edges: Edges = {
      count: n,
      coords: Float64Array.from(coords),
      kind: Uint8Array.from(kind),
      shape: new Int32Array(n),
      filled: new Uint8Array(n),
      lines: 0,
      curves: 0
    };
    const bvh = new SegmentBvh(edges, 'l1');
    const out = { score: 0, x: 0, y: 0, segment: -1 };
    const one = { d: 0, x: 0, y: 0 };
    for (let q = 0; q < 300; q++) {
      const px = rand() * 1.4 - 20;
      const py = rand() * 1.4 - 20;
      bvh.nearest(px, py, out, q % 2 ? out.segment : -1);
      let best = Infinity;
      for (let i = 0; i < n; i++)
        best = Math.min(
          best,
          (kind[i] === EDGE_LINE ? nearestL1Line : nearestL1Cubic)(edges.coords, i * 8, px, py, one).d
        );
      expect(out.score).toBeCloseTo(best, 9);
    }
  });
});

describe('cubicRootsInUnit', () => {
  const roots = (a: number, b: number, c: number, d: number) => {
    const out = new Float64Array(8);
    return Array.from(out.subarray(0, cubicRootsInUnit(a, b, c, d, out)));
  };

  it('finds every root in [0, 1]', () => {
    // (t - 0.2)(t - 0.5)(t - 0.9)
    const r = roots(1, -1.6, 0.73, -0.09);
    expect(r).toHaveLength(3);
    [0.2, 0.5, 0.9].forEach((v, i) => expect(r[i]).toBeCloseTo(v, 10));
    expect(roots(0, 0, 2, -1)).toEqual([0.5]);
    expect(roots(1, 0, 0, 5)).toEqual([]);
    expect(roots(0, 0, 1, -1)).toEqual([1]);
    expect(roots(0, 0, 1, 0)).toEqual([0]);
  });

  it('appends after existing entries', () => {
    const out = new Float64Array(8);
    out[0] = 0.75;
    const end = cubicRootsInUnit(0, 0, 4, -1, out, 1);
    expect(end).toBe(2);
    expect(out[1]).toBeCloseTo(0.25);
  });
});

/** brute force minimum of a distance over a sampled edge */
const bruteForce = (c: number[], line: boolean, dist: (x: number, y: number) => number) => {
  let best = Infinity;
  for (let i = 0; i <= 20000; i++) {
    const t = i / 20000;
    const [x, y] = line ? [c[0] + t * (c[6] - c[0]), c[1] + t * (c[7] - c[1])] : point(c, t);
    best = Math.min(best, dist(x, y));
  }
  return best;
};

const randomEdges = (count: number) => {
  const edges: { c: number[]; line: boolean }[] = [];
  for (let k = 0; k < count; k++) {
    edges.push({ c: [rand(), rand(), 0, 0, 0, 0, rand(), rand()], line: true });
    for (const piece of monotonePieces(Array.from({ length: 8 }, rand))) edges.push({ c: piece, line: false });
  }
  return edges;
};

describe('Lp nearest points', () => {
  it('matches brute force on lines and cubics', () => {
    const out: GaugePoint = { score: 0, x: 0, y: 0 };
    for (const p of [1.3, 3, 7]) {
      const lp = (px: number, py: number) => (x: number, y: number) =>
        (Math.abs(x - px) ** p + Math.abs(y - py) ** p) ** (1 / p);
      for (const { c, line } of randomEdges(12)) {
        const px = rand() * 1.4 - 20;
        const py = rand() * 1.4 - 20;
        nearestLp(c, 0, line, px, py, p, out);
        const d = out.score ** (1 / p);
        const best = bruteForce(c, line, lp(px, py));
        expect(d).toBeLessThanOrEqual(best + 1e-9);
        expect(best - d).toBeLessThan(1e-2);
        expect(lp(px, py)(out.x, out.y)).toBeCloseTo(d, 7);
      }
    }
  });
});

describe('polygon nearest points', () => {
  it('matches brute force on lines and cubics', () => {
    const out: GaugePoint = { score: 0, x: 0, y: 0 };
    for (const sides of [3, 5, 6, 8]) {
      const { normals, vertices } = metricSetup(toMetricSpec({ kind: 'polygon', sides }));
      const gauge = (px: number, py: number) => (x: number, y: number) => {
        let f = -Infinity;
        for (let k = 0; k < sides; k++) f = Math.max(f, normals[k * 2] * (x - px) + normals[k * 2 + 1] * (y - py));
        return f;
      };
      for (const { c, line } of randomEdges(10)) {
        const px = rand() * 1.4 - 20;
        const py = rand() * 1.4 - 20;
        nearestPolygon(c, 0, line, px, py, normals, vertices, out);
        const best = bruteForce(c, line, gauge(px, py));
        expect(out.score).toBeLessThanOrEqual(best + 1e-9);
        expect(best - out.score).toBeLessThan(1e-2);
        expect(gauge(px, py)(out.x, out.y)).toBeCloseTo(out.score, 7);
      }
    }
  });
});

describe('gauge hierarchies', () => {
  it('agree with brute force for lp and polygon searches', () => {
    const list = randomEdges(25);
    const n = list.length;
    const edges: Edges = {
      count: n,
      coords: Float64Array.from(list.flatMap((e) => (e.line ? [e.c[0], e.c[1], 0, 0, 0, 0, e.c[6], e.c[7]] : e.c))),
      kind: Uint8Array.from(list.map((e) => (e.line ? EDGE_LINE : EDGE_CUBIC))),
      shape: new Int32Array(n),
      filled: new Uint8Array(n),
      lines: 0,
      curves: 0
    };
    for (const spec of [toMetricSpec({ kind: 'lp', p: 4 }), toMetricSpec({ kind: 'polygon', sides: 6 })]) {
      const setup = metricSetup(spec);
      const bvh = new SegmentBvh(edges, setup.search, setup.p, setup.normals, setup.vertices);
      const out = { score: 0, x: 0, y: 0, segment: -1 };
      const one: GaugePoint = { score: 0, x: 0, y: 0 };
      for (let q = 0; q < 150; q++) {
        const px = rand() * 1.4 - 20;
        const py = rand() * 1.4 - 20;
        bvh.nearest(px, py, out, q % 2 ? out.segment : -1);
        let best = Infinity;
        for (let i = 0; i < n; i++) {
          const r =
            setup.search === 'lp'
              ? nearestLp(edges.coords, i * 8, list[i].line, px, py, setup.p, one)
              : nearestPolygon(edges.coords, i * 8, list[i].line, px, py, setup.normals, setup.vertices, one);
          best = Math.min(best, r.score);
        }
        expect(out.score).toBeCloseTo(best, 6);
      }
    }
  });
});
