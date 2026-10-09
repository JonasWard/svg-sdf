import { describe, expect, it } from 'vitest';
import { computeInside, computeLayout, computeRows, prepareScene } from '../sdf/compute';
import { flattenGeometry } from '../svg/scene';
import { parsePathData } from '../svg/pathData';
import { Scene, SDF_STRIDE, toMetricSpec } from '../types';
import { packScene } from './pack';
import { referencePixel } from './reference';

const shapes = [
  {
    d: 'M50 85 C10 55 5 30 25 18 C40 10 50 25 50 30 C50 25 60 10 75 18 C95 30 90 55 50 85 Z',
    fillRule: 'nonzero' as const
  },
  { d: 'M10 10 Q50 -10 90 10 T90 40 L60 30 Z M30 15 Q50 5 70 15 Z', fillRule: 'evenodd' as const },
  { d: 'M5 95 L95 60', fillRule: 'nonzero' as const, filled: false }
];

const scene = (mode: 'exact' | 'polyline', offset = 0): Scene =>
  flattenGeometry(
    {
      bounds: { minX: offset, minY: offset, maxX: offset + 100, maxY: offset + 100 },
      shapes: shapes.map(({ d, fillRule, filled = true }) => ({
        fill: filled ? [0, 0, 0, 1] : null,
        stroke: filled ? null : [0, 0, 0, 1],
        fillRule,
        // shift everything to test far away coordinates
        subpaths: parsePathData(d).map((sp) => ({
          ...sp,
          x: sp.x + offset,
          y: sp.y + offset,
          segments: sp.segments.map((seg) => {
            const s = { ...seg } as Record<string, number | string>;
            for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2'])
              if (typeof s[k] === 'number') s[k] = (s[k] as number) + offset;
            return s as unknown as typeof seg;
          })
        }))
      }))
    },
    0.05,
    mode
  );

const specs = [
  toMetricSpec('euclidean'),
  toMetricSpec({ kind: 'euclidean', angle: 25, aspect: 1.7 }),
  toMetricSpec('manhattan'),
  toMetricSpec({ kind: 'chebyshev', angle: 10 }),
  toMetricSpec({ kind: 'lp', p: 3 }),
  toMetricSpec({ kind: 'polygon', sides: 6, angle: 15 })
];

describe('computeInside', () => {
  it('gives the signs and inside shape ids of the full computation', () => {
    const s = scene('exact');
    const layout = computeLayout(s.bounds, { width: 40 });
    const prepared = prepareScene(s);
    const rows = computeRows(prepared, layout, 0, layout.height);
    const inside = computeInside(prepared, layout, 0, layout.height);
    for (let k = 0; k < inside.length; k++) {
      expect(rows[k * SDF_STRIDE] < 0).toBe(inside[k] >= 0);
      if (inside[k] >= 0) expect(rows[k * SDF_STRIDE + 3]).toBe(inside[k]);
    }
  });
});

describe('packed scene', () => {
  it('reproduces the cpu buffer for every metric, curve mode and far away coordinates', () => {
    for (const offset of [0, 50000])
      for (const mode of ['exact', 'polyline'] as const) {
        const s = scene(mode, offset);
        const layout = computeLayout(s.bounds, { width: 36 });
        for (const spec of specs) {
          const prepared = prepareScene(s, spec);
          const cpu = computeRows(prepared, layout, 0, layout.height);
          const inside = computeInside(prepared, layout, 0, layout.height);
          const packed = packScene(prepared, layout);
          for (let j = 0; j < layout.height; j++)
            for (let i = 0; i < layout.width; i++) {
              const k = j * layout.width + i;
              const [d, vx, vy] = referencePixel(packed, i, j, inside[k]);
              // float32 storage of coordinates relative to the region, in pixel units
              const tolerance = 1e-3 * layout.pixelSize;
              expect(Math.abs(d - cpu[k * SDF_STRIDE])).toBeLessThan(tolerance);
              // the nearest point itself may differ where two edges tie, the distance it realises may not
              expect(
                Math.abs(Math.hypot(vx, vy) - Math.hypot(cpu[k * SDF_STRIDE + 1], cpu[k * SDF_STRIDE + 2]))
              ).toBeLessThan(Math.max(tolerance, 2e-3 * Math.abs(d)));
            }
        }
      }
  });
});
