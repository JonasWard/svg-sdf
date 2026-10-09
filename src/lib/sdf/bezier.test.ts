import { describe, expect, it } from 'vitest';
import { crossingX, isStraight, monotonePieces, nearestOnCubic, quadraticToCubic, subCubic } from './bezier';

const point = (c: number[], t: number): [number, number] => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return [a * c[0] + b * c[2] + d * c[4] + e * c[6], a * c[1] + b * c[3] + d * c[5] + e * c[7]];
};

let seed = 11;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 100;
const randomCubics = (n: number) => Array.from({ length: n }, () => Array.from({ length: 8 }, rand));

describe('monotonePieces', () => {
  it('splits into joined pieces that stay inside their endpoint boxes', () => {
    for (const c of [...randomCubics(50), [0, 0, 100, 100, 0, 100, 100, 0], [0, 0, 100, 0, 0, 0, 100, 0]]) {
      const pieces = monotonePieces(c);
      expect(pieces[0].slice(0, 2)).toEqual(c.slice(0, 2));
      const last = pieces[pieces.length - 1];
      expect(last[6]).toBeCloseTo(c[6], 9);
      expect(last[7]).toBeCloseTo(c[7], 9);
      for (let i = 1; i < pieces.length; i++) expect(pieces[i].slice(0, 2)).toEqual(pieces[i - 1].slice(6, 8));
      for (const p of pieces) {
        const minX = Math.min(p[0], p[6]) - 1e-7;
        const maxX = Math.max(p[0], p[6]) + 1e-7;
        const minY = Math.min(p[1], p[7]) - 1e-7;
        const maxY = Math.max(p[1], p[7]) + 1e-7;
        for (let k = 0; k <= 50; k++) {
          const [x, y] = point(p, k / 50);
          expect(x).toBeGreaterThanOrEqual(minX);
          expect(x).toBeLessThanOrEqual(maxX);
          expect(y).toBeGreaterThanOrEqual(minY);
          expect(y).toBeLessThanOrEqual(maxY);
        }
      }
    }
  });

  it('reproduces the original curve', () => {
    const c = [0, 0, 120, -40, -20, 140, 100, 100];
    const sub = subCubic(c, 0.25, 0.75);
    const [x, y] = point(sub, 0.5);
    const [ex, ey] = point(c, 0.5);
    expect(x).toBeCloseTo(ex, 9);
    expect(y).toBeCloseTo(ey, 9);
  });
});

describe('nearestOnCubic', () => {
  it('matches a dense brute force search', () => {
    const out = { d2: 0, x: 0, y: 0, t: 0 };
    for (const c of randomCubics(40)) {
      for (const piece of monotonePieces(c)) {
        const samples = Array.from({ length: 20001 }, (_, k) => point(piece, k / 20000));
        for (let q = 0; q < 10; q++) {
          const px = rand() * 1.4 - 20;
          const py = rand() * 1.4 - 20;
          nearestOnCubic(piece, 0, px, py, out);
          let best = Infinity;
          for (const [x, y] of samples) best = Math.min(best, (x - px) ** 2 + (y - py) ** 2);
          // the exact minimum is never worse than a sample, and the samples are within ~1e-3 of the curve
          expect(Math.sqrt(out.d2)).toBeLessThanOrEqual(Math.sqrt(best) + 1e-9);
          expect(Math.sqrt(best) - Math.sqrt(out.d2)).toBeLessThan(1e-3);
          const [x, y] = point(piece, out.t);
          expect(Math.hypot(x - out.x, y - out.y)).toBeLessThan(1e-9);
        }
      }
    }
  });
});

describe('crossingX', () => {
  it('finds where a monotone piece crosses a horizontal line', () => {
    for (const c of randomCubics(30))
      for (const piece of monotonePieces(c)) {
        if (piece[1] === piece[7]) continue;
        const t = 0.37;
        const [x, y] = point(piece, t);
        expect(crossingX(piece, 0, y)).toBeCloseTo(x, 6);
      }
  });
});

describe('helpers', () => {
  it('raises quadratics to identical cubics', () => {
    const c = quadraticToCubic(0, 0, 50, 100, 100, 0);
    const [x, y] = point(c, 0.5);
    expect(x).toBeCloseTo(50);
    expect(y).toBeCloseTo(50);
  });

  it('recognises straight pieces', () => {
    expect(isStraight([0, 0, 10, 10, 20, 20, 30, 30])).toBe(true);
    expect(isStraight([0, 0, 10, 12, 20, 20, 30, 30])).toBe(false);
  });
});
