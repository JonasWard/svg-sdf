import { describe, expect, it } from 'vitest';
import { monotonePieces } from './bezier';
import { SegmentBvh } from './bvh';
import { EDGE_CUBIC, EDGE_LINE, Edges } from './edges';
import { nearestL1Cubic, nearestL1Line } from './metrics';

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
    const bvh = new SegmentBvh(edges, true);
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
