// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseColor } from './color';
import { parseSvg } from './parse';

describe('parseColor', () => {
  it('reads hex, functional and named colours', () => {
    expect(parseColor('#f00')).toEqual([1, 0, 0, 1]);
    expect(parseColor('#00ff0080')![3]).toBeCloseTo(0.5, 2);
    expect(parseColor('rgb(255, 0, 255)')).toEqual([1, 0, 1, 1]);
    expect(parseColor('rgba(0 0 255 / 50%)')).toEqual([0, 0, 1, 0.5]);
    expect(parseColor('hsl(120, 100%, 50%)')!.map((v) => Math.round(v * 255))).toEqual([0, 255, 0, 255]);
    expect(
      parseColor('steelblue')!
        .slice(0, 3)
        .map((v) => Math.round(v * 255))
    ).toEqual([70, 130, 180]);
    expect(parseColor('none')).toBeNull();
  });
});

describe('parseSvg', () => {
  it('reads the viewBox as bounds', () => {
    const g = parseSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-10 0 200 100"><rect width="5" height="5"/></svg>'
    );
    expect(g.bounds).toEqual({ minX: -10, minY: 0, maxX: 190, maxY: 100 });
  });

  it('turns basic shapes into subpaths with transforms applied', () => {
    const g = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <g transform="translate(10 20)">
        <rect x="0" y="0" width="10" height="5" fill="red"/>
        <circle cx="50" cy="50" r="10"/>
        <polygon points="0,0 10,0 5,5" fill-rule="evenodd"/>
        <line x1="0" y1="0" x2="10" y2="10" stroke="blue"/>
      </g>
    </svg>`);
    expect(g.shapes).toHaveLength(4);
    const [rect, circle, polygon, line] = g.shapes;
    expect(rect.fill).toEqual([1, 0, 0, 1]);
    expect(rect.subpaths[0].x).toBe(10);
    expect(rect.subpaths[0].y).toBe(20);
    expect(circle.fill).toEqual([0, 0, 0, 1]);
    expect(circle.subpaths[0].x).toBeCloseTo(70);
    expect(polygon.fillRule).toBe('evenodd');
    expect(line.fill).toBeNull();
    expect(line.stroke).toEqual([0, 0, 1, 1]);
  });

  it('resolves inheritance, inline styles and simple css rules', () => {
    const g = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
      <style>.land { fill: #00ff00 } path#lake { fill: blue }</style>
      <g fill="red" opacity="0.5">
        <path d="M0 0H1V1Z"/>
        <path class="land" d="M0 0H1V1Z"/>
        <path class="land" id="lake" d="M0 0H1V1Z"/>
        <path class="land" style="fill: white; fill-opacity: 0.5" d="M0 0H1V1Z"/>
        <path fill="none" stroke="currentColor" d="M0 0H1V1Z"/>
      </g>
      <path display="none" d="M0 0H1V1Z"/>
    </svg>`);
    expect(g.shapes.map((s) => s.fill)).toEqual([
      [1, 0, 0, 0.5],
      [0, 1, 0, 0.5],
      [0, 0, 1, 0.5],
      [1, 1, 1, 0.25],
      null
    ]);
    expect(g.shapes[4].stroke).toEqual([0, 0, 0, 0.5]);
  });

  it('follows use references', () => {
    const g =
      parseSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10">
      <defs><path id="p" d="M0 0H1V1Z"/></defs>
      <use href="#p" x="5"/>
      <use xlink:href="#p" y="3"/>
    </svg>`);
    expect(g.shapes.map((s) => [s.subpaths[0].x, s.subpaths[0].y])).toEqual([
      [5, 0],
      [0, 3]
    ]);
  });

  it('rejects documents that are not svg', () => {
    expect(() => parseSvg('<html></html>')).toThrow();
  });
});
