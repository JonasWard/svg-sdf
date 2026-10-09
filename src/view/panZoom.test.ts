import { describe, expect, it } from 'vitest';
import { fitView, zoomAt } from './panZoom';

describe('zoomAt', () => {
  it('keeps the world point under the cursor fixed', () => {
    const view = { cx: 10, cy: 20, scale: 2 };
    const x = 30;
    const y = -40;
    const before = [view.cx + x * view.scale, view.cy + y * view.scale];
    const next = zoomAt(view, 0.5, x, y);
    expect(next.scale).toBe(1);
    expect([next.cx + x * next.scale, next.cy + y * next.scale]).toEqual(before);
  });
});

describe('fitView', () => {
  it('centres the region and fits its limiting side', () => {
    const v = fitView({ minX: 0, minY: 0, maxX: 200, maxY: 100 }, 100, 100, 1);
    expect(v).toEqual({ cx: 100, cy: 50, scale: 2 });
  });

  it('centres the region in the visible part of the viewport', () => {
    // the left half is covered, the region has to land in the right half
    const v = fitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 200, 100, 1, {
      left: 100,
      top: 0,
      right: 200,
      bottom: 100
    });
    expect(v.scale).toBe(1);
    // screen x = 150 (50 right of the centre) must show world x = 50
    expect(v.cx + 50 * v.scale).toBe(50);
  });
});
